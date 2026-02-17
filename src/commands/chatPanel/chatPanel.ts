import * as vscode from 'vscode';
import { LollmsAPI, ChatMessage } from '../../lollmsAPI';
import { ContextManager, ContextResult } from '../../contextManager';
import { Discussion, DiscussionManager } from '../../discussionManager';
import { AgentManager } from '../../agentManager';
import { HerdManager } from '../../herdManager';
import { getProcessedSystemPrompt, stripThinkingTags, DiscussionCapabilities, ResponseProfile } from '../../utils';
import * as path from 'path';
import { InfoPanel } from '../infoPanel';
import { ProcessManager } from '../../processManager';
import { getNonce } from './getNonce';
import { SkillsManager } from '../../skillsManager';
import { Logger } from '../../logger';
import { PersonalityManager } from '../../personalityManager';
import { GitIntegration } from '../../gitIntegration';
import { applyDiffToString, applySearchReplace } from '../../utils';
import { BigDataProcessor } from '../../bigDataProcessing';

interface ActiveGeneration {
    messageId: string;
    buffer: string;
    model: string;
    startTime: number;
    tokenCount: number; // Added to track metrics
    listeners: Set<(chunk: string) => void>;
    onComplete: Set<(fullContent: string) => void>;
}

export class ChatPanel {
  public static panels: Map<string, ChatPanel> = new Map();
  // Static registry to persist AgentManagers even if their UI panel is disposed
  public static activeAgents: Map<string, AgentManager> = new Map();
  // Static registry for standard chat generations
  public static activeGenerations: Map<string, ActiveGeneration> = new Map();
  
  public static currentPanel: ChatPanel | undefined;
  public readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  public readonly _lollmsAPI: LollmsAPI;
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
  private _tokenAbortController: AbortController | null = null;

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

    this._discussionCapabilities = this._discussionManager.getLastCapabilities();

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
  
  public setPersonalityManager(manager: PersonalityManager) { this._personalityManager = manager; }
  public setHerdManager(manager: HerdManager) { this.herdManager = manager; }
  public getCurrentDiscussion(): Discussion | null { return this._currentDiscussion; }
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
  private async _updateHtmlForWebview() { this._panel.webview.html = await this._getHtmlForWebview(this._panel.webview); }
  public setContextManager(contextManager: ContextManager) { this._contextManager = contextManager; }
  
  public setProcessManager(processManager: ProcessManager) { 
      this.processManager = processManager; 
      
      // Initialize AgentManager logic
      if (ChatPanel.activeAgents.has(this.discussionId)) {
          this.log(`Reconnecting to existing active agent for discussion ${this.discussionId}`);
          this.agentManager = ChatPanel.activeAgents.get(this.discussionId)!;
          this.agentManager.setUI(this);
      } else {
          // If created here directly (fallback), we construct it.
          // Usually registry creates it and calls setAgentManager
          this.agentManager = new AgentManager(
              this, 
              this._lollmsAPI, 
              this._contextManager, 
              this._gitIntegration,
              this._discussionManager,
              this._extensionUri,
              // @ts-ignore - Assuming dependencies injected shortly after
              undefined, 
              this._skillsManager
          );
      }
  }
  
  public setAgentManager(agent: AgentManager) {
      if (ChatPanel.activeAgents.has(this.discussionId)) {
          this.log(`Reconnecting to EXISTING active agent for discussion ${this.discussionId}`);
          this.agentManager = ChatPanel.activeAgents.get(this.discussionId)!;
          this.agentManager.setUI(this);
      } else {
          this.log(`Registering NEW active agent for discussion ${this.discussionId}`);
          this.agentManager = agent;
          ChatPanel.activeAgents.set(this.discussionId, agent);
      }
  }
  

