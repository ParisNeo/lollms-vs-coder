import * as vscode from 'vscode';
import { LollmsAPI, ChatMessage } from '../lollmsAPI';
import { ContextManager, ContextResult } from '../contextManager';
import { Discussion, DiscussionManager } from '../discussionManager';
import { AgentManager } from '../agentManager';
import { getProcessedSystemPrompt, stripThinkingTags } from '../utils';
import * as path from 'path';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';
import * as ExcelJS from 'exceljs';
import { Readable } from 'stream';
import { InfoPanel } from './infoPanel';
import { ProcessManager } from '../processManager';


export class ChatPanel {
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


  public static createOrShow(extensionUri: vscode.Uri, lollmsAPI: LollmsAPI, discussionManager: DiscussionManager): ChatPanel {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

    if (ChatPanel.currentPanel) {
      ChatPanel.currentPanel._panel.reveal(column);
      return ChatPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'lollmsChat',
      'Lollms Chat',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [
            extensionUri,
            vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode/codicons', 'dist')
        ],
        retainContextWhenHidden: true
      }
    );

    ChatPanel.currentPanel = new ChatPanel(panel, extensionUri, lollmsAPI, discussionManager);
    return ChatPanel.currentPanel;
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, lollmsAPI: LollmsAPI, discussionManager: DiscussionManager) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._lollmsAPI = lollmsAPI;
    this._discussionManager = discussionManager;

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
  
  public async loadDiscussion(id: string): Promise<void> {
    const discussion = await this._discussionManager.getDiscussion(id);

    if (discussion) {
        let needsSave = false;
        discussion.messages.forEach(msg => {
            if (!msg.id) {
                msg.id = Date.now().toString() + Math.random().toString(36).substring(2);
                needsSave = true;
            }
        });

        if (needsSave) {
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
        
        this.displayPlan(null);
        this.updateGeneratingState();
        await this._updateContextAndTokens();
    }
  }
  public async startNewDiscussion(groupId: string | null = null): Promise<void> {
    this._currentDiscussion = this._discussionManager.createNewDiscussion(groupId);
    await this._discussionManager.saveDiscussion(this._currentDiscussion);
    this._panel.title = this._currentDiscussion.title;
    this._panel.webview.postMessage({ command: 'loadDiscussion', messages: this._currentDiscussion.messages });
    this.displayPlan(null); // Clear plan for new discussion
    this.updateGeneratingState();
    this._updateContextAndTokens();
  }
  
  private async _updateContextAndTokens() {
    if (!this._contextManager || !this._currentDiscussion) return;

    try {
        const context = await this._contextManager.getContextContent();
        this._panel.webview.postMessage({ command: 'updateContext', context: context.text });
        this._panel.webview.postMessage({ command: 'updateImageContext', images: context.images });

        const discussionContent = this._currentDiscussion.messages
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

        const fullLimitWarningId = 'context-limit-warning';
        const quarterLimitWarningId = 'context-quarter-limit-warning';

        const hasFullWarning = this._currentDiscussion.messages.some(m => m.id === fullLimitWarningId);
        const hasQuarterWarning = this._currentDiscussion.messages.some(m => m.id === quarterLimitWarningId);

        if (totalTokens > contextSize) {
            if (hasQuarterWarning) {
                await this.deleteMessage(quarterLimitWarningId, false);
            }
            const message: ChatMessage = {
                id: fullLimitWarningId,
                role: 'system',
                content: `⚠️ **Warning:** The discussion size (${totalTokens} tokens) has exceeded the model's context limit (${contextSize} tokens). The earliest messages may not be included in the context.`
            };
            await this.addMessageToDiscussion(message);
        } else if (totalTokens > (contextSize * 0.75)) {
            if (hasFullWarning) {
                await this.deleteMessage(fullLimitWarningId, false);
            }
            const message: ChatMessage = {
                id: quarterLimitWarningId,
                role: 'system',
                content: `⚠️ **Warning:** The discussion size (${totalTokens} tokens) has exceeded 75% of the model's context limit (${contextSize} tokens). Very long responses may be truncated.`
            };
            await this.addMessageToDiscussion(message);
        } else {
            if (hasFullWarning) {
                await this.deleteMessage(fullLimitWarningId, false);
            }
            if (hasQuarterWarning) {
                await this.deleteMessage(quarterLimitWarningId, false);
            }
        }

    } catch (error) {
        console.error("Failed to update tokens:", error);
        this._panel.webview.postMessage({
            command: 'updateTokenProgress',
            totalTokens: 'Error',
            contextSize: 'N/A'
        });
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
        if (this._currentDiscussion.messages[existingMessageIndex].content === message.content) return;
        this._currentDiscussion.messages[existingMessageIndex] = message;
    } else {
        this._currentDiscussion.messages.push(message);
    }

    this._currentDiscussion.timestamp = Date.now();
    await this._discussionManager.saveDiscussion(this._currentDiscussion);
    
    // Only post back messages that didn't originate from the user to avoid duplication
    if (message.role !== 'user') {
        this._panel.webview.postMessage({ command: 'addMessage', message: message });
    }

    this._updateContextAndTokens();
    vscode.commands.executeCommand('lollms-vs-coder.refreshDiscussions');
  }

  public setInputText(text: string) {
    this._panel.webview.postMessage({ command: 'setInputText', text: text });
  }

  public dispose() {
    ChatPanel.currentPanel = undefined;
    this._panel.dispose();
  }

  private async _getHtmlForWebview(webview: vscode.Webview): Promise<string> {
    const templatePath = vscode.Uri.joinPath(this._extensionUri, 'src', 'commands', 'chatPanel.html');
    const templateContent = await vscode.workspace.fs.readFile(templatePath);
    let html = Buffer.from(templateContent).toString('utf8');

    const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css'));
    
    html = html.replace(/{{codiconsUri}}/g, codiconsUri.toString());
    html = html.replace(/{{welcomeTitle}}/g, vscode.l10n.t("welcome.title"));
    html = html.replace(/{{welcomeItem1}}/g, vscode.l10n.t("welcome.item1"));
    html = html.replace(/{{welcomeItem2}}/g, vscode.l10n.t("welcome.item2"));
    html = html.replace(/{{welcomeItem3}}/g, vscode.l10n.t("welcome.item3"));
    html = html.replace(/{{welcomeItem4}}/g, vscode.l10n.t("welcome.item4"));

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
        this._callApiWithMessages([...this._currentDiscussion.messages, analysisPrompt]);
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

    this._callApiWithMessages(messagesForApi, false);
  }

  private _callApiWithMessages(messages: ChatMessage[], includeProjectContext: boolean = true, modelOverride?: string) {
    if (!this._currentDiscussion) return;

    (async () => {
        const { id, controller } = this.processManager.register(this._currentDiscussion!.id, 'Generating chat response...');
        
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
            const responseText = await this._lollmsAPI.sendChat(apiMessages, controller.signal, modelOverride);
            this._lastApiResponse = responseText;
            
            if (controller.signal.aborted) { return; }
            
            const assistantMessage: ChatMessage = { role: 'assistant', content: responseText };
            
            await this.addMessageToDiscussion(assistantMessage);
        
        } catch (error: any) {
            const isAbortError = error.name === 'AbortError' || (error instanceof Error && error.message.includes('aborted'));
            if (isAbortError) {
                console.log('Generation was aborted.');
                return;
            }

            const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
            this._lastApiResponse = errorMessage;
            const errorResponseMessage: ChatMessage = { role: 'system', content: `Sorry, I encountered an error: ${errorMessage}` };
            await this.addMessageToDiscussion(errorResponseMessage);
        } finally {
            this.processManager.unregister(id);
        }
    })();
  }

  public async startDiscussionWithPrompt(prompt: string): Promise<void> {
    
    this._currentDiscussion = this._discussionManager.createNewDiscussion();

    const userMessage: ChatMessage = {
        id: 'user_' + Date.now().toString() + Math.random().toString(36).substring(2),
        role: 'user',
        content: prompt
    };
    this._currentDiscussion.messages.push(userMessage);
    this._currentDiscussion.timestamp = Date.now();
    await this._discussionManager.saveDiscussion(this._currentDiscussion);

    this._panel.title = this._currentDiscussion.title;
    this._panel.webview.postMessage({ command: 'loadDiscussion', messages: this._currentDiscussion.messages });
    this.displayPlan(null);
    
    vscode.commands.executeCommand('lollms-vs-coder.refreshDiscussions');

    await this._updateContextAndTokens();

    (async () => {
        const newTitle = await this._discussionManager.generateDiscussionTitle(this._currentDiscussion!);
        if (newTitle && this._currentDiscussion) {
            this._currentDiscussion.title = newTitle;
            this._panel.title = newTitle;
            await this._discussionManager.saveDiscussion(this._currentDiscussion);
            vscode.commands.executeCommand('lollms-vs-coder.refreshDiscussions');
        }
    })();

    this._callApiWithMessages(this._currentDiscussion.messages);
}
  public async sendMessage(userMessage: ChatMessage) {
    if (!this._currentDiscussion) {
        vscode.window.showErrorMessage("No active discussion. Please start a new one.");
        return;
    }

    await vscode.workspace.saveAll();
    
    const isFirstMessage = this._currentDiscussion.messages.filter(m => m.role !== 'system').length === 0;

    this._currentDiscussion.messages.push(userMessage);
    this._currentDiscussion.timestamp = Date.now();
    await this._discussionManager.saveDiscussion(this._currentDiscussion);
    
    vscode.commands.executeCommand('lollms-vs-coder.refreshDiscussions');

    await this._updateContextAndTokens();

    if (isFirstMessage) {
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


    this._callApiWithMessages(this._currentDiscussion.messages);
  }

  private async regenerateResponse() {
    if (!this._currentDiscussion || this._currentDiscussion.messages.length < 1) return;

    const lastAssistantMsgIndex = this._currentDiscussion.messages.map(m => m.role).lastIndexOf('assistant');
    if (lastAssistantMsgIndex === -1) {
        vscode.window.showInformationMessage("No assistant message found to regenerate.");
        return;
    }

    const lastUserMsgIndex = this._currentDiscussion.messages
        .slice(0, lastAssistantMsgIndex)
        .map(m => m.role)
        .lastIndexOf('user');
    
    if (lastUserMsgIndex === -1) {
        vscode.window.showInformationMessage("Could not find the user message for this response.");
        return;
    }

    const lastUserMessage = this._currentDiscussion.messages[lastUserMsgIndex];
    if (!lastUserMessage || typeof lastUserMessage.content !== 'string') {
        vscode.window.showErrorMessage("Failed to get content of last user message.");
        return;
    };
    const lastUserMessageContent = lastUserMessage.content;
    
    this._currentDiscussion.messages.splice(lastAssistantMsgIndex);
    
    await this._discussionManager.saveDiscussion(this._currentDiscussion);
    this._panel.webview.postMessage({ command: 'loadDiscussion', messages: this._currentDiscussion.messages });

    const messageId = 'user_' + Date.now().toString() + Math.random().toString(36).substring(2);
    this._panel.webview.postMessage({ command: 'resendMessage', message: {id: messageId, role: 'user', content: lastUserMessageContent }});
  }

  private async regenerateFromMessage(messageId: string) {
    if (!this._currentDiscussion) return;

    const messageIndex = this._currentDiscussion.messages.findIndex(m => m.id === messageId);

    if (messageIndex === -1) {
        vscode.window.showErrorMessage("Could not find the message to regenerate from.");
        return;
    }

    const targetMessage = this._currentDiscussion.messages[messageIndex];
    if (targetMessage.role !== 'user' || typeof targetMessage.content !== 'string' && !Array.isArray(targetMessage.content)) {
        vscode.window.showErrorMessage("Can only regenerate from a user's text message.");
        return;
    }
    const messageContent = targetMessage.content as string;
    
    this._currentDiscussion.messages.splice(messageIndex);
    
    await this._discussionManager.saveDiscussion(this._currentDiscussion);
    
    this._panel.webview.postMessage({ command: 'loadDiscussion', messages: this._currentDiscussion.messages });

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
    await this._discussionManager.saveDiscussion(this._currentDiscussion);

    this._panel.webview.postMessage({ command: 'loadDiscussion', messages: this._currentDiscussion.messages });
    this._updateContextAndTokens();
    vscode.commands.executeCommand('lollms-vs-coder.refreshDiscussions');
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
        await this._discussionManager.saveDiscussion(this._currentDiscussion);
        await this._updateContextAndTokens();
    }
  }

  private async _handleFileAttachment(name: string, dataUrl: string, isImage: boolean) {
    let chatMessage: ChatMessage;
    const attachmentId = 'attachment_' + Date.now().toString() + Math.random().toString(36).substring(2);

    if (isImage) {
        chatMessage = {
            id: attachmentId,
            role: 'user',
            content: [
                { type: 'text', text: `Attached image: ${name}` },
                { type: 'image_url', image_url: { url: dataUrl } }
            ]
        };
    } else {
        let extractedText = '';
        let warning = '';
        try {
            const extension = path.extname(name).toLowerCase();
            const base64Data = dataUrl.split(',')[1];
            const buffer = Buffer.from(base64Data, 'base64');

            switch (extension) {
                case '.pdf':
                    const data = await pdf(buffer);
                    extractedText = data.text;
                    break;
                case '.docx':
                    const docxResult = await mammoth.extractRawText({ buffer });
                    extractedText = docxResult.value;
                    break;
                case '.xlsx':
                    const workbook = new ExcelJS.Workbook();
                    const stream = new Readable();
                    stream.push(buffer);
                    stream.push(null);
                    await workbook.xlsx.read(stream);
                    
                    let fullText = '';
                    workbook.eachSheet((worksheet) => {
                        fullText += `--- Sheet: ${worksheet.name} ---\n`;
                        worksheet.eachRow({ includeEmpty: false }, (row) => {
                            const values = row.values as ExcelJS.CellValue[];
                            const cleanValues = values.slice(1).map(v => (v === null || v === undefined) ? '' : v.toString());
                            fullText += cleanValues.join(', ') + '\n';
                        });
                        fullText += '\n';
                    });
                    extractedText = fullText;
                    break;
                case '.pptx':
                    warning = `\n\n**Warning**: Content extraction for PPTX files is not supported.`;
                    extractedText = '(Content not displayed for .pptx)';
                    break;
                default:
                    extractedText = buffer.toString('utf8');
                    break;
            }
        } catch (error: any) {
            extractedText = `Error parsing file: ${error.message}`;
        }
        
        const fileContentBlock = `\`\`\`\n${extractedText}\n\`\`\`${warning}`;

        chatMessage = {
            id: attachmentId,
            role: 'system',
            content: `Attached file: **${name}**\n\n${fileContentBlock}`
        };
    }
    await this.addMessageToDiscussion(chatMessage);
  }
    
  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'sendMessage':
          await this.sendMessage(message.message);
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
            if (!this._currentDiscussion) return;
            
            const config = vscode.workspace.getConfiguration('lollmsVsCoder');
            if (!config.get('enableCodeInspector')) return;
        
            await this.addMessageToDiscussion({ role: 'system', content: '🔍 Inspecting code...' });
        
            const inspectorModel = config.get<string>('inspectorModelName') || undefined;
            const systemPrompt = getProcessedSystemPrompt('inspector');
        
            if (!systemPrompt) {
                this.addMessageToDiscussion({ role: 'system', content: '❌ Inspection failed: Inspector system prompt could not be generated.' });
                return;
            }
        
            const inspectionMessages: ChatMessage[] = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Inspect the following ${message.language} code block:\n\n\`\`\`${message.language}\n${message.code}\n\`\`\`` }
            ];
        
            (async () => {
                const { id, controller } = this.processManager.register(this._currentDiscussion!.id, 'Inspecting code...');
                try {
                    const response = await this._lollmsAPI.sendChat(inspectionMessages, controller.signal, inspectorModel);
                    if(controller.signal.aborted) return;

                    const cleanResponse = stripThinkingTags(response);
        
                    if (cleanResponse.trim().toUpperCase() === 'OK') {
                        await this.addMessageToDiscussion({ role: 'system', content: '✅ **Inspector:** Code is OK.' });
                    } else if (cleanResponse.startsWith('**🚨 CRITICAL ALERT:')) {
                        await this.addMessageToDiscussion({ role: 'system', content: `🔴 ${cleanResponse}` });
                    } else if (cleanResponse.startsWith('**⚠️ VULNERABILITY DETECTED:')) {
                        await this.addMessageToDiscussion({ role: 'system', content: `🟠 ${cleanResponse}` });
                    } else {
                        const codeBlockRegex = /```(?:[\w-]*)\n([\s\S]+?)\n```/s;
                        const match = cleanResponse.match(codeBlockRegex);
                        if (match && match[1] && this._currentDiscussion) {
                            const newCode = match[1];
                            const originalMessageIndex = this._currentDiscussion.messages.findIndex(m => m.id === message.messageId);
                            
                            if (originalMessageIndex > -1) {
                                const originalMessage = this._currentDiscussion.messages[originalMessageIndex];
                                const originalCodeBlock = `\`\`\`${message.language}\n${message.code}\n\`\`\``;
                                const newCodeBlock = `\`\`\`${message.language}\n${newCode}\n\`\`\``;
                                
                                if (typeof originalMessage.content === 'string') {
                                    originalMessage.content = originalMessage.content.replace(originalCodeBlock, newCodeBlock);
                                }
                                
                                await this._discussionManager.saveDiscussion(this._currentDiscussion);
                                await this.addMessageToDiscussion({ role: 'system', content: '✅ **Inspector:** Found issues and corrected the code above.' });
                                
                                this._panel.webview.postMessage({ 
                                    command: 'loadDiscussion', 
                                    messages: this._currentDiscussion.messages,
                                    isInspectorEnabled: true 
                                });
                            }
                        } else {
                            await this.addMessageToDiscussion({ role: 'system', content: `**Inspector Analysis:**\n${cleanResponse}` });
                        }
                    }
                } catch (error: any) {
                    await this.addMessageToDiscussion({ role: 'system', content: `❌ Inspection failed: ${error.message}` });
                } finally {
                    this.processManager.unregister(id);
                }
            })();
            break;
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
                    const stopMessage: ChatMessage = {
                        role: 'system',
                        content: '🛑 Generation stopped by user.'
                    };
                    await this.addMessageToDiscussion(stopMessage);
                }
            } else {
                vscode.commands.executeCommand('lollms-vs-coder.stopExecution');
            }
            break;
        case 'toggleAgentMode':
          this.agentManager.toggleAgentMode();
          break;
        case 'runAgent':
          await this.sendMessage(message.message);
          this.agentManager.run(message.objective, this._currentDiscussion?.messages || []);
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
        case 'regenerateResponse':
          await this.regenerateResponse();
          break;
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
        case 'saveMessageAsPrompt':
          vscode.commands.executeCommand('lollms-vs-coder.saveMessageAsPrompt', message.content);
          break;
        case 'saveCodeToFile':
            vscode.commands.executeCommand('lollms-vs-coder.saveCodeToFile', message.content, message.language);
            break;
        case 'saveMarkdownToFile':
            vscode.commands.executeCommand('lollms-vs-coder.saveMarkdownToFile', message.content);
            break;
      }
    });
  }
}