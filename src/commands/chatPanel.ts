// src/commands/chatPanel.ts
import * as vscode from 'vscode';
import { LollmsAPI, ChatMessage } from '../lollmsAPI';
import { ContextManager, ContextResult } from '../contextManager';
import { Discussion, DiscussionManager } from '../discussionManager';
import { AgentManager } from '../agentManager';
import { getProcessedSystemPrompt, stripThinkingTags } from '../utils';
import * as path from 'path';
import { InfoPanel } from './infoPanel';
import { ProcessManager } from '../processManager';

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
            vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode/codicons'),
            vscode.Uri.joinPath(extensionUri, 'media'),
            vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri: extensionUri
        ],
        retainContextWhenHidden: true,
        iconPath: vscode.Uri.joinPath(extensionUri, 'media', 'lollms-icon.svg')
      }
    );

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
    this._getHtmlForWebview(this._panel.webview).then(html => {
        this._panel.webview.html = html;
        this._setWebviewMessageListener(this._panel.webview);
    });
  }

  public setContextManager(contextManager: ContextManager) {
    this._contextManager = contextManager;
  }
  
  public setProcessManager(processManager: ProcessManager) {
    this.processManager = processManager;
  }
  
  public updateGeneratingState() {
    const process = this._currentDiscussion ? this.processManager.getForDiscussion(this._currentDiscussion.id) : undefined;
    this._panel.webview.postMessage({ command: 'setGeneratingState', isGenerating: !!process });
  }

  public updateAgentMode(isActive: boolean) {
    this._panel.webview.postMessage({ command: 'updateAgentMode', isActive });
  }

  public displayPlan(plan: any | null): void {
      this._panel.webview.postMessage({ command: 'displayPlan', plan: plan });
  }
  
  public async loadDiscussion(): Promise<void> {
    this._panel.webview.postMessage({ command: 'showGlobalSpinner', show: true });
    
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

        this._panel.webview.postMessage({ 
            command: 'loadDiscussion', 
            messages: this._currentDiscussion.messages,
            isInspectorEnabled: isInspectorEnabled
        });
        
        this.displayPlan(discussion.plan);
        this.updateGeneratingState();

        this._fetchAndSetModels();
        this._updateContextAndTokens();

    } else {
        this._panel.webview.postMessage({ command: 'updateTokenProgress' }); // Ends loading state
        this._panel.webview.postMessage({ command: 'showGlobalSpinner', show: false });
        vscode.window.showErrorMessage(`Lollms: Could not load discussion ${this.discussionId}. It may have been deleted.`);
        this.dispose();
    }
  }

  private async _fetchAndSetModels() {
    let models = [];
    try {
        models = await this._lollmsAPI.getModels();
    } catch (error) {
        console.warn("Could not fetch models from the backend. The server might be offline.", error);
    }
    
    if (this._currentDiscussion) {
        this._panel.webview.postMessage({ 
            command: 'updateModels',
            models: models,
            currentModel: this._currentDiscussion.model
        });
    }
  }
  
  private _updateContextAndTokens() {
    if (!this._contextManager || !this._currentDiscussion) {
        this._panel.webview.postMessage({ command: 'updateTokenProgress' }); // This will hide the spinner
        return;
    }

    (async () => {
        try {
            const context = await this._contextManager.getContextContent();
            this._panel.webview.postMessage({ command: 'updateContext', context: context.text });
            this._panel.webview.postMessage({ command: 'updateImageContext', images: context.images });
    
            const discussionContent = this._currentDiscussion!.messages
                .map(msg => {
                    if (typeof msg.content === 'string') {
                        return msg.content;
                    }
                    if (Array.isArray(msg.content)) {
                        return msg.content
                            .filter(item => item.type === 'text' && typeof item.text === 'string')
                            .map(item => item.text)
                            .join('\n');
                    }
                    return '';
                })
                .join('\n');
            
            const fullTextToTokenize = context.text + '\n' + discussionContent;
    
            const [tokenizeResponse, contextSizeResponse] = await Promise.all([
                this._lollmsAPI.tokenize(fullTextToTokenize),
                this._lollmsAPI.getContextSize()
            ]);
            
            const totalTokens = tokenizeResponse.count;
            const contextSize = contextSizeResponse.context_size;
    
            this._panel.webview.postMessage({
                command: 'updateTokenProgress',
                totalTokens: totalTokens,
                contextSize: contextSize
            });
    
        } catch (error) {
            console.error("Failed to update tokens:", error);
            this._panel.webview.postMessage({
                command: 'updateTokenProgress',
                totalTokens: 'Error',
                contextSize: 'N/A'
            });
        }
    })();
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
    
    // Always post to webview to ensure UI consistency
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

  private async _getHtmlForWebview(webview: vscode.Webview): Promise<string> {
    const templatePath = vscode.Uri.joinPath(this._extensionUri, 'out', 'commands', 'chatPanel.html');
    const templateContent = await vscode.workspace.fs.readFile(templatePath);
    let html = Buffer.from(templateContent).toString('utf8');

    const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css'));
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'commands', 'chatPanel.css'));

    html = html.replace(/{{codiconsUri}}/g, codiconsUri.toString());
    html = html.replace(/{{cssUri}}/g, cssUri.toString());
    html = html.replace(/{{welcomeTitle}}/g, vscode.l10n.t("welcome.title"));
    html = html.replace(/{{welcomeItem1}}/g, vscode.l10n.t("welcome.item1"));
    html = html.replace(/{{welcomeItem2}}/g, vscode.l10n.t("welcome.item2"));
    html = html.replace(/{{welcomeItem3}}/g, vscode.l10n.t("welcome.item3"));
    html = html.replace(/{{welcomeItem4}}/g, vscode.l10n.t("welcome.item4"));
    html = html.replace(/{{progressLoadingFiles}}/g, vscode.l10n.t("progress.loadingFiles"));
    html = html.replace(/{{tooltipRefreshContext}}/g, vscode.l10n.t("tooltip.refreshContext"));
    
    return html;
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

  private _callApiWithMessages(messages: ChatMessage[], includeProjectContext: boolean = true, modelOverride?: string) {
    if (!this._currentDiscussion) return;
  
    (async () => {
      const { id: processId, controller } = this.processManager.register(this._currentDiscussion!.id, 'Generating chat response...');
      const assistantMessageId = 'assistant_' + Date.now().toString() + Math.random().toString(36).substring(2);
      const modelToUse = modelOverride || this._lollmsAPI.getModelName();
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
            tokenCount = (await this._lollmsAPI.tokenize(fullResponseText)).count;
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

                // Save the partially streamed content to the discussion history if there is any
                if (assistantPlaceholder.content && (assistantPlaceholder.content as string).trim() !== '') {
                    await this.addMessageToDiscussion(assistantPlaceholder);
                }

                // Add the timeout system message
                const timeoutMessage: ChatMessage = {
                    role: 'system',
                    content: `❌ **API Error:** ${error.message}`
                };
                await this.addMessageToDiscussion(timeoutMessage);
            } else {
                // For user cancellation or other errors, replace the message.
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
    if (targetMessage.role !== 'user' || (typeof targetMessage.content !== 'string' && !Array.isArray(targetMessage.content))) {
        vscode.window.showErrorMessage("Can only regenerate from a user's text message.");
        return;
    }
    const messageContent = targetMessage.content;
    
    this._currentDiscussion.messages.splice(messageIndex);
    
    if (!this._currentDiscussion.id.startsWith('temp-')) {
        await this._discussionManager.saveDiscussion(this._currentDiscussion);
    }
    
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    const isInspectorEnabled = config.get<boolean>('enableCodeInspector', true);
    const models = await this._lollmsAPI.getModels();
    this._panel.webview.postMessage({
        command: 'loadDiscussion',
        messages: this._currentDiscussion.messages,
        isInspectorEnabled: isInspectorEnabled,
        models: models,
        currentModel: this._currentDiscussion.model
    });

    const newMessageId = 'user_' + Date.now().toString() + Math.random().toString(36).substring(2);
    this._panel.webview.postMessage({ command: 'resendMessage', message: {id: newMessageId, role: 'user', content: messageContent }});
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
        vscode.commands.executeCommand('lollms-vs-coder.refreshDiscussions');
    }
    
    const models = await this._lollmsAPI.getModels();
    this._panel.webview.postMessage({ 
        command: 'loadDiscussion', 
        messages: this._currentDiscussion.messages,
        models: models,
        currentModel: this._currentDiscussion.model
    });
  }

  private async editMessage(messageId: string) {
    if (!this._currentDiscussion) return;

    const messageIndex = this._currentDiscussion.messages.findIndex(m => m.id === messageId);
    if (messageIndex === -1 || this._currentDiscussion.messages[messageIndex].role !== 'user') {
        return;
    }

    const messageContent = typeof this._currentDiscussion.messages[messageIndex].content === 'string' 
        ? this._currentDiscussion.messages[messageIndex].content 
        : '';

    await this.deleteMessage(messageId, false);
    this.setInputText(messageContent);
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
    // Use a regular ID so it's treated as a normal chat message
    const messageId = Date.now().toString() + Math.random().toString(36).substring(2);

    if (isImage) {
        // Create a user message with multipart content (text + image)
        chatMessage = {
            id: messageId,
            role: 'user',
            content: [
                { type: 'text', text: `Attached image: ${name}` },
                { type: 'image_url', image_url: { url: dataUrl } }
            ]
        };
    } else {
        // For documents, extract text and show as a system message for context
        let extractedText = '';
        let warning = '';
        try {
            const base64Data = dataUrl.split(',')[1];
            extractedText = await this._lollmsAPI.extractText(base64Data, name);
        } catch (error: any) {
            extractedText = `Error parsing file via backend: ${error.message}`;
            console.error(extractedText);
        }
        
        const fileContentBlock = `\`\`\`\n${extractedText}\n\`\`\`${warning}`;

        chatMessage = {
            id: messageId,
            role: 'system',
            content: `Attached file: **${name}**\n\n${fileContentBlock}`
        };
    }
    // This will add the message to history and send it to the webview
    await this.addMessageToDiscussion(chatMessage);
  }
    
  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(async (message) => {
      const activeWorkspaceFolder = vscode.workspace.workspaceFolders?.[0];
      switch (message.command) {
        case 'sendMessage':
          await this.sendMessage(message.message);
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
                this._currentDiscussion.model = message.model || undefined; // set to undefined if empty string
                if (!this._currentDiscussion.id.startsWith('temp-')) {
                    await this._discussionManager.saveDiscussion(this._currentDiscussion);
                }
            }
            return;
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
        case 'resendMessage':
          const userMessage = message.message;
          this._panel.webview.postMessage({ command: 'addMessage', message: userMessage });
          await this.sendMessage(userMessage);
          break;
        case 'stopGeneration':
            if (this._currentDiscussion) {
                const process = this.processManager.getForDiscussion(this._currentDiscussion.id);
                if (process) {
                    this.processManager.cancel(process.id);
                }
            } else {
                vscode.commands.executeCommand('lollms-vs-coder.stopExecution');
            }
            break;
        case 'toggleAgentMode':
          this.agentManager.toggleAgentMode();
          break;
        case 'runAgent':
          if (!this._currentDiscussion) {
            vscode.window.showErrorMessage("No active discussion. Please start a new one.");
            this.updateGeneratingState();
            return;
          }
          await this.addMessageToDiscussion(message.message);
          
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
            this.addMessageToDiscussion({ role: 'system', content: 'Agent requires an active workspace folder to run.' });
            this.updateGeneratingState();
          }
          break;
        case 'retryAgentTask':
            if (this.agentManager) {
                this.agentManager.retryFailedTask(parseInt(message.taskId, 10));
            }
            break;
        case 'displayPlan':
            this.displayPlan(message.plan);
            break;
        case 'loadFile':
            const { name, content, isImage } = message.file;
            await this._handleFileAttachment(name, content, isImage);
            break;
        case 'saveCurrentPrompt':
            vscode.commands.executeCommand('lollms-vs-coder.saveCurrentPrompt', message.text);
            break;
        case 'requestDeleteMessage':
            await this.deleteMessage(message.messageId);
            break;
        case 'removeFileFromContext':
            vscode.commands.executeCommand('lollms-vs-coder.removeFileFromContext', message.filePath);
            break;
        case 'requestLog':
          if (!this._lastApiRequest && !this._lastApiResponse) {
            InfoPanel.createOrShow(this._extensionUri, 'Lollms API Log', 'No log data available for the last interaction.');
            return;
          }

          let logContent = `# Last Lollms API Interaction\n\n`;
          logContent += `**Note:** This log shows the most recent API request and response. It may not correspond to older messages in the chat history.\n\n`;
          logContent += `## ➡️ Request Sent to Lollms\n\n`;
          
          if (this._lastApiRequest) {
            this._lastApiRequest.forEach(msg => {
              logContent += `### Role: \`${msg.role}\`\n`;
              const content = (typeof msg.content === 'string') ? msg.content : JSON.stringify(msg.content, null, 2);
              logContent += `\`\`\`\n${content}\n\`\`\`\n\n`;
            });
          } else {
            logContent += `*No request data available.*\n\n`;
          }

          logContent += `## ⬅️ Raw Response from Lollms\n\n`;

          if (this._lastApiResponse) {
            logContent += `\`\`\`\n${this._lastApiResponse}\n\`\`\`\n`;
          } else {
            logContent += `*No response data available.*\n`;
          }

          InfoPanel.createOrShow(this._extensionUri, 'Lollms API Log', logContent);
          return;
        case 'regenerateFromMessage':
            await this.regenerateFromMessage(message.messageId);
            break;
        case 'editMessage':
            await this.editMessage(message.messageId);
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
        case 'saveMarkdownToFile':
            vscode.commands.executeCommand('lollms-vs-coder.saveMarkdownToFile', message.content);
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
                    
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) {
                        throw new Error("No workspace folder is open to save the image.");
                    }
                    
                    const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, message.filePath);
                    const buffer = Buffer.from(b64_json, 'base64');
                    await vscode.workspace.fs.writeFile(fileUri, buffer);

                    const webviewUri = webview.asWebviewUri(fileUri);
                    webview.postMessage({ command: 'imageGenerationResult', buttonId: message.buttonId, success: true, webviewUri: webviewUri.toString() });
                    
                    this.addMessageToDiscussion({
                        role: 'system',
                        content: `✅ Image successfully generated and saved to \`${message.filePath}\``
                    });

                } catch (error: any) {
                    webview.postMessage({ command: 'imageGenerationResult', buttonId: message.buttonId, success: false });
                    this.addMessageToDiscussion({
                        role: 'system',
                        content: `❌ Image generation failed: ${error.message}`
                    });
                }
            });
            break;            
      }
    });
  }
}