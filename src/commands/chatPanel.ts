import * as vscode from 'vscode';
import { LollmsAPI, ChatMessage } from '../lollmsAPI';
import { ContextManager, ContextResult } from '../contextManager';
import { Discussion, DiscussionManager } from '../discussionManager';
import { AgentManager } from '../agentManager';
import { getProcessedGlobalSystemPrompt } from '../utils';
import * as path from 'path';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';
import * as ExcelJS from 'exceljs';
import { Readable } from 'stream';


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
  private _currentRequestController: AbortController | null = null;


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

  public updateAgentMode(isActive: boolean) {
    this._panel.webview.postMessage({ command: 'updateAgentMode', isActive });
  }

  public displayPlan(plan: any | null): void {
      this._panel.webview.postMessage({ command: 'displayPlan', plan: plan });
  }

  public async loadDiscussion(id: string): Promise<void> {
    if (this._currentRequestController) {
        this._currentRequestController.abort();
    }
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
        this._panel.webview.postMessage({ command: 'loadDiscussion', messages: this._currentDiscussion.messages });
        this.displayPlan(null); // Clear plan when switching discussions
        this._updateContextAndTokens();
    }
  }

  public async startNewDiscussion(groupId: string | null = null): Promise<void> {
    if (this._currentRequestController) {
        this._currentRequestController.abort();
    }
    this._currentDiscussion = this._discussionManager.createNewDiscussion(groupId);
    await this._discussionManager.saveDiscussion(this._currentDiscussion);
    this._panel.title = this._currentDiscussion.title;
    this._panel.webview.postMessage({ command: 'loadDiscussion', messages: this._currentDiscussion.messages });
    this.displayPlan(null); // Clear plan for new discussion
    this._updateContextAndTokens();
  }
  
  private async _updateContextAndTokens() {
    if (!this._contextManager || !this._currentDiscussion) return;

    try {
        const context = await this._contextManager.getContextContent();
        this._panel.webview.postMessage({ command: 'updateContext', context: context.text });

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
    
    const existingMessage = this._currentDiscussion.messages.find(m => m.id === message.id);
    if(existingMessage){
        if(existingMessage.content === message.content) return;
        existingMessage.content = message.content;
    } else {
        this._currentDiscussion.messages.push(message);
    }


    this._currentDiscussion.timestamp = Date.now();
    await this._discussionManager.saveDiscussion(this._currentDiscussion);
    
    if (message.role === 'system' || message.role === 'assistant') {
        this._panel.webview.postMessage({ command: 'loadDiscussion', messages: this._currentDiscussion.messages });
    } else {
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

    // Add new localization strings for the plan view
    html = html.replace(/{{planTitle}}/g, vscode.l10n.t("plan.title", "Execution Plan"));
    html = html.replace(/{{planObjective}}/g, vscode.l10n.t("plan.objective", "Objective"));
    html = html.replace(/{{planDetails}}/g, vscode.l10n.t("plan.details", "Details"));
    html = html.replace(/{{planStatusPending}}/g, vscode.l10n.t("plan.status.pending", "Pending"));
    html = html.replace(/{{planStatusInProgress}}/g, vscode.l10n.t("plan.status.inProgress", "In Progress"));
    html = html.replace(/{{planStatusCompleted}}/g, vscode.l10n.t("plan.status.completed", "Completed"));
    html = html.replace(/{{planStatusFailed}}/g, vscode.l10n.t("plan.status.failed", "Failed"));

    return html;
  }

  public async analyzeExecutionResult(code: string, language: string, output: string, exitCode: number | null) {
    if (!this._currentDiscussion) {
      return;
    }

    this._panel.webview.postMessage({ command: 'showLoading' });

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

    await this._callApiWithMessages(messagesForApi, false);
  }

  private async _callApiWithMessages(messages: ChatMessage[], includeProjectContext: boolean = true) {
    this._currentRequestController = new AbortController();
    try {
      const apiMessages: ChatMessage[] = [];
      const globalPrompt = getProcessedGlobalSystemPrompt();
      const systemPrompt = `You are Lollms, a helpful AI coding assistant integrated into VS Code.

**RESPONSE FORMATTING RULES:**

**1. For File Modifications (Creating or Overwriting):**
- You MUST prefix your response with a single line in this EXACT format: \`File: path/to/the/file.ext\`
- This line MUST be on its own, followed by a newline.
- Immediately after, provide the COMPLETE and FULL file content in a single markdown code block.
- DO NOT add any conversational text or explanations before the \`File:\` line or after the code block.

--- CORRECT EXAMPLE ---
File: src/app.js
\`\`\`javascript
console.log("Hello, World!");
\`\`\`
--- END CORRECT EXAMPLE ---

--- INCORRECT EXAMPLE ---
Of course! Here is the file:
File: src/app.js
\`\`\`javascript
console.log("Hello, World!");
\`\`\`
I hope this helps!
--- END INCORRECT EXAMPLE ---

**2. For Patches (Advanced):**
- You MUST prefix your response with a single line: \`Patch: path/to/the/file.ext\`
- Follow this with the content in a standard \`.diff\` format inside a code block.

**3. For General Conversation (When NOT editing a file):**
- Respond naturally in Markdown. Do NOT use the \`File:\` or \`Patch:\` prefixes.

**BEHAVIOR:**
- Prioritize following the formatting rules above all else.
- Your primary function is to provide code that works with the VS Code extension.
- Be helpful and concise.

User preferences: ${globalPrompt}`;
      apiMessages.push({ role: 'system', content: systemPrompt });

      if (includeProjectContext) {
        const context: ContextResult = this._contextManager ? await this._contextManager.getContextContent() : { text: '', images: [] };
        if (context.text && context.text.trim().length > 0) {
            apiMessages.push({ role: 'system', content: `## Project Context\n${context.text}` });
        }
      }

      apiMessages.push(...messages);
      
      this._lastApiRequest = apiMessages;
      const responseText = await this._lollmsAPI.sendChat(apiMessages, this._currentRequestController.signal);
      this._lastApiResponse = responseText;
      const assistantMessage: ChatMessage = { role: 'assistant', content: responseText };
      
      await this.addMessageToDiscussion(assistantMessage);
      
    } catch (error: any) {
        const isAbortError = error.name === 'AbortError' || (error instanceof Error && error.message.includes('aborted'));
        if (isAbortError) {
            // Abort is now handled by the initiator (stop button, new discussion), so we just return silently.
            return;
        }

        const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
        this._lastApiResponse = errorMessage;
        const errorResponseMessage: ChatMessage = { role: 'system', content: `Sorry, I encountered an error: ${errorMessage}` };
        await this.addMessageToDiscussion(errorResponseMessage);
    } finally {
        this._currentRequestController = null;
    }
  }

  public async sendMessage(userMessage: ChatMessage) {
    if (!this._currentDiscussion) {
        vscode.window.showErrorMessage("No active discussion. Please start a new one.");
        return;
    }

    await vscode.workspace.saveAll();
    
    const isFirstMessage = this._currentDiscussion.messages.filter(m => m.role !== 'system').length === 0;

    // This is the single point where we add the new message to the discussion.
    if (!userMessage.id) {
        userMessage.id = Date.now().toString() + Math.random().toString(36).substring(2);
    }
    this._currentDiscussion.messages.push(userMessage);
    this._currentDiscussion.timestamp = Date.now();
    await this._discussionManager.saveDiscussion(this._currentDiscussion);
    
    // Update the webview with just the new message, then show loading.
    this._panel.webview.postMessage({ command: 'addMessage', message: userMessage });
    this._panel.webview.postMessage({ command: 'showLoading' });

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

    await this._callApiWithMessages(this._currentDiscussion.messages);
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
    
    this._currentDiscussion.messages.splice(lastUserMsgIndex);
    
    await this._discussionManager.saveDiscussion(this._currentDiscussion);
    this._panel.webview.postMessage({ command: 'loadDiscussion', messages: this._currentDiscussion.messages });

    await this.sendMessage({ role: 'user', content: lastUserMessageContent });
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
    const messageContent = targetMessage.content;
    
    // Remove the target message and everything after it
    this._currentDiscussion.messages.splice(messageIndex);
    
    await this._discussionManager.saveDiscussion(this._currentDiscussion);
    
    // Reload the webview with the truncated history
    this._panel.webview.postMessage({ command: 'loadDiscussion', messages: this._currentDiscussion.messages });

    // Resend the original message prompt
    await this.sendMessage({ role: 'user', content: messageContent as string });
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

  private async _handleFileAttachment(name: string, dataUrl: string, isImage: boolean) {
    let chatMessage: ChatMessage;
    const attachmentId = 'attachment_' + Date.now().toString() + Math.random().toString(36).substring(2);

    if (isImage) {
        chatMessage = {
            id: attachmentId,
            role: 'system',
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
            content: [
                { type: 'text', text: `Attached file: ${name}` },
                { type: 'text', text: fileContentBlock }
            ]
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
        case 'stopGeneration':
            if (this._currentRequestController) {
                this._currentRequestController.abort();
                const stopMessage: ChatMessage = {
                    role: 'system',
                    content: '🛑 Generation stopped by user.'
                };
                await this.addMessageToDiscussion(stopMessage);
            } else {
                // If there's no active request, the UI might be stuck. Reset it.
                this._panel.webview.postMessage({ command: 'loadDiscussion', messages: this._currentDiscussion?.messages || [] });
            }
            break;
        case 'toggleAgentMode':
          this.agentManager.toggleAgentMode();
          break;
        case 'runAgent':
          await this.agentManager.run(message.objective, this._currentDiscussion?.messages || []);
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
        case 'requestLog':
          this._panel.webview.postMessage({ 
              command: 'showLog', 
              request: this._lastApiRequest, 
              response: this._lastApiResponse 
          });
          break;
        case 'regenerateResponse':
          await this.regenerateResponse();
          break;
        case 'regenerateFromMessage':
            await this.regenerateFromMessage(message.messageId);
            break;
        case 'applyFile':
            vscode.commands.executeCommand('lollms-vs-coder.applyFileContent', message.filePath, message.content);
            break;
        case 'applyPatch':
            vscode.commands.executeCommand('lollms-vs-coder.applyPatchContent', message.filePath, message.content);
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