// src/commands/chatPanel/chatPanel.ts
import * as vscode from 'vscode';
import { LollmsAPI, ChatMessage } from '../../lollmsAPI';
import { ContextManager, ContextResult } from '../../contextManager';
import { Discussion, DiscussionManager } from '../../discussionManager';
import { AgentManager } from '../../agentManager';
import { getProcessedSystemPrompt, stripThinkingTags } from '../../utils';
import * as path from 'path';
import { InfoPanel } from '../infoPanel';
import { ProcessManager } from '../../processManager';
import { getNonce } from './getNonce';

export class ChatPanel {
  public static panels: Map<string, ChatPanel> = new Map();
  public static currentPanel: ChatPanel | undefined;
  public readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _lollmsAPI: LollmsAPI;
  private _contextManager!: ContextManager;
  private _discussionManager!: DiscussionManager;
  private _currentDiscussion: Discussion | null = null;
  public agentManager!: AgentManager;
  private _lastApiRequest: ChatMessage[] | null = null;
  private _lastApiResponse: string | null = null;
  private processManager!: ProcessManager;
  private readonly discussionId: string;
  private _isWebviewReady = false;
  private _isLoadPending = false;


  public static createOrShow(extensionUri: vscode.Uri, lollmsAPI: LollmsAPI, discussionManager: DiscussionManager, discussionId: string): ChatPanel {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

    const existingPanel = ChatPanel.panels.get(discussionId);
    if (existingPanel) {
      existingPanel._panel.reveal(column);
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

    const newPanel = new ChatPanel(panel, extensionUri, lollmsAPI, discussionManager, discussionId);
    ChatPanel.panels.set(discussionId, newPanel);
    return newPanel;
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, lollmsAPI: LollmsAPI, discussionManager: DiscussionManager, discussionId: string) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._lollmsAPI = lollmsAPI;
    this._discussionManager = discussionManager;
    this.discussionId = discussionId;

    panel.onDidChangeViewState(e => {
        if (e.webviewPanel.active) {
            ChatPanel.currentPanel = this;
        }
    });

    this._panel.onDidDispose(() => this.dispose(), null, []);
    this._updateHtmlForWebview(); 
    this._setWebviewMessageListener(this._panel.webview);
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
    if (this._panel.webview) {
        const process = this._currentDiscussion ? this.processManager.getForDiscussion(this._currentDiscussion.id) : undefined;
        this._panel.webview.postMessage({ command: 'setGeneratingState', isGenerating: !!process });
    }
  }

  public updateAgentMode(isActive: boolean) {
    if (this._panel.webview) {
        this._panel.webview.postMessage({ command: 'updateAgentMode', isActive });
    }
  }

  public displayPlan(plan: any | null): void {
      if (this._panel.webview) {
        this._panel.webview.postMessage({ command: 'displayPlan', plan: plan });
      }
  }
  
