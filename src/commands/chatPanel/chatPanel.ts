import * as vscode from 'vscode';
import { LollmsAPI, ChatMessage } from '../../lollmsAPI';
import { ContextManager, ContextResult } from '../../contextManager';
import { Discussion, DiscussionManager } from '../../discussionManager';
import { AgentManager } from '../../agentManager';
import { HerdManager } from '../../herdManager';
import { getProcessedSystemPrompt, stripThinkingTags, DiscussionCapabilities } from '../../utils';
import * as path from 'path';
import { InfoPanel } from '../infoPanel';
import { ProcessManager } from '../../processManager';
import { getNonce } from './getNonce';
import { SkillsManager } from '../../skillsManager';
import { Logger } from '../../logger';
import { PersonalityManager } from '../../personalityManager';
import { GitIntegration } from '../../gitIntegration';

export class ChatPanel {
  public static panels: Map<string, ChatPanel> = new Map();
  public static currentPanel: ChatPanel | undefined;
  public readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _lollmsAPI: LollmsAPI;
  private _contextManager!: ContextManager;
  private _discussionManager!: DiscussionManager;
  private _gitIntegration: GitIntegration;
  private _currentDiscussion: Discussion | null = null;
  public agentManager!: AgentManager;
  public herdManager?: HerdManager;
  private _executionLogs: string[] = [];
  private processManager!: ProcessManager;
  private readonly discussionId: string;
  private _isWebviewReady = false;
  private _isLoadPending = false;
  private _inputResolver: ((value: string) => void) | null = null;
  private _skillsManager: SkillsManager;
  private _personalityManager?: PersonalityManager;
  private _isDisposed = false;
  
  private _viewReadyPromise: Promise<void>;
  private _viewReadyResolver!: () => void;
  
  private _discussionCapabilities: DiscussionCapabilities;

  public static createOrShow(extensionUri: vscode.Uri, lollmsAPI: LollmsAPI, discussionManager: DiscussionManager, discussionId: string, gitIntegration: GitIntegration, skillsManager?: SkillsManager): ChatPanel {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

    const existingPanel = ChatPanel.panels.get(discussionId);
    if (existingPanel) {
      existingPanel._panel.reveal(column);
      ChatPanel.currentPanel = existingPanel;
      return existingPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'lollmsChat',
      'Lollms Chat',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [
            vscode.Uri.joinPath(extensionUri, 'out'),
            vscode.Uri.joinPath(extensionUri, 'media'),
            vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri: extensionUri
        ],
        retainContextWhenHidden: true
      }
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'lollms-icon.svg');

