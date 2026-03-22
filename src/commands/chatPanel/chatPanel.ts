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
import { AutomationPanel } from '../../panels/automationPanel';
import { LocalizationManager } from '../../utils/localizationManager';

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

  // Track active listeners to prevent duplication
  private _activeGenerationListener?: (chunk: string) => void;
  private _activeGenerationCompleteListener?: (fullContent: string) => void;

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
  
private async executeAutomationPipeline(content: string, messageId: string, signal: AbortSignal, processId: string) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;

    // 1. Auto Branching
    if (this._discussionCapabilities.autoBranch) {
        this.processManager.updateDescription(processId, "Creating git branch...");
        await vscode.commands.executeCommand('lollms-vs-coder.createGitBranch', { 
            branch: `autofix-${Date.now()}` 
        });
    }

    // 2. Extraction & Application
    const aiderRegex = /^<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/gm;
    const blockRegex = /```(\w+):([^\n\s]+)[\r\n]+([\s\S]+?)[\r\n]+```/g;
    let match;
    const modifiedFiles = new Set<string>();

    while ((match = blockRegex.exec(content)) !== null) {
        const filePath = match[2];
        const blockContent = match[3];
        modifiedFiles.add(filePath);

        this.processManager.updateDescription(processId, `Applying updates to ${path.basename(filePath)}...`);
        
        const opts = { silent: true };
        if (blockContent.includes('<<<<<<< SEARCH')) {
            await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', filePath, blockContent, this, messageId, opts);
        } else {
            await vscode.commands.executeCommand('lollms-vs-coder.applyFileContent', filePath, blockContent, opts);
        }
    }

    // 3. Auto Fix Loop
    if (this._discussionCapabilities.autoFix && modifiedFiles.size > 0) {
        const urisToFix = Array.from(modifiedFiles).map(fp => vscode.Uri.joinPath(workspaceFolder.uri, fp));
        await this.repairFilesIteratively(urisToFix, signal, processId, messageId);
    }
}
    public updateGeneratingState() {
        if (this._isDisposed || !this.processManager) return;

        if (this._panel.webview) {
            const process = this.processManager.getForDiscussion(this.discussionId);
            const activeGen = ChatPanel.activeGenerations.get(this.discussionId);

            // Identify processes that should not trigger the UI-blocking overlay
            // We removed "scanning", "analyz", and "optimiz" because the Librarian
            // uses these and we WANT to see the Stop button while it works.
            const desc = process?.description || "";
            const isBackgroundProcess = 
                desc.toLowerCase().includes("title") || 
                desc.toLowerCase().includes("counting") || 
                desc.toLowerCase().includes("cleaning");
            
            // We show the overlay if there is a real process ID registered (and it's not background)
            // or if a standard LLM generation is currently streaming.
            const isGenerating = ((process && !isBackgroundProcess) || !!activeGen) && !this._inputResolver;
            
            let statusText = vscode.l10n.t("Lollms is thinking...");
            
            // Prioritize the real-time process description for better transparency
            if (process) {
                statusText = process.description;
            } else if (activeGen) {
                statusText = vscode.l10n.t("Generating response...");
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

    // SHOW SPINNER IMMEDIATELY
    this._panel.webview.postMessage({ command: 'setGeneratingState', isGenerating: true, statusText: 'Loading conversation...' });

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
          const includedFiles = this._contextManager.getContextStateProvider()?.getIncludedFiles().map(f => f.path) || [];
          const projectSkills = await this._contextManager.getActiveProjectSkills();
          const discussionSkills = this._currentDiscussion.importedSkills || [];
          
          // Merge metadata for immediate display
          const allSkillIds = Array.from(new Set([...projectSkills, ...discussionSkills]));

          if (cachedContext) {
              const contextTextToSend = cachedContext.text.length > 50000 
                  ? `# Context Hidden (Too Large for Preview)\n\nThe full context (${cachedContext.text.length} chars) is loaded in backend memory for AI usage, but is hidden from this preview to improve UI performance.`
                  : cachedContext.text;

            this._panel.webview.postMessage({ 
                command: 'updateContext', 
                context: contextTextToSend,
                files: includedFiles,
                skills: cachedContext.importedSkills || [],
                diagrams: cachedContext.diagrams || []
            });
            this._panel.webview.postMessage({ command: 'updateImageContext', images: cachedContext.images });
          } else {
              // NO CACHE: Send minimal metadata immediately so the header appears right away
              this._panel.webview.postMessage({ 
                command: 'updateContext', 
                context: '', 
                files: includedFiles,
                // Create skeleton skill objects so the count is correct
                skills: allSkillIds.map(id => ({ id, name: '...' })),
                diagrams: this._currentDiscussion.activeDiagrams?.map(type => ({ type, mermaid: '' })) || []
            });
          }
      }

      // Optimization: Send messages in a single batch but ensure the UI doesn't block
      const safeMessages = Array.isArray(this._currentDiscussion.messages) ? this._currentDiscussion.messages : [];
      
      // Use a slightly faster serialization path for large histories
      this._panel.webview.postMessage({ 
          command: 'loadDiscussion', 
          messages: safeMessages,
          isInspectorEnabled: isInspectorEnabled,
          appliedState: this._currentDiscussion.appliedState || {}
      });
      
      const activeGen = ChatPanel.activeGenerations.get(this.discussionId);
      if (activeGen) {
          this.log(`Reconnecting to active generation for ${this.discussionId}`);
          
          // Re-inject the partial message into the UI (since loadDiscussion wipes UI state)
          const tempMsg: ChatMessage = {
              id: activeGen.messageId,
              role: 'assistant',
              content: activeGen.buffer,
              model: activeGen.model,
              startTime: activeGen.startTime
          };
          this._panel.webview.postMessage({ command: 'addMessage', message: tempMsg });
          
          // Only attach new listeners if we haven't already attached them for this panel instance
          if (!this._activeGenerationListener || !activeGen.listeners.has(this._activeGenerationListener)) {
              this.log("Attaching new listeners for active generation");

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
                      
                      // Cleanup
                      this._activeGenerationListener = undefined;
                      this._activeGenerationCompleteListener = undefined;
                  }
              };

              this._activeGenerationListener = listener;
              this._activeGenerationCompleteListener = completionListener;

              activeGen.listeners.add(listener);
              activeGen.onComplete.add(completionListener);
          } else {
              this.log("Listeners already attached for this panel, skipping.");
          }
          
          this.updateGeneratingState();
      }

      // Merge System Profiles with User Profiles for the UI
      const { SYSTEM_RESPONSE_PROFILES } = require('../../utils');
      const userProfiles = (Array.isArray(profiles) ? profiles : []).filter((p: any) => p && p.id);
      const allProfiles = [...SYSTEM_RESPONSE_PROFILES, ...userProfiles.filter((p: any) => !SYSTEM_RESPONSE_PROFILES.some((sp: any) => sp.id === p.id))];

      this._panel.webview.postMessage({ 
          command: 'updateDiscussionCapabilities', 
          capabilities: this._discussionCapabilities,
          profiles: allProfiles
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
            const activeDiagrams = this._currentDiscussion?.activeDiagrams || [];
            
            const modelForTokenization = this._currentDiscussion?.model || this._lollmsAPI.getModelName();
            const context = await this._contextManager.getContextContent({ 
                signal, 
                importedSkillIds: importedIds,
                activeDiagramIds: activeDiagrams,
                modelName: modelForTokenization,
                onProgress: (pct) => {
                    if (!this._isDisposed) {
                        this._panel.webview.postMessage({ command: 'tokenCalculationProgress', progress: pct });
                    }
                }
            });
            
            if (signal.aborted) {
                this.log("Token calculation aborted.");
                return;
            }

            this.log(`Context content fetched. Length: ${context.text.length} chars`);

            if (this._isDisposed) return;

            const includedFiles = this._contextManager.getContextStateProvider()?.getIncludedFiles().map(f => f.path) || [];
            
            // Aggressive truncation for Webview UI to prevent IPC Channel Closure
            const UI_PREVIEW_LIMIT = 10000; 
            const contextTextForUI = context.text.length > UI_PREVIEW_LIMIT
                ? context.text.substring(0, UI_PREVIEW_LIMIT) + `\n\n... [Truncated for UI performance. Total: ${context.text.length} chars]`
                : context.text;

            if (!this._isDisposed && this._panel.webview) {
                this._panel.webview.postMessage({ 
                    command: 'updateContext', 
                    context: contextTextForUI,
                    files: includedFiles,
                    skills: context.importedSkills || [],
                    diagrams: context.diagrams || []
                });
            }
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
            ]).catch(err => {
                this.log(`Tokenization Promise failed: ${err.message}`, 'ERROR');
                return [null, null];
            });
            
            if (this._isDisposed || signal.aborted || !tokenizeResponse || !contextSizeResponse) return;

            let ctxSize = contextSizeResponse.context_size || 0;
            const isApproximate = tokenizeResponse.isEstimation || contextSizeResponse.isEstimation;

            if (this._panel && this._panel.webview) {
                this._panel.webview.postMessage({
                    command: 'updateTokenProgress',
                    totalTokens: tokenizeResponse.count,
                    contextSize: ctxSize,
                    isApproximate: isApproximate
                });
            }
            
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
                const failsafeSize = config.get<number>('failsafeContextSize') || 128000;

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

  private async saveCapabilities(isGlobalDefault: boolean = false) {
      if (this._currentDiscussion && !this._currentDiscussion.id.startsWith('temp-')) {
          this._currentDiscussion.capabilities = this._discussionCapabilities;
          await this._discussionManager.saveDiscussion(this._currentDiscussion);
      }
      
      // ONLY update global defaults if explicitly requested (e.g. from Settings)
      // Chat badges should only affect the CURRENT discussion.
      if (isGlobalDefault) {
          await this._discussionManager.saveLastCapabilities(this._discussionCapabilities);
      }
  }

  public async handleManualAutoContext(userPrompt: string) {
      if (this._isDisposed || !this.processManager || !this._currentDiscussion) return;
      
      if (this._discussionCapabilities.disableProjectContext) {
          vscode.window.showWarningMessage("Auto-Context cannot run while Project Context is muted.");
          return;
      }
    
      const { id: processId, controller } = this.processManager.register(this.discussionId, 'Librarian: Optimizing context...');
      // Force UI state update to hide input and show Stop button
      this.updateGeneratingState();
      try {
          const model = this._currentDiscussion.model || this._lollmsAPI.getModelName();
          let objective = userPrompt.trim();
          
          if (!objective) {
              objective = "Analyze project structure to populate context with relevant code for the current task.";
          }

          const contextAgentMsgId = 'ctx_agent_manual_' + Date.now();
          await this.addMessageToDiscussion({
              id: contextAgentMsgId,
              role: 'system',
              content: `**🧠 Auto-Context Agent (Manual)**\n*Objective: "${objective}"*\n\n`,
              skipInPrompt: true 
          });

          const result = await this._contextManager.runContextAgent(
                objective, 
                model, 
                controller.signal,
                (newContent) => {
                    if (!this._isDisposed) this._panel.webview.postMessage({ command: 'updateMessage', messageId: contextAgentMsgId, newContent: newContent });
                },
                (status) => {
                    if (!this._isDisposed && this.processManager) {
                        this.processManager.updateDescription(processId, status);
                        this.updateGeneratingState();
                    }
                },
                undefined,
                'selection_only',
                this._currentDiscussion.messages
            );

            if (result.analysis) {
                const header = `### 🧠 MANUAL CONTEXT ANALYSIS\n`;
                this._currentDiscussion.discussion_data_zone = (this._currentDiscussion.discussion_data_zone || "") + `\n${header}${result.analysis}\n`;
                
                // Persistence check
                if (!this._currentDiscussion.id.startsWith('temp-')) {
                    await this._discussionManager.saveDiscussion(this._currentDiscussion);
                }
            }

            // Sync context UI but PRESERVE the original prompt
            // The user may want to review selected files before sending
            this.updateContextAndTokens();
            // Note: Intentionally NOT clearing the input - user might want to edit or send after review

      } catch (e: any) {
          if (e.name !== 'AbortError' && e.message !== 'AbortError') {
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
    // 1. Show the UI immediately with loading state
    this._panel.webview.postMessage({ command: 'showSkillsModal', loading: true });

    // 2. Perform the heavy disk operations asynchronously
    const allSkills = await this._skillsManager.getSkills();
    
    if (allSkills.length === 0) {
        this._panel.webview.postMessage({ command: 'closeSkillsModal' });
        vscode.window.showInformationMessage("No saved skills found.");
        return;
    }

    const projectSkills = await this._contextManager.getActiveProjectSkills();
    const discussionSkills = this._currentDiscussion?.importedSkills || [];
    const activeSkillIds = Array.from(new Set([...projectSkills, ...discussionSkills]));

    const root: any = { id: 'root', label: 'Skills Library', children: [], isSkill: false };
    const globalRoot = { id: 'global-lib', label: 'Global Library', children: [], isSkill: false, isBundle: true };
    const projectRoot = { id: 'project-lib', label: 'Project Library', children: [], isSkill: false, isBundle: true };
    root.children.push(globalRoot, projectRoot);

    allSkills.forEach(skill => {
        const category = skill.category || 'Uncategorized';
        const parts = category.replace(/\\/g, '/').split('/').filter(p => p);
        
        // Route to the correct library branch based on scope
        let current = skill.scope === 'global' ? globalRoot : projectRoot;
        let pathSoFar = skill.scope;
        
        // Build/Navigate Categories within that branch
        parts.forEach(part => {
            pathSoFar = `${pathSoFar}/${part}`;
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
  private async verifyAndProcessCodeBlocks(messageId: string, fullContent: string, signal: AbortSignal, onStatusUpdate?: (status: string) => void): Promise<string> {
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    const shouldVerify = config.get<boolean>('verifyAndCorrectCodeBlocks') ?? false;
    
    if (!shouldVerify) return fullContent;

    const maxRetries = config.get<number>('agentMaxRetries') || 2;
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return fullContent;

    let currentContent = fullContent;
    
    // Detect all partial blocks (Diff/SearchReplace)
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
                // FIX: Use line-anchored markers to avoid confusion with code comments like # =============
                const aiderRegex = /^<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/gm;
                const matches = [...block.content.matchAll(aiderRegex)];
                
                if (matches.length > 0) {
                    let currentFileState = originalFileText;
                    let allSuccess = true;
                    let firstError = "";

                    for (const match of matches) {
                        const searchPart = match[1];
                        const replacePart = match[2];
                        const srResult = applySearchReplace(currentFileState, searchPart, replacePart);
                        
                        if (srResult.success) {
                            currentFileState = srResult.result;
                        } else {
                            allSuccess = false;
                            firstError = srResult.error || "Search block match failed.";
                            break;
                        }
                    }
                    result = { success: allSuccess, result: currentFileState, error: firstError };
                } else {
                    result = { success: false, result: originalFileText, error: "Invalid Search/Replace block format or markers not at start of line." };
                }
            }
            if (result.success) {
                verifiedFullCode = result.result;
                success = true;
            } else {
                retryCount++;
                lastError = result.error || "Unknown error.";
                if (retryCount > maxRetries) break;

                if (onStatusUpdate) {
                    onStatusUpdate(`Applying self-correction to ${path.basename(block.path)} (Attempt ${retryCount}/${maxRetries})...`);
                }

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
      // 1. Show feedback in Chat Panel immediately
      this._panel.webview.postMessage({ command: 'setGeneratingState', isGenerating: true, statusText: 'Assembling full prompt...' });

      // 2. Use VS Code standard progress notification for long-running tasks
      await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: "Lollms: Preparing context for clipboard...",
          cancellable: false
      }, async (progress) => {
          try {
              const config = vscode.workspace.getConfiguration('lollmsVsCoder');
              const forceFullCode = config.get<boolean>('forceFullCodePath') || false;

              const importedIds = this._currentDiscussion?.importedSkills || [];
              
              progress.report({ message: "Extracting file contents..." });
              const contextData = await this._contextManager.getContextContent({ 
                  importedSkillIds: importedIds,
                  modelName: this._currentDiscussion?.model || this._lollmsAPI.getModelName()
              });
              
              const context = {
                  tree: contextData.projectTree,
                  files: contextData.selectedFilesContent,
                  skills: contextData.skillsContent
              };

              progress.report({ message: "Processing system prompt..." });
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

              progress.report({ message: "Writing to clipboard..." });
              await vscode.env.clipboard.writeText(fullText);
              vscode.window.showInformationMessage("✅ Full context and prompt copied to clipboard.");
          } catch (e: any) {
              vscode.window.showErrorMessage(`Failed to copy: ${e.message}`);
          } finally {
              // 3. Dismiss loading states
              this._panel.webview.postMessage({ command: 'setGeneratingState', isGenerating: false });
          }
      });
  }
  
  private async deleteMessage(messageId: string) {
    if (this._currentDiscussion) {
        // 1. Force stop and purge before deletion to prevent ghost states
        ChatPanel.activeGenerations.delete(this.discussionId);
        this.processManager.cancelForDiscussion(this.discussionId);

        this._currentDiscussion.messages = this._currentDiscussion.messages.filter(m => m.id !== messageId);
        
        if (!this._currentDiscussion.id.startsWith('temp-')) {
            await this._discussionManager.saveDiscussion(this._currentDiscussion);
        }

        // 2. Reload UI
        await this.loadDiscussion(); 
        
        // 3. Explicitly signal to the webview that generation has stopped
        this._panel.webview.postMessage({ 
            command: 'setGeneratingState', 
            isGenerating: false 
        });
        this.updateGeneratingState();
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
                
                // Register title generation as a process
                const { id: titleProcId } = this.processManager.register(this.discussionId, vscode.l10n.t("Generating discussion title..."));
                // We DON'T call updateGeneratingState() here to avoid flickering the UI

                this._discussionManager.generateDiscussionTitle(this._currentDiscussion).then(newTitle => {
                    this.processManager.unregister(titleProcId);

                    if (newTitle && this._currentDiscussion && !this._isDisposed) {
                        this._currentDiscussion.title = newTitle;
                        this._panel.title = newTitle;
                        this._discussionManager.saveDiscussion(this._currentDiscussion);
                        
                        // Internal refresh of the data provider
                        vscode.commands.executeCommand('lollms-vs-coder.refreshDiscussions');
                        // Force VS Code to repaint the specific tree view with safety guard
                        vscode.commands.executeCommand('workbench.action.refreshTreeView', 'lollmsDiscussionsView')
                            .then(undefined, () => { /* View might be hidden, ignore */ });
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

    const { id: processId, controller } = this.processManager.register(this.discussionId, 'Preparing request...');
    this.updateGeneratingState();

    // Strictly check if AutoContext is enabled AND not muted
    // CRITICAL: Skip automated agents if the message is a 'system' role.
    // This prevents "Auto-Resume" nudges from triggering a second Librarian run (recursion loop).
    const isAutoContext = (!!this._discussionCapabilities.autoContextMode || autoContextMode) && message.role !== 'system';

    // --- AUTO SKILL SELECTION ---
    if (this._discussionCapabilities.autoSkillMode && !this._discussionCapabilities.disableProjectContext && message.role !== 'system') {
        this.processManager.updateDescription(processId, "Selecting skills...");
        this.updateGeneratingState();

        const model = this._currentDiscussion.model || this._lollmsAPI.getModelName();
        const userPromptText = (typeof message.content === 'string') ? message.content : "User request";
        const autoSkillMsgId = 'auto_skill_agent_' + Date.now();

        try {
            this.processManager.updateDescription(processId, "💡 Selecting skills...");

            // NEW: Add the actual UI bubble immediately so the user sees thoughts in real-time
            await this.addMessageToDiscussion({
                id: autoSkillMsgId,
                role: 'system',
                content: `**💡 Auto-Skill Agent**\n\n*Analyzing request...*`,
                skipInPrompt: true 
            });

            const newSkills = await this._contextManager.runSkillSelectionAgent(
                userPromptText, 
                model, 
                controller.signal, 
                this._currentDiscussion.importedSkills || [],
                (newContent) => {
                    if (!this._isDisposed) {
                        this._panel.webview.postMessage({ 
                            command: 'updateMessage', 
                            messageId: autoSkillMsgId, 
                            newContent: newContent 
                        });
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

    // --- SYNERGY: THE LIBRARIAN MUST FINISH FIRST ---
    let librarianAnalysis = "";
    if (isAutoContext && !this._discussionCapabilities.disableProjectContext) {
        this.processManager.updateDescription(processId, "Librarian is searching...");
        this.updateGeneratingState();

        const model = this._currentDiscussion.model || this._lollmsAPI.getModelName();
        const userPromptText = (typeof message.content === 'string') ? message.content : "User request";
        const contextAgentMsgId = 'ctx_agent_' + Date.now();
        
        await this.addMessageToDiscussion({
            id: contextAgentMsgId, 
            role: 'system', 
            content: `**🧠 Auto-Context Agent**\n*Searching for relevant files...*\n\n`, 
            skipInPrompt: true 
        });

        try {
            // CRITICAL: We block here. The main AI won't start until this returns.
            const result = await this._contextManager.runContextAgent(
                userPromptText, 
                model, 
                controller.signal, 
                (newContent) => {
                    if (!this._isDisposed) this._panel.webview.postMessage({ command: 'updateMessage', messageId: contextAgentMsgId, newContent });
                },
                (status) => {
                    if (!this._isDisposed && this.processManager) {
                        this.processManager.updateDescription(processId, status);
                        this.updateGeneratingState();
                    }
                },
                undefined,
                'collaborative',
                this._currentDiscussion.messages
            );
            
            librarianAnalysis = result.analysis;
            
            if (this._currentDiscussion && result.analysis) {
                const header = `### 🧠 AUTO-CONTEXT ANALYSIS\n`;
                this._currentDiscussion.discussion_data_zone = (this._currentDiscussion.discussion_data_zone || "") + `\n${header}${result.analysis}\n`;
            }
            
            if (!this._isDisposed) {
                await this.updateMessageContent(contextAgentMsgId, `**🧠 Auto-Context Agent**\n\n${librarianAnalysis || "*Analysis complete. Relevant files synchronized.*"}`);
            }
        } catch (e: any) { 
            this.log(`Librarian failed: ${e.message}`, 'ERROR');
        }
    }

    // --- WEB RESEARCH AGENT ---
    if (this._discussionCapabilities.webSearch) {
        this.processManager.updateDescription(processId, "Web Search...");
        this.updateGeneratingState();

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

    this.processManager.updateDescription(processId, "Loading file content...");
    this.updateGeneratingState();

    const importedIds = this._currentDiscussion?.importedSkills || [];

    // Check if context is explicitly disabled for this turn
    const isContextMuted = this._discussionCapabilities.disableProjectContext;

    const activeDiagramIds = this._currentDiscussion?.activeDiagrams || [];
    const diagrams: { type: string, mermaid: string }[] = [];
    
    for (const diagId of activeDiagramIds) {
        const mermaidCode = this.agentManager.codeGraphManager.generateMermaid(diagId);
        diagrams.push({ type: diagId, mermaid: mermaidCode });
    }

    const contextData = await this._contextManager.getContextContent({ 
        importedSkillIds: importedIds,
        includeTree: !isContextMuted,
        modelName: this._currentDiscussion?.model || this._lollmsAPI.getModelName() 
    });

    // Append diagrams to the text sent to the AI
    if (diagrams.length > 0) {
        contextData.text += `\n## Project Architecture Diagrams\n`;
        for (const d of diagrams) {
            contextData.text += `### ${d.type.replace('_', ' ').toUpperCase()}\n\`\`\`mermaid\n${d.mermaid}\n\`\`\`\n\n`;
        }
    }

    const context = { 
        tree: isContextMuted ? "## Project Structure\n(Muted by user for this turn)" : contextData.projectTree, 
        files: isContextMuted ? "## File Contents\n(Muted by user for this turn)" : contextData.selectedFilesContent, 
        skills: contextData.skillsContent 
    };

    const workingMemory = this._currentDiscussion?.discussion_data_zone || "";

    if (this._discussionCapabilities.herdMode && this.herdManager) {
        this.processManager.updateDescription(processId, "🐂 Planning herd...");
        this.updateGeneratingState();

        try {
            const promptText = typeof message.content === 'string' 
                ? message.content : 'User rich content.';
            const herdMessageId = 'herd_log_' + Date.now();

            const orchestrator = this._discussionCapabilities.herdOrchestratorModel 
                || this._currentDiscussion.model 
                || this._lollmsAPI.getModelName();

            const config = vscode.workspace.getConfiguration('lollmsVsCoder');
            const modelPool = config.get<any[]>('herdDynamicModelPool') || [];
            const maxRounds = this._discussionCapabilities.herdRounds || 3;

            await this.addMessageToDiscussion({ 
                id: herdMessageId, 
                role: 'system', 
                content: `### 🐂 Herd Discussion\n\n*Planning team...*`, 
                skipInPrompt: true 
            });

            // Always plan first — this assigns personas to models
            this.processManager.updateDescription(processId, "🐂 Assembling team...");
            const plan = modelPool.length > 0
                ? await this.herdManager.planDynamicHerd(
                    promptText,
                    modelPool,
                    orchestrator,
                    controller.signal,
                    this._discussionCapabilities
                )
                : null;

            // plan is null only if modelPool was empty — use empty arrays and
            // let herdManager's fallback archetypes kick in via buildFallbackHerd.
            // But buildFallbackHerd needs a pool, so if pool is empty we warn.
            if (!plan) {
                await this.updateMessageContent(herdMessageId, 
                    `### 🐂 Herd Discussion\n\n❌ No model pool configured. Add models to \`lollmsVsCoder.herdDynamicModelPool\` in settings.`
                );
                this.processManager.unregister(processId);
                this.updateGeneratingState();
                return;
            }

            this.processManager.updateDescription(processId, "🐂 Herd thinking...");

            const synthesisResult = await this.herdManager.run(
                promptText,
                plan.pre,                   // brainstorming participants (with personas)
                plan.post,                  // review participants (with personas)
                maxRounds,
                orchestrator,
                contextData.text,
                (status: string) => {
                    this.processManager.updateDescription(processId, status);
                    this.updateGeneratingState();
                },
                async (newContent: string) => { 
                    await this.updateMessageContent(herdMessageId, newContent); 
                },
                controller.signal,
                this._currentDiscussion.messages,
                this._discussionCapabilities
            );

            if (!controller.signal.aborted && synthesisResult) {
                const assistantMessageId = 'assistant_' + Date.now().toString();
                await this.addMessageToDiscussion({ 
                    id: assistantMessageId, 
                    role: 'assistant', 
                    content: synthesisResult, 
                    model: orchestrator 
                }, true);

                if (!this._isDisposed) {
                    this._panel.webview.postMessage({ 
                        command: 'finalizeMessage', 
                        id: assistantMessageId, 
                        fullContent: synthesisResult 
                    });
                }
            }
        } catch (error: any) { 
            if (error.name !== 'AbortError') {
                this.addMessageToDiscussion({ 
                    role: 'system', 
                    content: `Herd Error: ${error.message}` 
                }); 
            }
        } finally { 
            this.processManager.unregister(processId); 
            this.updateGeneratingState(); 
            this.updateContextAndTokens(); 
        }
        return;
    }

    let assistantMessageId = '';
    try {
        this.processManager.updateDescription(processId, "Waiting for model...");
        this.updateGeneratingState();

        const personaContent = this.getCurrentPersonaSystemPrompt();
        const forceFullCode = config.get<boolean>('forceFullCodePath') || false;
        // Synergy: Inject librarianAnalysis as workingMemory
        const systemPrompt = await getProcessedSystemPrompt('chat', this._discussionCapabilities, personaContent, undefined, forceFullCode, context, librarianAnalysis || workingMemory);
        
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
        assistantMessageId = 'assistant_' + Date.now().toString() + Math.random().toString(36).substring(2);
        
        const generationSession: ActiveGeneration = {
            messageId: assistantMessageId, 
            buffer: '', 
            model: this._currentDiscussion.model || this._lollmsAPI.getModelName(),
            startTime: Date.now(), 
            tokenCount: 0, // Explicit initialization
            listeners: new Set(), 
            onComplete: new Set()
        };
        
        const panelListener = (chunk: string) => { 
            if (!this._isDisposed && this._panel.webview) {
                this._panel.webview.postMessage({ command: 'appendMessageChunk', id: assistantMessageId, chunk }); 
            }
        };
        
        this._activeGenerationListener = panelListener;
        generationSession.listeners.add(panelListener);
        ChatPanel.activeGenerations.set(this.discussionId, generationSession);
        
        if (!this._isDisposed) this._panel.webview.postMessage({ command: 'addMessage', message: { id: assistantMessageId, role: 'assistant', content: '', startTime: Date.now(), model: generationSession.model } });

        let fullResponse = '';
        let firstTokenReceived = false;

        await this._lollmsAPI.sendChat(messagesToSend, (chunk) => {
            if (!firstTokenReceived) {
                firstTokenReceived = true;
                this.processManager.updateDescription(processId, "Generating response...");
                this.updateGeneratingState();
            }

            // 🧠 THOUGHT NOTIFICATIONS (REAL-TIME)
            // If the model starts thinking using tags, show a preview notification
            if (fullResponse.length === 0 && chunk.includes('<think')) {
                vscode.window.showInformationMessage("🧠 Lollms is contemplating a solution...");
            }

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
        }, controller.signal, this._currentDiscussion.model, { 
            thinking: this._discussionCapabilities.thinkingMode 
        });

        this.processManager.updateDescription(processId, "Verifying generated code...");
        this.updateGeneratingState();
        
        const processedResponse = await this.verifyAndProcessCodeBlocks(
            assistantMessageId, 
            fullResponse, 
            controller.signal,
            (status) => {
                this.processManager.updateDescription(processId, status);
                this.updateGeneratingState();
            }
        );
        // --- CONTEXT EXPANSION (SELF-CORRECTION) ---
        const addFilesRegex = /<add_files>([\s\S]*?)<\/add_files>/i;
        const addFilesMatch = processedResponse.match(addFilesRegex);

        // --- CONTEXT EXPANSION (STOP & WAIT) ---
        if (addFilesMatch && !controller.signal.aborted) {
            // We do nothing here in the backend because the Webview UI already renders 
            // the <add_files> widget with a manual "Add to Context" button.
            // By NOT calling sendMessage here, we respect the "Don't call LLM" rule.
            this.log(`AI issued context expansion request. Waiting for user interaction.`);
        }

        // --- AUTOMATION PIPELINE ---
        if (this._discussionCapabilities.autoApply && !controller.signal.aborted) {
            await this.executeAutomationPipeline(processedResponse, assistantMessageId, controller.signal, processId);
        }

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

    } catch (error: any) { 
        if (error.name === 'AbortError' || error.message === 'AbortError') {
            const session = ChatPanel.activeGenerations.get(this.discussionId);
            // If the user stopped it but NO text was generated yet, remove the empty bubble.
            // Since it hasn't been added to the discussion.messages array yet, 
            // reloading the discussion will clear the optimistic UI state in the webview.
            if (session && (!session.buffer || session.buffer.trim().length === 0)) {
                await this.loadDiscussion(); 
            }
        } else {
            this.addMessageToDiscussion({ role: 'system', content: `**Error:** ${error.message}` }); 
        }
    }
    finally { 
        ChatPanel.activeGenerations.delete(this.discussionId); 
        
        // Clean up listeners
        this._activeGenerationListener = undefined;
        this._activeGenerationCompleteListener = undefined;

        this.processManager.unregister(processId); 
        
        // Reset metrics in the UI
        if (!this._isDisposed) {
            this._panel.webview.postMessage({
                command: 'updateGenerationMetrics',
                tps: "0.0",
                count: 0,
                reset: true
            });
        }

        this.updateGeneratingState(); 
        this.updateContextAndTokens(); 
    }
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
      const contextData = await this._contextManager.getContextContent({ 
          importedSkillIds: importedIds,
          modelName: this._currentDiscussion?.model || this._lollmsAPI.getModelName()
      });
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
  
  public async updateAppliedState(messageId: string, blockIdx: number, hunkIdx?: number) {
      if (!this._currentDiscussion || !messageId) return;
      if (!this._currentDiscussion.appliedState) this._currentDiscussion.appliedState = {};
      if (!this._currentDiscussion.appliedState[messageId]) this._currentDiscussion.appliedState[messageId] = {};
      
      if (!this._currentDiscussion.appliedState[messageId][blockIdx]) {
          this._currentDiscussion.appliedState[messageId][blockIdx] = [];
      }

      if (hunkIdx !== undefined) {
          if (!this._currentDiscussion.appliedState[messageId][blockIdx].includes(hunkIdx)) {
              this._currentDiscussion.appliedState[messageId][blockIdx].push(hunkIdx);
          }
      } else {
          // Mark whole block (all hunks or full file) as applied
          this._currentDiscussion.appliedState[messageId][blockIdx] = [-1]; 
      }

      if (!this._currentDiscussion.id.startsWith('temp-')) {
          await this._discussionManager.saveDiscussion(this._currentDiscussion);
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
      
      const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Date.now();
      
      await this._skillsManager.addSkill({ 
          id,
          name, 
          description, 
          content,
          scope: 'local',
          language: 'markdown' 
      });

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
            case 'copySystemPrompt':
                await this.copySystemPromptToClipboard();
                break;
            case 'copyTreeAndContent':
                vscode.commands.executeCommand('lollms-vs-coder.copyTreeAndContent');
                break;
            case 'verifyAllChanges':
                {
                    const results: any = await vscode.commands.executeCommand('lollms-vs-coder.verifyHunks', message.changes);
                    webview.postMessage({
                        command: 'verifyAllResult',
                        messageId: message.messageId,
                        results: results
                    });
                }
                break;
            case 'applyAllChanges':
                {
                    const changesBatch = message.changes;
                    const messageId = message.messageId;
                    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                    if (!workspaceFolder) break;

                    const { id: applyProcId, controller: applyCtrl } = this.processManager.register(this.discussionId, `Applying ${changesBatch.length} changes...`);
                    
                    await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: `Lollms: Bulk Apply (${changesBatch.length} files)`,
                        cancellable: true
                    }, async (progress, token) => {
                        token.onCancellationRequested(() => applyCtrl.abort());

                        let count = 0;
                        const total = changesBatch.length;

                        for (let i = 0; i < total; i++) {
                            if (token.isCancellationRequested || applyCtrl.signal.aborted) break;

                            const change = changesBatch[i];
                            const fileName = path.basename(change.path);
                            count++;

                            // Update the UI Overlay with granular details
                            const hunkInfo = change.hunkIndex !== undefined ? ` (Hunk ${change.hunkIndex + 1})` : "";
                            this.processManager.updateDescription(applyProcId, `Applying [${count}/${total}]: ${fileName}${hunkInfo}`);
                            this.updateGeneratingState();

                            // IDEMPOTENCY CHECK
                            const currentApplied = this._currentDiscussion?.appliedState?.[messageId]?.[change.blockIndex] || [];
                            if (currentApplied.includes(-1) || (change.hunkIndex !== undefined && currentApplied.includes(change.hunkIndex))) {
                                this._panel.webview.postMessage({
                                    command: 'applyAllResult',
                                    messageId: messageId,
                                    filePath: change.path,
                                    blockIndex: change.blockIndex,
                                    hunkIndex: change.hunkIndex,
                                    success: true,
                                    alreadyApplied: true
                                });
                                continue;
                            }

                            progress.report({ 
                                message: `(${count}/${total}) ${fileName}`,
                                increment: (1 / total) * 100 
                            });

                            this._panel.webview.postMessage({ 
                                command: 'applyAllStart', 
                                messageId: messageId, 
                                blockIndex: change.blockIndex,
                                hunkIndex: change.hunkIndex
                            });

                            let result: any = { success: false };
                            try {
                                const opts = { silent: true };
                                if (change.type === 'file') {
                                const applyResult: any = await vscode.commands.executeCommand('lollms-vs-coder.applyFileContent', change.path, change.content, opts);
                                result = applyResult || { success: true };
                            } else if (change.type === 'replace') {
                                try {
                                    const replaceResult: any = await vscode.commands.executeCommand(
                                        'lollms-vs-coder.replaceCode',
                                        change.path,
                                        change.content,
                                        this,
                                        messageId,
                                        { ...opts, blockIndex: change.blockIndex, hunkIndex: change.hunkIndex }
                                    );
                                    // Robust check for command return value
                                    result = (replaceResult && typeof replaceResult === 'object') ? replaceResult : { success: false, error: "Replacement command failed to return a result." };
                                } catch (e: any) {
                                    result = { success: false, error: e.message };
                                }
                            } else if (change.type === 'diff') {
                                await vscode.commands.executeCommand('lollms-vs-coder.applyPatchContent', change.path, change.content, opts);
                                result.success = true;
                            }
                        } catch (e: any) {
                            result = { success: false, error: e.message };
                        }
                        
                        this._panel.webview.postMessage({
                            command: 'applyAllResult',
                            messageId: messageId,
                            filePath: change.path,
                            blockIndex: change.blockIndex,
                            hunkIndex: change.hunkIndex,
                            success: result.success,
                            error: result.error
                        });

                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                });
                this.processManager.unregister(applyProcId);
                break;
            }
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
                try {
                    const res: any = await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', message.filePath, message.content, this, message.messageId, message.options);
                    if (res && res.success) {
                        webview.postMessage({
                            command: 'applyAllResult',
                            messageId: message.messageId,
                            filePath: message.filePath,
                            blockIndex: message.blockIndex,
                            hunkIndex: message.hunkIndex,
                            success: true,
                            repaired: res.repaired
                        });
                        await this.updateAppliedState(message.messageId, message.blockIndex, message.hunkIndex);
                    }
                } catch (e: any) {
                    this.log(`Command replaceCode failed: ${e.message}`, 'ERROR');
                }
                break;
            case 'deleteCodeBlock':
                vscode.commands.executeCommand('lollms-vs-coder.deleteCodeBlock', message.filePath, message.content);
                break;
            case 'addFilesToContext':
                {
                    const blockId = message.blockId;
                    const filesToAdd = message.files as string[];
                    const results: { [key: string]: boolean } = {};
                    
                    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
                        filesToAdd.forEach(f => results[f] = false);
                        webview.postMessage({ command: 'filesAddedToContext', results, blockId });
                        return;
                    }

                    const activeWorkspace = vscode.workspace.workspaceFolders[0];
                    const validFiles: string[] = [];

                    for (const filePath of filesToAdd) {
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
                        // Call the core context command to perform the inclusion
                        await vscode.commands.executeCommand('lollms-vs-coder.addFilesToContext', validFiles);
                        // Force a background token count refresh
                        this.updateContextAndTokens();
                    }

                    webview.postMessage({
                        command: 'filesAddedToContext',
                        results: results,
                        blockId: blockId
                    });
                }
                break;
            case 'requestFileSearch':
                {
                    const query = message.query.trim();
                    const searchMode = message.mode || 'path';
                    const options = message.options || { matchCase: false, wholeWord: false };
                    let results: any[] = [];

                    const includedFiles = new Set(
                        this._contextManager.getContextStateProvider()?.getIncludedFiles().map(f => f.path) || []
                    );

                    if (searchMode === 'content') {
                        results = await this._contextManager.searchWorkspaceContent(query, options);
                    } else {
                        let allFiles = await this._contextManager.getWorkspaceFilePaths();

                        // Apply Include/Exclude filters to filename list
                        if (options.include) {
                            const includes = options.include.split(',').map((p: string) => p.trim().toLowerCase());
                            allFiles = allFiles.filter(f => includes.some((p: string) => f.toLowerCase().includes(p) || f.toLowerCase().endsWith(p.replace('*', ''))));
                        }
                        if (options.exclude) {
                            const excludes = options.exclude.split(',').map((p: string) => p.trim().toLowerCase());
                            allFiles = allFiles.filter(f => !excludes.some((p: string) => f.toLowerCase().includes(p) || f.toLowerCase().endsWith(p.replace('*', ''))));
                        }
                        
                        // --- ADVANCED FILENAME PARSER ---
                        let filtered = allFiles;
                        
                        // 1. Handle Extension Filter (ext:py)
                        const extMatch = query.match(/ext:(\w+)/);
                        if (extMatch) {
                            const targetExt = "." + extMatch[1].toLowerCase();
                            filtered = filtered.filter(f => f.toLowerCase().endsWith(targetExt));
                        }
                        
                        // Clean query of metadata tags
                        const cleanQuery = query.replace(/ext:\w+/g, '').trim();
                        if (!cleanQuery) {
                            results = filtered.slice(0, 50).map(f => ({ path: f, snippet: "" }));
                        } else {
                            // 2. Handle OR logic (|)
                            const orParts = cleanQuery.split('|').map(p => p.trim()).filter(p => p);

                            if (options.fuzzy === false) {
                                // STRICT MATCHING MODE
                                const filteredFiles = filtered.filter(f => {
                                    return orParts.some(part => {
                                        const terms = part.split(/\s+/);
                                        return terms.every(term => {
                                            const isNot = term.startsWith('-');
                                            const actualTerm = isNot ? term.substring(1) : term;
                                            const match = options.matchCase ? f.includes(actualTerm) : f.toLowerCase().includes(actualTerm.toLowerCase());
                                            return isNot ? !match : match;
                                        });
                                    });
                                });
                                results = filteredFiles.slice(0, 50).map(f => ({ path: f, snippet: "" }));
                            } else {
                                // FUZZY SCORING MODE
                                const scoredResults = filtered.map(f => {
                                    let maxOrScore = 0;
                                    const matches = orParts.some(part => {
                                        const terms = part.split(/\s+/);
                                        return terms.every(term => {
                                            const isNot = term.startsWith('-');
                                            const actualTerm = isNot ? term.substring(1) : term;
                                            if (!actualTerm) return true;

                                            const fLower = f.toLowerCase();
                                            const tLower = actualTerm.toLowerCase();
                                            const idx = options.matchCase ? f.indexOf(actualTerm) : fLower.indexOf(tLower);

                                            if (idx !== -1) {
                                                let score = 10;
                                                if (f.split(/[\\/]/).pop()?.toLowerCase().startsWith(tLower)) score += 50;
                                                if (idx === 0) score += 100;
                                                maxOrScore = Math.max(maxOrScore, score);
                                                return isNot ? false : true;
                                            }
                                            return isNot ? true : false;
                                        });
                                    });
                                    return { path: f, score: maxOrScore, matches };
                                })
                                .filter(res => res.matches)
                                .sort((a, b) => b.score - a.score);

                                results = scoredResults.slice(0, 50).map(r => ({ path: r.path, snippet: "" }));
                            }
                        }
                    }
                    
                    // Add the 'isAlreadyIncluded' flag to each result
                    const resultsWithMetadata = results.map(r => ({
                        ...r,
                        isAlreadyIncluded: includedFiles.has(r.path)
                    }));
                    
                    webview.postMessage({ command: 'fileSearchResults', results: resultsWithMetadata, query, mode: searchMode });
                }
                break;
            case 'performDeepDiscussionSearch':
                const query = message.query.trim();
                if (!query) return;

                try {
                    const allDiscussions = await this._discussionManager.getAllDiscussions();
                    const results: any[] = [];
                    
                    // Conversion: treat query as regex if it contains special chars, 
                    // otherwise convert standard wildcards.
                    let regex: RegExp;
                    try {
                        const regexStr = query.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                                              .replace(/\\\*/g, '.*') // Support escaped *
                                              .replace(/\\\?/g, '.')  // Support escaped ?
                                              .replace(/\*/g, '.*')
                                              .replace(/\?/g, '.');
                        regex = new RegExp(regexStr, 'gi');
                    } catch (e) {
                        // Fallback to literal search if regex is invalid
                        regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                    }

                    for (const d of allDiscussions) {
                        let matchFound = false;
                        let snippet = "";
                        
                        // Check Title
                        if (d.title && d.title.match(regex)) {
                            matchFound = true;
                            snippet = "Discussion Title Match";
                        }

                        // Check Messages
                        if (!matchFound) {
                            for (const msg of d.messages) {
                                const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                                const match = regex.exec(content);
                                if (match) {
                                    matchFound = true;
                                    const start = Math.max(0, match.index - 50);
                                    const end = Math.min(content.length, match.index + 150);
                                    snippet = (start > 0 ? "..." : "") + content.substring(start, end).replace(/\r?\n/g, ' ') + (end < content.length ? "..." : "");
                                    break; 
                                }
                                regex.lastIndex = 0; // Reset for next message
                            }
                        }

                        if (matchFound) {
                            results.push({
                                id: d.id,
                                title: d.title || "Untitled Discussion",
                                snippet: snippet,
                                timestamp: d.timestamp
                            });
                        }
                    }

                    webview.postMessage({ command: 'discussionSearchResults', results, query });
                } catch (e: any) {
                    vscode.window.showErrorMessage("Deep Search failed: " + e.message);
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
            case 'requestAddDiagramToContext':
                const diagType = await vscode.window.showQuickPick([
                    { label: 'Inheritance Diagram', id: 'class_diagram' },
                    { label: 'Call Graph', id: 'call_graph' },
                    { label: 'Import Graph', id: 'import_graph' },
                    { label: 'Function Signatures', id: 'function_signatures' }
                ], { placeHolder: 'Select diagram type to include in AI context' });

                if (diagType && this._currentDiscussion) {
                    if (!this._currentDiscussion.activeDiagrams) this._currentDiscussion.activeDiagrams = [];
                    if (!this._currentDiscussion.activeDiagrams.includes(diagType.id)) {
                        this._currentDiscussion.activeDiagrams.push(diagType.id);
                        await this._discussionManager.saveDiscussion(this._currentDiscussion);
                        this.updateContextAndTokens();
                    }
                }
                break;
            case 'requestWebAction':
                {
                    const { action, params } = message;
                    try {
                        const loadingMsgId = 'system_web_loading_' + Date.now();
                        
                        if (action === 'youtube' || action === 'scrape') {
                            const targetUrl = params.url;
                            const lang = params.language || 'en';
                            const depth = params.depth || 0;

                            await this.addMessageToDiscussion({
                                id: loadingMsgId,
                                role: 'system', 
                                content: `🌐 Processing ${action}: ${targetUrl}...`
                            });

                            const result = await this._contextManager.processUrl(targetUrl, lang, undefined, undefined, depth);
                            await this.updateMessageContent(loadingMsgId, `✅ **Web Content Added:** ${targetUrl}\nSaved as: \`${result.filename}\`\n\nPreview:\n> ${result.summary}`);
                            this.updateContextAndTokens();
                        } else if (['wiki', 'arxiv', 'google', 'ddg', 'so'].includes(action)) {
                            const query = params.query;
                            const results = await this._contextManager.searchWebInfo(action, query);
                            webview.postMessage({ command: 'webSearchResults', action, results, query });
                        }
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Web action failed: ${e.message}`);
                        // CRITICAL: Tell the UI to stop spinning even on error
                        if (['wiki', 'arxiv', 'google', 'ddg', 'so'].includes(action)) {
                            webview.postMessage({ command: 'webSearchResults', action, results: [], query: params.query });
                        }
                    }
                }
                break;
            case 'addWebPagesToContext':
                try {
                    const { urls } = message;
                    for (const url of urls) {
                        await this._contextManager.processUrl(url, 'en');
                    }
                    vscode.window.showInformationMessage(`Added ${urls.length} web pages to context.`);
                    this.updateContextAndTokens();
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to add web pages: ${e.message}`);
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
                if (message.text) {
                    await vscode.env.clipboard.writeText(message.text);
                    // Optional: Show a small status bar message to confirm
                    vscode.window.setStatusBarMessage("Lollms: Copied to clipboard", 2000);
                }
                break;
            case 'executeLollmsCommand':
                const { command, params } = message.details;
                if (command === 'search-add-context-btn') {
                    if (dom.fileSearchModal) {
                        dom.fileSearchModal.classList.add('visible');
                        dom.fileSearchInput.focus();
                    }
                } else if (command === 'createNotebook') {
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
                } else if (command === 'workbench.action.reloadWindow') {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
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
                    // 1. Force Deactivate Agent if running
                    if (this.agentManager && this.agentManager.getIsActive()) {
                        this.agentManager.toggleAgentMode(); 
                    }
                    
                    // 2. Force purge from the generation registry
                    ChatPanel.activeGenerations.delete(this.discussionId);

                    // 3. Cancel all backend processes for this discussion
                    this.processManager.cancelForDiscussion(this.discussionId);
                    
                    // 4. Reset metrics
                    this._panel.webview.postMessage({
                        command: 'updateGenerationMetrics',
                        reset: true
                    });

                    // 5. Authoritatively hide overlay and unlock input
                    this.updateGeneratingState();
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
            case 'editAndRetryAgentTask':
                if (this.agentManager) {
                    this.agentManager.editAndRetryTask(parseInt(message.taskId, 10), message.params);
                }
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
                    const res: any = await vscode.commands.executeCommand('lollms-vs-coder.applyFileContent', message.filePath, message.content);
                    if (res && res.success) {
                        webview.postMessage({
                            command: 'applyAllResult',
                            messageId: message.messageId,
                            filePath: message.filePath,
                            blockIndex: message.blockIndex,
                            success: true
                        });
                        await this.updateAppliedState(message.messageId, message.blockIndex);
                    }
                } catch (e: any) {
                    this.log(`Command applyFileContent failed: ${e.message}`, 'ERROR');
                }
                break;
            case 'applyPatchContent':
                try {
                    const res: any = await vscode.commands.executeCommand('lollms-vs-coder.applyPatchContent', message.filePath, message.content);
                    if (res && res.success) {
                        webview.postMessage({
                            command: 'applyAllResult',
                            messageId: message.messageId,
                            filePath: message.filePath,
                            blockIndex: message.blockIndex,
                            success: true
                        });
                        await this.updateAppliedState(message.messageId, message.blockIndex);
                    }
                } catch (e: any) {
                    this.log(`Command applyPatchContent failed: ${e.message}`, 'ERROR');
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
                this.processManager.unregister(applyProcId);
                break;
            case 'saveSkill':
                await this.handleSaveSkill(message.content);
                break;
            case 'saveSkillToFile':
                {
                    const { name, description, content, category } = message.skillData;
                    const format = await vscode.window.showQuickPick([
                        { label: 'LoLLMs XML (.xml)', value: 'lollms', description: 'Native Lollms format' },
                        { label: 'Claude Markdown (.md)', value: 'claude', description: 'Claude Code compatible format' }
                    ], { placeHolder: 'Select file format to save the skill' });

                    if (!format) return;

                    const isClaude = format.value === 'claude';
                    const fileName = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + (isClaude ? '.md' : '.xml');
                    
                    const uri = await vscode.window.showSaveDialog({
                        defaultUri: vscode.workspace.workspaceFolders ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, fileName) : undefined,
                        filters: isClaude ? { 'Markdown': ['md'] } : { 'XML': ['xml'] },
                        saveLabel: 'Save Skill File'
                    });

                    if (uri) {
                        const skill: any = { name, description, content, category, id: 'temp' };
                        const fileContent = isClaude 
                            ? this._skillsManager.skillToClaudeMarkdown(skill) 
                            : `<skill title="${name}" description="${description}" category="${category}">${content}</skill>`;

                        await vscode.workspace.fs.writeFile(uri, Buffer.from(fileContent, 'utf8'));
                        vscode.window.showInformationMessage(`Skill saved to ${path.basename(uri.fsPath)}`);
                    }
                }
                break;
            case 'saveGeneratedSkill':
                const { name: sName, description: sDesc, content: sContent, category: sCat, scope: sScope } = message.skillData;
                
                // Ensure a category exists before sending to the manager
                const finalCategory = (sCat && sCat.trim() !== "") ? sCat : "general";

                const sId = (sName || 'skill').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Date.now();
                
                await this._skillsManager.addSkill({
                    id: sId,
                    name: sName, 
                    description: sDesc, 
                    content: sContent,
                    category: finalCategory,
                    language: 'markdown',
                    scope: sScope 
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
                // Full settings update from modal: we treat this as a potential default update
                await this.saveCapabilities(true);
                
                this.log(`Updated Discussion Capabilities: ${JSON.stringify(this._discussionCapabilities)}`);
                this._panel.webview.postMessage({ command: 'updateDiscussionCapabilities', capabilities: this._discussionCapabilities });
                break;
            case 'updateDiscussionCapabilitiesPartial':
                if (this._discussionCapabilities) {
                    const partial = message.partial;

                    // Handle specific diagram removal
                    if (partial.removeDiagram && this._currentDiscussion?.activeDiagrams) {
                        this._currentDiscussion.activeDiagrams = this._currentDiscussion.activeDiagrams.filter(d => d !== partial.removeDiagram);
                        delete partial.removeDiagram; // Don't save this key to capabilities
                    }

                    this._discussionCapabilities = { ...this._discussionCapabilities, ...partial };
                    
                    if (partial.agentMode !== undefined) {
                        if (partial.agentMode && !this.agentManager.getIsActive()) {
                            this.agentManager.toggleAgentMode();
                        } else if (!partial.agentMode && this.agentManager.getIsActive()) {
                            this.agentManager.toggleAgentMode();
                        }
                    }
                    
                    if (partial.webSearch !== undefined && this.agentManager) {
                        if (partial.webSearch) {
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

                    // Only save to Global Defaults if it's NOT the ephemeral mute state
                    if (partial.disableProjectContext === undefined) {
                        await this._discussionManager.saveLastCapabilities(this._discussionCapabilities);
                    }

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
                this.processManager.unregister(applyProcId);
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
                        const folder = vscode.workspace.workspaceFolders[0];
                        const hash = await this._gitIntegration.commitWithMessage(message.message, folder);
                        if (hash) {
                            // Notify chat with a system message containing the hash
                            await this.addMessageToDiscussion({
                                role: 'system',
                                content: `✅ **Commit Successful**\n**Hash:** \`${hash}\`\n*Link to this fix for CVE tracking.*`
                            });
                            // Update the UI state
                            this._panel.webview.postMessage({ command: 'updateGitState', branch: await this._gitIntegration.getCurrentBranch(folder), lastHash: hash });
                        }
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
                try {
                    const contextResult = await this._contextManager.getContextContent({ 
                        modelName: this._currentDiscussion?.model || this._lollmsAPI.getModelName() 
                    });
                    InfoPanel.createOrShow(this._extensionUri, "Full AI Context Preview", contextResult.text);
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to load context preview: ${e.message}`);
                }
                break;
            case 'requestContextUsage':
                await this.handleRequestContextUsage();
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

  private async copySystemPromptToClipboard() {
      this._panel.webview.postMessage({ command: 'setGeneratingState', isGenerating: true, statusText: 'Assembling system prompt...' });

      await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: "Lollms: Preparing system prompt...",
          cancellable: false
      }, async (progress) => {
          try {
              const config = vscode.workspace.getConfiguration('lollmsVsCoder');
              const forceFullCode = config.get<boolean>('forceFullCodePath') || false;
              const importedIds = this._currentDiscussion?.importedSkills || [];
              
              progress.report({ message: "Reading context..." });
              const contextData = await this._contextManager.getContextContent({ 
                  importedSkillIds: importedIds,
                  modelName: this._currentDiscussion?.model || this._lollmsAPI.getModelName()
              });
              
              const context = {
                  tree: contextData.projectTree,
                  files: contextData.selectedFilesContent,
                  skills: contextData.skillsContent
              };

              progress.report({ message: "Generating Persona..." });
              const personaContent = this.getCurrentPersonaSystemPrompt();
              const systemPrompt = await getProcessedSystemPrompt('chat', this._discussionCapabilities, personaContent, undefined, forceFullCode, context);

              await vscode.env.clipboard.writeText(systemPrompt);
              vscode.window.showInformationMessage("✅ System prompt (with context) copied to clipboard.");
          } catch (e: any) {
              vscode.window.showErrorMessage(`Failed to copy system prompt: ${e.message}`);
          } finally {
              this._panel.webview.postMessage({ command: 'setGeneratingState', isGenerating: false });
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
  private async handleRequestContextUsage() {
      if (this._isDisposed || !this._currentDiscussion || !this._contextManager) return;
      const provider = this._contextManager.getContextStateProvider();
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!provider || !workspaceFolder) return;

      const includedFiles = provider.getIncludedFiles();
      const model = this._currentDiscussion.model || this._lollmsAPI.getModelName();
      const crypto = require('crypto');

      // 1. Send initial list immediately so UI renders skeleton
      const initialUsage = includedFiles.map(f => ({
          path: f.path,
          state: f.state,
          tokens: -1, // Loading state
          isExtra: f.path.includes('.lollms/') || f.path.startsWith('http')
      }));

      this._panel.webview.postMessage({ command: 'contextUsageData', usage: initialUsage });

      // 2. Populate tokens incrementally
      for (const file of includedFiles) {
          try {
              const uri = vscode.Uri.joinPath(workspaceFolder.uri, file.path);
              const stats = await vscode.workspace.fs.stat(uri);
              const fileContent = await vscode.workspace.fs.readFile(uri);
              const hash = crypto.createHash('md5').update(fileContent).digest('hex');

              let tokenCount = await this._contextManager.getCachedTokens(file.path, hash);

              if (tokenCount === null) {
                  let text = "";
                  if (file.state === 'definitions-only') {
                      text = await (this._contextManager as any).extractDefinitions(uri);
                  } else {
                      text = Buffer.from(fileContent).toString('utf8');
                  }
                  const tokenRes = await this._lollmsAPI.tokenize(text, model);
                  tokenCount = tokenRes.count;
                  await this._contextManager.setCachedTokens(file.path, hash, tokenCount);
              }

              this._panel.webview.postMessage({
                  command: 'updateContextFileUsage',
                  path: file.path,
                  tokens: tokenCount
              });
          } catch (e) {
              this._panel.webview.postMessage({ command: 'updateContextFileUsage', path: file.path, tokens: 0, error: true });
          }
      }
  }
  private async _getHtmlForWebview(webview: vscode.Webview): Promise<string> {
    const nonce = getNonce();

    const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'));
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'chatPanel.css'));
    const prismThemeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'prism-tomorrow.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'chatPanel.bundle.js'));
    const lollmsIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'lollms-icon.svg'));

    const l10nStrings = LocalizationManager.getBundleForWebview();

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
                        <div class="ai-orb-container">
                            <div class="orb-ring"></div>
                            <div class="ai-orb"></div>
                        </div>
                        <div class="generating-details">
                            <span id="generating-status-text">Processing...</span>
                            <div class="step-timeline" id="step-timeline">
                                <div class="step-dot active"></div>
                                <div class="step-dot"></div>
                                <div class="step-dot"></div>
                                <div class="step-dot"></div>
                            </div>
                            <div id="generating-metrics" class="generating-metrics" style="display: none;">
                                <div class="metric-item">
                                    <i class="codicon codicon-dashboard"></i>
                                    <span id="metrics-tps" class="metric-value">0.0</span> <span class="metric-label">t/s</span>
                                </div>
                                <div class="metric-item">
                                    <i class="codicon codicon-symbol-parameter"></i>
                                    <span id="metrics-count" class="metric-value">0</span> <span class="metric-label">tokens</span>
                                </div>
                            </div>
                        </div>
                    </div>
                    <button id="stopButton" class="stop-btn-red">
                        <i class="codicon codicon-primitive-square"></i>
                        <span>Cancel Task</span>
                    </button>
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
                            <button class="menu-item" id="discussionToolsButton"><i class="codicon codicon-settings"></i><span>Discussion Settings</span></button>
                            <button class="menu-item" id="agentToolsButton"><i class="codicon codicon-briefcase"></i><span>Agent Tools List</span></button>
                            <div class="menu-separator"></div>
                            <button class="menu-item" id="attachButton"><i class="codicon codicon-add"></i><span>Attach Files</span></button>
                            <button class="menu-item" id="importSkillsButton"><i class="codicon codicon-lightbulb"></i><span>Import Skill</span></button>
                            <button class="menu-item" id="copyFullPromptButton"><i class="codicon codicon-copy"></i><span>Copy Context & Prompt</span></button>
                            <button class="menu-item" id="copySystemPromptButton"><i class="codicon codicon-shield"></i><span>Copy System Prompt Only</span></button>
                            <button class="menu-item" id="copyTreeAndContentButton"><i class="codicon codicon-clippy"></i><span>Copy Tree & Content</span></button>
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
                                <span>🐂 Multi-Agent</span>
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
                        <div class="active-badges" id="active-badges">
                        </div>

                        <div id="websearch-indicator" class="websearch-indicator" title="Web Search Active" style="display: none;">
                            <i class="codicon codicon-globe"></i>
                            <span>Web</span>
                        </div>
                        
                        <div id="active-tools-indicator" class="active-tools-indicator"></div>
                        
                        <div id="context-loading-spinner" style="display: none; align-items: center; gap: 8px; font-size: 0.9em; color: var(--vscode-descriptionForeground);">
                            <div class="spinner"></div>
                            <div style="display:flex; flex-direction:column; gap:2px;">
                                <span id="loading-files-text" style="font-size: 11px;"></span>
                                <div class="token-progress-container" id="file-tree-progress-container" style="width: 80px; height: 4px; display: none;">
                                    <div class="token-progress-bar range-safe" id="file-tree-progress-bar" style="width: 0%;"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="input-area-container">
                        <div class="rich-input-toolbar">
                            <button class="toolbar-tool" data-wrap-type="python" title="Python Block"><i class="codicon codicon-symbol-method"></i><span>Python</span></button>
                            <button class="toolbar-tool" data-wrap-type="code" title="Code Block"><i class="codicon codicon-code"></i><span>Code</span></button>
                            <div class="toolbar-separator"></div>
                            <button class="toolbar-tool" data-wrap-type="h1" title="Heading 1"><span>H1</span></button>
                            <button class="toolbar-tool" data-wrap-type="h2" title="Heading 2"><span>H2</span></button>
                            <button class="toolbar-tool" data-wrap-type="h3" title="Heading 3"><span>H3</span></button>
                            <div class="toolbar-separator"></div>
                            <button class="toolbar-tool" data-wrap-type="list" title="Bullet List"><i class="codicon codicon-list-unordered"></i></button>
                            <button class="toolbar-tool" data-wrap-type="bold" title="Bold"><i class="codicon codicon-bold"></i></button>
                            <button class="toolbar-tool" data-wrap-type="italic" title="Italic"><i class="codicon codicon-italic"></i></button>
                        </div>
                        <div class="input-area">
                            <div id="attachment-preview-area" class="attachment-preview-area"></div>
                            <div class="input-row">
                                <div class="control-buttons">
                                    <button id="moreActionsButton" title="Menu"><i class="codicon codicon-menu"></i></button>
                                    <button id="addDrawingButton" title="Add Empty Drawing"><i class="codicon codicon-edit"></i></button>
                                </div>
                                
                                <textarea id="messageInput" placeholder="Enter your message (Shift+Enter for new line)..."></textarea>

                                <div class="control-buttons">
                                    <button id="sendButton" title="Send Message"><i class="codicon codicon-send"></i></button>
                                </div>
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
                <div class="modal-body">
                    <div style="margin-bottom: 12px;">
                        <input type="text" id="skills-search-input" class="search-modal-input" placeholder="Filter skills by name or category..." style="width: 100%;">
                    </div>
                    <div id="skills-tree-container">
                        <!-- Tree generated dynamically -->
                    </div>
                </div>
                <div class="modal-footer">
                    <button id="skills-import-btn">Apply Selected</button>
                </div>
            </div>
        </div>

        <div id="discussion-tools-modal" class="modal">
            <div class="modal-content">
                <div class="modal-header">
                    <h2>Discussion Settings</h2>
                    <span class="close-btn" id="close-discussion-tools-modal">&times;</span>
                </div>
                <div class="modal-body">

                    <div class="modal-section">
                        <h3>Response Style (Profile)</h3>
                        <p style="font-size: 11px; opacity: 0.8; margin-bottom: 10px;">Customize how the AI talks and thinks.</p>
                        
                        <div style="display:flex; gap:10px; margin-bottom:10px;">
                            <select id="modal-default-profile-select" class="menu-select" style="flex:1; margin:0;"></select>
                            <button id="modal-add-profile-btn" class="code-action-btn apply-btn" style="margin:0; width: auto; height: 32px;"><i class="codicon codicon-add"></i> New</button>
                        </div>

                        <div id="modal-profiles-container" style="display:flex; flex-direction:column; gap:8px; max-height: 200px; overflow-y: auto; padding: 2px;">
                            <!-- Profiles list injected here -->
                        </div>

                        <!-- Profile Editor (Hidden) -->
                        <div id="modal-profile-editor" style="display:none; border: 1px solid var(--vscode-focusBorder); padding: 12px; border-radius: 4px; margin-top: 10px; background: var(--vscode-editor-inactiveSelectionBackground);">
                            <h4 style="margin: 0 0 10px 0; font-size: 12px;">Edit Profile</h4>
                            <div style="display:flex; flex-direction:column; gap:8px;">
                                <div>
                                    <label style="font-size: 11px; font-weight:bold;">Name</label>
                                    <input type="text" id="modal-p-name" style="width:100%; padding:4px; margin-top:2px;">
                                </div>
                                <div>
                                    <label style="font-size: 11px; font-weight:bold;">Description</label>
                                    <input type="text" id="modal-p-desc" style="width:100%; padding:4px; margin-top:2px;">
                                </div>
                                <div>
                                    <label style="font-size: 11px; font-weight:bold;">Prefix (Optional command)</label>
                                    <input type="text" id="modal-p-prefix" placeholder="/no_think" style="width:100%; padding:4px; margin-top:2px;">
                                </div>
                                <div>
                                    <label style="font-size: 11px; font-weight:bold;">System Instructions</label>
                                    <textarea id="modal-p-prompt" rows="4" style="width:100%; padding:4px; margin-top:2px; font-family:var(--vscode-editor-font-family); font-size:11px;"></textarea>
                                </div>
                                <div style="display:flex; gap:8px; margin-top:10px; justify-content: flex-end;">
                                    <button id="modal-p-cancel" class="code-action-btn" style="width: auto;">Cancel</button>
                                    <button id="modal-p-save" class="code-action-btn apply-btn" style="width: auto;">Update</button>
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    <div class="modal-section">
                        <h3>Context Management</h3>
                        <div class="form-group" style="margin-bottom: 12px;">
                            <label style="font-size: 11px; font-weight: bold; display: block; margin-bottom: 4px;">Auto-Context Aggression</label>
                            <select id="modal-context-aggression" class="menu-select" style="width: 100%; margin: 0;">
                                <option value="respect">Respect Context (75% Max)</option>
                                <option value="none">No Restrictions (Recover Max)</option>
                                <option value="minimal">Minimal (Smallest useful set)</option>
                                <option value="signatures">Smart Signatures (Full for Edit, Defs for Context)</option>
                            </select>
                            <p style="font-size: 10px; opacity: 0.7; margin-top: 4px;">Controls how many files the Auto-Context agent tries to pack into the prompt.</p>
                        </div>
                        <div class="checkbox-container">
                            <label class="switch"><input type="checkbox" id="cap-debugMode"><span class="slider"></span></label>
                            <label for="cap-debugMode"><strong>🐞 Debug Mode:</strong> Autonomous live debugging loop.</label>
                        </div>
                        <div id="debug-config-section" style="display:none; margin: 8px 0 0 40px; border-left: 2px solid var(--vscode-charts-red); padding-left: 12px;">
                            <label style="font-size:11px;">Max Debug Steps: <input type="number" id="cap-maxDebugSteps" value="10" min="1" max="50" style="width:40px; float:right;"></label>
                        </div>

                        <div class="checkbox-container">
                            <label class="switch"><input type="checkbox" id="cap-herdMode"><span class="slider"></span></label>
                            <label for="cap-herdMode"><strong>🐂 Herd Mode:</strong> Multiple agents brainstorm the answer.</label>
                        </div>
                        <div id="herd-config-section" style="display:none; margin: 8px 0 0 40px; border-left: 2px solid var(--vscode-charts-purple); padding-left: 12px;">
                            <div style="display:flex; flex-direction:column; gap:8px;">
                                <label style="font-size:11px;">Debate Rounds: <input type="number" id="cap-herdRounds" min="1" max="10" style="width:40px; float:right;"></label>
                                <label style="font-size:11px;">Brainstorm Agents: <input type="number" id="cap-herdPreCount" min="1" max="5" style="width:40px; float:right;"></label>
                                <label style="font-size:11px;">Review Agents: <input type="number" id="cap-herdPostCount" min="1" max="5" style="width:40px; float:right;"></label>
                            </div>
                            
                            <label style="font-size: 10px; font-weight: bold; margin-top: 10px; display: block; opacity: 0.7;">ACTIVE MODEL POOL</label>
                            <div id="herd-models-list" style="max-height: 100px; overflow-y: auto; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); padding: 4px; border-radius: 4px; margin-top: 4px;">
                                <!-- Checkboxes injected here -->
                            </div>

                            <div class="checkbox-container" style="margin-top:8px; border:none; background:transparent; padding:0;">
                                <label class="switch" style="width:24px; height:14px;"><input type="checkbox" id="cap-herdParallelGeneration"><span class="slider"></span></label>
                                <label for="cap-herdParallelGeneration" style="font-size:11px; opacity:0.8;">Parallel Generation (Fast Servers)</label>
                            </div>
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

                        <h3 style="margin-top:20px; color:var(--vscode-charts-orange);">🚀 Automation</h3>
                        <div class="checkbox-container">
                            <label class="switch"><input type="checkbox" id="cap-autoApply"><span class="slider"></span></label>
                            <label for="cap-autoApply"><strong>Auto Apply:</strong> Automatically apply code blocks</label>
                        </div>
                        <div id="automation-sub-options" style="margin-left: 25px; opacity: 0.5; pointer-events: none;">
                            <div class="checkbox-container">
                                <label class="switch"><input type="checkbox" id="cap-autoBranch"><span class="slider"></span></label>
                                <label for="cap-autoBranch">Auto Branch (Git)</label>
                            </div>
                            <div class="checkbox-container">
                                <label class="switch"><input type="checkbox" id="cap-autoFix"><span class="slider"></span></label>
                                <label for="cap-autoFix">Auto Fix (Repair linting errors)</label>
                            </div>
                            <div style="margin-top:8px; display:flex; align-items:center; gap:10px;">
                                <label style="font-size:11px;">Max Fix Retries:</label>
                                <input type="number" id="cap-maxFixRetries" value="3" min="1" max="10" style="width:50px;">
                            </div>
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
                        <h3>Agent & Vision Permissions</h3>
                        <div class="checkbox-grid">
                            <div class="checkbox-container">
                                <label class="switch"><input type="checkbox" id="cap-enableImages" checked><span class="slider"></span></label>
                                <label for="cap-enableImages">Enable Vision (Images)</label>
                            </div>
                            <div class="checkbox-container">
                                <label class="switch"><input type="checkbox" id="cap-useImageModeForDocs"><span class="slider"></span></label>
                                <label for="cap-useImageModeForDocs" title="Convert PDF/PPTX to Images">Visual Doc Mode</label>
                            </div>
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

        <div id="usage-modal" class="modal">
            <div class="modal-content" style="max-width: 800px; width: 90%;">
                <div class="modal-header">
                    <h2>Context Token Usage</h2>
                    <span class="close-btn" id="usage-close-btn">&times;</span>
                </div>
                <div class="modal-body">
                    <p style="font-size: 11px; opacity: 0.8; margin-bottom: 15px;">Detailed breakdown of tokens per file using the currently selected model.</p>
                    <div id="usage-list-container" style="max-height: 400px; overflow-y: auto;">
                        <div style="text-align:center; padding: 20px;"><div class="spinner"></div> Calculating...</div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button id="usage-refresh-btn" class="code-action-btn apply-btn" style="width:auto; height:32px;"><span class="codicon codicon-refresh"></span> Recalculate</button>
                </div>
            </div>
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

        <div id="file-search-modal" class="modal">
            <div class="modal-content" style="max-width: 500px;">
                <div class="modal-header">
                    <h2 style="font-size: 14px; font-weight: 600;"><i class="codicon codicon-search" style="margin-right: 8px;"></i>Search & Add Files</h2>
                    <span class="close-btn" id="file-search-close-btn">&times;</span>
                </div>
                <div class="modal-body">
                    <div style="display:flex; flex-direction:column; gap:10px; margin-bottom:12px;">
                        <div style="display:flex; justify-content: space-between; align-items: center; background: var(--vscode-editor-inactiveSelectionBackground); padding: 8px; border-radius: 4px; border: 1px solid var(--vscode-widget-border);">
                            <div style="display:flex; align-items:center; gap:8px;">
                                <label style="font-size:11px; font-weight: 600; opacity:0.9; margin: 0;">Scope:</label>
                                <select id="file-search-mode" class="menu-select" style="width: 130px; margin: 0; height: 24px;">
                                    <option value="content" selected>Code Content</option>
                                    <option value="path">Filenames</option>
                                </select>
                            </div>
                            <div style="display:flex; gap:12px;">
                                <div style="display:flex; align-items:center; gap:4px;" title="Match Case">
                                    <span style="font-size: 10px; font-weight: bold; opacity: 0.8;">Ab</span>
                                    <label class="switch" style="width: 24px; height: 14px; margin: 0;">
                                        <input type="checkbox" id="file-search-case">
                                        <span class="slider" style="border-radius: 14px;"></span>
                                    </label>
                                </div>
                                <div style="display:flex; align-items:center; gap:4px;" title="Match Whole Word">
                                    <span style="font-size: 10px; font-weight: bold; opacity: 0.8;">\b</span>
                                    <label class="switch" style="width: 24px; height: 14px; margin: 0;">
                                        <input type="checkbox" id="file-search-word">
                                        <span class="slider" style="border-radius: 14px;"></span>
                                    </label>
                                </div>
                                <div style="display:flex; align-items:center; gap:4px;" title="Fuzzy Search (Filename only)">
                                    <span style="font-size: 10px; font-weight: bold; opacity: 0.8;">~</span>
                                    <label class="switch" style="width: 24px; height: 14px; margin: 0;">
                                        <input type="checkbox" id="file-search-fuzzy" checked>
                                        <span class="slider" style="border-radius: 14px;"></span>
                                    </label>
                                </div>
                            </div>
                        </div>
                        <input type="text" id="file-search-input" class="search-modal-input" placeholder="Type query and press Enter..." style="flex:1;">
                        
                        <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                            <div class="form-group" style="margin:0;">
                                <label style="font-size: 10px; opacity: 0.7; margin-bottom: 2px;">Include (e.g. src/, *.ts)</label>
                                <input type="text" id="file-search-include" class="search-modal-input" placeholder="Files to include..." style="font-size: 11px; height: 24px;">
                            </div>
                            <div class="form-group" style="margin:0;">
                                <label style="font-size: 10px; opacity: 0.7; margin-bottom: 2px;">Exclude (e.g. tests/, *.log)</label>
                                <input type="text" id="file-search-exclude" class="search-modal-input" placeholder="Files to hide..." style="font-size: 11px; height: 24px;">
                            </div>
                        </div>

                        <div style="font-size: 10px; opacity: 0.7; display: flex; gap: 10px; flex-wrap: wrap; line-height: 1.5;">
                            <span>Pro Search:</span>
                            <code>A B (AND)</code>
                            <code>A | B (OR)</code>
                            <code>-ignore (NOT)</code>
                        </div>
                    </div>
                    <div class="checkbox-container" id="file-search-master-container" style="display:none; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid var(--vscode-widget-border);">
                        <input type="checkbox" id="file-search-select-all">
                        <label for="file-search-select-all" style="font-weight: bold; font-size: 11px; cursor: pointer;">Select All Results</label>
                    </div>
                    <div id="file-search-results" style="max-height: 350px; overflow-y: auto; border: 1px solid var(--vscode-widget-border); padding: 8px; border-radius: 4px;">
                        <div style="opacity:0.6; text-align:center; padding: 20px;">Type to start searching...</div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button id="file-search-add-btn" class="code-action-btn apply-btn" style="width: 100%; justify-content: center;">Add Selected Files</button>
                </div>
            </div>
        </div>

        <div id="file-search-modal" class="modal">
            <div class="modal-content" style="max-width: 500px;">
                <div class="modal-header">
                    <h2 style="font-size: 14px; font-weight: 600;"><i class="codicon codicon-search" style="margin-right: 8px;"></i>Search & Add Files</h2>
                    <span class="close-btn" id="file-search-close-btn">&times;</span>
                </div>
                <div class="modal-body">
                    <div style="display:flex; flex-direction:column; gap:10px; margin-bottom:12px;">
                        <div style="display:flex; justify-content: space-between; align-items: center; background: var(--vscode-editor-inactiveSelectionBackground); padding: 8px; border-radius: 4px; border: 1px solid var(--vscode-widget-border);">
                            <div style="display:flex; align-items:center; gap:8px;">
                                <label style="font-size:11px; font-weight: 600; opacity:0.9; margin: 0;">Scope:</label>
                                <select id="file-search-mode" class="menu-select" style="width: 130px; margin: 0; height: 24px;">
                                    <option value="content" selected>Code Content</option>
                                    <option value="path">Filenames</option>
                                </select>
                            </div>
                            <div style="display:flex; gap:12px;">
                                <div style="display:flex; align-items:center; gap:4px;" title="Match Case">
                                    <span style="font-size: 10px; font-weight: bold; opacity: 0.8;">Ab</span>
                                    <label class="switch" style="width: 24px; height: 14px; margin: 0;">
                                        <input type="checkbox" id="file-search-case">
                                        <span class="slider" style="border-radius: 14px;"></span>
                                    </label>
                                </div>
                                <div style="display:flex; align-items:center; gap:4px;" title="Match Whole Word">
                                    <span style="font-size: 10px; font-weight: bold; opacity: 0.8;">\b</span>
                                    <label class="switch" style="width: 24px; height: 14px; margin: 0;">
                                        <input type="checkbox" id="file-search-word">
                                        <span class="slider" style="border-radius: 14px;"></span>
                                    </label>
                                </div>
                                <div style="display:flex; align-items:center; gap:4px;" title="Fuzzy Search (Filename only)">
                                    <span style="font-size: 10px; font-weight: bold; opacity: 0.8;">~</span>
                                    <label class="switch" style="width: 24px; height: 14px; margin: 0;">
                                        <input type="checkbox" id="file-search-fuzzy" checked>
                                        <span class="slider" style="border-radius: 14px;"></span>
                                    </label>
                                </div>
                            </div>
                        </div>
                        <input type="text" id="file-search-input" class="search-modal-input" placeholder="Type query and press Enter..." style="flex:1;">
                        
                        <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                            <div class="form-group" style="margin:0;">
                                <label style="font-size: 10px; opacity: 0.7; margin-bottom: 2px;">Include (e.g. src/, *.ts)</label>
                                <input type="text" id="file-search-include" class="search-modal-input" placeholder="Files to include..." style="font-size: 11px; height: 24px;">
                            </div>
                            <div class="form-group" style="margin:0;">
                                <label style="font-size: 10px; opacity: 0.7; margin-bottom: 2px;">Exclude (e.g. tests/, *.log)</label>
                                <input type="text" id="file-search-exclude" class="search-modal-input" placeholder="Files to hide..." style="font-size: 11px; height: 24px;">
                            </div>
                        </div>

                        <div style="font-size: 10px; opacity: 0.7; display: flex; gap: 10px; flex-wrap: wrap; line-height: 1.5;">
                            <span>Pro Search:</span>
                            <code>A B (AND)</code>
                            <code>A | B (OR)</code>
                            <code>-ignore (NOT)</code>
                        </div>
                    </div>
                    <div class="checkbox-container" id="file-search-master-container" style="display:none; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid var(--vscode-widget-border);">
                        <input type="checkbox" id="file-search-select-all">
                        <label for="file-search-select-all" style="font-weight: bold; font-size: 11px; cursor: pointer;">Select All Results</label>
                    </div>
                    <div id="file-search-results" style="max-height: 350px; overflow-y: auto; border: 1px solid var(--vscode-widget-border); padding: 8px; border-radius: 4px;">
                        <div style="opacity:0.6; text-align:center; padding: 20px;">Type to start searching...</div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button id="file-search-add-btn" class="code-action-btn apply-btn" style="width: 100%; justify-content: center;">Add Selected Files</button>
                </div>
            </div>
        </div>

        <!-- Web Discovery Modal -->
        <div id="web-modal" class="modal">
            <div class="modal-content" style="max-width: 700px; width: 90%;">
                <div class="modal-header">
                    <h2>Web Discovery</h2>
                    <span class="close-btn" id="web-modal-close-btn">&times;</span>
                </div>
                <div class="web-tabs-nav">
                    <button class="web-tab-btn active" data-tab="tab-url">URL / Scrape</button>
                    <button class="web-tab-btn" data-tab="tab-google">Google</button>
                    <button class="web-tab-btn" data-tab="tab-ddg">DuckDuckGo</button>
                    <button class="web-tab-btn" data-tab="tab-youtube">YouTube</button>
                    <button class="web-tab-btn" data-tab="tab-wiki">Wikipedia</button>
                    <button class="web-tab-btn" data-tab="tab-arxiv">ArXiv</button>
                    <button class="web-tab-btn" data-tab="tab-so">StackOverflow</button>
                    <button class="web-tab-btn" data-tab="tab-github">GitHub</button>
                </div>
                <div class="modal-body">
                    <!-- URL Tab -->
                    <div id="tab-url" class="web-tab-content active">
                        <label>URL to Scrape</label>
                        <input type="text" id="web-url-input" placeholder="https://example.com/docs">
                        <label>Crawl Depth (0 = this page only)</label>
                        <input type="number" id="web-url-depth" value="0" min="0" max="3">
                        <p class="help-text">Depth 1+ will follow internal links found on the page.</p>
                        <button class="code-action-btn apply-btn web-submit-btn" style="width:100%; margin-top:15px;" data-action="scrape">Scrape Content</button>
                    </div>

                    <!-- YouTube Tab -->
                    <div id="tab-youtube" class="web-tab-content">
                        <label>YouTube Video URL</label>
                        <input type="text" id="web-yt-url" placeholder="https://youtube.com/watch?v=...">
                        <label>Transcript Language</label>
                        <input type="text" id="web-yt-lang" value="en" placeholder="en, fr, es...">
                        <button class="code-action-btn apply-btn web-submit-btn" style="width:100%; margin-top:15px;" data-action="youtube">Extract Transcript</button>
                    </div>

                    <!-- Wikipedia Tab -->
                    <div id="tab-wiki" class="web-tab-content">
                        <label>Search Query or Page URL</label>
                        <div style="display:flex; gap:8px;">
                            <input type="text" id="web-wiki-input" placeholder="e.g. Quantum Computing" style="flex:1;">
                            <button class="code-action-btn secondary-btn web-submit-btn" data-action="wiki">Search</button>
                        </div>
                        <div id="web-wiki-results" class="web-search-results"></div>
                        <button class="code-action-btn apply-btn" id="web-wiki-add-btn" style="width:100%; margin-top:15px; display:none;">Add Selected Page</button>
                    </div>

                    <!-- ArXiv Tab -->
                    <div id="tab-arxiv" class="web-tab-content">
                        <label>Search Query or Article ID/Link</label>
                        <div style="display:flex; gap:8px;">
                            <input type="text" id="web-arxiv-input" placeholder="e.g. 2401.00001 or LLM Safety" style="flex:1;">
                            <button class="code-action-btn secondary-btn web-submit-btn" data-action="arxiv">Search</button>
                        </div>
                        <div id="web-arxiv-results" class="web-search-results"></div>
                        <div class="checkbox-container">
                            <input type="radio" name="arxiv-mode" id="arxiv-abstract" value="abstract" checked>
                            <label for="arxiv-abstract">Abstract Only</label>
                            <input type="radio" name="arxiv-mode" id="arxiv-full" value="full">
                            <label for="arxiv-full">Full Text (Experimental)</label>
                        </div>
                        <button class="code-action-btn apply-btn" id="web-arxiv-add-btn" style="width:100%; margin-top:15px; display:none;">Add Selected Article</button>
                    </div>

                    <!-- Google Tab -->
                    <div id="tab-google" class="web-tab-content">
                        <label>Google Search Query</label>
                        <div style="display:flex; gap:8px; align-items: center;">
                            <input type="text" id="web-google-input" placeholder="e.g. latest news on LoLLMs" style="flex:1;">
                            <button class="code-action-btn apply-btn web-submit-btn" style="width: 100px;" data-action="google">Search</button>
                        </div>
                        <p class="help-text">Requires Google Custom Search API Key in Settings.</p>
                    </div>

                    <!-- DuckDuckGo Tab -->
                    <div id="tab-ddg" class="web-tab-content">
                        <label>DuckDuckGo Query</label>
                        <div style="display:flex; gap:8px; align-items: center;">
                            <input type="text" id="web-ddg-input" placeholder="e.g. rust programming best practices" style="flex:1;">
                            <button class="code-action-btn apply-btn web-submit-btn" style="width: 100px;" data-action="ddg">Search</button>
                        </div>
                    </div>

                    <!-- SO Tab -->
                    <div id="tab-so" class="web-tab-content">
                        <label>Search Query</label>
                        <input type="text" id="web-so-input" placeholder="e.g. Python list comprehension performance">
                        <button class="code-action-btn apply-btn web-submit-btn" style="width:100%; margin-top:15px;" data-action="so">Search & Add Results</button>
                    </div>

                    <!-- GitHub Tab -->
                    <div id="tab-github" class="web-tab-content">
                        <label>Repository URL or Search</label>
                        <div style="display:flex; gap:8px;">
                            <input type="text" id="web-github-input" placeholder="e.g. parisneo/lollms-webui" style="flex:1;">
                            <button class="code-action-btn apply-btn web-submit-btn" data-action="github">Search</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Global Discussion Search Modal -->
        <div id="discussion-search-modal" class="modal">
            <div class="modal-content" style="max-width: 800px;">
                <div class="modal-header">
                    <h2>Advanced Discussion Search</h2>
                    <span class="close-btn" id="discussion-search-close-btn">&times;</span>
                </div>
                <div class="modal-body">
                    <div style="display:flex; gap:8px; margin-bottom:12px;">
                        <input type="text" id="discussion-search-input" placeholder="Search across all discussions (supports * and ?)..." style="flex:1;">
                        <button id="discussion-search-run-btn" class="code-action-btn apply-btn" style="width:auto; height: 32px;">Search</button>
                    </div>
                    <div id="discussion-search-results" style="max-height: 500px; overflow-y: auto; border: 1px solid var(--vscode-widget-border); padding: 8px; border-radius: 4px;">
                        <div style="opacity:0.6; text-align:center; padding: 20px;">Enter keywords to search in titles and message history.</div>
                    </div>
                </div>
            </div>
        </div>

        <!-- NEW: Raw Code Preview Modal -->
        <div id="raw-code-modal" class="modal">
            <div class="modal-content" style="max-width: 90%; width: 800px;">
                <div class="modal-header">
                    <div style="display:flex; align-items:center; gap:15px; flex:1;">
                        <h2 style="margin:0; white-space:nowrap;">Raw Aider Block</h2>
                        <div class="raw-search-container" style="display:flex; align-items:center; gap:5px; background:var(--vscode-input-background); border:1px solid var(--vscode-input-border); padding:2px 8px; border-radius:4px; flex:1; max-width:400px;">
                            <i class="codicon codicon-search" style="font-size:12px; opacity:0.7;"></i>
                            <input type="text" id="raw-search-input" placeholder="Search in block..." style="background:transparent; border:none; color:var(--vscode-input-foreground); outline:none; font-size:11px; flex:1; padding:2px 0;">
                            <span id="raw-search-count" style="font-size:10px; opacity:0.6; min-width:35px; text-align:center;"></span>
                            <button id="raw-search-prev" class="icon-btn" style="padding:0; width:18px; height:18px;"><i class="codicon codicon-arrow-up" style="font-size:12px;"></i></button>
                            <button id="raw-search-next" class="icon-btn" style="padding:0; width:18px; height:18px;"><i class="codicon codicon-arrow-down" style="font-size:12px;"></i></button>
                        </div>
                    </div>
                    <span class="close-btn" id="raw-code-close-btn">&times;</span>
                </div>
                <div class="modal-body">
                    <pre id="raw-code-display" style="user-select: text; white-space: pre-wrap; word-break: break-all; background: var(--vscode-textCodeBlock-background); padding: 12px; border-radius: 4px; border: 1px solid var(--vscode-widget-border); max-height: 70vh; overflow-y: auto; font-family: var(--vscode-editor-font-family); font-size: 12px;"></pre>
                </div>
                <div class="modal-footer">
                    <button id="copy-raw-btn" class="code-action-btn apply-btn" style="width: 100%; justify-content: center;"><span class="codicon codicon-copy"></span> Copy to Clipboard</button>
                </div>
            </div>
        </div>

        <!-- Image Editor Modal -->
        <div id="image-editor-modal" class="editor-modal">
            <div class="editor-toolbar">
                <div class="tool-group">
                    <button class="code-action-btn" id="tool-brush" title="Brush"><i class="codicon codicon-edit"></i></button>
                    <button class="code-action-btn" id="tool-text" title="Text Area"><i class="codicon codicon-type-hierarchy"></i></button>
                    <button class="code-action-btn" id="tool-webcam" title="Webcam"><i class="codicon codicon-device-camera"></i></button>
                </div>
                <div class="tool-group">
                    <button class="code-action-btn" id="editor-undo" title="Undo"><i class="codicon codicon-discard"></i></button>
                    <button class="code-action-btn" id="editor-redo" title="Redo"><i class="codicon codicon-redo"></i></button>
                </div>
                <div class="tool-group">
                    <label>Color</label>
                    <input type="color" id="editor-color" value="#ff0000">
                </div>
                <div class="tool-group">
                    <label>Width</label>
                    <input type="number" id="editor-width" value="3" min="1" max="50">
                </div>
                <div class="tool-group">
                    <label>Font Size</label>
                    <input type="number" id="editor-font-size" value="20" min="8" max="100">
                </div>
                <div style="flex:1"></div>
                <button class="code-action-btn" id="editor-clear">Clear</button>
                <button class="code-action-btn" id="editor-cancel">Cancel</button>
                <button class="code-action-btn apply-btn" id="editor-save">Save & Close</button>
            </div>
            <div class="editor-canvas-container">
                <div id="webcam-container" style="display: none; position: absolute; z-index: 10001; background: black; flex-direction: column; align-items: center; gap: 10px; padding: 10px; border-radius: 8px;">
                    <video id="webcam-feed" autoplay playsinline style="max-width: 100%; border-radius: 4px;"></video>
                    <div style="display: flex; gap: 10px;">
                        <button class="code-action-btn secondary-btn" id="webcam-cancel">Cancel</button>
                        <button class="code-action-btn apply-btn" id="webcam-capture">Capture Photo</button>
                    </div>
                </div>
                <canvas id="image-editor-canvas"></canvas>
                <input type="text" id="canvas-text-input">
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
    
    /**
     * Core loop that fixes errors in a set of files using Aider blocks.
     */
    public async repairFilesIteratively(fileUris: vscode.Uri[], signal: AbortSignal, processId: string, messageId: string) {
        const max = this._discussionCapabilities.maxFixRetries || 3;

        for (const fileUri of fileUris) {
            const relativePath = vscode.workspace.asRelativePath(fileUri);
            let retries = 0;

            while (retries < max) {
                if (signal.aborted) break;

                const diagnostics = vscode.languages.getDiagnostics(fileUri)
                    .filter(d => d.severity === vscode.DiagnosticSeverity.Error);

                if (diagnostics.length === 0) {
                    this.log(`File ${relativePath} is now clean.`);
                    break;
                }

                retries++;
                this.processManager.updateDescription(processId, `Repairing ${path.basename(relativePath)} (${diagnostics.length} errors, attempt ${retries}/${max})...`);

                const errorReport = diagnostics.map(d => `[Line ${d.range.start.line + 1}] ${d.message}`).join('\n');
                const doc = await vscode.workspace.openTextDocument(fileUri);
                
                const repairPrompt = `### 🛑 ERRORS DETECTED IN \`${relativePath}\`
The following errors must be fixed:
${errorReport}

**FILE CONTENT:**
\`\`\`${doc.languageId}
${doc.getText()}
\`\`\`

**INSTRUCTION:**
Provide SEARCH/REPLACE blocks to resolve these specific errors. Use Aider format ONLY.`;

                const systemPrompt = "You are a surgical code repair expert. Output only Aider SEARCH/REPLACE blocks to fix the requested errors.";
                
                try {
                    const response = await this._lollmsAPI.sendChat([
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: repairPrompt }
                    ], null, signal, this._currentDiscussion?.model);

                    // Apply the fix silently
                    await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', relativePath, response, this, messageId, { silent: true });
                    
                    // Wait for diagnostics to refresh
                    await new Promise(r => setTimeout(r, 1500));
                } catch (e: any) {
                    this.log(`Repair failed for ${relativePath}: ${e.message}`, 'ERROR');
                    break;
                }
            }
        }
    }

    /**
     * Triggered by the manual "Fix All" command.
     */
    public async handleFixAllErrors() {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder || !this.processManager) return;

        const allDiagnostics = vscode.languages.getDiagnostics();
        const urisWithErrors: vscode.Uri[] = [];
        for (const [uri, diagnostics] of allDiagnostics) {
            if (diagnostics.some(d => d.severity === vscode.DiagnosticSeverity.Error)) {
                if (uri.fsPath.startsWith(workspaceFolder.uri.fsPath)) urisWithErrors.push(uri);
            }
        }

        if (urisWithErrors.length === 0) {
            vscode.window.showInformationMessage("🎉 No errors found in the workspace!");
            return;
        }

        const { id: processId, controller } = this.processManager.register(this.discussionId, `Repairing ${urisWithErrors.length} files...`);
        const autoUI = AutomationPanel.createOrShow(this._extensionUri);
        const sharedCache = new Map<string, string>(); // path -> content

        autoUI.onDidCancel(() => {
            this.processManager.cancel(processId);
            autoUI.dispose();
        });

        try {
            for (const uri of urisWithErrors) {
                if (controller.signal.aborted) break;
                const relPath = vscode.workspace.asRelativePath(uri);
                const diagnostics = vscode.languages.getDiagnostics(uri).filter(d => d.severity === vscode.DiagnosticSeverity.Error);
                
                autoUI.updateFileProgress(relPath, 'scanning', `Starting repair: ${diagnostics.length} errors detected.`, diagnostics.length);

                let hasFixed = false;
                let retries = 0;
                const max = this._discussionCapabilities.maxFixRetries || 3;

                while (retries < max && !hasFixed) {
                    if (controller.signal.aborted) break;
                    retries++;

                    const doc = await vscode.workspace.openTextDocument(uri);
                    const errorLog = diagnostics.map(d => `[Line ${d.range.start.line + 1}] ${d.message}`).join('\n');
                    
                    // Construct surgical prompt with mutualized cache
                    const cacheText = Array.from(sharedCache.entries()).map(([p,c]) => `--- ${p} ---\n${c}`).join('\n');
                    const systemPrompt = await getProcessedSystemPrompt('surgical_agent');
                    const userPrompt = `### REPAIR TASK\nFile: ${relPath}\n\nErrors:\n${errorLog}\n\nContent:\n${doc.getText()}\n\nShared Knowledge:\n${cacheText || 'No extra context cached yet.'}`;

                    autoUI.updateFileProgress(relPath, 'fixing', `Agent Decision (Attempt ${retries}/${max})...`);
                    const response = await this._lollmsAPI.sendChat([
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt }
                    ], null, controller.signal, this._currentDiscussion?.model);

                    const cleanResponse = stripThinkingTags(response);

                    // 1. Check for Context Expansion (Decision)
                    if (cleanResponse.includes('"tool"')) {
                        try {
                            const action = JSON.parse(cleanResponse.match(/\{[\s\S]*\}/)![0]);
                            if (action.tool === 'read_files') {
                                for(const p of (action.params.paths || [])) {
                                    autoUI.updateFileProgress(relPath, 'scanning', `Reading dependency: ${p}`);
                                    const content = await this._contextManager.readSpecificFiles([p]);
                                    sharedCache.set(p, content);
                                }
                                continue; // Retry fixing with new context
                            }
                        } catch(e) {}
                    }

                    // 2. Apply Aider Patch
                    autoUI.updateFileProgress(relPath, 'fixing', `Applying surgical patch...`);
                    await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', relPath, cleanResponse, this, undefined, { silent: true });
                    
                    // 3. Verify
                    await new Promise(r => setTimeout(r, 2000));
                    const currentDiags = vscode.languages.getDiagnostics(uri).filter(d => d.severity === vscode.DiagnosticSeverity.Error);
                    if (currentDiags.length === 0) {
                        autoUI.updateFileProgress(relPath, 'success', `Fixed all errors successfully!`);
                        hasFixed = true;
                    } else {
                        autoUI.updateFileProgress(relPath, 'fixing', `Reduced to ${currentDiags.length} errors.`);
                    }
                }
            }
        } finally {
            this.processManager.unregister(processId);
        }
    }
}