  public async loadDiscussion(): Promise<void> {
    console.log("ChatPanel: loadDiscussion called for", this.discussionId);
    if (!this._isWebviewReady) {
        console.log("ChatPanel: Webview not ready, queuing load.");
        this._isLoadPending = true;
        return;
    }
    this._isLoadPending = false;

    let discussion: Discussion | null;
    if (this.discussionId.startsWith('temp-')) {
        discussion = {
            id: this.discussionId,
            title: 'Temporary Discussion',
            messages: [],
            timestamp: Date.now(),
            groupId: null,
            plan: null
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

        if (needsSave && !discussion.id.startsWith('temp-')) {
            await this._discussionManager.saveDiscussion(discussion);
        }

        this._currentDiscussion = discussion;
        this._panel.title = this._currentDiscussion.title;

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const isInspectorEnabled = config.get<boolean>('enableCodeInspector', true);

        console.log("ChatPanel: Sending loadDiscussion message to webview with", this._currentDiscussion.messages.length, "messages");
        // 1. Render the discussion UI first
        await this._panel.webview.postMessage({ 
            command: 'loadDiscussion', 
            messages: this._currentDiscussion.messages,
            isInspectorEnabled: isInspectorEnabled
        });
        
        this.displayPlan(discussion.plan);
        this.updateGeneratingState();

        // 2. Then load models (using cache if available)
        await this._fetchAndSetModels(false);

        // 3. Finally compute tokens and context (heavy operation)
        this._updateContextAndTokens();

    } else {
        this._panel.webview.postMessage({ command: 'updateTokenProgress' });
        vscode.window.showErrorMessage(`Lollms: Could not load discussion ${this.discussionId}. It may have been deleted.`);
        this.dispose();
    }
  }

  private async _fetchAndSetModels(forceRefresh: boolean = false) {
    try {
        if (!this._panel.webview) return;
        let models: Array<{ id: string }> = [];
        try {
            // Pass the forceRefresh flag to the API
            models = await this._lollmsAPI.getModels(forceRefresh);
        } catch (error) {
            console.warn("Lollms: Could not fetch models from the backend.", error);
        }
        
        if (this._currentDiscussion) {
            this._panel.webview.postMessage({ 
                command: 'updateModels',
                models: models,
                currentModel: this._currentDiscussion.model
            });
        }
    } catch (e) {
        console.error("Lollms: Unexpected error in _fetchAndSetModels", e);
    }
  }
  
  private _updateContextAndTokens() {
    try {
        if (!this._contextManager || !this._currentDiscussion || !this._panel.webview) {
            this._panel.webview?.postMessage({ command: 'updateTokenProgress' });
            return;
        }
        this._panel.webview.postMessage({ command: 'startContextLoading' });

        (async () => {
            try {
                const context = await this._contextManager.getContextContent();
                this._panel.webview.postMessage({ command: 'updateContext', context: context.text });
                this._panel.webview.postMessage({ command: 'updateImageContext', images: context.images });
        
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
                    console.warn("Lollms: No model selected for token calculation. Skipping token count.");
                    this._panel.webview.postMessage({
                        command: 'updateTokenProgress',
                        error: `No model configured`
                    });
                    return;
                }
        
                const [tokenizeResponse, contextSizeResponse] = await Promise.all([
                    this._lollmsAPI.tokenize(fullTextToTokenize, modelForTokenization),
                    this._lollmsAPI.getContextSize(modelForTokenization)
                ]);
                
                this._panel.webview.postMessage({
                    command: 'updateTokenProgress',
                    totalTokens: tokenizeResponse.count,
                    contextSize: contextSizeResponse.context_size
                });
        
            } catch (error: any) {
                console.error("Failed to update tokens:", error);
                this._panel.webview.postMessage({
                    command: 'updateTokenProgress',
                    error: `API Error. Check console.`
                });
            }
        })();
    } catch (e) {
        console.error("Lollms: Unexpected error in _updateContextAndTokens", e);
    }
  }

  public getCurrentDiscussionId(): string | null {
    return this._currentDiscussion?.id || null;
  }
  
  public async addMessageToDiscussion(message: ChatMessage): Promise<void> {
    if (!this._currentDiscussion) return;
    
    if (!message.id) {
        message.id = Date.now().toString() + Math.random().toString(36).substring(2);
    }
    
    const existingMessageIndex = this._currentDiscussion.messages.findIndex(m => m.id === message.id);
    if (existingMessageIndex !== -1) {
        this._currentDiscussion.messages[existingMessageIndex] = message;
    } else {
        this._currentDiscussion.messages.push(message);
    }
    
    this._panel.webview.postMessage({ command: 'addMessage', message: message });

    if (!this._currentDiscussion.id.startsWith('temp-')) {
        this._currentDiscussion.timestamp = Date.now();
        await this._discussionManager.saveDiscussion(this._currentDiscussion);
        vscode.commands.executeCommand('lollms-vs-coder.refreshDiscussions');
    }
  }

  public setInputText(text: string) {
    this._panel.webview.postMessage({ command: 'setInputText', text: text });
  }

  public dispose() {
    ChatPanel.panels.delete(this.discussionId);
    if (ChatPanel.currentPanel === this) {
        ChatPanel.currentPanel = undefined;
        if (ChatPanel.panels.size > 0) {
            ChatPanel.currentPanel = ChatPanel.panels.values().next().value;
        }
    }
    this._panel.dispose();
  }