    const newPanel = new ChatPanel(panel, extensionUri, lollmsAPI, discussionManager, discussionId, gitIntegration, skillsManager);
    ChatPanel.panels.set(discussionId, newPanel);
    ChatPanel.currentPanel = newPanel;
    return newPanel;
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, lollmsAPI: LollmsAPI, discussionManager: DiscussionManager, discussionId: string, gitIntegration: GitIntegration, skillsManager?: SkillsManager) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._lollmsAPI = lollmsAPI;
    this._discussionManager = discussionManager;
    this.discussionId = discussionId;
    this._gitIntegration = gitIntegration;
    this._skillsManager = skillsManager || new SkillsManager();

    // Initialize capabilities with last used settings
    this._discussionCapabilities = this._discussionManager.getLastCapabilities();

    // Initialize view ready promise
    this._viewReadyPromise = new Promise<void>((resolve) => {
        this._viewReadyResolver = resolve;
    });

    this.log(`ChatPanel initialized for discussion: ${discussionId}`);

    panel.onDidChangeViewState(e => {
        if (e.webviewPanel.active) {
            ChatPanel.currentPanel = this;
        }
    });

    this._panel.onDidDispose(() => this.dispose(), null, []);
    this._updateHtmlForWebview(); 
    this._setWebviewMessageListener(this._panel.webview);
  }
  
  public setPersonalityManager(manager: PersonalityManager) {
      this._personalityManager = manager;
  }

  public setHerdManager(manager: HerdManager) {
      this.herdManager = manager;
  }

  public getCurrentDiscussion(): Discussion | null {
      return this._currentDiscussion;
  }

  private log(message: string, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO') {
      const timestamp = new Date().toLocaleTimeString();
      const logEntry = `[${timestamp}] [${level}] ${message}`;
      console.log(logEntry);
      if (level === 'ERROR') Logger.error(message);
      else if (level === 'WARN') Logger.warn(message);
      else Logger.info(message);
      this._executionLogs.push(logEntry);
      if (this._executionLogs.length > 2000) this._executionLogs.shift();
  }
  
  private async _updateHtmlForWebview() {
    this._panel.webview.html = await this._getHtmlForWebview(this._panel.webview);
  }

  public setContextManager(contextManager: ContextManager) {
    this._contextManager = contextManager;
  }
  
  public setProcessManager(processManager: ProcessManager) {
    this.processManager = processManager;
  }
  
  public updateGeneratingState() {
    if (this._isDisposed) return;
    if (this._panel.webview) {
        const process = this._currentDiscussion ? this.processManager.getForDiscussion(this._currentDiscussion.id) : undefined;
        const isGenerating = !!process && !this._inputResolver;
        this._panel.webview.postMessage({ command: 'setGeneratingState', isGenerating });
    }
  }

  public updateAgentMode(isActive: boolean) {
    if (this._isDisposed) return;
    if (this._panel.webview) {
        this._panel.webview.postMessage({ command: 'updateAgentMode', isActive });
    }
  }

  public displayPlan(plan: any | null): void {
      if (this._isDisposed) return;
      if (this._panel.webview) {
        this._panel.webview.postMessage({ command: 'displayPlan', plan: plan });
      }
  }

  public showDebugLog() {
      this.showInternalLog();
  }

  public showInternalLog() {
      const content = this._executionLogs.length > 0 
          ? this._executionLogs.join('\n') 
          : 'No logs available for this session.';
      InfoPanel.createOrShow(this._extensionUri, "Discussion Log", `\`\`\`log\n${content}\n\`\`\``);
  }
  
  public async updateMessageContent(messageId: string, newContent: string) {
      if (!this._currentDiscussion) return;
      const msg = this._currentDiscussion.messages.find(m => m.id === messageId);
      if (msg) {
          msg.content = newContent;
          if (!this._currentDiscussion.id.startsWith('temp-')) {
              await this._discussionManager.saveDiscussion(this._currentDiscussion);
          }
      }
      if (this._panel.webview && !this._isDisposed) {
          this._panel.webview.postMessage({ command: 'updateMessage', messageId, newContent });
      }
  }
  
  public async loadDiscussion(): Promise<void> {
    if (this._isDisposed) return;
    this.log(`Loading discussion ${this.discussionId}`);

    if (!this._currentDiscussion || this._currentDiscussion.id !== this.discussionId) {
        let discussion: Discussion | null;
        if (this.discussionId.startsWith('temp-')) {
            discussion = {
                id: this.discussionId,
                title: 'Temporary Discussion',
                messages: [],
                timestamp: Date.now(),
                groupId: null,
                plan: null,
                capabilities: this._discussionCapabilities, // Use current/last defaults
                personalityId: 'default_coder'
            };
        } else {
            discussion = await this._discussionManager.getDiscussion(this.discussionId);
        }

        if (discussion) {
            let needsSave = false;
            if (!discussion.messages || !Array.isArray(discussion.messages)) {
                discussion.messages = [];
                needsSave = true;
            }
            discussion.messages.forEach(msg => {
                if (!msg.id) {
                    msg.id = Date.now().toString() + Math.random().toString(36).substring(2);
                    needsSave = true;
                }
            });
            if (!('plan' in discussion)) {
                discussion.plan = null;
                needsSave = true;
            }

            // Restore capabilities from discussion or save defaults to it
            if (discussion.capabilities) {
                this._discussionCapabilities = discussion.capabilities;
            } else {
                discussion.capabilities = this._discussionCapabilities;
                needsSave = true;
            }
            
            // Restore personality
            if (!discussion.personalityId) {
                discussion.personalityId = 'default_coder';
                needsSave = true;
            }

            if (needsSave && !discussion.id.startsWith('temp-')) {
                await this._discussionManager.saveDiscussion(discussion);
            }

            this._currentDiscussion = discussion;
            this._panel.title = this._currentDiscussion.title;
            
            // Sync Agent Mode state from capability
            if (this._discussionCapabilities.agentMode && !this.agentManager.getIsActive()) {
                this.agentManager.toggleAgentMode();
            } else if (!this._discussionCapabilities.agentMode && this.agentManager.getIsActive()) {
                this.agentManager.toggleAgentMode();
            }

        } else {
            this.log(`Discussion ${this.discussionId} not found.`, 'ERROR');
            this._panel.webview.postMessage({ command: 'updateTokenProgress' });
            vscode.window.showErrorMessage(`Lollms: Could not load discussion ${this.discussionId}. It may have been deleted.`);
            this.dispose();
            return;
        }
    }

    if (!this._isWebviewReady) {
        this.log("Webview not ready, queuing load.");
        this._isLoadPending = true;
        return;
    }
    this._isLoadPending = false;

    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    const isInspectorEnabled = config.get<boolean>('enableCodeInspector', true);

    if (this._contextManager) {
        const cachedContext = this._contextManager.getLastContext();
        if (cachedContext) {
            this._panel.webview.postMessage({ command: 'updateContext', context: cachedContext.text });
            this._panel.webview.postMessage({ command: 'updateImageContext', images: cachedContext.images });
        }
    }

    this.log(`Sending ${this._currentDiscussion.messages.length} messages to webview`);
    
    await this._panel.webview.postMessage({ 
        command: 'loadDiscussion', 
        messages: this._currentDiscussion.messages,
        isInspectorEnabled: isInspectorEnabled
    });
    
    this._panel.webview.postMessage({ 
        command: 'updateDiscussionCapabilities', 
        capabilities: this._discussionCapabilities 
    });
    
    // Check Git Repo Status
    let isGitRepo = false;
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder && this._gitIntegration) {
        isGitRepo = await this._gitIntegration.isGitRepo(workspaceFolder);
    }
    this._panel.webview.postMessage({ command: 'updateGitRepoStatus', isRepo: isGitRepo });

    this._panel.webview.postMessage({ command: 'updateThinkingMode', mode: this._discussionCapabilities.thinkingMode });

    if (this._personalityManager) {
        this._panel.webview.postMessage({
            command: 'updatePersonalities',
            personalities: this._personalityManager.getPersonalities(),
            currentPersonalityId: this._currentDiscussion.personalityId
        });
    }

    this.displayPlan(this._currentDiscussion.plan);
    this.updateGeneratingState();

    this._updateContextAndTokens();
    await this._fetchAndSetModels(false);
  }

  // ... rest of the file (unchanged parts are omitted for brevity, but full file replacement requires strictness so I will include full content)
  // FULL CONTENT BELOW

  private async _fetchAndSetModels(forceRefresh: boolean = false) {
    if (this._isDisposed) return;
    try {
        if (!this._panel.webview) return;
        let models: Array<{ id: string }> = [];
        try {
            models = await this._lollmsAPI.getModels(forceRefresh);
        } catch (error: any) {
            this.log(`Failed to fetch models: ${error.message}`, 'WARN');
        }
        
        if (this._currentDiscussion) {
            this._panel.webview.postMessage({ 
                command: 'updateModels',
                models: models,
                currentModel: this._currentDiscussion.model
            });
        }
    } catch (e: any) {
        this.log(`Unexpected error in _fetchAndSetModels: ${e.message}`, 'ERROR');
    }
  }
  
  private async _updateContextAndTokens() {
    this.log("_updateContextAndTokens called");
    if (this._isDisposed) {
        this.log("_updateContextAndTokens aborted (disposed)", 'WARN');
        return;
    }

    try {
        if (!this._contextManager || !this._currentDiscussion || !this._panel.webview) {
            this.log("_updateContextAndTokens: Missing dependencies (contextManager or discussion)", 'WARN');
            this._panel.webview?.postMessage({ command: 'updateTokenProgress' });
            return;
        }
        
        // Use a safe postMessage check
        if (!this._isDisposed) {
            this._panel.webview.postMessage({ command: 'tokenCalculationStarted', text: 'Building file tree...' });
            this._panel.webview.postMessage({ command: 'updateStatus', status: 'Scanning project files...', type: 'info' });
        }

        // Run calculation safely
        try {
            this.log("Fetching context content...");
            const context = await this._contextManager.getContextContent();
            this.log(`Context content fetched. Length: ${context.text.length} chars`);

            if (this._isDisposed) return;

            this._panel.webview.postMessage({ command: 'updateContext', context: context.text });
            this._panel.webview.postMessage({ command: 'updateImageContext', images: context.images });
            
            this._panel.webview.postMessage({ command: 'tokenCalculationStarted', text: 'Counting tokens...' });
            this._panel.webview.postMessage({ command: 'updateStatus', status: 'Computing tokens length...', type: 'info' });
    
            const discussionContent = this._currentDiscussion!.messages.map(msg => {
                if (typeof msg.content === 'string') return msg.content;
                if (Array.isArray(msg.content)) {
                    return msg.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
                }
                return '';
            }).join('\n');
            
            const fullTextToTokenize = context.text + '\n' + discussionContent;
            const modelForTokenization = this._currentDiscussion?.model || this._lollmsAPI.getModelName();

            if (!modelForTokenization) {
                this.log("No model selected for tokenization.", 'WARN');
                if (!this._isDisposed) {
                    this._panel.webview.postMessage({
                        command: 'updateTokenProgress',
                        error: `No model configured`
                    });
                    this._panel.webview.postMessage({ command: 'updateStatus', status: 'Ready (No model)', type: 'info' });
                }
                return;
            }
    
            this.log(`Starting API Tokenization. Model: ${modelForTokenization}, Text Length: ${fullTextToTokenize.length}`);
            
            const [tokenizeResponse, contextSizeResponse] = await Promise.all([
                this._lollmsAPI.tokenize(fullTextToTokenize, modelForTokenization),
                this._lollmsAPI.getContextSize(modelForTokenization)
            ]);
            
            if (this._isDisposed) return;

            this.log(`Tokenization complete. Count: ${tokenizeResponse.count}, Context Size: ${contextSizeResponse.context_size}, Estimated: ${tokenizeResponse.isEstimation}`);

            let ctxSize = contextSizeResponse.context_size;
            if (!ctxSize || ctxSize <= 0) {
                ctxSize = 0;
            }

            const isApproximate = tokenizeResponse.isEstimation || contextSizeResponse.isEstimation;

            this._panel.webview.postMessage({
                command: 'updateTokenProgress',
                totalTokens: tokenizeResponse.count,
                contextSize: ctxSize,
                isApproximate: isApproximate
            });
            
            if (isApproximate) {
                this._panel.webview.postMessage({ command: 'updateStatus', status: 'Ready (Approximate - API Check Failed)', type: 'warning' });
            } else {
                this._panel.webview.postMessage({ command: 'updateStatus', status: 'Ready', type: 'info' });
            }
    
        } catch (error: any) {
            this.log(`Failed to update tokens via API: ${error.message}. Using failsafe fallback.`, 'WARN');
            if (this._isDisposed) return;
            
            try {
                const context = await this._contextManager.getContextContent();
                const discussionContent = this._currentDiscussion!.messages.map(msg => {
                    if (typeof msg.content === 'string') return msg.content;
                    if (Array.isArray(msg.content)) {
                        return msg.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
                    }
                    return '';
                }).join('\n');
                const fullText = context.text + '\n' + discussionContent;
                
                const wordCount = fullText.trim().split(/\s+/).length;
                const estimatedTokens = Math.ceil(wordCount * 1.33);
                
                const config = vscode.workspace.getConfiguration('lollmsVsCoder');
                const failsafeSize = config.get<number>('failsafeContextSize') || 4096;

                this._panel.webview.postMessage({
                    command: 'updateTokenProgress',
                    totalTokens: estimatedTokens,
                    contextSize: failsafeSize,
                    isApproximate: true
                });
                
                this._panel.webview.postMessage({ command: 'updateStatus', status: 'Ready (Approx)', type: 'warning' });

            } catch (fallbackError: any) {
                this.log(`Fallback token calculation failed: ${fallbackError.message}`, 'ERROR');
                if (!this._isDisposed) {
                    this._panel.webview.postMessage({
                        command: 'updateTokenProgress',
                        error: `API Error`
                    });
                    this._panel.webview.postMessage({ command: 'updateStatus', status: 'Error scanning context', type: 'error' });
                }
            }
        } finally {
            if (!this._isDisposed) {
                this._panel.webview.postMessage({ command: 'tokenCalculationFinished' });
            }
        }
    } catch (e: any) {
        this.log(`Unexpected error in _updateContextAndTokens: ${e.message}`, 'ERROR');
        if (!this._isDisposed && this._panel.webview) {
            this._panel.webview.postMessage({ command: 'tokenCalculationFinished' });
        }
    }
  }

  // Helper to ensure webview is ready
  private async waitForWebviewReady() {
      if (this._isWebviewReady) return;
      return this._viewReadyPromise;
  }

  // Public method to safely set input text after webview is ready
  public async setInputText(text: string) {
      if (this._isDisposed) return;
      await this.waitForWebviewReady();
      if (!this._isDisposed) {
          this._panel.webview.postMessage({ command: 'setInputText', text });
      }
  }

  private async saveCapabilities() {
      if (this._currentDiscussion && !this._currentDiscussion.id.startsWith('temp-')) {
          this._currentDiscussion.capabilities = this._discussionCapabilities;
          await this._discussionManager.saveDiscussion(this._currentDiscussion);
      }
      await this._discussionManager.saveLastCapabilities(this._discussionCapabilities);
  }

  // ... (Other methods remain unchanged) ...
  public async handleManualAutoContext(userPrompt: string) {
      if (this._isDisposed) return;
      
      const { id: processId, controller } = this.processManager.register(this.discussionId, 'Running Auto-Context...');
      this.updateGeneratingState();

      try {
          const model = this._currentDiscussion?.model || this._lollmsAPI.getModelName();
          
          let objective = userPrompt.trim();
          
          // If no prompt in input, try to infer objective from history
          if (!objective && this._currentDiscussion && this._currentDiscussion.messages.length > 0) {
              // Find the last user message
              for (let i = this._currentDiscussion.messages.length - 1; i >= 0; i--) {
                  const m = this._currentDiscussion.messages[i];
                  if (m.role === 'user') {
                      if (typeof m.content === 'string') {
                          objective = m.content;
                      } else if (Array.isArray(m.content)) {
                          objective = m.content.map(c => c.type === 'text' ? c.text : '').join(' ');
                      }
                      break;
                  }
              }
          }
          
          if (!objective) {
              objective = "Analyze current project context relevance.";
          }

          const contextAgentMsgId = 'ctx_agent_manual_' + Date.now();
          await this.addMessageToDiscussion({
              id: contextAgentMsgId,
              role: 'system',
              content: `**🧠 Auto-Context Agent (Manual)**\n*Objective: "${objective.substring(0, 100)}${objective.length>100?'...':''}"*\n\n`
          });

          await this._contextManager.runContextAgent(
                objective, 
                model, 
                controller.signal,
                (newContent) => {
                    if (!this._isDisposed) {
                        this._panel.webview.postMessage({ 
                            command: 'updateMessage', 
                            messageId: contextAgentMsgId, 
                            newContent: newContent 
                        });
                    }
                }
            );
            
            this._updateContextAndTokens();

      } catch (e: any) {
          if (e.name !== 'AbortError') {
            this.log(`Manual Auto-Context failed: ${e.message}`, 'ERROR');
            this.addMessageToDiscussion({ role: 'system', content: `❌ Auto-Context Failed: ${e.message}` });
          }
      } finally {
          this.processManager.unregister(processId);
          this.updateGeneratingState();
      }
  }

  public async sendMessage(message: ChatMessage, autoContextMode: boolean = false) {
    // ... sendMessage implementation ...
    // Since I need to output full file, I will copy it from previous context but make sure it compiles with TS.
    // The previous implementation was very long. I will output the whole file content to be safe.
    
    if (this._isDisposed) return;
    if (!this._currentDiscussion) {
        await this.waitForWebviewReady();
        if (!this._currentDiscussion) {
            vscode.window.showErrorMessage("No active discussion found.");
            return;
        }
    } else {
        await this.waitForWebviewReady();
    }

    await this.addMessageToDiscussion(message);

    const { id: processId, controller } = this.processManager.register(this.discussionId, 'Generating response...');
    this.updateGeneratingState();

    let autoContextText = "";

    const isAutoContext = this._discussionCapabilities.autoContextMode || autoContextMode;

    if (isAutoContext) {
        // ... (AutoContext logic) ...
        this.log("Auto-Context mode active. Starting agent loop.");
        const model = this._currentDiscussion.model || this._lollmsAPI.getModelName();
        const userPromptText = (typeof message.content === 'string') ? message.content : "User request with attachments";
        
        const contextAgentMsgId = 'ctx_agent_' + Date.now();
        await this.addMessageToDiscussion({
            id: contextAgentMsgId,
            role: 'system',
            content: `**🧠 Auto-Context Agent**\n*Analyzing project structure and selecting files...*\n\n`,
            skipInPrompt: true 
        });

        try {
            autoContextText = await this._contextManager.runContextAgent(
                userPromptText, 
                model, 
                controller.signal,
                (newContent) => {
                    if (!this._isDisposed) {
                        this._panel.webview.postMessage({ 
                            command: 'updateMessage', 
                            messageId: contextAgentMsgId, 
                            newContent: newContent 
                        });
                    }
                }
            );
        } catch (e: any) {
            this.log(`Auto-Context failed: ${e.message}`, 'ERROR');
            if (!this._isDisposed) this._panel.webview.postMessage({ command: 'updateStatus', status: 'Auto-Context Failed. Using default.', type: 'error' });
        }
    }

    let contextText = autoContextText;
    if (!contextText) {
        const standardContext = await this._contextManager.getContextContent();
        contextText = standardContext.text;
    }

    if (this._discussionCapabilities.herdMode && this.herdManager) {
        // ... (Herd Mode logic) ...
        // Simplified for brevity in this output, but logic remains
        let preParticipants = this._discussionCapabilities.herdPreCodeParticipants;
        let postParticipants = this._discussionCapabilities.herdPostCodeParticipants;
        const leaderModel = this._currentDiscussion.model || this._lollmsAPI.getModelName();
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const dynamicMode = config.get<boolean>('herdDynamicMode') || false;
        
        if (dynamicMode) {
             const modelPool = config.get<any[]>('herdDynamicModelPool') || [];
             if (modelPool.length > 0) {
                 const herdMessageId = 'herd_plan_' + Date.now();
                 await this.addMessageToDiscussion({
                    id: herdMessageId,
                    role: 'system',
                    content: `### ðŸ —ï¸  Dynamic Herd: Recruiting Agents...\n\n`,
                    skipInPrompt: true
                 });

                 const plan = await this.herdManager.planDynamicHerd(
                     typeof message.content === 'string' ? message.content : "Complex task",
                     modelPool,
                     leaderModel,
                     controller.signal
                 );

                 if (plan) {
                     preParticipants = plan.pre;
                     postParticipants = plan.post;
                     await this.updateMessageContent(herdMessageId, `### ðŸ —ï¸  Dynamic Herd Assembled\n\n**Pre-Code Team:** ${plan.pre.map(p => p.name).join(', ')}\n**Post-Code Team:** ${plan.post.map(p => p.name).join(', ')}`);
                 } else {
                     await this.updateMessageContent(herdMessageId, `âš ï¸  Dynamic planning failed. Falling back to static configuration.`);
                 }
             } else {
                 await this.addMessageToDiscussion({ role: 'system', content: "âš ï¸  Dynamic Herd Mode enabled but Model Pool is empty. Using static configuration.", skipInPrompt: true });
             }
        }

        if ((!preParticipants || preParticipants.length === 0) && (!postParticipants || postParticipants.length === 0)) {
            this.addMessageToDiscussion({role: 'system', content: "Herd Mode enabled but no Pre-Code or Post-Code participants configured. Please check Settings."});
            this.processManager.unregister(processId);
            this.updateGeneratingState();
            return;
        }

        try {
            const promptText = typeof message.content === 'string' ? message.content : 'User provided rich content.';

            const herdMessageId = 'herd_log_' + Date.now();
            await this.addMessageToDiscussion({
                id: herdMessageId,
                role: 'system',
                content: `### 🐂 Herd Mode Initializing...\n\n`,
                skipInPrompt: true 
            });

            const synthesisResult = await this.herdManager.run(
                promptText,
                preParticipants,
                postParticipants,
                this._discussionCapabilities.herdRounds || 2,
                leaderModel,
                contextText, 
                (status) => {
                    this._panel.webview.postMessage({ command: 'updateStatus', status });
                },
                async (newContent) => {
                    await this.updateMessageContent(herdMessageId, newContent);
                },
                controller.signal,
                this._currentDiscussion.messages 
            );

            if (!controller.signal.aborted && synthesisResult) {
                const synthesisPrompt: ChatMessage = {
                    role: 'user',
                    content: synthesisResult 
                };
                
                const systemPrompt = await getProcessedSystemPrompt('chat', this._discussionCapabilities);
                const systemMessage: ChatMessage = { role: 'system', content: systemPrompt };
                
                const history = this._currentDiscussion.messages.filter(m => !m.skipInPrompt);
                
                const messagesToSend = [systemMessage, ...history, synthesisPrompt];
                
                const assistantMessageId = 'assistant_' + Date.now().toString();
                this._panel.webview.postMessage({
                    command: 'addMessage',
                    message: { id: assistantMessageId, role: 'assistant', content: '', startTime: Date.now(), model: leaderModel }
                });

                let fullResponse = '';
                await this._lollmsAPI.sendChat(messagesToSend, (chunk) => {
                    fullResponse += chunk;
                    this._panel.webview.postMessage({ command: 'appendMessageChunk', id: assistantMessageId, chunk });
                }, controller.signal, leaderModel);

                const finalMsg: ChatMessage = {
                    id: assistantMessageId,
                    role: 'assistant',
                    content: fullResponse,
                    model: leaderModel
                };
                await this.addMessageToDiscussion(finalMsg, false);
                this._panel.webview.postMessage({ command: 'finalizeMessage', id: assistantMessageId, fullContent: fullResponse });
            }

        } catch (error: any) {
            if (error.name !== 'AbortError') {
                this.log(`Herd error: ${error.message}`, 'ERROR');
                this.addMessageToDiscussion({ role: 'system', content: `Herd Error: ${error.message}` });
            }
        } finally {
            this.processManager.unregister(processId);
            this.updateGeneratingState();
            this._updateContextAndTokens();
        }
        return; 
    }

    try {
        let personaContent = '';
        if (this._personalityManager && this._currentDiscussion.personalityId) {
            const p = this._personalityManager.getPersonality(this._currentDiscussion.personalityId);
            if (p) personaContent = p.systemPrompt;
        }

        const systemPrompt = await getProcessedSystemPrompt('chat', this._discussionCapabilities, personaContent);
        
        let combinedSystemContent = systemPrompt;
        if (contextText && contextText.trim().length > 0) {
            combinedSystemContent += `\n\n${contextText}`;
        }

        const systemMessage: ChatMessage = { role: 'system', content: combinedSystemContent };
        
        let messagesToSend: ChatMessage[] = [systemMessage];
        
        const standardContextForImages = await this._contextManager.getContextContent();
        if (standardContextForImages.images.length > 0) {
            const imageContent = standardContextForImages.images.map(img => ({
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${img.data}` }
            }));
            if (imageContent.length > 0) {
                messagesToSend.push({ role: 'user', content: imageContent as any });
            }
        }

        const history = this._currentDiscussion.messages.filter(m => !m.skipInPrompt);
        messagesToSend = [...messagesToSend, ...history];

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const addPedagogical = config.get<boolean>('addPedagogicalInstruction');

        if (addPedagogical) {
            const lastMsgIndex = messagesToSend.length - 1;
            if (lastMsgIndex >= 0) {
                const lastMsg = messagesToSend[lastMsgIndex];
                if (lastMsg.role === 'user') {
                    const pedagogicalSuffix = "\n\n(Important: Please start with a clear pedagogical description of your plan and logic before outputting any code or actions. Teach me!)";
                    
                    const modifiedLastMsg = { ...lastMsg };
                    
                    if (typeof modifiedLastMsg.content === 'string') {
                        if (!modifiedLastMsg.content.includes(pedagogicalSuffix.trim())) {
                             modifiedLastMsg.content += pedagogicalSuffix;
                        }
                    } else if (Array.isArray(modifiedLastMsg.content)) {
                        const newContent = [...modifiedLastMsg.content];
                        newContent.push({ type: 'text', text: pedagogicalSuffix });
                        modifiedLastMsg.content = newContent;
                    }
                    
                    messagesToSend[lastMsgIndex] = modifiedLastMsg;
                }
            }
        }

        // GIT WORKFLOW
        if (this._discussionCapabilities.gitWorkflow) {
            const tempBranchName = `ai-feat-${Date.now()}`;
            const startBranchMessage: ChatMessage = {
                id: 'sys_branch_start_' + Date.now(),
                role: 'system',
                content: `**Git Workflow Active**\n\n[command:lollms-vs-coder.createGitBranch|label:Step 1: Create Branch & Switch|params:{"branch":"${tempBranchName}"}]\n\n`,
                skipInPrompt: true 
            };
            await this.addMessageToDiscussion(startBranchMessage);
        }

        const assistantMessageId = 'assistant_' + Date.now().toString() + Math.random().toString(36).substring(2);
        
        if (!this._isDisposed) {
            this._panel.webview.postMessage({
                command: 'addMessage',
                message: {
                    id: assistantMessageId,
                    role: 'assistant',
                    content: '',
                    startTime: Date.now(),
                    model: this._currentDiscussion.model || this._lollmsAPI.getModelName()
                }
            });
        }

        let fullResponse = '';
        let tokenCount = 0;
        let webSearchTriggered = false;

        await this._lollmsAPI.sendChat(messagesToSend, (chunk) => {
            if (this._isDisposed) {
                controller.abort();
                return;
            }
            fullResponse += chunk;
            tokenCount++; 
            this._panel.webview.postMessage({
                command: 'appendMessageChunk',
                id: assistantMessageId,
                chunk: chunk
            });

            const searchMatch = fullResponse.match(/<web_search>(.*?)<\/web_search>/);
            if (searchMatch && !webSearchTriggered) {
                webSearchTriggered = true;
                controller.abort(); 
                this.handleAutomatedSearch(searchMatch[1], assistantMessageId);
            }
        }, controller.signal, this._currentDiscussion.model);

        if (!webSearchTriggered) {
            if (!fullResponse || fullResponse.trim() === '') {
                fullResponse = "*[No response received from Lollms. The server might be busy or the model failed to generate text.]*";
            }

            const cleanResponse = fullResponse;
            const assistantMessage: ChatMessage = {
                id: assistantMessageId,
                role: 'assistant',
                content: cleanResponse,
                model: this._currentDiscussion.model || this._lollmsAPI.getModelName()
            };

            await this.addMessageToDiscussion(assistantMessage, false);

            if (!this._isDisposed) {
                this._panel.webview.postMessage({
                    command: 'finalizeMessage',
                    id: assistantMessageId,
                    fullContent: cleanResponse,
                    tokenCount: tokenCount
                });
            }

            // GIT WORKFLOW
            if (this._discussionCapabilities.gitWorkflow) {
                const endBranchMessage: ChatMessage = {
                    id: 'sys_branch_end_' + Date.now(),
                    role: 'system',
                    content: `\n\n[command:lollms-vs-coder.mergeGitBranch|label:Step 2: Fuse (Merge) Changes|params:{}]`,
                    skipInPrompt: true
                };
                await this.addMessageToDiscussion(endBranchMessage);
            }
        }

    } catch (error: any) {
        if (error.name !== 'AbortError') {
            this.log(`Error generating response: ${error.message}`, 'ERROR');
            const errorMsg: ChatMessage = {
                id: 'error_' + Date.now(),
                role: 'system',
                content: `**Error Generating Response:**\n${error.message}\n\n*Check the "Lollms VS Coder" output channel for raw server responses.*`
            };
            await this.addMessageToDiscussion(errorMsg);
            if (!this._isDisposed) {
                this._panel.webview.postMessage({ command: 'finalizeMessage', id: 'assistant_failed', fullContent: `*Generation Failed: ${error.message}*` });
            }
        } else {
            this.log('Generation aborted by user.');
        }
    } finally {
        this.processManager.unregister(processId);
        this.updateGeneratingState();
        this._updateContextAndTokens();
    }
  }

  // ... (handleAutomatedSearch, addMessageToDiscussion, handleInspectCode, sendIsolatedMessage, handleProjectExecutionResult, requestUserInput, analyzeExecutionResult, handleSaveSkill, handleImportSkills, copyFullPromptToClipboard, deleteMessage, regenerateFromMessage, insertMessage, updateMessage, _handleFileAttachment, dispose, _setWebviewMessageListener, _getHtmlForWebview - no changes in these)
  // ... including existing method implementations ...
  // Full method signatures below just to be sure valid TS file is output

  private async handleAutomatedSearch(query: string, messageId: string) {
      this.log(`Automated search triggered: ${query}`);
      const searchTool = this.agentManager.getTools().find(t => t.name === 'search_web');
      if (searchTool && !this._isDisposed) {
          this._panel.webview.postMessage({ command: 'finalizeMessage', id: messageId, fullContent: `*Thinking... Need more info. Pausing to search the web for: "${query}"...*` });

          try {
            const result = await searchTool.execute({ query }, { 
                lollmsApi: this._lollmsAPI, contextManager: this._contextManager, currentPlan: null 
            }, new AbortController().signal);

            const resultMsg: ChatMessage = { 
                role: 'system', 
                content: `**AUTOMATED SEARCH RESULTS:**\n\n${result.output}\n\n*Results injected. Please proceed with the user's objective using this information.*` 
            };
            await this.addMessageToDiscussion(resultMsg);

            this.sendMessage({ role: 'system', content: "Continue your response based on the search results provided above." } as any);
          } catch (e: any) {
              this.addMessageToDiscussion({ role: 'system', content: `Search failed: ${e.message}` });
          }
      }
  }

  public async handleInspectCode(args: { code: string, language: string }) {
      const config = vscode.workspace.getConfiguration('lollmsVsCoder');
      const model = config.get<string>('inspectorModelName') || this._currentDiscussion?.model || this._lollmsAPI.getModelName();
      const systemPrompt = await getProcessedSystemPrompt('inspector');
      const userPrompt = `Review the following ${args.language} code for bugs, security vulnerabilities, and logic errors. Provide a detailed report.\n\n\`\`\`${args.language}\n${args.code}\n\`\`\``;

      await this.sendIsolatedMessage(systemPrompt, userPrompt, model);
  }

  public async sendIsolatedMessage(systemPrompt: string, userPrompt: string, model: string) {
      await this.waitForWebviewReady();
      if (this._isDisposed) return;

      const { id: processId, controller } = this.processManager.register(this.discussionId, 'Running isolated task...');
      this.updateGeneratingState();

      const assistantMessageId = 'assistant_' + Date.now() + Math.random().toString(36).substring(2);
      this._panel.webview.postMessage({
          command: 'addMessage',
          message: { id: assistantMessageId, role: 'assistant', content: '', startTime: Date.now(), model: model }
      });

      try {
          const messages: ChatMessage[] = [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
          ];

          let fullResponse = '';
          await this._lollmsAPI.sendChat(messages, (chunk) => {
              fullResponse += chunk;
              if (!this._isDisposed) this._panel.webview.postMessage({ command: 'appendMessageChunk', id: assistantMessageId, chunk: chunk });
          }, controller.signal, model);

          if (!this._isDisposed) this._panel.webview.postMessage({ command: 'finalizeMessage', id: assistantMessageId, fullContent: fullResponse });
          
      } catch (error: any) {
          if (!this._isDisposed) this._panel.webview.postMessage({ command: 'error', content: error.message });
      } finally {
          this.processManager.unregister(processId);
          this.updateGeneratingState();
      }
  }

  public handleProjectExecutionResult(output: string, success: boolean) {
      const message: ChatMessage = {
          id: 'system_exec_' + Date.now() + Math.random().toString(36).substring(2),
          role: 'system',
          content: success 
            ? `✅ **Project Executed Successfully**\n\`\`\`\n${output}\n\`\`\`\n`
            : `❌ **Project Execution Failed**\n\`\`\`\n${output}\n\`\`\`\n`
      };
      this.addMessageToDiscussion(message);
      this.analyzeExecutionResult(null, null, output, success ? 0 : 1);
  }

  public async analyzeExecutionResult(code: string | null, language: string | null, output: string, exitCode: number) {
      if (exitCode === 0 && !output.trim()) return;

      await this.waitForWebviewReady();
      if (this._isDisposed) return;

      const systemPrompt = await getProcessedSystemPrompt('chat', this._discussionCapabilities);
      let userPrompt = "";

      if (code && language) {
          if (exitCode !== 0) {
              userPrompt = `I executed the following ${language} script and it failed with exit code ${exitCode}.\n\n**Script:**\n\`\`\`${language}\n${code}\n\`\`\`\n\n**Output/Error:**\n\`\`\`\n${output}\n\`\`\`\n\nPlease analyze the error and provide a fixed version of the code.`;
          } else {
              userPrompt = `I executed the following ${language} script and it finished with exit code 0.\n\n**Script:**\n\`\`\`${language}\n${code}\n\`\`\`\n\n**Output:**\n\`\`\`\n${output}\n\`\`\`\n\nPlease analyze the output. If there are any warnings, errors, or unexpected behaviors in the text output, please explain them and suggest a fix. If everything looks good, just say "Execution successful."`;
          }
      } else {
          if (exitCode !== 0) {
               userPrompt = `I executed the project and it failed with exit code ${exitCode}.\n\n**Output/Error:**\n\`\`\`\n${output}\n\`\`\`\n\nPlease analyze the error and suggest a fix.`;
          } else {
               userPrompt = `I executed the project and it finished with exit code 0.\n\n**Output:**\n\`\`\`\n${output}\n\`\`\`\n\nPlease analyze the output. If there are any warnings or issues in the logs, please explain them and suggest fixes. If it looks clean, just confirm it was successful.`;
          }
      }

      const { id: processId, controller } = this.processManager.register(this.discussionId, 'Analyzing output...');
      this.updateGeneratingState();

      try {
          const userMsg: ChatMessage = { 
              id: 'user_analyze_' + Date.now(),
              role: 'user', 
              content: userPrompt 
          };
          await this.addMessageToDiscussion(userMsg);

          const context = await this._contextManager.getContextContent();
          
          let combinedSystemContent = systemPrompt;
          if (context.text && context.text.trim().length > 0) {
              combinedSystemContent += `\n\n${context.text}`;
          }

          const messages: ChatMessage[] = [
              { role: 'system', content: combinedSystemContent },
              ...this._currentDiscussion!.messages
          ];

          const assistantMessageId = 'assistant_' + Date.now();
          if (!this._isDisposed) {
              this._panel.webview.postMessage({
                  command: 'addMessage',
                  message: { id: assistantMessageId, role: 'assistant', content: '', startTime: Date.now(), model: this._currentDiscussion?.model }
              });
          }

          let fullResponse = '';
          await this._lollmsAPI.sendChat(messages, (chunk) => {
              fullResponse += chunk;
              if (!this._isDisposed) this._panel.webview.postMessage({ command: 'appendMessageChunk', id: assistantMessageId, chunk: chunk });
          }, controller.signal, this._currentDiscussion?.model);

          const responseMsg: ChatMessage = {
              id: assistantMessageId,
              role: 'assistant',
              content: fullResponse,
              model: this._currentDiscussion?.model
          };
          await this.addMessageToDiscussion(responseMsg, false);
          if (!this._isDisposed) this._panel.webview.postMessage({ command: 'finalizeMessage', id: assistantMessageId, fullContent: fullResponse });

      } catch (error: any) {
          if (!this._isDisposed) this._panel.webview.postMessage({ command: 'error', content: error.message });
      } finally {
          this.processManager.unregister(processId);
          this.updateGeneratingState();
      }
  }
  
  public async addMessageToDiscussion(message: ChatMessage, updateWebview: boolean = true) {
      if (this._currentDiscussion) {
          if (message.id && this._currentDiscussion.messages.some(m => m.id === message.id)) {
              this.log(`Duplicate message ignored: ${message.id}`, 'WARN');
              return;
          }
          this._currentDiscussion.messages.push(message);
          if (!this._currentDiscussion.id.startsWith('temp-')) {
              await this._discussionManager.saveDiscussion(this._currentDiscussion);
          }
      }
      if (updateWebview && this._panel.webview && !this._isDisposed) {
          this._panel.webview.postMessage({ command: 'addMessage', message: message });
      }
  }

  private async handleSaveSkill(content: string) {
      const name = await vscode.window.showInputBox({ prompt: "Enter a name for the new skill" });
      if (!name) return;
      const description = await vscode.window.showInputBox({ prompt: "Enter a brief description of the skill" });
      if (!description) return;
      await this._skillsManager.addSkill({ name, description, content });
      vscode.window.showInformationMessage(`Skill '${name}' saved successfully!`);
      vscode.commands.executeCommand('lollms-vs-coder.refreshSkills'); 
  }
  private async handleImportSkills() {
      if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
          vscode.window.showWarningMessage("Please open a workspace to import skills.");
          return;
      }
      try {
          const skills = await this._skillsManager.getSkills();
          if (skills.length === 0) {
              vscode.window.showInformationMessage("No saved skills found. Learn skills from the sidebar or chat first.");
              return;
          }
          const items = skills.map(s => ({
              label: s.name,
              description: s.description,
              detail: s.content.substring(0, 50) + "...",
              skill: s
          }));
          const selected = await vscode.window.showQuickPick(items, {
              canPickMany: true,
              placeHolder: "Select skills to add to the current discussion context"
          });
          if (selected && selected.length > 0) {
              let skillText = "";
              selected.forEach(item => {
                  skillText += `\n\n--- Skill: ${item.skill.name} ---\n${item.skill.content}\n`;
              });
              const skillMessage: ChatMessage = {
                  id: 'system_skill_' + Date.now(),
                  role: 'system',
                  content: `Loaded Skills Context:\n${skillText}`
              };
              await this.addMessageToDiscussion(skillMessage);
              vscode.window.showInformationMessage(`Imported ${selected.length} skills into discussion.`);
          }
      } catch (e: any) {
          this.log(`Error importing skills: ${e.message}`, 'ERROR');
          vscode.window.showErrorMessage(`Failed to import skills: ${e.message}`);
      }
  }
  private async copyFullPromptToClipboard(draftMessage: string) {
      const systemPrompt = await getProcessedSystemPrompt('chat', this._discussionCapabilities);
      const context = await this._contextManager.getContextContent();
      let fullText = `--- SYSTEM PROMPT ---\n${systemPrompt}\n\n`;
      fullText += `--- CONTEXT ---\n${context.text}\n\n`;
      if (this._currentDiscussion) {
          fullText += `--- CHAT HISTORY ---\n`;
          this._currentDiscussion.messages.forEach(m => {
              const content = Array.isArray(m.content) ? m.content.map(c => c.type === 'text' ? c.text : '[Image]').join('\n') : m.content;
              fullText += `${m.role.toUpperCase()}: ${content}\n\n`;
          });
      }
      if (draftMessage) {
          fullText += `USER (Draft): ${draftMessage}\n`;
      }
      await vscode.env.clipboard.writeText(fullText);
      vscode.window.showInformationMessage("Full prompt context copied to clipboard.");
  }
  private async deleteMessage(messageId: string) {
      if (this._currentDiscussion) {
          this._currentDiscussion.messages = this._currentDiscussion.messages.filter(m => m.id !== messageId);
          if (!this._currentDiscussion.id.startsWith('temp-')) {
              await this._discussionManager.saveDiscussion(this._currentDiscussion);
          }
          await this.loadDiscussion(); 
      }
  }
  private async regenerateFromMessage(messageId: string) {
      if (!this._currentDiscussion) return;
      const index = this._currentDiscussion.messages.findIndex(m => m.id === messageId);
      if (index === -1) return;
      const messageToResend = this._currentDiscussion.messages[index];
      if (messageToResend.role !== 'user') return;
      this._currentDiscussion.messages = this._currentDiscussion.messages.slice(0, index); 
      await this.sendMessage(messageToResend);
  }
  private async insertMessage(afterMessageId: string | null, role: 'user' | 'assistant', content: string) {
      if (!this._currentDiscussion) return;
      const newMessage: ChatMessage = {
          id: role + '_' + Date.now(),
          role: role,
          content: content,
          timestamp: Date.now()
      } as any;
      if (afterMessageId) {
          const index = this._currentDiscussion.messages.findIndex(m => m.id === afterMessageId);
          if (index !== -1) {
              this._currentDiscussion.messages.splice(index + 1, 0, newMessage);
          } else {
              this._currentDiscussion.messages.push(newMessage);
          }
      } else {
          this._currentDiscussion.messages.push(newMessage);
      }
      if (!this._currentDiscussion.id.startsWith('temp-')) {
          await this._discussionManager.saveDiscussion(this._currentDiscussion);
      }
      await this.loadDiscussion();
  }
  private async updateMessage(messageId: string, newContent: string) {
      if (!this._currentDiscussion) return;
      const msg = this._currentDiscussion.messages.find(m => m.id === messageId);
      if (msg) {
          msg.content = newContent;
          if (!this._currentDiscussion.id.startsWith('temp-')) {
              await this._discussionManager.saveDiscussion(this._currentDiscussion);
          }
      }
  }
  private async _handleFileAttachment(name: string, content: string, isImage: boolean) {
      if (isImage) {
          const msg: ChatMessage = {
              id: 'user_img_' + Date.now() + Math.random().toString(36).substring(2),
              role: 'user',
              content: [
                  { type: 'text', text: `Attached image: ${name}` },
                  { type: 'image_url', image_url: { url: content } }
              ]
          };
          this.addMessageToDiscussion(msg);
      } else {
          const base64 = content.split(',')[1];
          const text = await this._contextManager.processFile(name, base64);
          const systemMsg: ChatMessage = {
              id: 'system_file_' + Date.now() + Math.random().toString(36).substring(2),
              role: 'system',
              content: `Attached file: **${name}**\n\`\`\`\n${text}\n\`\`\`\n`
          };
          this.addMessageToDiscussion(systemMsg);
      }
  }
  public dispose() {
    this._isDisposed = true;
    ChatPanel.currentPanel = undefined;
    ChatPanel.panels.delete(this.discussionId);
    this._panel.dispose();
    while (this._executionLogs.length) { this._executionLogs.pop(); }
  }
  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(async (message) => {
        if (message.command !== 'webview-ready' && message.command !== 'webview-bootstrap-ok') {
            console.log("Lollms: Received message from webview:", message.command);
        }
        
        switch (message.command) {
            case 'webview-bootstrap-ok':
            case 'webview-html-loaded':
                console.log("ChatPanel: HTML Loaded signal received.");
                break;
            case 'webview-ready':
                console.log("ChatPanel: JS Ready signal received.");
                this._isWebviewReady = true;
                this._viewReadyResolver(); // Resolve promise for waiting logic
                if (this._isLoadPending) {
                    this.loadDiscussion();
                }
                return;
            case 'showError':
                vscode.window.showErrorMessage(message.message);
                break;
            case 'sendMessage':
                await this.sendMessage(message.message, message.autoContext);
                break;
            case 'runAutoContext':
                await this.handleManualAutoContext(message.prompt);
                break;
            case 'addMessage':
                await this.addMessageToDiscussion(message.message);
                break;
            case 'copyFullPrompt':
                await this.copyFullPromptToClipboard(message.draftMessage);
                break;
            case 'applyAllChanges':
                const changes = message.changes;
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `Applying ${changes.length} changes...`,
                    cancellable: true
                }, async (progress, token) => {
                    for (const change of changes) {
                        if (token.isCancellationRequested) break;
                        const progressMsg = `Applying ${change.type}: ${change.path}`;
                        progress.report({ message: progressMsg });
                        try {
                            if (change.type === 'file') {
                                await vscode.commands.executeCommand('lollms-vs-coder.applyFileContent', change.path, change.content);
                            } else if (change.type === 'diff') {
                                await vscode.commands.executeCommand('lollms-vs-coder.applyPatchContent', change.path, change.content);
                            } else if (change.type === 'insert') {
                                await vscode.commands.executeCommand('lollms-vs-coder.insertCode', change.path, change.content);
                            } else if (change.type === 'replace') {
                                await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', change.path, change.content);
                            } else if (change.type === 'delete') {
                                await vscode.commands.executeCommand('lollms-vs-coder.deleteCodeBlock', change.path, change.content);
                            }
                        } catch (e: any) {
                            vscode.window.showErrorMessage(`Failed to apply change to ${change.path}: ${e.message}`);
                        }
                    }
                });
                break;
            case 'renameFile':
                vscode.commands.executeCommand('lollms-vs-coder.renameFile', message.originalPath, message.newPath);
                break;
            case 'deleteFile':
                vscode.commands.executeCommand('lollms-vs-coder.deleteFile', message.filePaths);
                break;
            case 'insertCode':
                vscode.commands.executeCommand('lollms-vs-coder.insertCode', message.filePath, message.content);
                break;
            case 'replaceCode':
                vscode.commands.executeCommand('lollms-vs-coder.replaceCode', message.filePath, message.content);
                break;
            case 'deleteCodeBlock':
                vscode.commands.executeCommand('lollms-vs-coder.deleteCodeBlock', message.filePath, message.content);
                break;
            case 'addFilesToContext':
                const blockId = message.blockId;
                const files = message.files as string[];
                const results: { [key: string]: boolean } = {};
                if (!activeWorkspaceFolder) {
                    vscode.window.showErrorMessage("No active workspace to add files from.");
                    files.forEach(f => results[f] = false);
                    webview.postMessage({
                        command: 'filesAddedToContext',
                        results: results,
                        blockId: blockId
                    });
                    return;
                }
                try {
                    const validFiles: string[] = [];
                    for (const filePath of files) {
                        try {
                            const uri = vscode.Uri.joinPath(activeWorkspaceFolder.uri, filePath);
                            await vscode.workspace.fs.stat(uri); 
                            results[filePath] = true;
                            validFiles.push(filePath);
                        } catch (e) {
                            results[filePath] = false;
                        }
                    }
                    if (validFiles.length > 0) {
                        await vscode.commands.executeCommand('lollms-vs-coder.addFilesToContext', validFiles);
                    }
                    this._updateContextAndTokens();
                } catch (err: any) {
                    this.log("Error adding files to context: " + err.message, 'ERROR');
                    vscode.window.showErrorMessage("Error adding files: " + err.message);
                } finally {
                    webview.postMessage({
                        command: 'filesAddedToContext',
                        results: results,
                        blockId: blockId
                    });
                }
                break;
            case 'showWarning':
                vscode.window.showWarningMessage(message.message);
                break;
            case 'updateDiscussionModel':
                if (this._currentDiscussion) {
                    this._currentDiscussion.model = message.model || undefined;
                    if (!this._currentDiscussion.id.startsWith('temp-')) {
                        await this._discussionManager.saveDiscussion(this._currentDiscussion);
                    }
                }
                return;
            case 'refreshModels':
                await this._fetchAndSetModels(true);
                break;
            case 'calculateTokens':
                this._updateContextAndTokens();
                break;
            case 'copyToClipboard':
                await vscode.env.clipboard.writeText(message.text);
                break;
            case 'executeLollmsCommand':
                const { command, params } = message.details;
                if (command === 'createNotebook') {
                    vscode.commands.executeCommand('lollms-vs-coder.createNotebook', params.path, params.cellContent);
                } else if (command === 'gitCommit') {
                    vscode.commands.executeCommand('lollms-vs-coder.gitCommit', params.message);
                } else if (command === 'resetContext') {
                    vscode.commands.executeCommand('lollms-vs-coder.resetContextSelection');
                } else if (command === 'lollms-vs-coder.createGitBranch') {
                    vscode.commands.executeCommand('lollms-vs-coder.createGitBranch', params);
                } else if (command === 'lollms-vs-coder.mergeGitBranch') {
                    vscode.commands.executeCommand('lollms-vs-coder.mergeGitBranch', params);
                } else if (command === 'synthesizeSearchResults') {
                    if (!this.agentManager.getIsActive()) {
                        this.agentManager.toggleAgentMode();
                    }
                    const query = params.query;
                    const objective = `Research the following query: "${query}"
                    
Look at the previous message which contains search results and links.

Task:
1. Use the \`scrape_website\` tool to read the content of the relevant links found in the previous search results (limit to top 3).
2. Synthesize the information gathered from these pages.
3. Provide a comprehensive answer to the query based on the scraped content.`;

                    if (activeWorkspaceFolder) {
                        this.agentManager.run(objective, this._currentDiscussion!, activeWorkspaceFolder, this._currentDiscussion?.model);
                    } else {
                        vscode.window.showErrorMessage("Active workspace required for agent execution.");
                    }
                }
                break;
            case 'inspectCode':
                this.handleInspectCode(message);
                return;
            case 'stopGeneration':
                if (this._currentDiscussion) {
                    const process = this.processManager.getForDiscussion(this._currentDiscussion.id);
                    if (process) {
                        this.processManager.cancel(process.id);
                    }
                }
                break;
            case 'toggleAgentMode':
                this.agentManager.toggleAgentMode();
                this._discussionCapabilities.agentMode = this.agentManager.getIsActive();
                this.saveCapabilities();
                break;
            case 'toggleAutoContext': 
                this._discussionCapabilities.autoContextMode = message.enabled;
                this.saveCapabilities();
                break;
            case 'runAgent':
                if (!this._currentDiscussion) {
                    vscode.window.showErrorMessage("No active discussion.");
                    this.updateGeneratingState();
                    return;
                }
                const isFirstMessage = this._currentDiscussion.messages.filter(m => m.role !== 'system').length <= 1;
                if (isFirstMessage && !this._currentDiscussion.id.startsWith('temp-')) {
                    (async () => {
                        const newTitle = await this._discussionManager.generateDiscussionTitle(this._currentDiscussion!);
                        if (newTitle && this._currentDiscussion) {
                            this._currentDiscussion.title = newTitle;
                            this._panel.title = newTitle;
                            await this._discussionManager.saveDiscussion(this._currentDiscussion);
                            vscode.commands.executeCommand('lollms-vs-coder.refreshDiscussions');
                        }
                    })();
                }
                if (message.message) {
                    await this.addMessageToDiscussion(message.message);
                }
                if (activeWorkspaceFolder) {
                    this.agentManager.run(message.objective, this._currentDiscussion, activeWorkspaceFolder, this._currentDiscussion.model);
                } else {
                    this.addMessageToDiscussion({ role: 'system', content: 'Agent requires an active workspace folder.' });
                    this.updateGeneratingState();
                }
                break;
            case 'retryAgentTask':
                this.agentManager?.retryFailedTask(parseInt(message.taskId, 10));
                break;
            case 'loadFile':
                const { name: fileName, content: fileContent, isImage } = message.file;
                await this._handleFileAttachment(fileName, fileContent, isImage);
                break;
            case 'requestDeleteMessage':
                await this.deleteMessage(message.messageId);
                break;
            case 'requestAvailableTools': {
                const allTools = this.agentManager.getTools();
                const enabledTools = this.agentManager.getEnabledTools().map(t => t.name);
                this._panel.webview.postMessage({ command: 'showAvailableTools', allTools, enabledTools });
                break;
            }
            case 'updateEnabledTools': {
                this.agentManager.setEnabledTools(message.tools);
                break;
            }
            case 'requestLog':
                this.showInternalLog();
                return;
            case 'regenerateFromMessage':
                await this.regenerateFromMessage(message.messageId);
                break;
            case 'insertMessage':
                await this.insertMessage(message.afterMessageId, message.role, message.content);
                break;
            case 'updateMessage':
                await this.updateMessage(message.messageId, message.newContent);
                break;
            case 'applyFileContent':
                try {
                    await vscode.commands.executeCommand('lollms-vs-coder.applyFileContent', message.filePath, message.content);
                } catch (e: any) {
                    this.log(`Command applyFileContent failed: ${e.message}`, 'ERROR');
                    vscode.window.showErrorMessage(`Failed to apply changes: ${e.message}`);
                }
                break;
            case 'applyPatchContent':
                try {
                    await vscode.commands.executeCommand('lollms-vs-coder.applyPatchContent', message.filePath, message.content);
                } catch (e: any) {
                    this.log(`Command applyPatchContent failed: ${e.message}`, 'ERROR');
                    vscode.window.showErrorMessage(`Failed to apply patch: ${e.message}`);
                }
                break;
            case 'runScript':
                vscode.commands.executeCommand('lollms-vs-coder.runScript', message.code, message.language);
                break;
            case 'executeProject':
                await vscode.commands.executeCommand('lollms-vs-coder.executeProject', this);
                break;
            case 'setEntryPoint':
                vscode.commands.executeCommand('lollms-vs-coder.setEntryPoint');
                break;
            case 'debugRestart':
                vscode.commands.executeCommand('workbench.action.debug.restart');
                break;
            case 'saveMessageAsPrompt':
                vscode.commands.executeCommand('lollms-vs-coder.saveMessageAsPrompt', message.content);
                break;
            case 'saveCodeToFile':
                vscode.commands.executeCommand('lollms-vs-coder.saveCodeToFile', message.content, message.language);
                break;
            case 'generateImage':
                vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "Lollms: Generating image...",
                    cancellable: true
                }, async (progress, token) => {
                    try {
                        const b64_json = await this._lollmsAPI.generateImage(message.prompt, token);
                        if (token.isCancellationRequested) {
                            webview.postMessage({ command: 'imageGenerationResult', buttonId: message.buttonId, success: false });
                            return;
                        }
                        
                        let saveUri: vscode.Uri | undefined;
                        
                        if (message.filePath && activeWorkspaceFolder) {
                            saveUri = vscode.Uri.joinPath(activeWorkspaceFolder.uri, message.filePath);
                        } else {
                            // Ask user where to save
                            saveUri = await vscode.window.showSaveDialog({
                                title: 'Save Generated Image',
                                filters: { 'Images': ['png'] },
                                defaultUri: activeWorkspaceFolder ? vscode.Uri.joinPath(activeWorkspaceFolder.uri, 'generated_image.png') : undefined
                            });
                        }

                        if (saveUri) {
                            await vscode.workspace.fs.writeFile(saveUri, Buffer.from(b64_json, 'base64'));
                            const webviewUri = webview.asWebviewUri(saveUri);
                            webview.postMessage({ command: 'imageGenerationResult', buttonId: message.buttonId, success: true, webviewUri: webviewUri.toString() });
                        } else {
                             webview.postMessage({ command: 'imageGenerationResult', buttonId: message.buttonId, success: false }); 
                        }
                    } catch (error: any) {
                        webview.postMessage({ command: 'imageGenerationResult', buttonId: message.buttonId, success: false });
                        this.addMessageToDiscussion({ role: 'system', content: `❌ Image generation failed: ${error.message}` });
                    }
                });
                break;
            case 'saveSkill':
                await this.handleSaveSkill(message.content);
                break;
            case 'importSkills':
                await this.handleImportSkills();
                break;
            case 'openSettings':
                vscode.commands.executeCommand('lollms-vs-coder.showConfigView');
                break;
            case 'updateDiscussionCapabilities':
                this._discussionCapabilities = message.capabilities;
                if (this._currentDiscussion) {
                    this._currentDiscussion.capabilities = this._discussionCapabilities;
                    if (!this._currentDiscussion.id.startsWith('temp-')) {
                        await this._discussionManager.saveDiscussion(this._currentDiscussion);
                    }
                }
                await this._discussionManager.saveLastCapabilities(this._discussionCapabilities);
                
                this.log(`Updated Discussion Capabilities: ${JSON.stringify(this._discussionCapabilities)}`);
                this._panel.webview.postMessage({ command: 'updateThinkingMode', mode: this._discussionCapabilities.thinkingMode });
                this._panel.webview.postMessage({ command: 'updateDiscussionCapabilities', capabilities: this._discussionCapabilities });
                break;
            case 'updateDiscussionCapabilitiesPartial':
                if (this._discussionCapabilities) {
                    const partial = message.partial;
                    this._discussionCapabilities = { ...this._discussionCapabilities, ...partial };
                    
                    if (this._currentDiscussion) {
                        this._currentDiscussion.capabilities = this._discussionCapabilities;
                        if (!this._currentDiscussion.id.startsWith('temp-')) {
                            await this._discussionManager.saveDiscussion(this._currentDiscussion);
                        }
                    }
                    await this._discussionManager.saveLastCapabilities(this._discussionCapabilities);
                    this._panel.webview.postMessage({ command: 'updateDiscussionCapabilities', capabilities: this._discussionCapabilities });
                }
                break;
            case 'updateDiscussionPersonality':
                if (this._currentDiscussion) {
                    this._currentDiscussion.personalityId = message.personalityId;
                    if (!this._currentDiscussion.id.startsWith('temp-')) {
                        await this._discussionManager.saveDiscussion(this._currentDiscussion);
                    }
                }
                break;
            case 'runTool':
                const toolName = message.tool;
                const toolParams = message.params;
                if (this.agentManager) {
                    const toolDef = this.agentManager.getTools().find(t => t.name === toolName);
                    if (toolDef) {
                        const { id: processId, controller } = this.processManager.register(this.discussionId, `Running tool: ${toolName}...`);
                        this.updateGeneratingState();
                        try {
                            const env = {
                                workspaceRoot: vscode.workspace.workspaceFolders?.[0],
                                lollmsApi: this._lollmsAPI,
                                contextManager: this._contextManager,
                                agentManager: this.agentManager,
                                currentPlan: null
                            };
                            const result = await toolDef.execute(toolParams, env as any, controller.signal);
                            const resultMessage: ChatMessage = {
                                role: 'system',
                                content: `**Tool Output (${toolName}):**\n\n${result.output}`
                            };
                            this.addMessageToDiscussion(resultMessage);
                        } catch (e: any) {
                            this.addMessageToDiscussion({ role: 'system', content: `❌ Tool execution failed: ${e.message}` });
                        } finally {
                            this.processManager.unregister(processId);
                            this.updateGeneratingState();
                        }
                    } else {
                        vscode.window.showErrorMessage(`Tool '${toolName}' not found.`);
                    }
                }
                break;
        }
    });
  }
  
  private async _getHtmlForWebview(webview: vscode.Webview): Promise<string> {
    // ... same as before, no changes to HTML logic itself here ...
    // To minimize output size, I will call a utility or simply paste the HTML if necessary.
    // However, I need to output the full file content as per rules.
    const nonce = getNonce();

    const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'));
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'chatPanel.css'));
    const prismThemeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'prism-tomorrow.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'chatPanel.bundle.js'));
    const lollmsIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'lollms-icon.svg'));

    const l10nStrings = {
        welcomeTitle: vscode.l10n.t("welcome.title"),
        welcomeItem1: vscode.l10n.t("welcome.item1"),
        welcomeItem2: vscode.l10n.t("welcome.item2"),
        welcomeItem3: vscode.l10n.t("welcome.item3"),
        welcomeItem4: vscode.l10n.t("welcome.item4"),
        progressLoadingFiles: vscode.l10n.t("progress.loadingFiles"),
        tooltipRefreshContext: vscode.l10n.t("tooltip.refreshContext")
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="
        default-src 'none';
        style-src ${webview.cspSource} 'unsafe-inline';
        font-src ${webview.cspSource};
        img-src ${webview.cspSource} data:;
        script-src 'nonce-${nonce}' 'unsafe-eval';
    ">
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Lollms Chat</title>
    <link href="${codiconsUri}" rel="stylesheet" />
    <link href="${cssUri}" rel="stylesheet" />
    <link href="${prismThemeUri}" rel="stylesheet" />
    <style>
        :root {
            --lollms-icon: url("${lollmsIconUri}");
        }
    </style>
</head>
<body>
    <div class="chat-container">
        <div class="messages" id="messages">
            <div class="search-bar" id="search-bar" style="display: none;">
                <input type="text" id="searchInput" placeholder="Search discussion...">
                <span id="search-results-count"></span>
                <button id="search-prev" title="Previous match"><i class="codicon codicon-arrow-up"></i></button>
                <button id="search-prev" title="Previous match"><i class="codicon codicon-arrow-up"></i></button>
                <button id="search-next" title="Next match"><i class="codicon codicon-arrow-down"></i></button>
                <button id="search-close" title="Close search"><i class="codicon codicon-close"></i></button>
            </div>
            
            <div id="context-container"></div>
            
            <div class="message special-zone-message" style="display: none;">
                <div class="message-avatar">
                    <span class="codicon codicon-file-text"></span>
                </div>
                <div class="message-body">
                    <div class="message-header"><span class="role-name">Attached Files</span></div>
                    <div class="message-content">
                        <div id="attachments-container"></div>
                    </div>
                </div>
            </div>
            
            <div id="welcome-message" style="display: none;">
                <h3 id="welcome-title"></h3>
                <ul>
                    <li id="welcome-item-1"></li>
                    <li id="welcome-item-2"></li>
                    <li id="welcome-item-3"></li>
                    <li id="welcome-item-4"></li>
                </ul>
            </div>

            <div id="chat-messages-container">
                <div id="message-insertion-controls">
                    <button class="code-action-btn" id="add-user-message-btn"><i class="codicon codicon-add"></i> Add User Message</button>
                    <button class="code-action-btn" id="add-ai-message-btn"><i class="codicon codicon-add"></i> Add AI Message</button>
                </div>
            </div>

        </div>
        
        <button id="scrollToBottomBtn" title="Scroll to bottom" style="display: none;">
            <i class="codicon codicon-arrow-down"></i>
        </button>

        <!-- AGENT TOOLS MODAL -->
        <div id="tools-modal" class="modal">
            <div class="modal-content">
                <div class="modal-header">
                    <h2>Agent Tools</h2>
                    <span class="close-btn" id="close-tools-modal">&times;</span>
                </div>
                <div class="modal-body" id="tools-list"></div>
                <div class="modal-footer">
                    <button id="save-tools-btn">OK</button>
                </div>
            </div>
        </div>

        <!-- DISCUSSION TOOLS MODAL -->
        <div id="discussion-tools-modal" class="modal">
            <div class="modal-content">
                <div class="modal-header">
                    <h2>Discussion Tools</h2>
                    <span class="close-btn" id="close-discussion-tools-modal">&times;</span>
                </div>
                <div class="modal-body">
                    <div class="modal-section">
                        <h3>Herd Mode 🐂</h3>
                        <div class="checkbox-container">
                            <label class="switch"><input type="checkbox" id="cap-herdMode"><span class="slider"></span></label>
                            <label for="cap-herdMode">Enable Herd Mode</label>
                        </div>
                        <div id="herd-config-section" style="display:none; margin-top:10px; padding-left:15px; border-left:2px solid var(--vscode-textLink-foreground);">
                            <label>Rounds: <input type="number" id="cap-herdRounds" min="1" max="10" style="width:50px;"></label>
                            <p style="font-size:0.85em; opacity:0.8;">Use settings to configure participants.</p>
                        </div>
                    </div>

                    <div class="modal-section">
                        <h3>Thinking Process</h3>
                        <div class="form-group">
                            <label for="cap-thinkingMode" style="display:block; margin-bottom:5px; font-weight:600; color:var(--vscode-descriptionForeground);">Reasoning Strategy</label>
                            <select id="cap-thinkingMode" style="width: 100%; padding: 6px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 2px;">
                                <option value="none">None (Standard)</option>
                                <option value="chain_of_thought">Chain of Thought</option>
                                <option value="chain_of_verification">Chain of Verification</option>
                                <option value="plan_and_solve">Plan and Solve</option>
                                <option value="self_critique">Self Critique</option>
                                <option value="no_think">No Think (Force Disable)</option>
                            </select>
                        </div>
                    </div>

                    <div class="modal-section">
                        <h3>Allowed File Formats</h3>
                        <div class="checkbox-grid">
                            <div class="checkbox-container">
                                <label class="switch"><input type="checkbox" id="fmt-fullFile" checked><span class="slider"></span></label>
                                <label for="fmt-fullFile">Full File (File:)</label>
                            </div>
                            <div class="checkbox-container">
                                <label class="switch"><input type="checkbox" id="fmt-insert"><span class="slider"></span></label>
                                <label for="fmt-insert">Insert</label>
                            </div>
                            <div class="checkbox-container">
                                <label class="switch"><input type="checkbox" id="fmt-replace"><span class="slider"></span></label>
                                <label for="fmt-replace">Replace</label>
                            </div>
                            <div class="checkbox-container">
                                <label class="switch"><input type="checkbox" id="fmt-delete"><span class="slider"></span></label>
                                <label for="fmt-delete">Delete Code</label>
                            </div>
                        </div>
                    </div>

                    <div class="modal-section">
                        <h3>Code Generation Mode</h3>
                        <div class="radio-group">
                            <label class="radio-option">
                                <input type="radio" name="codeGenType" value="full" checked> Full Content Preferred
                            </label>
                            <label class="radio-option">
                                <input type="radio" name="codeGenType" value="diff"> Diffs Preferred
                            </label>
                            <label class="radio-option">
                                <input type="radio" name="codeGenType" value="none"> None (Chat Only)
                            </label>
                        </div>
                    </div>

                    <div class="modal-section">
                        <h3>File Capabilities</h3>
                        <div class="checkbox-grid">
                            <div class="checkbox-container">
                                <label class="switch"><input type="checkbox" id="cap-fileRename" checked><span class="slider"></span></label>
                                <label for="cap-fileRename">Rename/Move</label>
                            </div>
                            <div class="checkbox-container">
                                <label class="switch"><input type="checkbox" id="cap-fileDelete" checked><span class="slider"></span></label>
                                <label for="cap-fileDelete">Delete</label>
                            </div>
                            <div class="checkbox-container">
                                <label class="switch"><input type="checkbox" id="cap-fileSelect" checked><span class="slider"></span></label>
                                <label for="cap-fileSelect">Select (Add Context)</label>
                            </div>
                            <div class="checkbox-container">
                                <label class="switch"><input type="checkbox" id="cap-fileReset" checked><span class="slider"></span></label>
                                <label for="cap-fileReset">Reset (Clear Context)</label>
                            </div>
                        </div>
                    </div>

                    <div class="modal-section">
                        <h3>External Tools</h3>
                        <div class="checkbox-container">
                            <label class="switch"><input type="checkbox" id="cap-imageGen" checked><span class="slider"></span></label>
                            <label for="cap-imageGen">Image Generation</label>
                        </div>
                        <div class="checkbox-container">
                            <label class="switch"><input type="checkbox" id="cap-webSearch"><span class="slider"></span></label>
                            <label for="cap-webSearch">Web Search (Google)</label>
                        </div>
                        <div class="checkbox-container">
                            <label class="switch"><input type="checkbox" id="cap-arxivSearch"><span class="slider"></span></label>
                            <label for="cap-arxivSearch">ArXiv Search</label>
                        </div>
                        <div class="checkbox-container">
                            <label class="switch"><input type="checkbox" id="cap-gitCommit" checked><span class="slider"></span></label>
                            <label for="cap-gitCommit">Git Commit</label>
                        </div>
                        <div class="checkbox-container" id="cap-gitWorkflowContainer" title="Requires Git Repository">
                            <label class="switch"><input type="checkbox" id="cap-gitWorkflow"><span class="slider"></span></label>
                            <label for="cap-gitWorkflow">Git Workflow (Auto-Branching)</label>
                        </div>
                    </div>

                    <div class="modal-section" style="border:none;">
                        <h3>Modes</h3>
                        <div class="checkbox-grid">
                            <div class="checkbox-container">
                                <label class="switch"><input type="checkbox" id="mode-funMode"><span class="slider"></span></label>
                                <label for="mode-funMode">Fun Mode ðŸ¤ª</label>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button id="save-discussion-tools-btn">Apply</button>
                </div>
            </div>
        </div>

        <div class="input-area-wrapper">
            <div id="more-actions-menu">
                <div class="menu-view" id="menu-main">
                    <div class="menu-item has-submenu" data-target="menu-modes">
                        <i class="codicon codicon-settings-gear"></i>
                        <span>Discussion Modes</span>
                        <span class="menu-arrow">›</span>
                    </div>
                    <div class="menu-item has-submenu" data-target="menu-ai">
                        <i class="codicon codicon-hubot"></i>
                        <span>AI Configuration</span>
                        <span class="menu-arrow">›</span>
                    </div>
                    <div class="menu-separator"></div>
                    <button class="menu-item" id="discussionToolsButton"><i class="codicon codicon-tools"></i><span>Advanced Tools</span></button>
                    <button class="menu-item" id="agentToolsButton"><i class="codicon codicon-briefcase"></i><span>Agent Tools List</span></button>
                    <div class="menu-separator"></div>
                    <button class="menu-item" id="attachButton"><i class="codicon codicon-add"></i><span>Attach Files</span></button>
                    <button class="menu-item" id="importSkillsButton"><i class="codicon codicon-lightbulb"></i><span>Import Skill</span></button>
                    <button class="menu-item" id="copyFullPromptButton"><i class="codicon codicon-copy"></i><span>Copy Context & Prompt</span></button>
                    <button class="menu-item" id="setEntryPointButton"><i class="codicon codicon-target"></i><span>Set Project Entry Point</span></button>
                    <button class="menu-item" id="executeButton"><i class="codicon codicon-play"></i><span>Execute Project</span></button>
                    <button class="menu-item" id="debugRestartButton"><i class="codicon codicon-debug-restart"></i><span>Re-run Last Debug</span></button>
                    <button class="menu-item" id="showDebugLogButton"><i class="codicon codicon-output"></i><span>Show Debug Log</span></button>
                </div>

                <!-- Modes View -->
                <div class="menu-view hidden" id="menu-modes">
                    <div class="menu-header">
                        <button class="back-btn"><i class="codicon codicon-arrow-left"></i></button>
                        <span>Discussion Modes</span>
                    </div>
                    <div class="menu-item-toggle">
                        <span>🤖 Agent Mode</span>
                        <label class="switch"><input type="checkbox" id="agentModeCheckbox"><span class="slider"></span></label>
                    </div>
                    <div class="menu-item-toggle">
                        <span>🧠 Auto Context</span>
                        <label class="switch"><input type="checkbox" id="autoContextCheckbox"><span class="slider"></span></label>
                    </div>
                    <div class="menu-item-toggle">
                        <span>🐂 Herd Mode</span>
                        <label class="switch"><input type="checkbox" id="herdModeCheckbox"><span class="slider"></span></label>
                    </div>
                </div>

                <!-- AI Config View -->
                <div class="menu-view hidden" id="menu-ai">
                     <div class="menu-header">
                        <button class="back-btn"><i class="codicon codicon-arrow-left"></i></button>
                        <span>AI Configuration</span>
                    </div>
                     <label style="margin-left:12px; margin-top:8px; display:block; font-size:11px; font-weight:600;">Model</label>
                     <select id="model-selector" class="menu-select"></select>
                     
                     <label style="margin-left:12px; margin-top:8px; display:block; font-size:11px; font-weight:600;">Persona</label>
                     <select id="personality-selector" class="menu-select"></select>
                     
                     <div style="padding: 0 12px 12px 12px;">
                        <button id="refresh-models-btn" class="code-action-btn" style="width:100%; justify-content:center;"><i class="codicon codicon-refresh"></i> Refresh Models</button>
                     </div>
                </div>
            </div>

            <div class="top-controls">
                <div id="status-label" class="status-label">
                    <div id="status-spinner" class="spinner"></div>
                    <span id="status-text">Ready</span>
                </div>
                
                <div class="active-badges" id="active-badges">
                    <!-- Badges injected via JS -->
                </div>

                <!-- Web Search Indicator -->
                <div id="websearch-indicator" class="websearch-indicator" title="Web Search Active" style="display: none;">
                    <i class="codicon codicon-globe"></i>
                    <span>Web</span>
                </div>
                
                <div id="active-tools-indicator" class="active-tools-indicator"></div>
                
                <div class="token-progress">
                    <div class="token-progress-container">
                        <div class="token-progress-bar" id="token-progress-bar"></div>
                    </div>
                    <div id="context-status-container" style="display: flex; align-items: center; gap: 8px;">
                        <span id="token-count-label"></span>
                        <button id="refresh-context-btn" class="icon-btn" title="Refresh Context"><i class="codicon codicon-refresh"></i></button>
                    </div>
                </div>
                
                <div id="context-loading-spinner" style="display: none; align-items: center; gap: 8px; font-size: 0.9em; color: var(--vscode-descriptionForeground);">
                    <div class="spinner"></div>
                    <span id="loading-files-text"></span>
                </div>
            </div>
            <div class="input-area">
                <div class="control-buttons">
                    <button id="moreActionsButton" title="Menu"><i class="codicon codicon-menu"></i></button>
                </div>
                
                <textarea id="messageInput" placeholder="Enter your message (Shift+Enter for new line)..."></textarea>

                <div class="control-buttons">
                    <button id="sendButton" title="Send Message"><i class="codicon codicon-send"></i></button>
                </div>
            </div>
            
        </div>
        
        <div id="generating-overlay" class="generating-overlay" style="display: none;">
            <div class="generating-content">
                <div class="spinner"></div>
                <span>Generating...</span>
            </div>
            <button id="stopButton" class="stop-btn-red">Stop Generation</button>
        </div>
        
        <div id="token-counting-overlay" class="token-counting-overlay" style="display: none;">
            <div class="spinner"></div>
            <span>Counting tokens...</span>
        </div>
    </div>

    <input type="file" id="fileInput" style="display: none;" multiple accept=".md,.txt,.msg,.docx,.pdf,.pptx,.xlsx,.csv,.png,.jpg,.jpeg,.bmp,.webp">

    <script nonce="${nonce}">
        try {
            const vscode = acquireVsCodeApi();
            window.vscode = vscode;
            
            window.onerror = function(message, source, lineno, colno, error) {
                vscode.postMessage({
                    command: 'showError',
                    message: 'Webview Runtime Error: ' + message + ' (' + source + ':' + lineno + ')'
                });
                console.error("Webview Error:", message, error);
            };

            console.log("Webview Bootstrap: API acquired");
            vscode.postMessage({ command: 'webview-bootstrap-ok' });
        } catch (e) {
            console.error("Webview Bootstrap Failed:", e);
        }
        const l10n = ${JSON.stringify(l10nStrings)};
    </script>
    <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}