    public updateGeneratingState() {
        if (this._isDisposed || !this.processManager) return;

        if (this._panel.webview) {
            const process = this.processManager.getForDiscussion(this.discussionId);
            const activeGen = ChatPanel.activeGenerations.get(this.discussionId);
            const activeAgent = ChatPanel.activeAgents.get(this.discussionId);
            const agentIsActive = activeAgent ? activeAgent.getIsActive() : false;

            const isGenerating = (!!process || !!activeGen || agentIsActive) && !this._inputResolver;
            
            // Extract descriptive status
            let statusText = vscode.l10n.t("Generating...");
            if (process) {
                statusText = process.description;
            } else if (agentIsActive) {
                statusText = vscode.l10n.t("Agent Thinking...");
            }

            this._panel.webview.postMessage({ 
                command: 'setGeneratingState', 
                isGenerating,
                statusText
            });
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
  
  public showDebugLog() { this.showInternalLog(); }
  public showInternalLog() {
      const content = this._executionLogs.length > 0 ? this._executionLogs.join('\n') : 'No logs available for this session.';
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
                  capabilities: this._discussionCapabilities, 
                  personalityId: 'default_coder',
                  importedSkills: []
              };
          } else {
              discussion = await this._discussionManager.getDiscussion(this.discussionId);
          }

          if (discussion) {
              // Ensure critical fields exist in memory but DO NOT save immediately
              // Saving during load is a destructive race condition
              if (!discussion.messages || !Array.isArray(discussion.messages)) {
                  discussion.messages = [];
              }
              
              discussion.messages.forEach(msg => {
                  if (!msg.id) {
                      msg.id = Date.now().toString() + Math.random().toString(36).substring(2);
                  }
              });

              if (!('plan' in discussion)) {
                  discussion.plan = null;
              }

              if (discussion.capabilities) {
                  this._discussionCapabilities = discussion.capabilities;
              } else {
                  discussion.capabilities = this._discussionCapabilities;
              }

              if (!discussion.personalityId) {
                  discussion.personalityId = 'default_coder';
              }

              if (!discussion.importedSkills) {
                  discussion.importedSkills = [];
              }

              this._currentDiscussion = discussion;
              this._panel.title = this._currentDiscussion.title;
              
              if (this.agentManager) {
                  const isActive = this.agentManager.getIsActive();
                  if (isActive !== this._discussionCapabilities.agentMode) {
                      this._discussionCapabilities.agentMode = isActive;
                  }
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
      const profiles = config.get('responseProfiles') || [];

      if (this._contextManager) {
          const cachedContext = this._contextManager.getLastContext();
          if (cachedContext) {
              const includedFiles = this._contextManager.getContextStateProvider()?.getIncludedFiles().map(f => f.path) || [];
              
              const contextTextToSend = cachedContext.text.length > 50000 
                  ? `# Context Hidden (Too Large for Preview)\n\nThe full context (${cachedContext.text.length} chars) is loaded in backend memory for AI usage, but is hidden from this preview to improve UI performance.`
                  : cachedContext.text;

              this._panel.webview.postMessage({ 
                  command: 'updateContext', 
                  context: contextTextToSend,
                  files: includedFiles,
                  skills: cachedContext.importedSkills || []
              });
              this._panel.webview.postMessage({ command: 'updateImageContext', images: cachedContext.images });
          }
      }

      this.log(`Sending ${this._currentDiscussion.messages.length} messages to webview`);
      
      await this._panel.webview.postMessage({ 
          command: 'loadDiscussion', 
          messages: this._currentDiscussion.messages,
          isInspectorEnabled: isInspectorEnabled
      });
      
      const activeGen = ChatPanel.activeGenerations.get(this.discussionId);
      if (activeGen) {
          this.log(`Reconnecting to active generation for ${this.discussionId}`);
          
          const tempMsg: ChatMessage = {
              id: activeGen.messageId,
              role: 'assistant',
              content: activeGen.buffer,
              model: activeGen.model,
              startTime: activeGen.startTime
          };
          this._panel.webview.postMessage({ command: 'addMessage', message: tempMsg });
          
          const listener = (chunk: string) => {
              if (!this._isDisposed && this._panel.webview) {
                  this._panel.webview.postMessage({ 
                      command: 'appendMessageChunk', 
                      id: activeGen.messageId, 
                      chunk: chunk 
                  });
              }
          };
          
          const completionListener = (fullContent: string) => {
              if (!this._isDisposed && this._panel.webview) {
                  this._panel.webview.postMessage({ 
                      command: 'finalizeMessage', 
                      id: activeGen.messageId, 
                      fullContent: fullContent 
                  });
                  this.updateGeneratingState();
              }
          };

          activeGen.listeners.add(listener);
          activeGen.onComplete.add(completionListener);
          
          this.updateGeneratingState();
      }

      this._panel.webview.postMessage({ 
          command: 'updateDiscussionCapabilities', 
          capabilities: this._discussionCapabilities,
          profiles: profiles
      });
      
      let isRepo = false;
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (workspaceFolder && this._gitIntegration) {
          isRepo = await this._gitIntegration.isGitRepo(workspaceFolder);
      }
      this._panel.webview.postMessage({ command: 'updateGitRepoStatus', isRepo: isRepo });

      if (this._discussionCapabilities.gitWorkflow && workspaceFolder) {
          this.sendGitBranchState(workspaceFolder);
      }

      if (this._personalityManager) {
          this._panel.webview.postMessage({
              command: 'updatePersonalities',
              personalities: this._personalityManager.getPersonalities(),
              currentPersonalityId: this._currentDiscussion.personalityId
          });
      }

      this.displayPlan(this._currentDiscussion.plan);
      this.updateGeneratingState();

      setTimeout(() => {
          this.updateContextAndTokens();
      }, 100);
      
      await this._fetchAndSetModels(false);
  }

  public async sendGitBranchState(folder: vscode.WorkspaceFolder) {
      if (!this._gitIntegration) return;
      try {
          const branch = await this._gitIntegration.getCurrentBranch(folder);
          this._panel.webview.postMessage({ command: 'updateGitState', branch });
      } catch (e) {
          this.log(`Error fetching git branch: ${e}`, 'WARN');
      }
  }

  private getCurrentPersonaSystemPrompt(): string {
      if (this._personalityManager && this._currentDiscussion && this._currentDiscussion.personalityId) {
          const p = this._personalityManager.getPersonality(this._currentDiscussion.personalityId);
          if (p) return p.systemPrompt;
      }
      return '';
  }

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

  public async updateContextAndTokens() {
    this.log("updateContextAndTokens called");
    if (this._isDisposed) {
        this.log("updateContextAndTokens aborted (disposed)", 'WARN');
        return;
    }

    if (this._tokenAbortController) {
        this._tokenAbortController.abort();
        this._tokenAbortController = null;
    }
    this._tokenAbortController = new AbortController();
    const signal = this._tokenAbortController.signal;

    try {
        if (!this._contextManager || !this._currentDiscussion || !this._panel.webview) {
            this.log("updateContextAndTokens: Missing dependencies (contextManager or discussion)", 'WARN');
            this._panel.webview?.postMessage({ command: 'updateTokenProgress' });
            return;
        }
        
        if (!this._isDisposed) {
            this._panel.webview.postMessage({ command: 'tokenCalculationStarted', text: 'Building file tree...' });
            this._panel.webview.postMessage({ command: 'updateStatus', status: 'Scanning project files...', type: 'info' });
        }

        try {
            this.log("Fetching context content...");
            const importedIds = this._currentDiscussion?.importedSkills || [];
            const context = await this._contextManager.getContextContent({ signal, importedSkillIds: importedIds });
            
            if (signal.aborted) {
                this.log("Token calculation aborted.");
                return;
            }

            this.log(`Context content fetched. Length: ${context.text.length} chars`);

            if (this._isDisposed) return;

            const includedFiles = this._contextManager.getContextStateProvider()?.getIncludedFiles().map(f => f.path) || [];
            
            const PREVIEW_LIMIT = 50000;
            const contextTextToSend = context.text.length > PREVIEW_LIMIT
                ? `# Context Hidden (Too Large for Preview)\n\nThe full context (${context.text.length} chars) is loaded in backend memory for AI usage, but is hidden from this preview to improve UI performance.`
                : context.text;

            this._panel.webview.postMessage({ 
                command: 'updateContext', 
                context: contextTextToSend,
                files: includedFiles,
                skills: context.importedSkills || []
            });
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
            
            if (signal.aborted) return;

            const [tokenizeResponse, contextSizeResponse] = await Promise.all([
                this._lollmsAPI.tokenize(fullTextToTokenize, modelForTokenization),
                this._lollmsAPI.getContextSize(modelForTokenization)
            ]);
            
            if (this._isDisposed || signal.aborted) return;

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
            if (error.message === "Operation cancelled" || signal.aborted) {
                this.log("Context update cancelled.", 'INFO');
                if (!this._isDisposed) this._panel.webview.postMessage({ command: 'updateStatus', status: 'Context scan stopped', type: 'warning' });
                return;
            }

            this.log(`Failed to update tokens via API: ${error.message}. Using failsafe fallback.`, 'WARN');
            if (this._isDisposed) return;
            
            try {
                const context = await this._contextManager.getContextContent({ signal }); 
                if (signal.aborted) return;

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
                if (signal.aborted || fallbackError.message === "Operation cancelled") return;
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
            if (this._tokenAbortController === signal) {
                this._tokenAbortController = null;
            }
        }
    } catch (e: any) {
        this.log(`Unexpected error in updateContextAndTokens: ${e.message}`, 'ERROR');
        if (!this._isDisposed && this._panel.webview) {
            this._panel.webview.postMessage({ command: 'tokenCalculationFinished' });
        }
    }
  }

  private async waitForWebviewReady() { if (this._isWebviewReady) return; return this._viewReadyPromise; }
  
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

  public async handleManualAutoContext(userPrompt: string) {
      if (this._isDisposed || !this.processManager) return; // Add !this.processManager guard
    
      const { id: processId, controller } = this.processManager.register(this.discussionId, 'Running Auto-Context...');
      this.updateGeneratingState();
      try {
          const model = this._currentDiscussion?.model || this._lollmsAPI.getModelName();
          let objective = userPrompt.trim();
          let keywords: string[] = [];
          if (objective.includes('#')) {
              const parts = objective.split('#');
              objective = parts[0].trim();
              keywords = parts[1].split(',').map(k => k.trim()).filter(k => k);
          }
          if (!objective && this._currentDiscussion && this._currentDiscussion.messages.length > 0) {
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
              content: `**🧠 Auto-Context Agent (Manual)**\n*Objective: "${objective.substring(0, 100)}${objective.length>100?'...':''}"*\n\n`,
              skipInPrompt: true // Keep it out of future context
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
                },
                keywords
            );
            this.updateContextAndTokens();
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

  // --- REPLACED: NEW HIERARCHICAL IMPORT LOGIC ---

  private async handleImportSkills() {
    const allSkills = await this._skillsManager.getSkills();
    if (allSkills.length === 0) {
        vscode.window.showInformationMessage("No saved skills found.");
        return;
    }

    // Get currently active skills to pre-select them
    const projectSkills = await this._contextManager.getActiveProjectSkills();
    const discussionSkills = this._currentDiscussion?.importedSkills || [];
    const activeSkillIds = Array.from(new Set([...projectSkills, ...discussionSkills]));

    const root: any = { id: 'root', label: 'Skills Library', children: [], isSkill: false };

    allSkills.forEach(skill => {
        const category = skill.category || 'Uncategorized';
        // Handle backslashes and split
        const parts = category.replace(/\\/g, '/').split('/').filter(p => p);
        
        let current = root;
        let pathSoFar = "";
        
        // Build/Navigate Categories
        parts.forEach(part => {
            pathSoFar = pathSoFar ? `${pathSoFar}/${part}` : part;
            let existing = current.children.find((c:any) => c.label === part && !c.isSkill);
            if (!existing) {
                existing = { id: pathSoFar, label: part, children: [], isSkill: false, isBundle: true };
                current.children.push(existing);
            }
            current = existing;
        });
        
        // Add Skill Leaf
        current.children.push({
            id: skill.id,
            label: skill.name,
            isSkill: true,
            description: skill.description,
            skill: skill 
        });
    });

    this._panel.webview.postMessage({ 
        command: 'showSkillsModal', 
        skillsTree: root,
        activeSkillIds: activeSkillIds 
    });
  }

  /**
   * Code verification and Self-Correction Loop.
   * Scans a finished message for partial blocks (Diff/SearchReplace),
   * verifies them against the actual file on disk, and asks AI to fix if broken.
   */
  private async verifyAndProcessCodeBlocks(messageId: string, fullContent: string, signal: AbortSignal): Promise<string> {
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    const maxRetries = config.get<number>('agentMaxRetries') || 2;
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return fullContent;

    let currentContent = fullContent;
    
    // Detect all partial blocks (diff:path or language:path containing Aider markers)
    // Support both \n and \r\n after the language:path header
    const blockRegex = /```(\w+):([^\n\s]+)[\r\n]+([\s\S]+?)[\r\n]+```/g;
    let match;
    const blocksToVerify: { type: string, path: string, content: string, originalMatch: string }[] = [];

    while ((match = blockRegex.exec(fullContent)) !== null) {
        const type = match[1].toLowerCase();
        const path = match[2];
        const content = match[3];
        if (type === 'diff' || content.includes('<<<<<<< SEARCH')) {
            blocksToVerify.push({ type, path, content, originalMatch: match[0] });
        }
    }

    if (blocksToVerify.length === 0) return fullContent;

    this.log(`Verifying ${blocksToVerify.length} partial code blocks...`);

    for (const block of blocksToVerify) {
        let verifiedFullCode = "";
        let success = false;
        let retryCount = 0;
        let lastError = "";

        const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, block.path);
        let originalFileText = "";
        try {
            const bytes = await vscode.workspace.fs.readFile(fileUri);
            originalFileText = Buffer.from(bytes).toString('utf8');
        } catch (e) {
            this.log(`Verification failed: Could not read ${block.path}`, 'WARN');
            continue; 
        }

        while (!success && retryCount <= maxRetries) {
            if (signal.aborted) break;

            let result: { success: boolean, result: string, error?: string };
            if (block.type === 'diff') {
                result = applyDiffToString(originalFileText, block.content);
            } else {
                // Handle multiple SEARCH/REPLACE blocks within the same content
                const aiderRegex = /<<<<<<< SEARCH([\s\S]*?)=======([\s\S]*?)>>>>>>> REPLACE/g;
                const matches = [...block.content.matchAll(aiderRegex)];
                
                if (matches.length > 0) {
                    let currentContent = originalFileText;
                    let allSuccess = true;
                    let firstError = "";

                    for (const match of matches) {
                        const srResult = applySearchReplace(currentContent, match[1], match[2]);
                        if (srResult.success) {
                            currentContent = srResult.result;
                        } else {
                            allSuccess = false;
                            firstError = srResult.error || "Search block match failed.";
                            break;
                        }
                    }
                    result = { success: allSuccess, result: currentContent, error: firstError };
                } else {
                    result = { success: false, result: originalFileText, error: "Invalid Search/Replace block format." };
                }
            }

            if (result.success) {
                verifiedFullCode = result.result;
                success = true;
            } else {
                retryCount++;
                lastError = result.error || "Unknown error.";
                if (retryCount > maxRetries) break;

                const repairPrompt = `The following code update failed to apply to \`${block.path}\`.
**Error:** ${lastError}
**Original File:**
\`\`\`
${originalFileText}
\`\`\`
**Your Attempt:**
\`\`\`${block.type}
${block.content}
\`\`\`
Please provide the **FULL CONTENT** of the file instead using the format:
\`\`\`language:${block.path}
[FULL CODE]
\`\`\`
`;

                try {
                    const repairResponse = await this._lollmsAPI.sendChat([
                        { role: 'system', content: "You are a code repair assistant." },
                        { role: 'user', content: repairPrompt }
                    ], null, signal, this._currentDiscussion?.model);
                    const repairMatch = repairResponse.match(/```(\w+):[^\n]*\n([\s\S]+?)\n```/);
                    if (repairMatch) {
                        verifiedFullCode = repairMatch[2].trim();
                        success = true;
                    }
                } catch (e) { break; }
            }
        }
        // Only replace the block in the chat UI with the full verified content if:
        // 1. We actually had to perform a repair (retryCount > 0)
        // 2. It was a 'diff' block (converts messy diffs to clean full files for easier applying)
        // 3. It was NOT an Aider/Search-Replace block (we want to keep successful Aider blocks as-is)
        const isAider = block.content.includes('<<<<<<< SEARCH');
        if (success && verifiedFullCode && (retryCount > 0 || block.type === 'diff' || !isAider)) {
            const lang = path.extname(block.path).substring(1) || 'plaintext';
            const newBlock = `Verified Full Code for ${block.path}:\n\`\`\`${lang}:${block.path}\n${verifiedFullCode}\n\`\`\``;
            currentContent = currentContent.replace(block.originalMatch, newBlock);
        }
    }
    return currentContent;
  }

  private async copyFullPromptToClipboard(draftMessage: string) {
      const config = vscode.workspace.getConfiguration('lollmsVsCoder');
      const forceFullCode = config.get<boolean>('forceFullCodePath') || false;

      const importedIds = this._currentDiscussion?.importedSkills || [];
      const contextData = await this._contextManager.getContextContent({ importedSkillIds: importedIds });
      const context = {
          tree: contextData.projectTree,
          files: contextData.selectedFilesContent,
          skills: contextData.skillsContent
      };

      const personaContent = this.getCurrentPersonaSystemPrompt();
      const systemPrompt = await getProcessedSystemPrompt('chat', this._discussionCapabilities, personaContent, undefined, forceFullCode, context);
      
      let fullText = `${systemPrompt}\n\n`;

      if (this._currentDiscussion) {
          fullText += `--- CHAT HISTORY ---\n`;
          this._currentDiscussion.messages
              .filter(m => !m.skipInPrompt)
              .forEach(m => {
                  const content = Array.isArray(m.content) ? m.content.map(c => c.type === 'text' ? c.text : '[Image]').join('\n') : m.content;
                  fullText += `${m.role.toUpperCase()}: ${content}\n\n`;
              });
      }
      if (draftMessage && draftMessage.trim()) {
          fullText += `--- CURRENT PROMPT ---\n`;
          fullText += `USER: ${draftMessage}\n`;
      }
      await vscode.env.clipboard.writeText(fullText);
      vscode.window.showInformationMessage("Full context and prompt copied to clipboard.");
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
  
  public async requestUserInput(question: string, signal: AbortSignal): Promise<string> {
      return new Promise((resolve, reject) => {
          this._inputResolver = resolve;
          
          this.addMessageToDiscussion({
              id: 'agent_request_' + Date.now(),
              role: 'assistant',
              content: question,
              model: this._currentDiscussion?.model || this._lollmsAPI.getModelName()
          });
          
          this.updateGeneratingState();

          const disposable = signal.addEventListener('abort', () => {
              if (this._inputResolver === resolve) {
                  this._inputResolver = null;
                  reject(new Error("Input request aborted."));
              }
          });
      });
  }


  public async sendMessage(message: ChatMessage, autoContextMode: boolean = false) {
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

    if (this._inputResolver) {
        const text = (typeof message.content === 'string') ? message.content : "User provided input.";
        const resolver = this._inputResolver;
        this._inputResolver = null;
        await this.addMessageToDiscussion(message);
        resolver(text);
        return;
    }

    if (this._discussionCapabilities.agentMode && !this.agentManager.getIsActive()) {
        this.agentManager.toggleAgentMode();
    } else if (!this._discussionCapabilities.agentMode && this.agentManager.getIsActive()) {
        this.agentManager.toggleAgentMode();
    }

    await this.addMessageToDiscussion(message);

    // --- AUTO TITLE GENERATION ---
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    const isUntitled = !this._currentDiscussion?.title || 
                       this._currentDiscussion.title === 'New Discussion' || 
                       this._currentDiscussion.title.toLocaleLowerCase().startsWith('new discussion') ||
                       this._currentDiscussion.title.toLocaleLowerCase().startsWith('nouvelle discussion');

    if (config.get<boolean>('autoGenerateTitle') && 
        this._currentDiscussion && 
        !this._currentDiscussion.id.startsWith('temp-') && 
        isUntitled) {
        
        const userMessages = this._currentDiscussion.messages.filter(m => m.role === 'user');
        // Only generate title on the first user message to avoid redundant API calls
        if (userMessages.length === 1) {
            setTimeout(() => {
                if (this._isDisposed || !this._currentDiscussion || !this.processManager) return;
                
                // Register title generation as a process for the UI overlay
                const { id: titleProcId } = this.processManager.register(this.discussionId, vscode.l10n.t("Generating discussion title..."));
                this.updateGeneratingState();

                this._discussionManager.generateDiscussionTitle(this._currentDiscussion).then(newTitle => {
                    this.processManager.unregister(titleProcId);
                    this.updateGeneratingState();

                    if (newTitle && this._currentDiscussion && !this._isDisposed) {
                        this._currentDiscussion.title = newTitle;
                        this._panel.title = newTitle;
                        this._discussionManager.saveDiscussion(this._currentDiscussion);
                        
                        // Internal refresh of the data provider
                        vscode.commands.executeCommand('lollms-vs-coder.refreshDiscussions');
                        // Force VS Code to repaint the specific tree view
                        vscode.commands.executeCommand('workbench.action.refreshTreeView', 'lollmsDiscussionsView');
                    }
                }).catch(e => this.log(`Auto-title generation failed: ${e.message}`, 'WARN'));
            }, 2000); 
        }
    }

    if (this.agentManager && this.agentManager.getIsActive()) {
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
             await this.agentManager.handleUserMessage(
                 typeof message.content === 'string' ? message.content : "User Input", 
                 this._currentDiscussion, 
                 vscode.workspace.workspaceFolders[0]
             );
        } else {
             this.addMessageToDiscussion({ role: 'system', content: "Agent requires an active workspace folder." });
        }
        return;
    }

    const { id: processId, controller } = this.processManager.register(this.discussionId, 'Generating response...');
    this.updateGeneratingState();

    const isAutoContext = this._discussionCapabilities.autoContextMode || autoContextMode;

    // --- AUTO SKILL SELECTION ---
    if (this._discussionCapabilities.autoSkillMode) {
        const model = this._currentDiscussion.model || this._lollmsAPI.getModelName();
        const userPromptText = (typeof message.content === 'string') ? message.content : "User request";
        const autoSkillMsgId = 'auto_skill_agent_' + Date.now();

        try {
            await this.addMessageToDiscussion({
                id: autoSkillMsgId,
                role: 'system',
                content: `**💡 Auto-Skill Agent**\n*Analyzing relevant skills...*\n\n`,
                skipInPrompt: true 
            });

            const newSkills = await this._contextManager.runSkillSelectionAgent(
                userPromptText, 
                model, 
                controller.signal, 
                this._currentDiscussion.importedSkills || [],
                (log) => {
                    if (!this._isDisposed) {
                        this._panel.webview.postMessage({ command: 'updateMessage', messageId: autoSkillMsgId, newContent: log });
                    }
                }
            );
            
            if (this._currentDiscussion && JSON.stringify(newSkills) !== JSON.stringify(this._currentDiscussion.importedSkills)) {
                this._currentDiscussion.importedSkills = newSkills;
                if (!this._currentDiscussion.id.startsWith('temp-')) {
                    await this._discussionManager.saveDiscussion(this._currentDiscussion);
                }
                this.updateContextAndTokens();
                await this.updateMessageContent(autoSkillMsgId, `**💡 Auto-Skill Agent**\n*Optimized context with ${newSkills.length} active skills.*`);
            } else {
                // If no changes, we can either keep the log or update it to be very subtle
                await this.updateMessageContent(autoSkillMsgId, `**💡 Auto-Skill Agent**\n*Current skills are already optimal for this request.*`);
            }
        } catch (e) {
            this.log("Auto-skill failed", 'WARN');
            await this.updateMessageContent(autoSkillMsgId, `**💡 Auto-Skill Agent**\n*Analysis skipped or failed.*`);
        }
    }

    if (isAutoContext) {
        this.log("Auto-Context mode active. Starting agent loop.");
        const model = this._currentDiscussion.model || this._lollmsAPI.getModelName();
        const userPromptText = (typeof message.content === 'string') ? message.content : "User request with attachments";
        const contextAgentMsgId = 'ctx_agent_' + Date.now();
        await this.addMessageToDiscussion({
            id: contextAgentMsgId, role: 'system', content: `**🧠 Auto-Context Agent**\n*Analyzing project structure...*\n\n`, skipInPrompt: true 
        });
        try {
            await this._contextManager.runContextAgent(userPromptText, model, controller.signal, (newContent) => {
                if (!this._isDisposed) this._panel.webview.postMessage({ command: 'updateMessage', messageId: contextAgentMsgId, newContent });
            });
        } catch (e: any) { this.log(`Auto-Context failed: ${e.message}`, 'ERROR'); }
    }

    // --- WEB RESEARCH AGENT ---
    if (this._discussionCapabilities.webSearch) {
        this.log("Web Search active. Starting research agent.");
        const model = this._currentDiscussion.model || this._lollmsAPI.getModelName();
        const userPromptText = (typeof message.content === 'string') ? message.content : "User request";
        const webAgentMsgId = 'web_agent_' + Date.now();
        
        await this.addMessageToDiscussion({
            id: webAgentMsgId, 
            role: 'system', 
            content: `**🌍 Web Research Agent**\n*Checking if external info is needed...*\n\n`, 
            skipInPrompt: true 
        });

        try {
            await this._contextManager.runWebResearchAgent(
                userPromptText, 
                model, 
                controller.signal, 
                (newContent) => {
                    if (!this._isDisposed) this._panel.webview.postMessage({ command: 'updateMessage', messageId: webAgentMsgId, newContent });
                },
                (overlayStatus) => {
                    if (!this._isDisposed && this.processManager) {
                        this.processManager.updateDescription(processId, overlayStatus);
                        this.updateGeneratingState();
                    }
                }
            );
            
            // Refresh tokens/context after files might have been added
            this.updateContextAndTokens();
            
        } catch (e: any) { 
            this.log(`Web Research failed: ${e.message}`, 'ERROR');
        }
    }

    const importedIds = this._currentDiscussion?.importedSkills || [];
    const contextData = await this._contextManager.getContextContent({ importedSkillIds: importedIds });
    const context = { tree: contextData.projectTree, files: contextData.selectedFilesContent, skills: contextData.skillsContent };

    if (this._discussionCapabilities.herdMode && this.herdManager) {
        let preParticipants = this._discussionCapabilities.herdPreAnswerParticipants;
        let postParticipants = this._discussionCapabilities.herdPostAnswerParticipants;
        const leaderModel = this._currentDiscussion.model || this._lollmsAPI.getModelName();
        const dynamicMode = config.get<boolean>('herdDynamicMode') || false;
        
        if (dynamicMode) {
             const modelPool = config.get<any[]>('herdDynamicModelPool') || [];
             if (modelPool.length > 0) {
                 const herdMessageId = 'herd_plan_' + Date.now();
                 await this.addMessageToDiscussion({ id: herdMessageId, role: 'system', content: `### 🐂  Recruiting Agents...\n\n`, skipInPrompt: true });
                 const plan = await this.herdManager.planDynamicHerd(typeof message.content === 'string' ? message.content : "Task", modelPool, leaderModel, controller.signal);
                 if (plan) {
                     preParticipants = plan.pre;
                     postParticipants = plan.post;
                     await this.updateMessageContent(herdMessageId, `### ✨  Herd Assembled\n\n**Pre-Code:** ${plan.pre.map(p => p.name).join(', ')}\n**Post-Code:** ${plan.post.map(p => p.name).join(', ')}`);
                 }
             }
        }

        try {
            const promptText = typeof message.content === 'string' ? message.content : 'User rich content.';
            const herdMessageId = 'herd_log_' + Date.now();
            await this.addMessageToDiscussion({ id: herdMessageId, role: 'system', content: `### 🐂 Herd Mode Initializing...\n\n`, skipInPrompt: true });
            const synthesisResult = await this.herdManager.run(promptText, preParticipants, postParticipants, this._discussionCapabilities.herdRounds || 2, leaderModel, contextData.text, (status) => {
                this._panel.webview.postMessage({ command: 'updateStatus', status });
            }, async (newContent) => { await this.updateMessageContent(herdMessageId, newContent); }, controller.signal, this._currentDiscussion.messages );

            if (!controller.signal.aborted && synthesisResult) {
                const systemPrompt = await getProcessedSystemPrompt('chat', this._discussionCapabilities);
                const assistantMessageId = 'assistant_' + Date.now().toString();
                this._panel.webview.postMessage({ command: 'addMessage', message: { id: assistantMessageId, role: 'assistant', content: '', startTime: Date.now(), model: leaderModel } });
                let fullResponse = '';
                await this._lollmsAPI.sendChat([{ role: 'system', content: systemPrompt }, ...this._currentDiscussion.messages.filter(m => !m.skipInPrompt), { role: 'user', content: synthesisResult }], (chunk) => {
                    fullResponse += chunk;
                    this._panel.webview.postMessage({ command: 'appendMessageChunk', id: assistantMessageId, chunk });
                }, controller.signal, leaderModel);
                await this.addMessageToDiscussion({ id: assistantMessageId, role: 'assistant', content: fullResponse, model: leaderModel }, false);
                this._panel.webview.postMessage({ command: 'finalizeMessage', id: assistantMessageId, fullContent: fullResponse });
            }
        } catch (error: any) { if (error.name !== 'AbortError') this.addMessageToDiscussion({ role: 'system', content: `Herd Error: ${error.message}` }); }
        finally { this.processManager.unregister(processId); this.updateGeneratingState(); this.updateContextAndTokens(); }
        return; 
    }

    try {
        const personaContent = this.getCurrentPersonaSystemPrompt();
        const forceFullCode = config.get<boolean>('forceFullCodePath') || false;
        const systemPrompt = await getProcessedSystemPrompt('chat', this._discussionCapabilities, personaContent, undefined, forceFullCode, context);
        
        const profiles = config.get<ResponseProfile[]>('responseProfiles') || [];
        const activeProfileId = this._discussionCapabilities.responseProfileId || config.get<string>('defaultResponseProfileId') || 'balanced';
        const activeProfile = profiles.find(p => p.id === activeProfileId) || profiles[0];

        let messagesToSend: ChatMessage[] = [{ role: 'system', content: systemPrompt }];
        // Create a shallow copy of the history to avoid mutating the original discussion messages
        const history = this._currentDiscussion.messages
            .filter(m => !m.skipInPrompt)
            .map(m => ({ ...m }));
        
        // Turn reinforcement (Added only to the copy sent to API)
        if (history.length > 0 && activeProfile && activeProfile.id !== 'silent') {
            const lastUserMsg = history[history.length - 1];
            if (lastUserMsg.role === 'user' && typeof lastUserMsg.content === 'string') {
                lastUserMsg.content += `\n\n(Reminder: Please follow the ${activeProfile.name} response style precisely.)`;
            }
        }

        // Reinforce Response Style for long conversations to prevent persona drift (Added only to the copy sent to API)
        if (history.length > 2 && activeProfile && activeProfile.id !== 'silent') {
            const lastUserMsg = history[history.length - 1];
            if (lastUserMsg.role === 'user' && typeof lastUserMsg.content === 'string') {
                lastUserMsg.content += `\n\n(Style Reminder: You are currently in ${activeProfile.name} mode. Please ensure your response follows the required structure and tone.)`;
            }
        }

        messagesToSend = [...messagesToSend, ...history];
        const assistantMessageId = 'assistant_' + Date.now().toString() + Math.random().toString(36).substring(2);
        const generationSession: ActiveGeneration = {
            messageId: assistantMessageId, 
            buffer: '', 
            model: this._currentDiscussion.model || this._lollmsAPI.getModelName(),
            startTime: Date.now(), 
            tokenCount: 0, // Explicit initialization
            listeners: new Set(), 
            onComplete: new Set()
        };
        
        const panelListener = (chunk: string) => { if (!this._isDisposed && this._panel.webview) this._panel.webview.postMessage({ command: 'appendMessageChunk', id: assistantMessageId, chunk }); };
        generationSession.listeners.add(panelListener);
        ChatPanel.activeGenerations.set(this.discussionId, generationSession);
        
        if (!this._isDisposed) this._panel.webview.postMessage({ command: 'addMessage', message: { id: assistantMessageId, role: 'assistant', content: '', startTime: Date.now(), model: generationSession.model } });

        let fullResponse = '';
        await this._lollmsAPI.sendChat(messagesToSend, (chunk) => {
            fullResponse += chunk;
            generationSession.buffer += chunk;
            generationSession.tokenCount++;
            
            // Update metrics in real-time
            const elapsed = (Date.now() - generationSession.startTime) / 1000;
            const tps = (generationSession.tokenCount / elapsed).toFixed(1);
            
            this._panel.webview.postMessage({
                command: 'updateGenerationMetrics',
                tps: tps,
                count: generationSession.tokenCount
            });

            generationSession.listeners.forEach(listener => listener(chunk));
        }, controller.signal, this._currentDiscussion.model);

        const processedResponse = await this.verifyAndProcessCodeBlocks(assistantMessageId, fullResponse, controller.signal);

        const elapsed = (Date.now() - generationSession.startTime) / 1000;
        const finalTps = (generationSession.tokenCount / elapsed).toFixed(1);

        const assistantMessage: ChatMessage = { id: assistantMessageId, role: 'assistant', content: processedResponse, model: generationSession.model };
        await this.addMessageToDiscussion(assistantMessage, false);
        if (!this._isDisposed) {
            this._panel.webview.postMessage({ 
                command: 'finalizeMessage', 
                id: assistantMessageId, 
                fullContent: processedResponse,
                tps: finalTps
            });
        }

    } catch (error: any) { if (error.name !== 'AbortError') this.addMessageToDiscussion({ role: 'system', content: `**Error:** ${error.message}` }); }
    finally { ChatPanel.activeGenerations.delete(this.discussionId); this.processManager.unregister(processId); this.updateGeneratingState(); this.updateContextAndTokens(); }
  }

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
      const userPrompt = `Review the following ${args.language} code for bugs, security vulnerabilities, and logic errors. Provide a detailed report.\n\n\`\`\`${args.language}\n${args.code}\n\`\`\`\n\n`;

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
          id: 'execution_result_' + Date.now() + Math.random().toString(36).substring(2),
          role: 'user',
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

      const importedIds = this._currentDiscussion?.importedSkills || [];
      const contextData = await this._contextManager.getContextContent({ importedSkillIds: importedIds });
      const context = {
          tree: contextData.projectTree,
          files: contextData.selectedFilesContent,
          skills: contextData.skillsContent
      };
      
      const personaContent = this.getCurrentPersonaSystemPrompt();
      const systemPrompt = await getProcessedSystemPrompt('chat', this._discussionCapabilities, personaContent, undefined, false, context);
      
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

          const messages: ChatMessage[] = [
              { role: 'system', content: systemPrompt },
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
                this._viewReadyResolver();
                if (this._isLoadPending) {
                    this.loadDiscussion();
                }
                return;
            case 'showError':
                vscode.window.showErrorMessage(message.message);
                break;
            case 'sendMessage':
                const userMsg = message.message;
                if (!userMsg.id) {
                    userMsg.id = 'user_' + Date.now() + Math.random().toString(36).substring(2);
                }
                await this.sendMessage(userMsg, message.autoContext);
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
                vscode.commands.executeCommand('lollms-vs-coder.replaceCode', message.filePath, message.content, this, message.messageId);
                break;
            case 'deleteCodeBlock':
                vscode.commands.executeCommand('lollms-vs-coder.deleteCodeBlock', message.filePath, message.content);
                break;
            case 'addFilesToContext':
                const blockId = message.blockId;
                const files = message.files as string[];
                const results: { [key: string]: boolean } = {};
                if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
                    vscode.window.showErrorMessage("No active workspace to add files from.");
                    files.forEach(f => results[f] = false);
                    webview.postMessage({
                        command: 'filesAddedToContext',
                        results: results,
                        blockId: blockId
                    });
                    return;
                }
                const activeWorkspace = vscode.workspace.workspaceFolders[0];
                try {
                    const validFiles: string[] = [];
                    for (const filePath of files) {
                        try {
                            const uri = vscode.Uri.joinPath(activeWorkspace.uri, filePath);
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
                    this.updateContextAndTokens();
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
            case 'requestAddFileToContext':
                const uris = await vscode.window.showOpenDialog({
                    canSelectMany: true,
                    openLabel: 'Add to Context'
                });
                if (uris && uris.length > 0) {
                    const paths = uris.map(u => vscode.workspace.asRelativePath(u));
                    await vscode.commands.executeCommand('lollms-vs-coder.addFilesToContext', paths);
                    this.updateContextAndTokens();
                }
                break;
            case 'requestAddUrlToContext':
                const url = await vscode.window.showInputBox({ 
                    prompt: "Enter URL to scrape and add to context",
                    placeHolder: "https://example.com/article" 
                });
                if (url) {
                    let language = 'en';
                    if (url.includes('youtube.com') || url.includes('youtu.be')) {
                        const langChoice = await vscode.window.showInputBox({
                            prompt: "YouTube detected. Enter transcript language code (e.g. 'en', 'fr', 'es')",
                            value: "en"
                        });
                        if (langChoice === undefined) return; // User cancelled
                        language = langChoice || 'en';
                    }

                    try {
                        const loadingMsgId = 'system_url_loading_' + Date.now();
                        await this.addMessageToDiscussion({
                             id: loadingMsgId,
                             role: 'system', 
                             content: `🌐 Scraping content from: ${url}...`
                        });
                        
                        // We use the context manager to process and save the URL content
                        const result = await this._contextManager.processUrl(url, language);
                        
                        await this.updateMessageContent(loadingMsgId, `✅ **URL Added to Context:** ${url}\nSaved as: \`${result.filename}\`\n\nPreview:\n> ${result.summary}`);
                        
                        // It automatically adds to context, so we refresh tokens
                        this.updateContextAndTokens();
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to add URL: ${e.message}`);
                    }
                }
                break;
            case 'removeFileFromContext':
                if (this._contextManager && vscode.workspace.workspaceFolders) {
                    const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, message.path);
                    await this._contextManager.getContextStateProvider()?.setStateForUris([uri], 'tree-only');
                    this.updateContextAndTokens();
                }
                break;
            case 'openFile':
                if (vscode.workspace.workspaceFolders) {
                    const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, message.path);
                    try {
                        const doc = await vscode.workspace.openTextDocument(uri);
                        await vscode.window.showTextDocument(doc);
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Could not open file: ${e.message}`);
                    }
                }
                break;
            case 'removeSkillFromContext':
                if (this._currentDiscussion && this._currentDiscussion.importedSkills) {
                    this._currentDiscussion.importedSkills = this._currentDiscussion.importedSkills.filter(id => id !== message.skillId);
                    
                    // Also remove from project if it was added globally
                    await this._contextManager.removeSkillFromProject(message.skillId);

                    if (!this._currentDiscussion.id.startsWith('temp-')) {
                        await this._discussionManager.saveDiscussion(this._currentDiscussion);
                    }
                    this.updateContextAndTokens();
                }
                break;
            case 'summarizeContextFile':
                await this.handleSummarizeContextFile(message.path);
                break;
            case 'bulkSummarizeContextFiles':
                await this.handleBulkSummarizeContextFiles(message.files, message.instruction);
                break;
            case 'bulkDeleteContextFiles':
                await this.handleBulkDeleteContextFiles(message.files);
                break;
            case 'bulkRemoveSkills':
                await this.handleBulkRemoveSkills(message.skillIds);
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
                this.updateContextAndTokens();
                break;
            case 'stopTokenCalculation':
                if (this._tokenAbortController) {
                    this._tokenAbortController.abort();
                    this._tokenAbortController = null;
                }
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
                } else if (command === 'saveContext') {
                    vscode.commands.executeCommand('lollms-vs-coder.saveContextSelection');
                } else if (command === 'loadContext') {
                    vscode.commands.executeCommand('lollms-vs-coder.loadContextSelection');
                } else if (command === 'lollms-vs-coder.createGitBranch') {
                    vscode.commands.executeCommand('lollms-vs-coder.createGitBranch', params);
                } else if (command === 'lollms-vs-coder.mergeGitBranch') {
                    vscode.commands.executeCommand('lollms-vs-coder.mergeGitBranch', params);
                } else if (command === 'lollms-vs-coder.switchGitBranch') {
                    vscode.commands.executeCommand('lollms-vs-coder.switchGitBranch', params);
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

                    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                        this.agentManager.run(objective, this._currentDiscussion!, vscode.workspace.workspaceFolders[0], this._currentDiscussion?.model);
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
                this._panel.webview.postMessage({ command: 'updateDiscussionCapabilities', capabilities: this._discussionCapabilities });
                break;
            case 'toggleAutoContext': 
                this._discussionCapabilities.autoContextMode = message.enabled;
                this.saveCapabilities();
                this._panel.webview.postMessage({ command: 'updateDiscussionCapabilities', capabilities: this._discussionCapabilities });
                break;
            case 'runAgent':
                if (!this._currentDiscussion) {
                    vscode.window.showErrorMessage("No active discussion.");
                    this.updateGeneratingState();
                    return;
                }
                if (message.message) await this.addMessageToDiscussion(message.message);
                if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                    await this.agentManager.handleUserMessage(
                        message.objective, 
                        this._currentDiscussion, 
                        vscode.workspace.workspaceFolders[0]
                    );
                } else {
                    this.addMessageToDiscussion({ role: 'system', content: 'Agent requires an active workspace folder.' });
                    this.updateGeneratingState();
                }
                break;
            case 'retryAgentTask':
                this.agentManager?.retryFailedTask(parseInt(message.taskId, 10));
                break;
            case 'loadFile':
                const { name: fileName2, content: fileContent2, isImage: isImage2 } = message.file;
                await this._handleFileAttachment(fileName2, fileContent2, isImage2);
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
                        const size = (message.width && message.height) ? `${message.width}x${message.height}` : undefined;
                        const b64_json = await this._lollmsAPI.generateImage(message.prompt, { size }, token);
                        if (token.isCancellationRequested) {
                            webview.postMessage({ command: 'imageGenerationResult', buttonId: message.buttonId, success: false });
                            return;
                        }
                        
                        let saveUri: vscode.Uri | undefined;
                        
                        if (message.filePath && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                            saveUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, message.filePath);
                        } else {
                            saveUri = await vscode.window.showSaveDialog({
                                title: 'Save Generated Image',
                                filters: { 'Images': ['png'] },
                                defaultUri: (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'generated_image.png') : undefined
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
            case 'saveGeneratedSkill':
                const { name, description, content, category, scope } = message.skillData;
                // Generate a unique ID based on the name and timestamp
                const id = (name || 'skill').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Date.now();
                
                await this._skillsManager.addSkill({
                    id,
                    name, 
                    description, 
                    content,
                    category: category || '',
                    language: 'markdown',
                    scope: scope 
                });
                vscode.window.showInformationMessage(vscode.l10n.t("Skill '{0}' saved to {1} library.", name, scope));
                vscode.commands.executeCommand('lollms-vs-coder.refreshSkills'); 
                break;
            case 'importSkills':
                await this.handleImportSkills();
                break;
            case 'importSelectedSkills':
                const skillIds = message.skillIds;
                // Allow empty arrays to proceed so we can "uncheck" and remove everything
                if (!Array.isArray(skillIds)) {
                    return;
                }
                
                const allSkills = await this._skillsManager.getSkills();
                
                const choice = await vscode.window.showQuickPick(
                    [
                        { label: "Current Discussion Only", detail: "Synchronize skills for this chat. (Project-wide skills are unaffected)" },
                        { label: "Entire Project (Persistent)", detail: "Synchronize skills for the whole workspace." }
                    ],
                    { placeHolder: `Where should these skill changes be applied?` }
                );

                if (choice) {
                    const isProjectWide = choice.label.startsWith("Entire");
                    
                    // Collect all IDs that were present in the UI (so we know what was unchecked)
                    const uiAvailableIds = allSkills.map(s => s.id);

                    if (isProjectWide) {
                        for (const skillId of uiAvailableIds) {
                            if (skillIds.includes(skillId)) {
                                await this._contextManager.addSkillToProject(skillId);
                            } else {
                                await this._contextManager.removeSkillFromProject(skillId);
                                // Also remove from discussion if it was there
                                if (this._currentDiscussion?.importedSkills) {
                                    this._currentDiscussion.importedSkills = this._currentDiscussion.importedSkills.filter(id => id !== skillId);
                                }
                            }
                        }
                        vscode.window.showInformationMessage(`Project skills synchronized.`);
                    } else {
                        // Discussion Scope
                        if (this._currentDiscussion) {
                            this._currentDiscussion.importedSkills = skillIds;
                            
                            // CRITICAL: If it was unchecked in the modal, 
                            // we MUST remove it from Project Context too, or it will remain active.
                            for (const skillId of uiAvailableIds) {
                                if (!skillIds.includes(skillId)) {
                                    await this._contextManager.removeSkillFromProject(skillId);
                                }
                            }
                            vscode.window.showInformationMessage(`Discussion skills synchronized.`);
                        }
                    }

                    if (this._currentDiscussion && !this._currentDiscussion.id.startsWith('temp-')) {
                        await this._discussionManager.saveDiscussion(this._currentDiscussion);
                    }
                    
                    this.updateContextAndTokens();
                }
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
                    
                    if (partial.agentMode !== undefined) {
                        if (partial.agentMode && !this.agentManager.getIsActive()) {
                            this.agentManager.toggleAgentMode();
                        } else if (!partial.agentMode && this.agentManager.getIsActive()) {
                            this.agentManager.toggleAgentMode();
                        }
                    }
                    
                    // If Web Search is enabled, ensure relevant tools are enabled if Agent is active
                    if (partial.webSearch !== undefined && this.agentManager) {
                        if (partial.webSearch) {
                            // Enable default search tools
                            const tools = this.agentManager.getEnabledTools().map(t => t.name);
                            if (!tools.includes('search_web')) tools.push('search_web');
                            if (!tools.includes('search_wikipedia')) tools.push('search_wikipedia');
                            this.agentManager.setEnabledTools(tools);
                        }
                    }

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
            case 'openGitWorkflowMenu':
                const branch = this._currentDiscussion?.gitState?.tempBranch || 'current';
                const items: vscode.QuickPickItem[] = [
                    { 
                        label: `$(git-branch) New Branch for Discussion`, 
                        description: 'Create a new feature branch for this chat context',
                        detail: 'lollms-vs-coder.createGitBranch'
                    },
                    { 
                        label: `$(git-merge) Fuse Branch into Main`, 
                        description: `Merge ${branch} back into original branch`,
                        detail: 'lollms-vs-coder.mergeGitBranch' 
                    }
                ];
                
                vscode.window.showQuickPick(items, { placeHolder: 'Git Workflow Actions' }).then(selected => {
                    if (selected && selected.detail) {
                        if (selected.detail === 'lollms-vs-coder.createGitBranch') {
                            vscode.commands.executeCommand('lollms-vs-coder.createGitBranch');
                        } else if (selected.detail === 'lollms-vs-coder.mergeGitBranch') {
                            vscode.commands.executeCommand('lollms-vs-coder.mergeGitBranch');
                        }
                    }
                });
                break;

            case 'requestGitStatus':
                if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                    const status = await this._gitIntegration.getGitStatus(vscode.workspace.workspaceFolders[0]);
                    this._panel.webview.postMessage({ command: 'updateGitStatus', status });
                } else {
                    vscode.window.showErrorMessage("No workspace open.");
                }
                break;

            case 'stageAndGenerateMessage':
                if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                    const files = message.files;
                    const folder = vscode.workspace.workspaceFolders[0];
                    
                    try {
                        await this._gitIntegration.stageFiles(folder, files);
                        
                        await vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: "Generating commit message..."
                        }, async () => {
                            const msg = await this._gitIntegration.generateCommitMessage(folder);
                            this._panel.webview.postMessage({ command: 'setCommitMessage', message: msg });
                        });

                    } catch (e: any) {
                        vscode.window.showErrorMessage("Error processing commit preparation: " + e.message);
                    }
                }
                break;

            case 'requestCommitMessage':
                if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                    this.log('Generating commit message...');
                    try {
                        const msg = await this._gitIntegration.generateCommitMessage(vscode.workspace.workspaceFolders[0]);
                        this._panel.webview.postMessage({ command: 'setCommitMessage', message: msg });
                    } catch (e: any) {
                        vscode.window.showErrorMessage("Failed to generate commit message: " + e.message);
                    }
                } else {
                    vscode.window.showErrorMessage("No workspace open.");
                }
                break;
            case 'requestCommitStaging':
                if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                    try {
                        const status = await this._gitIntegration.getGitStatus(vscode.workspace.workspaceFolders[0]);
                        if (status.staged.length === 0 && status.unstaged.length === 0 && status.untracked.length === 0) {
                            vscode.window.showInformationMessage("No changes found in git repository.");
                            return;
                        }
                        this._panel.webview.postMessage({ command: 'showStagingModal', status });
                    } catch (e: any) {
                        vscode.window.showErrorMessage("Failed to get git status: " + e.message);
                    }
                } else {
                    vscode.window.showErrorMessage("No active workspace.");
                }
                break;
            case 'performCommit':
                if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                    try {
                        await this._gitIntegration.commitWithMessage(message.message, vscode.workspace.workspaceFolders[0]);
                        vscode.window.showInformationMessage("Commit successful.");
                    } catch (e: any) {
                         vscode.window.showErrorMessage("Commit failed: " + e.message);
                    }
                }
                break;
            case 'requestGitHistory':
                if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                    try {
                        const folder = vscode.workspace.workspaceFolders[0];
                        const commits = await this._gitIntegration.getCommitHistory(folder);
                        const currentHash = await this._gitIntegration.getCurrentHash(folder);
                        this._panel.webview.postMessage({ command: 'showGitHistory', commits, currentHash });
                    } catch (e: any) {
                        vscode.window.showErrorMessage("Failed to fetch history: " + e.message);
                    }
                }
                break;
            case 'performRevert':
                 if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                    try {
                        await this._gitIntegration.checkout(vscode.workspace.workspaceFolders[0], message.hash);
                        vscode.window.showInformationMessage(`Checked out ${message.hash}`);
                        this.sendGitBranchState(vscode.workspace.workspaceFolders[0]);
                    } catch(e: any) {
                        vscode.window.showErrorMessage(e.message);
                    }
                }
                break;
            case 'requestViewFullContext':
                if (this._contextManager) {
                    const ctx = this._contextManager.getLastContext();
                    if (ctx && ctx.text) {
                        InfoPanel.createOrShow(this._extensionUri, "Current AI Context", ctx.text);
                    } else {
                        vscode.window.showInformationMessage("No context loaded yet.");
                    }
                }
                break;
            case 'internetHelpSearch':
                // Execute ONLY the web research agent loop. 
                // This populates the project context with external info without generating a chat reply.
                if (this._isDisposed || !this.processManager) { break; }
                const { id: webProcId, controller: webCtrl } = this.processManager.register(this.discussionId, 'Running Web Research...');
                this.updateGeneratingState();
                try {
                    const model = this._currentDiscussion?.model || this._lollmsAPI.getModelName();
                    const query = message.query || "Latest information related to current context";
                    const webAgentMsgId = 'web_agent_manual_' + Date.now();
                    
                    await this.addMessageToDiscussion({
                        id: webAgentMsgId, 
                        role: 'system', 
                        content: `**🌍 Web Research Agent (Manual)**\n*Researching: "${query}"...*\n\n`, 
                        skipInPrompt: true 
                    });

                    await this._contextManager.runWebResearchAgent(query, model, webCtrl.signal, (newContent) => {
                        if (!this._isDisposed) {
                            this._panel.webview.postMessage({ command: 'updateMessage', messageId: webAgentMsgId, newContent });
                        }
                    });
                    
                    this.updateContextAndTokens();
                } catch (e: any) {
                    if (e.name !== 'AbortError') {
                        this.log(`Web Research failed: ${e.message}`, 'ERROR');
                    }
                } finally {
                    this.processManager.unregister(webProcId);
                    this.updateGeneratingState();
                }
                break;
            case 'runAutoSkill':
                if (this._isDisposed || !this.processManager) { break; }
                const { id: skillProcId, controller: skillCtrl } = this.processManager.register(this.discussionId, 'Optimizing Skills...');
                this.updateGeneratingState();
                try {
                    const model = this._currentDiscussion?.model || this._lollmsAPI.getModelName();
                    const prompt = message.prompt || "Update skills for current discussion";
                    const skillLogId = 'skill_refresh_' + Date.now();
                    
                    await this.addMessageToDiscussion({
                        id: skillLogId, 
                        role: 'system', 
                        content: `**💡 Auto-Skill Agent (Manual)**\n*Analyzing relevant skills...*\n\n`, 
                        skipInPrompt: true 
                    });

                    const newSkills = await this._contextManager.runSkillSelectionAgent(
                        prompt, 
                        model, 
                        skillCtrl.signal, 
                        this._currentDiscussion?.importedSkills || [],
                        (log) => {
                            if (!this._isDisposed) {
                                this._panel.webview.postMessage({ command: 'updateMessage', messageId: skillLogId, newContent: log });
                            }
                        }
                    );
                    
                    if (this._currentDiscussion && JSON.stringify(newSkills) !== JSON.stringify(this._currentDiscussion.importedSkills)) {
                        this._currentDiscussion.importedSkills = newSkills;
                        if (!this._currentDiscussion.id.startsWith('temp-')) {
                            await this._discussionManager.saveDiscussion(this._currentDiscussion);
                        }
                        this.updateContextAndTokens();
                        await this.updateMessageContent(skillLogId, `**💡 Auto-Skill Agent (Manual)**\n*Update complete. ${newSkills.length} skills active.*`);
                    } else {
                        await this.updateMessageContent(skillLogId, `**💡 Auto-Skill Agent (Manual)**\n*No changes needed. Context is optimal.*`);
                    }
                } catch (e: any) {
                    if (e.name !== 'AbortError') {
                        this.log(`Auto-Skill refresh failed: ${e.message}`, 'ERROR');
                    }
                } finally {
                    this.processManager.unregister(skillProcId);
                    this.updateGeneratingState();
                }
                break;
        }
    });
  }
  
  public async handleBulkSummarizeContextFiles(files: string[], instruction: string) {
      if (!vscode.workspace.workspaceFolders || files.length === 0) return;
      
      const processor = new BigDataProcessor(this._lollmsAPI);
      const workspaceFolder = vscode.workspace.workspaceFolders[0];

      await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: `Bulk processing files...`,
          cancellable: true
      }, async (progress, token) => {
          let processedCount = 0;
          for (let i = 0; i < files.length; i++) {
              if (token.isCancellationRequested) break;
              
              const relativePath = files[i];
              const uri = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);
              
              progress.report({ 
                  message: `Processing (${i + 1}/${files.length}): ${path.basename(relativePath)}`
              });

              try {
                  const result = await processor.processFile(uri, instruction, undefined, token);
                  if (result) {
                      await vscode.workspace.fs.writeFile(uri, Buffer.from(result, 'utf8'));
                      processedCount++;
                  }
              } catch (e: any) {
                  console.error(`Failed to process ${relativePath}: ${e.message}`);
                  vscode.window.showWarningMessage(`Failed to process ${relativePath}: ${e.message}`);
              }
          }
          
          this.updateContextAndTokens();
          if (processedCount > 0) {
              vscode.window.showInformationMessage(`Bulk processing complete. Updated ${processedCount} files.`);
          }
      });
  }

  public async handleBulkRemoveSkills(skillIds: string[]) {
      if (!this._currentDiscussion || !skillIds || skillIds.length === 0) return;

      const confirm = await vscode.window.showWarningMessage(
          vscode.l10n.t("prompt.confirmBulkRemoveSkills", skillIds.length),
          { modal: true },
          vscode.l10n.t("label.removeAll")
      );

      if (confirm === vscode.l10n.t("label.removeAll")) {
          this._currentDiscussion.importedSkills = (this._currentDiscussion.importedSkills || [])
              .filter(id => !skillIds.includes(id));

          // Also remove from project global context if applicable
          for (const id of skillIds) {
              await this._contextManager.removeSkillFromProject(id);
          }

          if (!this._currentDiscussion.id.startsWith('temp-')) {
              await this._discussionManager.saveDiscussion(this._currentDiscussion);
          }
          
          this.updateContextAndTokens();
          vscode.window.showInformationMessage(vscode.l10n.t("info.bulkRemoveSkillsSuccess", skillIds.length));
      }
  }

  public async handleBulkDeleteContextFiles(files: string[]) {
      if (!vscode.workspace.workspaceFolders || files.length === 0) return;
      const workspaceFolder = vscode.workspace.workspaceFolders[0];

      const confirm = await vscode.window.showWarningMessage(
          vscode.l10n.t("prompt.confirmBulkDeleteFiles", files.length),
          { modal: true },
          vscode.l10n.t("label.deleteAll")
      );

      if (confirm === vscode.l10n.t("label.deleteAll")) {
          try {
              for (const relativePath of files) {
                  const uri = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);
                  await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
              }
              vscode.window.showInformationMessage(vscode.l10n.t("info.bulkDeleteFilesSuccess", files.length));
              this.updateContextAndTokens();
          } catch (e: any) {
              vscode.window.showErrorMessage(vscode.l10n.t("error.bulkDeleteFailed", e.message));
          }
      }
  }

  public async handleSummarizeContextFile(relativePath: string) {
      if (!vscode.workspace.workspaceFolders) return;
      const workspaceFolder = vscode.workspace.workspaceFolders[0];
      const uri = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);

      const instruction = await vscode.window.showInputBox({
          prompt: `How should I process ${relativePath}?`,
          value: "Summarize this document and extract key insights.",
          placeHolder: "e.g., Clean up this transcript, Summarize into bullet points, Extract JSON data..."
      });

      if (!instruction) return;

      const processor = new BigDataProcessor(this._lollmsAPI);
      
      await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: `Processing ${path.basename(relativePath)}...`,
          cancellable: true
      }, async (progress, token) => {
          try {
              const result = await processor.processFile(uri, instruction, progress, token);
              if (result) {
                  // Replace file content
                  await vscode.workspace.fs.writeFile(uri, Buffer.from(result, 'utf8'));
                  vscode.window.showInformationMessage(`Successfully processed ${relativePath}. Content updated.`);
                  
                  // Refresh context
                  this.updateContextAndTokens();
              }
          } catch (e: any) {
              if (!token.isCancellationRequested) {
                  vscode.window.showErrorMessage(`Processing failed: ${e.message}`);
              }
          }
      });
  }

  private async _getHtmlForWebview(webview: vscode.Webview): Promise<string> {
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
        tooltipRefreshContext: vscode.l10n.t("tooltip.refreshContext"),
        labelApply: vscode.l10n.t("label.apply"),
        labelCancel: vscode.l10n.t("label.cancel"),
        labelSave: vscode.l10n.t("label.save")
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
        
        <div class="chat-content-wrapper">
            <div class="chat-main-column">
                <div class="messages" id="messages">
                    <div class="search-bar" id="search-bar" style="display: none;">
                        <input type="text" id="searchInput" placeholder="Search discussion...">
                        <span id="search-results-count"></span>
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
                            <button id="add-user-message-btn"><i class="codicon codicon-add"></i> Add User Message</button>
                            <button id="add-ai-message-btn"><i class="codicon codicon-add"></i> Add AI Message</button>
                        </div>
                    </div>
                </div>

                <div id="generating-overlay" class="generating-overlay" style="display: none;">
                    <div class="generating-content">
                        <div class="spinner"></div>
                        <div class="generating-details">
                            <span id="generating-status-text">Generating...</span>
                            <div id="generating-metrics" class="generating-metrics" style="display: none;">
                                <span id="metrics-tps">0.0</span> tokens/sec
                            </div>
                        </div>
                    </div>
                    <button id="stopButton" class="stop-btn-red">Stop Generation</button>
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
                                <span>💡 Auto Skill</span>
                                <label class="switch"><input type="checkbox" id="autoSkillCheckbox"><span class="slider"></span></label>
                            </div>
                            <div class="menu-item-toggle">
                                <span>🐂 Herd Mode</span>
                                <label class="switch"><input type="checkbox" id="herdModeCheckbox"><span class="slider"></span></label>
                            </div>
                        </div>

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
                        </div>

                        <div id="websearch-indicator" class="websearch-indicator" title="Web Search Active" style="display: none;">
                            <i class="codicon codicon-globe"></i>
                            <span>Web</span>
                        </div>
                        
                        <div id="active-tools-indicator" class="active-tools-indicator"></div>
                        
                        <div id="context-loading-spinner" style="display: none; align-items: center; gap: 8px; font-size: 0.9em; color: var(--vscode-descriptionForeground);">
                            <div class="spinner"></div>
                            <span id="loading-files-text"></span>
                        </div>
                    </div>
                    <div class="input-area-container">
                        <div class="rich-input-toolbar">
                            <button class="toolbar-tool" data-wrap-type="python" title="Wrap in Python Block"><i class="codicon codicon-symbol-method"></i><span>Python</span></button>
                            <button class="toolbar-tool" data-wrap-type="code" title="Wrap in Code Block"><i class="codicon codicon-code"></i><span>Code</span></button>
                            <button class="toolbar-tool" data-wrap-type="text" title="Wrap in Plain Text"><i class="codicon codicon-text-size"></i><span>Text</span></button>
                            <div class="toolbar-separator"></div>
                            <button class="toolbar-tool" data-wrap-type="bold" title="Bold"><i class="codicon codicon-bold"></i></button>
                            <button class="toolbar-tool" data-wrap-type="italic" title="Italic"><i class="codicon codicon-italic"></i></button>
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
                </div>
            </div>

            <div id="plan-resizer"></div>
            <div id="agent-plan-zone"></div>
        </div>
        
        <button id="scrollToBottomBtn" title="Scroll to bottom" style="display: none;">
            <i class="codicon codicon-arrow-down"></i>
        </button>

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

        <div id="staging-modal" class="modal">
            <div class="modal-content">
                <div class="modal-header">
                    <h2>Stage Files for Commit</h2>
                    <span class="close-btn" id="staging-close-btn">&times;</span>
                </div>
                <div class="modal-body" id="staging-list">
                </div>
                <div class="modal-footer">
                    <button id="staging-next-btn">Next (Generate Message)</button>
                </div>
            </div>
        </div>

        <div id="commit-modal" class="modal">
            <div class="modal-content">
                <div class="modal-header">
                    <h2>Commit Changes</h2>
                    <span class="close-btn" id="commit-cancel-btn">&times;</span>
                </div>
                <div class="modal-body">
                    <textarea id="commit-message-input" class="commit-textarea" placeholder="Generating commit message..."></textarea>
                </div>
                <div class="modal-footer">
                    <button id="commit-confirm-btn">Commit</button>
                </div>
            </div>
        </div>

        <div id="history-modal" class="modal">
            <div class="modal-content">
                <div class="modal-header">
                    <h2>Git History</h2>
                    <span class="close-btn" id="history-close-btn">&times;</span>
                </div>
                <div class="modal-body" id="history-list">
                </div>
            </div>
        </div>

        <div id="skills-modal" class="modal">
            <div class="modal-content">
                <div class="modal-header">
                    <h2>Apply Skills to Context</h2>
                    <span class="close-btn" id="skills-close-btn">&times;</span>
                </div>
                <div class="modal-body" id="skills-tree-container">
                    <!-- Tree generated dynamically -->
                </div>
                <div class="modal-footer">
                    <button id="skills-import-btn">Apply Selected</button>
                </div>
            </div>
        </div>

        <div id="discussion-tools-modal" class="modal">
            <div class="modal-content">
                <div class="modal-header">
                    <h2>Advanced Discussion Tools</h2>
                    <span class="close-btn" id="close-discussion-tools-modal">&times;</span>
                </div>
                <div class="modal-body">
                    
                    <div class="modal-section">
                        <h3>Logic & Reasoning</h3>
                        <div class="form-group">
                            <label for="cap-thinkingMode">Reasoning Strategy</label>
                            <select id="cap-thinkingMode" class="menu-select" style="width: 100%; margin: 0;">
                                <option value="none">None (Standard)</option>
                                <option value="chain_of_thought">Chain of Thought</option>
                                <option value="chain_of_verification">Chain of Verification</option>
                                <option value="plan_and_solve">Plan and Solve</option>
                                <option value="self_critique">Self Critique</option>
                                <option value="no_think">No Think (Force Disable)</option>
                            </select>
                        </div>
                        
                        <div class="checkbox-container" style="margin-top:12px;">
                            <label class="switch"><input type="checkbox" id="cap-herdMode"><span class="slider"></span></label>
                            <label for="cap-herdMode"><strong>🐂 Herd Mode:</strong> Multiple agents brainstorm the answer.</label>
                        </div>
                        <div id="herd-config-section" style="display:none; margin: 8px 0 0 40px;">
                            <label style="font-size:11px;">Debate Rounds: <input type="number" id="cap-herdRounds" min="1" max="10" style="width:40px; padding:2px;"></label>
                        </div>
                    </div>

                    <div class="modal-section">
                        <h3>Code Generation Strategy</h3>
                        <div class="checkbox-container">
                            <label class="switch"><input type="checkbox" id="cap-forceFullCode"><span class="slider"></span></label>
                            <label for="cap-forceFullCode"><strong>Force Full Code</strong> (Disable partial updates)</label>
                        </div>
                        
                        <div id="partial-strategy-container" style="margin-top:12px; padding-left: 10px; border-left: 2px solid var(--vscode-widget-border);">
                            <label style="font-size:11px; font-weight:bold; display:block; margin-bottom:4px;">Preferred Partial Update Format</label>
                            <div class="radio-group">
                                <label class="radio-option"><input type="radio" name="cap-partialFormat" value="aider" checked> Aider (Robust Search/Replace)</label>
                                <label class="radio-option"><input type="radio" name="cap-partialFormat" value="diff"> Unified Diff (.patch)</label>
                            </div>
                            <div class="checkbox-container" style="border:none; background:transparent; padding:0; margin-top:8px;">
                                <label class="switch" style="width:24px; height:14px;"><input type="checkbox" id="cap-allowFullFallback" checked><span class="slider"></span></label>
                                <label for="cap-allowFullFallback" style="font-size:11px; opacity:0.8;">Allow full-file fallback for large changes</label>
                            </div>
                        </div>

                        <div class="checkbox-container" style="margin-top:12px;">
                            <label class="switch"><input type="checkbox" id="cap-explainCode" checked><span class="slider"></span></label>
                            <label for="cap-explainCode">AI explains changes (Problem/Hypothesis/Fix)</label>
                        </div>
                    </div>

                    <div class="modal-section">
                        <h3>Response Instructions</h3>
                        <div class="checkbox-container">
                            <label class="switch"><input type="checkbox" id="cap-addPedagogicalInstruction"><span class="slider"></span></label>
                            <label for="cap-addPedagogicalInstruction">Add Pedagogical Context</label>
                        </div>
                        <div class="checkbox-container">
                            <label class="switch"><input type="checkbox" id="cap-forceFullCodePath"><span class="slider"></span></label>
                            <label for="cap-forceFullCodePath">Strict <code>\`\`\`lang:path</code> blocks</label>
                        </div>
                    </div>

                    <div class="modal-section">
                        <h3>Allowed UI Actions</h3>
                        <div class="checkbox-grid">
                            <div class="checkbox-container">
                                <label class="switch"><input type="checkbox" id="fmt-fullFile" checked><span class="slider"></span></label>
                                <label for="fmt-fullFile">Full File (Apply)</label>
                            </div>
                            <div class="checkbox-container">
                                <label class="switch"><input type="checkbox" id="fmt-insert" checked><span class="slider"></span></label>
                                <label for="fmt-insert">Insert Snippet</label>
                            </div>
                            <div class="checkbox-container">
                                <label class="switch"><input type="checkbox" id="fmt-replace" checked><span class="slider"></span></label>
                                <label for="fmt-replace">Replace Snippet</label>
                            </div>
                            <div class="checkbox-container">
                                <label class="switch"><input type="checkbox" id="fmt-delete" checked><span class="slider"></span></label>
                                <label for="fmt-delete">Delete Code</label>
                            </div>
                        </div>
                    </div>

                    <div class="modal-section">
                        <h3>Search & Web Tools</h3>
                        <div class="checkbox-container">
                            <label class="switch"><input type="checkbox" id="cap-webSearch"><span class="slider"></span></label>
                            <label for="cap-webSearch"><strong>Enable Web Search Agent</strong></label>
                        </div>
                        <div class="checkbox-container">
                            <label class="switch"><input type="checkbox" id="cap-searchInCacheFirst"><span class="slider"></span></label>
                            <label for="cap-searchInCacheFirst">Search in local cache first (.lollms)</label>
                        </div>
                        <div class="checkbox-container">
                            <label class="switch"><input type="checkbox" id="cap-distillWebResults"><span class="slider"></span></label>
                            <label for="cap-distillWebResults">Distill/Refactor web results using AI</label>
                        </div>
                        <div class="checkbox-container" style="margin-bottom: 10px; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 10px;">
                            <label class="switch"><input type="checkbox" id="cap-antiPromptInjection"><span class="slider"></span></label>
                            <label for="cap-antiPromptInjection">Anti-Prompt Injection cleaning</label>
                        </div>
                        <div style="font-size: 11px; margin-bottom: 8px; opacity: 0.8;">Active Sources:</div>
                        <div class="checkbox-grid" id="search-sources-grid">
                            <div class="checkbox-container">
                                <input type="checkbox" id="src-google" data-source="google">
                                <label for="src-google">Google (Custom)</label>
                            </div>
                            <div class="checkbox-container">
                                <input type="checkbox" id="src-arxiv" data-source="arxiv">
                                <label for="src-arxiv">ArXiv (Papers)</label>
                            </div>
                            <div class="checkbox-container">
                                <input type="checkbox" id="src-wikipedia" data-source="wikipedia">
                                <label for="src-wikipedia">Wikipedia</label>
                            </div>
                            <div class="checkbox-container">
                                <input type="checkbox" id="src-stackoverflow" data-source="stackoverflow">
                                <label for="src-stackoverflow">StackOverflow</label>
                            </div>
                            <div class="checkbox-container">
                                <input type="checkbox" id="src-youtube" data-source="youtube">
                                <label for="src-youtube">YouTube (Transcripts)</label>
                            </div>
                            <div class="checkbox-container">
                                <input type="checkbox" id="src-github" data-source="github">
                                <label for="src-github">GitHub (Search)</label>
                            </div>
                        </div>
                    </div>

                    <div class="modal-section">
                        <h3>Agent Permissions</h3>
                        <div class="checkbox-grid">
                            <div class="checkbox-container">
                                <label class="switch"><input type="checkbox" id="cap-imageGen" checked><span class="slider"></span></label>
                                <label for="cap-imageGen">Image Gen</label>
                            </div>
                            <div class="checkbox-container" id="cap-gitWorkflowContainer">
                                <label class="switch"><input type="checkbox" id="cap-gitWorkflow"><span class="slider"></span></label>
                                <label for="cap-gitWorkflow">Git Workflow</label>
                            </div>
                        </div>
                    </div>

                    <div class="modal-section">
                        <h3>File Operations</h3>
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
                                <label for="cap-fileSelect">Context Selection</label>
                            </div>
                            <div class="checkbox-container">
                                <label class="switch"><input type="checkbox" id="cap-fileReset" checked><span class="slider"></span></label>
                                <label for="cap-fileReset">Context Reset</label>
                            </div>
                        </div>
                    </div>

                    <div class="modal-section" style="border:none;">
                        <h3>Misc</h3>
                        <div class="checkbox-container">
                            <label class="switch"><input type="checkbox" id="mode-funMode"><span class="slider"></span></label>
                            <label for="mode-funMode">Fun Mode 🤪</label>
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button id="save-discussion-tools-btn" class="code-action-btn apply-btn" style="width:100px; justify-content:center;">Apply</button>
                </div>
            </div>
        </div>
        
        <div id="token-counting-overlay" class="token-counting-overlay" style="display: none;">
            <div class="spinner"></div>
            <span>Counting tokens...</span>
        </div>

        <div id="bulk-process-modal" class="modal">
            <div class="modal-content">
                <div class="modal-header">
                    <h2>Bulk Big Data Processing</h2>
                    <span class="close-btn" id="bulk-process-close-btn">&times;</span>
                </div>
                <div class="modal-body">
                    <p style="font-size: 12px; opacity: 0.8; margin-bottom: 12px;">Select files to process and enter your instructions. Each file will be processed and updated.</p>
                    <div class="checkbox-container" style="margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--vscode-widget-border);">
                        <input type="checkbox" id="bulk-process-select-all" checked>
                        <label for="bulk-process-select-all" style="font-weight: bold; font-size: 11px; cursor: pointer;">Select / Deselect All</label>
                    </div>
                    <div id="bulk-files-list" style="max-height: 200px; overflow-y: auto; border: 1px solid var(--vscode-widget-border); padding: 8px; border-radius: 4px; margin-bottom: 15px;">
                        <!-- List of checkboxes injected here -->
                    </div>
                    <label for="bulk-process-prompt">Instructions</label>
                    <textarea id="bulk-process-prompt" class="commit-textarea" style="height: 100px;" placeholder="e.g. Summarize this document and extract key insights."></textarea>
                </div>
                <div class="modal-footer">
                    <button id="bulk-process-run-btn" class="code-action-btn apply-btn" style="width: 100%; justify-content: center;">Start Bulk Processing</button>
                </div>
            </div>
        </div>

        <div id="bulk-delete-modal" class="modal">
            <div class="modal-content">
                <div class="modal-header">
                    <h2>Bulk Delete Files</h2>
                    <span class="close-btn" id="bulk-delete-close-btn">&times;</span>
                </div>
                <div class="modal-body">
                    <p style="font-size: 12px; opacity: 0.8; margin-bottom: 12px; color: var(--vscode-errorForeground);">Warning: This will permanently delete the selected files from your workspace.</p>
                    <div class="checkbox-container" style="margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--vscode-widget-border);">
                        <input type="checkbox" id="bulk-delete-select-all" checked>
                        <label for="bulk-delete-select-all" style="font-weight: bold; font-size: 11px; cursor: pointer;">Select / Deselect All</label>
                    </div>
                    <div id="bulk-delete-files-list" style="max-height: 250px; overflow-y: auto; border: 1px solid var(--vscode-widget-border); padding: 8px; border-radius: 4px; margin-bottom: 15px;">
                        <!-- List of checkboxes injected here -->
                    </div>
                </div>
                <div class="modal-footer">
                    <button id="bulk-delete-run-btn" class="code-action-btn delete-btn" style="width: 100%; justify-content: center;">Delete Selected Files</button>
                </div>
            </div>
        </div>

        <div id="bulk-delete-skills-modal" class="modal">
            <div class="modal-content">
                <div class="modal-header">
                    <h2>Bulk Remove Skills</h2>
                    <span class="close-btn" id="bulk-delete-skills-close-btn">&times;</span>
                </div>
                <div class="modal-body">
                    <p style="font-size: 12px; opacity: 0.8; margin-bottom: 12px;">Select skills to remove from the current context.</p>
                    <div class="checkbox-container" style="margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--vscode-widget-border);">
                        <input type="checkbox" id="bulk-skills-select-all" checked>
                        <label for="bulk-skills-select-all" style="font-weight: bold; font-size: 11px; cursor: pointer;">Select / Deselect All</label>
                    </div>
                    <div id="bulk-delete-skills-list" style="max-height: 250px; overflow-y: auto; border: 1px solid var(--vscode-widget-border); padding: 8px; border-radius: 4px; margin-bottom: 15px;">
                        <!-- List of checkboxes injected here -->
                    </div>
                </div>
                <div class="modal-footer">
                    <button id="bulk-delete-skills-run-btn" class="code-action-btn delete-btn" style="width: 100%; justify-content: center;">Remove Selected Skills</button>
                </div>
            </div>
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