  public async handleProjectExecutionResult(output: string, success: boolean) {
    if (!this._currentDiscussion) {
        this.updateGeneratingState();
        return;
    }

    const resultMessage: ChatMessage = {
        role: 'system',
        content: `**Project Execution Result (Success: ${success})**\n\n\`\`\`\n${output || '(No output)'}\n\`\`\``
    };

    await this.addMessageToDiscussion(resultMessage);
    
    if (!success) {
        const analysisPrompt: ChatMessage = {
            role: 'user',
            content: `The project failed to execute with the output shown in the last system message. Please analyze the error and provide a fix for the relevant file(s).`
        };
        this._callApiWithMessages([...this._currentDiscussion.messages, analysisPrompt], true, this._currentDiscussion.model);
    } else {
        this.updateGeneratingState();
    }
  }
  
  public async analyzeExecutionResult(code: string, language: string, output: string, exitCode: number | null) {
    if (!this._currentDiscussion) {
      return;
    }

    this.updateGeneratingState();

    const success = exitCode === 0;
    let analysisPromptContent: string;

    if (success) {
      analysisPromptContent = `The previous script executed successfully. Briefly acknowledge this success with a confirmation message.`;
    } else {
        analysisPromptContent = `ATTENTION: The last code block you provided for ${language} failed to execute. The user ran your code, and it produced the error shown in the last system message.

Your task is to re-analyze your previous code suggestion in light of this new error. Provide a new, complete, and corrected version of the entire script.

**CRITICAL INSTRUCTIONS:**
1.  DO NOT apologize or use conversational filler.
2.  DO NOT use placeholders or omit any part of the code.
3.  Your response MUST contain the full, runnable script in a single markdown code block.
4.  After the code block, briefly explain the specific change you made to fix the error.`;
    }
    
    const analysisPrompt: ChatMessage = { role: 'user', content: analysisPromptContent };
    
    const recentMessages = this._currentDiscussion.messages.slice(-6);
    const messagesForApi = [...recentMessages, analysisPrompt];

    this._callApiWithMessages(messagesForApi, false, this._currentDiscussion.model);
  }

  public async handleInspectCode(message: { code: string, language: string }) {
    if (!this._currentDiscussion || !this._discussionManager) {
        vscode.window.showErrorMessage("No active discussion to show inspection results.");
        return;
    }

    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    if (!config.get('enableCodeInspector')) {
        return;
    }

    const inspectorModel = config.get<string>('inspectorModelName') || this._currentDiscussion.model || this._lollmsAPI.getModelName();
    const systemPrompt = getProcessedSystemPrompt('inspector');

    if (!systemPrompt) {
        this.addMessageToDiscussion({ role: 'system', content: '❌ Inspection failed: Inspector system prompt could not be generated.' });
        return;
    }

    this.addMessageToDiscussion({ 
        role: 'system', 
        content: `🔍 Inspecting code with \`${inspectorModel}\`...` 
    });
    this._panel.webview.postMessage({ command: 'forceScrollToBottom' });

    const inspectionMessages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Inspect the following ${message.language} code block:\n\n\`\`\`${message.language}\n${message.code}\n\`\`\`` }
    ];

    this._callApiWithMessages(inspectionMessages, false, inspectorModel);
  }

  public async sendIsolatedMessage(systemPrompt: string, userMessageContent: string, modelOverride?: string) {
    if (!this._currentDiscussion) {
        vscode.window.showErrorMessage("No active discussion to send isolated message.");
        return;
    }
    
    const userMessage: ChatMessage = {
        id: 'user_' + Date.now().toString() + Math.random().toString(36).substring(2),
        role: 'user',
        content: userMessageContent
    };

    await this.addMessageToDiscussion(userMessage);

    const messagesForApi: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        userMessage
    ];
    
    this._callApiWithMessages(messagesForApi, false, modelOverride);
  }
  public async sendMessage(userMessage: ChatMessage) {
    if (!this._currentDiscussion) {
        vscode.window.showErrorMessage("No active discussion. Please start a new one.");
        return;
    }

    await vscode.workspace.saveAll();
    
    const isFirstMessage = this._currentDiscussion.messages.filter(m => m.role !== 'system').length === 0;

    await this.addMessageToDiscussion(userMessage);
    
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

    this._callApiWithMessages(this._currentDiscussion.messages, true, this._currentDiscussion.model);
  }

  private async regenerateFromMessage(messageId: string) {
    if (!this._currentDiscussion) return;

    const messageIndex = this._currentDiscussion.messages.findIndex(m => m.id === messageId);

    if (messageIndex === -1) {
        vscode.window.showErrorMessage("Could not find the message to regenerate from.");
        return;
    }
    const targetMessage = this._currentDiscussion.messages[messageIndex];
    if (targetMessage.role !== 'user') return;
    
    this._currentDiscussion.messages.splice(messageIndex);
    
    if (!this._currentDiscussion.id.startsWith('temp-')) {
        await this._discussionManager.saveDiscussion(this._currentDiscussion);
    }
    
    await this.loadDiscussion(); // Reload the UI with truncated history

    // Resend the message
    await this.sendMessage(targetMessage);
  }

  private async deleteMessage(messageId: string, showConfirmation: boolean = true) {
    if (!this._currentDiscussion) return;

    if (showConfirmation) {
        const confirm = await vscode.window.showWarningMessage(
            'Are you sure you want to delete this message or attachment?',
            { modal: true },
            'Delete'
        );
        if (confirm !== 'Delete') return;
    }
    
    this._currentDiscussion.messages = this._currentDiscussion.messages.filter(msg => msg.id !== messageId);
    
    if (!this._currentDiscussion.id.startsWith('temp-')) {
        await this._discussionManager.saveDiscussion(this._currentDiscussion);
    }
    
    await this.loadDiscussion(); // Reload to show the change
  }

  private async insertMessage(afterMessageId: string, role: 'user' | 'assistant', content: string) {
    if (!this._currentDiscussion) return;

    const messageIndex = this._currentDiscussion.messages.findIndex(m => m.id === afterMessageId);
    
    const newMessage: ChatMessage = {
        id: Date.now().toString() + Math.random().toString(36).substring(2),
        role: role,
        content: content
    };

    if (messageIndex === -1) {
        this._currentDiscussion.messages.push(newMessage);
    } else {
        this._currentDiscussion.messages.splice(messageIndex + 1, 0, newMessage);
    }

    if (!this._currentDiscussion.id.startsWith('temp-')) {
        await this._discussionManager.saveDiscussion(this._currentDiscussion);
    }
    await this.loadDiscussion();
  }

  private async updateMessage(messageId: string, newContent: string) {
    if (!this._currentDiscussion) return;

    const messageIndex = this._currentDiscussion.messages.findIndex(m => m.id === messageId);
    if (messageIndex !== -1) {
        this._currentDiscussion.messages[messageIndex].content = newContent;
        if (!this._currentDiscussion.id.startsWith('temp-')) {
            await this._discussionManager.saveDiscussion(this._currentDiscussion);
        }
    }
  }

  private async _handleFileAttachment(name: string, dataUrl: string, isImage: boolean) {
    let chatMessage: ChatMessage;
    const messageId = Date.now().toString() + Math.random().toString(36).substring(2);

    if (isImage) {
        chatMessage = {
            id: 'user_img_' + messageId,
            role: 'user',
            content: [
                { type: 'text', text: `Attached image: ${name}` },
                { type: 'image_url', image_url: { url: dataUrl } }
            ]
        };
    } else {
        let extractedText = '';
        try {
            const base64Data = dataUrl.split(',')[1];
            extractedText = await this._lollmsAPI.extractText(base64Data, name);
        } catch (error: any) {
            extractedText = `⚠️ **Error processing document on backend:** ${error.message}`;
        }
        
        chatMessage = {
            id: 'attachment_' + messageId,
            role: 'system',
            content: `Attached file: **${name}**\n\n\`\`\`\n${extractedText}\n\`\`\``
        };
    }
    await this.addMessageToDiscussion(chatMessage);
  }
    
  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(async (message) => {
      console.log("Lollms: Received message from webview:", message.command, message);
      const activeWorkspaceFolder = vscode.workspace.workspaceFolders?.[0];
      switch (message.command) {
        case 'webview-html-loaded':
            console.log("ChatPanel: HTML Loaded signal received.");
            break;
        case 'webview-ready':
            console.log("ChatPanel: JS Ready signal received.");
            this._isWebviewReady = true;
            if (this._isLoadPending) {
                this.loadDiscussion();
            }
            return;
        case 'showError':
            vscode.window.showErrorMessage(message.message);
            break;
        case 'sendMessage':
          await this.sendMessage(message.message);
          break;
        case 'addMessage':
          await this.addMessageToDiscussion(message.message);
          break;
        case 'applyAllChanges':
            vscode.commands.executeCommand('lollms-vs-coder.applyAllChanges', message);
            break;
        case 'renameFile':
            vscode.commands.executeCommand('lollms-vs-coder.renameFile', message.originalPath, message.newPath);
            break;
        case 'deleteFile':
            vscode.commands.executeCommand('lollms-vs-coder.deleteFile', message.filePaths);
            break;
        case 'addFilesToContext':
            vscode.commands.executeCommand('lollms-vs-coder.addFilesToContext', message.files);
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
            const { name, content, isImage } = message.file;
            await this._handleFileAttachment(name, content, isImage);
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
          if (!this._lastApiRequest && !this._lastApiResponse) {
            InfoPanel.createOrShow(this._extensionUri, 'Lollms API Log', 'No log data available.');
            return;
          }
          let logContent = `## ➡️ Request\n\n\`\`\`json\n${JSON.stringify(this._lastApiRequest, null, 2)}\n\`\`\`\n\n## ⬅️ Response\n\n\`\`\`\n${this._lastApiResponse}\n\`\`\``;
          InfoPanel.createOrShow(this._extensionUri, 'Lollms API Log', logContent);
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
            vscode.commands.executeCommand('lollms-vs-coder.applyFileContent', message.filePath, message.content);
            break;
        case 'applyPatchContent':
            vscode.commands.executeCommand('lollms-vs-coder.applyPatchContent', message.filePath, message.content);
            break;
        case 'runScript':
            vscode.commands.executeCommand('lollms-vs-coder.runScript', message.code, message.language);
            break;
        case 'executeProject':
            await vscode.commands.executeCommand('lollms-vs-coder.executeProject');
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
                    if (activeWorkspaceFolder) {
                        const fileUri = vscode.Uri.joinPath(activeWorkspaceFolder.uri, message.filePath);
                        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(b64_json, 'base64'));
                        const webviewUri = webview.asWebviewUri(fileUri);
                        webview.postMessage({ command: 'imageGenerationResult', buttonId: message.buttonId, success: true, webviewUri: webviewUri.toString() });
                    }
                } catch (error: any) {
                    webview.postMessage({ command: 'imageGenerationResult', buttonId: message.buttonId, success: false });
                    this.addMessageToDiscussion({ role: 'system', content: `❌ Image generation failed: ${error.message}` });
                }
            });
            break;            
      }
    });
  }

  private _callApiWithMessages(messages: ChatMessage[], includeProjectContext: boolean = true, modelOverride?: string) {
    if (!this._currentDiscussion) return;
  
    (async () => {
      const { id: processId, controller } = this.processManager.register(this._currentDiscussion!.id, 'Generating chat response...');
      const assistantMessageId = 'assistant_' + Date.now().toString() + Math.random().toString(36).substring(2);
      const modelToUse = modelOverride || this._currentDiscussion?.model || this._lollmsAPI.getModelName();
      const assistantPlaceholder: ChatMessage = { 
          id: assistantMessageId, 
          role: 'assistant', 
          content: '',
          startTime: Date.now(),
          model: modelToUse
      };
      
      try {
        const apiMessages: ChatMessage[] = [];
        const systemPrompt = getProcessedSystemPrompt('chat');
        if (systemPrompt) {
          apiMessages.push({ role: 'system', content: systemPrompt });
        }
  
        const messagesCopy = JSON.parse(JSON.stringify(messages));
  
        if (includeProjectContext) {
          const context: ContextResult = this._contextManager ? await this._contextManager.getContextContent() : { text: '', images: [] };
          if (context.text && context.text.trim().length > 0) {
            apiMessages.push({ role: 'system', content: `## Project Context\n${context.text}` });
          }
          if (context.images.length > 0) {
            let lastUserMessage = null;
            for (let i = messagesCopy.length - 1; i >= 0; i--) {
                if (messagesCopy[i].role === 'user') {
                    lastUserMessage = messagesCopy[i];
                    break;
                }
            }
            if (lastUserMessage) {
                if (typeof lastUserMessage.content === 'string') {
                    lastUserMessage.content = [{ type: 'text', text: lastUserMessage.content }];
                }
                for (const image of context.images) {
                    (lastUserMessage.content as any[]).push({
                        type: 'image_url',
                        image_url: { url: image.data, detail: "auto" }
                    });
                }
            }
          }
        }

        apiMessages.push(...messagesCopy);
  
        this._lastApiRequest = apiMessages;
  
        this._panel.webview.postMessage({ command: 'addMessage', message: assistantPlaceholder });
  
        const onChunk = (chunk: string) => {
          if (controller.signal.aborted) return;
          (assistantPlaceholder.content as string) += chunk;
          this._panel.webview.postMessage({ command: 'appendMessageChunk', id: assistantMessageId, chunk: chunk });
        };
  
        const fullResponseText = await this._lollmsAPI.sendChat(apiMessages, onChunk, controller.signal, modelToUse);
        this._lastApiResponse = fullResponseText;
  
        if (controller.signal.aborted) { return; }
        
        let tokenCount = 0;
        try {
            const modelForTokenization = modelToUse || this._lollmsAPI.getModelName();
            tokenCount = (await this._lollmsAPI.tokenize(fullResponseText, modelForTokenization)).count;
        } catch(e) {
            console.error("Could not tokenize final response, TPS will be unavailable.", e);
        }

        this._panel.webview.postMessage({ 
            command: 'finalizeMessage', 
            id: assistantMessageId, 
            fullContent: fullResponseText,
            tokenCount: tokenCount
        });
        
        assistantPlaceholder.content = fullResponseText;
        await this.addMessageToDiscussion(assistantPlaceholder);
  
      } catch (error: any) {
        try {
            const isAbortError = error.name === 'AbortError' || (error instanceof Error && error.message.includes('aborted'));
            const isTimeoutError = error instanceof Error && error.message.includes('timed out');

            if (isTimeoutError) {
                this._lastApiResponse = error.message;

                if (assistantPlaceholder.content && (assistantPlaceholder.content as string).trim() !== '') {
                    await this.addMessageToDiscussion(assistantPlaceholder);
                }

                const timeoutMessage: ChatMessage = {
                    role: 'system',
                    content: `❌ **API Error:** ${error.message}`
                };
                await this.addMessageToDiscussion(timeoutMessage);
            } else {
                const errorMessage = isAbortError ? 'Generation stopped by user.' : (error instanceof Error ? error.message : 'An unknown error occurred');
                this._lastApiResponse = errorMessage;

                const errorContent = `<p style="color:var(--vscode-errorForeground);">❌ **${isAbortError ? 'Cancelled' : 'API Error'}:**</p><pre style="background-color:var(--vscode-textCodeBlock-background); padding:10px; border-radius:4px; white-space:pre-wrap;">${errorMessage}</pre>`;

                this._panel.webview.postMessage({ 
                    command: 'finalizeMessage', 
                    id: assistantMessageId, 
                    fullContent: errorContent,
                    isHtml: true,
                    tokenCount: 0
                });

                assistantPlaceholder.content = errorContent;
                assistantPlaceholder.role = 'system';
                await this.addMessageToDiscussion(assistantPlaceholder);
            }
        } catch (secondaryError) {
            console.error("Error while handling initial API error:", secondaryError);
        }
      } finally {
        this.processManager.unregister(processId);
      }
    })();
  }

  private async _getHtmlForWebview(webview: vscode.Webview): Promise<string> {
    const nonce = getNonce();

    const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'));
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'chatPanel.css'));
    const prismThemeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'prism-tomorrow.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'chatPanel.bundle.js'));

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
</head>
<body>
    <div class="chat-container">
        <div class="messages" id="messages">
            <div class="search-bar" id="search-bar" style="display: none;">
                <input type="text" id="searchInput" placeholder="Search discussion...">
                <span id="search-results-count"></span>
                <button id="search-prev" title="Previous match"><i class="codicon codicon-arrow-up"></i></button>
                <button id="search-next" title="Next match"><i class="codicon codicon-arrow-down"></i></button>
                <button id="search-close" title="Close search"><i class="codicon codicon-close"></i></button>
            </div>
            
            <div id="context-container"></div>
            
            <details id="attachments-collapsible-wrapper" class="info-collapsible" style="display: none;" open>
                <summary id="attachments-summary">📎 Added Files</summary>
                <div id="attachments-container" class="collapsible-content" style="padding: 5px 0 0 0;">
                </div>
            </details>
            
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

        <div id="tools-modal" class="modal">
            <div class="modal-content">
                <div class="modal-header">
                    <h2>Configure Tools</h2>
                    <span class="close-btn" id="close-tools-modal">&times;</span>
                </div>
                <div class="modal-body" id="tools-list"></div>
                <div class="modal-footer">
                    <button id="save-tools-btn">OK</button>
                </div>
            </div>
        </div>

        <div class="input-area-wrapper">
            <div id="more-actions-menu">
                <button class="menu-item" id="attachButton"><i class="codicon codicon-add"></i><span>Attach Files</span></button>
                <button class="menu-item" id="configureToolsButton"><i class="codicon codicon-tools"></i><span>Configure Tools</span></button>
                <button class="menu-item" id="setEntryPointButton"><i class="codicon codicon-target"></i><span>Set Project Entry Point</span></button>
                <button class="menu-item" id="executeButton"><i class="codicon codicon-play"></i><span>Execute Project</span></button>
                <button class="menu-item" id="debugRestartButton"><i class="codicon codicon-debug-restart"></i><span>Re-run Last Debug</span></button>
            </div>

            <div class="top-controls">
                <div class="token-progress">
                    <div class="token-progress-container">
                        <div class="token-progress-bar" id="token-progress-bar"></div>
                    </div>
                    <div id="context-status-container" style="display: flex; align-items: center; gap: 8px;">
                        <span id="token-count-label">Tokens: 0 / 0</span>
                        <button id="refresh-context-btn"><i class="codicon codicon-sync"></i></button>
                    </div>
                    <div id="context-loading-spinner" style="display: none; align-items: center; gap: 8px; font-size: 0.9em; color: var(--vscode-descriptionForeground);">
                        <div class="spinner"></div>
                        <span id="loading-files-text"></span>
                    </div>
                </div>
                <div class="model-selector-container">
                    <label for="model-selector">Model:</label>
                    <select id="model-selector"></select>
                    <button id="refresh-models-btn" title="Refresh Models" class="icon-btn"><i class="codicon codicon-refresh"></i></button>
                </div>
                <div class="agent-mode-toggle">
                    <span>🤖 Agent Mode</span>
                    <label class="switch">
                        <input type="checkbox" id="agentModeCheckbox">
                        <span class="slider"></span>
                    </label>
                </div>
            </div>
            <div class="input-area">
                <div class="control-buttons">
                    <button id="moreActionsButton" title="More Actions"><i class="codicon codicon-ellipsis"></i></button>
                </div>
                <textarea id="messageInput" placeholder="Enter your message (Shift+Enter for new line)..." rows="1"></textarea>
                <div class="control-buttons">
                    <button id="sendButton" title="Send Message"><i class="codicon codicon-send"></i></button>
                    <button id="stopButton" title="Stop Generation" style="display: none;">
                        <div class="spinner"></div>
                        <span>Stop</span>
                    </button>
                </div>
            </div>
        </div>
    </div>

    <input type="file" id="fileInput" style="display: none;" multiple accept=".md,.txt,.msg,.docx,.pdf,.pptx,.xlsx,.csv,.png,.jpg,.jpeg,.bmp,.webp">

    <script nonce="${nonce}">
        // BOOTSTRAP SCRIPT
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
