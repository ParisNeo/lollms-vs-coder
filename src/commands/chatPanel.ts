import * as vscode from 'vscode';
import { LollmsAPI, ChatMessage } from '../lollmsAPI';
import { ContextManager, ContextResult } from '../contextManager';
import { Discussion, DiscussionManager } from '../discussionManager';
import { AgentManager } from '../agentManager';

export class ChatPanel {
  public static currentPanel: ChatPanel | undefined;
  public readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _lollmsAPI: LollmsAPI;
  private _contextManager!: ContextManager;
  private _discussionManager!: DiscussionManager;
  private _currentDiscussion: Discussion | null = null;
  public agentManager!: AgentManager;

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

    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
    this._setWebviewMessageListener(this._panel.webview);
    this._panel.onDidDispose(() => this.dispose(), null, []);
  }

  public setContextManager(contextManager: ContextManager) {
    this._contextManager = contextManager;
  }

  public updateAgentMode(isActive: boolean) {
    this._panel.webview.postMessage({ command: 'updateAgentMode', isActive });
  }

  public displayPlan(plan: any): void {
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
        this._panel.webview.postMessage({ command: 'loadDiscussion', messages: this._currentDiscussion.messages });
    }
  }

  public async startNewDiscussion(groupId: string | null = null): Promise<void> {
    this._currentDiscussion = this._discussionManager.createNewDiscussion(groupId);
    await this._discussionManager.saveDiscussion(this._currentDiscussion);
    this._panel.title = this._currentDiscussion.title;
    this._panel.webview.postMessage({ command: 'loadDiscussion', messages: this._currentDiscussion.messages });
  }

  public getCurrentDiscussionId(): string | null {
    return this._currentDiscussion?.id || null;
  }
  
  public async addMessageToDiscussion(message: ChatMessage): Promise<void> {
    if (!this._currentDiscussion) return;
    
    if (!message.id) {
        message.id = Date.now().toString() + Math.random().toString(36).substring(2);
    }

    this._currentDiscussion.messages.push(message);
    this._currentDiscussion.timestamp = Date.now();
    await this._discussionManager.saveDiscussion(this._currentDiscussion);
    this._panel.webview.postMessage({
        command: 'addMessage',
        message: message
    });
    vscode.commands.executeCommand('lollms-vs-coder.refreshDiscussions');
  }

  public setInputText(text: string) {
    this._panel.webview.postMessage({ command: 'setInputText', text: text });
  }

  public dispose() {
    ChatPanel.currentPanel = undefined;
    this._panel.dispose();
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css'));

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Lollms Chat</title>
        <link href="${codiconsUri}" rel="stylesheet" />
        <link href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css" rel="stylesheet" />
        
        <style>
            :root {
                --code-bg: #1e1e1e;
                --code-border: #3e3e3e;
            }
            body { 
                font-family: var(--vscode-font-family); 
                padding: 10px;
                margin: 0;
                background-color: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
            }
            .chat-container {
                height: 100vh;
                display: flex;
                flex-direction: column;
            }
            .messages {
                flex: 1;
                overflow-y: auto;
                padding: 10px;
                border: 1px solid var(--vscode-panel-border);
                background-color: var(--vscode-panel-background);
                margin-bottom: 10px;
                border-radius: 6px;
            }
            .message {
                margin-bottom: 15px;
                padding: 12px;
                border-radius: 8px;
                position: relative;
            }
            .user-message {
                background-color: var(--vscode-inputOption-activeBackground);
                border-left: 4px solid var(--vscode-inputOption-activeBorder);
            }
            .assistant-message {
                background-color: var(--vscode-textBlockQuote-background);
                border-left: 4px solid var(--vscode-textBlockQuote-border);
            }
            .system-message {
                background-color: var(--vscode-editor-background);
                border: 1px dashed var(--vscode-panel-border);
                font-size: 0.9em;
                opacity: 0.8;
            }
            .message-header {
                font-weight: 600;
                margin-bottom: 8px;
                color: var(--vscode-textPreformat-foreground);
                font-size: 0.9em;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            .message-content {
                line-height: 1.6;
                word-wrap: break-word;
            }
            .message-content pre {
                position: relative;
                background-color: var(--code-bg) !important;
                border: 1px solid var(--code-border);
                border-radius: 8px;
                margin: 12px 0;
                padding: 0;
                overflow: hidden;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
            }
            .message-content pre code {
                background: transparent !important;
                padding: 16px !important;
                display: block;
                overflow-x: auto;
                font-family: var(--vscode-editor-font-family);
                font-size: 13px;
                line-height: 1.5;
                color: #D4D4D4;
            }
            .code-header {
                background-color: var(--vscode-editorGroupHeader-tabsBackground);
                padding: 8px 16px;
                font-size: 12px;
                font-weight: 600;
                color: var(--vscode-tab-activeForeground);
                border-bottom: 1px solid var(--code-border);
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .language-label {
                background-color: var(--vscode-badge-background);
                color: var(--vscode-badge-foreground);
                padding: 2px 8px;
                border-radius: 12px;
                font-size: 11px;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            .code-actions {
                display: flex;
                gap: 8px;
            }
            .code-action-btn, .msg-action-btn {
                background-color: var(--vscode-button-secondaryBackground);
                color: var(--vscode-button-secondaryForeground);
                border: 1px solid transparent;
                border-radius: 4px;
                padding: 4px 8px;
                cursor: pointer;
                font-size: 11px;
                font-weight: 500;
                transition: background-color 0.2s;
            }
            .code-action-btn:hover, .msg-action-btn:hover {
                background-color: var(--vscode-button-secondaryHoverBackground);
            }
            .input-area {
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .input-container {
                display: flex;
                flex-grow: 1;
            }
            .input-container textarea, .input-container input {
                flex: 1;
                padding: 12px;
                border: 1px solid var(--vscode-input-border);
                background-color: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                border-radius: 6px;
                font-size: 14px;
                font-family: var(--vscode-font-family);
            }
            .input-area button {
                padding: 12px 20px;
                background-color: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-weight: 600;
            }
            .input-area button:disabled {
                background-color: var(--vscode-button-secondaryBackground);
                cursor: not-allowed;
                opacity: 0.6;
            }
            .input-container input:disabled {
                background-color: var(--vscode-input-background);
                cursor: not-allowed;
                opacity: 0.6;
            }
            .loading .message-content {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 10px;
                font-style: italic;
                color: var(--vscode-descriptionForeground);
            }
            .spinner {
                border: 2px solid var(--vscode-panel-border);
                border-top: 2px solid var(--vscode-focusBorder);
                border-radius: 50%;
                width: 16px;
                height: 16px;
                animation: spin 1s linear infinite;
            }
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
            .message-actions {
                display: none;
                position: absolute;
                top: 5px;
                right: 5px;
                gap: 5px;
            }
            .message:hover .message-actions {
                display: flex;
            }
            .msg-action-btn {
                background: var(--vscode-sideBar-background);
                opacity: 0.7;
            }
            .msg-action-btn:hover {
                opacity: 1;
            }
            .agent-mode-toggle {
                display: flex;
                align-items: center;
                gap: 8px;
                margin-right: 15px;
                font-size: 0.9em;
                color: var(--vscode-descriptionForeground);
            }
            .switch {
                position: relative;
                display: inline-block;
                width: 34px;
                height: 20px;
            }
            .switch input { display: none; }
            .slider {
                position: absolute;
                cursor: pointer;
                top: 0; left: 0; right: 0; bottom: 0;
                background-color: #ccc;
                transition: .4s;
                border-radius: 20px;
            }
            .slider:before {
                position: absolute;
                content: "";
                height: 12px; width: 12px;
                left: 4px; bottom: 4px;
                background-color: white;
                transition: .4s;
                border-radius: 50%;
            }
            input:checked + .slider { background-color: var(--vscode-button-background); }
            input:checked + .slider:before { transform: translateX(14px); }
            
            .plan-container {
                border: 1px solid var(--vscode-panel-border);
                border-radius: 8px;
                margin-top: 10px;
                background-color: var(--vscode-sideBar-background);
            }
            .plan-header {
                padding: 10px 15px;
                font-weight: 600;
                border-bottom: 1px solid var(--vscode-panel-border);
                cursor: pointer;
            }
            .plan-objective {
                font-size: 0.9em;
                font-weight: normal;
                color: var(--vscode-descriptionForeground);
                margin-top: 5px;
            }
            .plan-tasks {
                padding: 5px 15px 15px 15px;
                max-height: 400px;
                overflow-y: auto;
            }
            .plan-task {
                display: flex;
                align-items: center;
                padding: 8px 0;
                border-bottom: 1px solid var(--vscode-editorWidget-background);
            }
            .plan-task:last-child { border-bottom: none; }
            .task-status {
                width: 24px;
                text-align: center;
                margin-right: 10px;
                font-size: 16px;
            }
            .task-status .codicon-sync~.spin {
                animation: spin 1.5s linear infinite;
            }
            .task-status .codicon-check { color: var(--vscode-testing-iconPassed); }
            .task-status .codicon-error { color: var(--vscode-testing-iconFailed); }
            .task-status .codicon-circle-large-filled { 
                color: var(--vscode-descriptionForeground); 
                font-size: 12px;
                vertical-align: middle;
             }
            
            .task-description { flex: 1; }
            .task-details {
                font-size: 0.8em;
                color: var(--vscode-descriptionForeground);
                margin-top: 3px;
                font-family: var(--vscode-editor-font-family);
            }
        </style>
        
        <script src="https://cdn.jsdelivr.net/npm/marked@5.1.1/marked.min.js"></script>
        <script src="https://cdn.jsdelivr.net/npm/dompurify@3.0.5/dist/purify.min.js"></script>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-core.min.js"></script>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/plugins/autoloader/prism-autoloader.min.js"></script>
    </head>
    <body>
        <div class="chat-container">
            <div class="messages" id="messages"></div>
            <div class="input-area">
                <div class="agent-mode-toggle">
                    <span>🤖 Agent</span>
                    <label class="switch">
                        <input type="checkbox" id="agentModeCheckbox">
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="input-container">
                    <input type="text" id="messageInput" placeholder="Enter your objective..." />
                </div>
                <button id="sendButton">Send</button>
            </div>
        </div>

        <script>
            const vscode = acquireVsCodeApi();
            const messagesDiv = document.getElementById('messages');
            const messageInput = document.getElementById('messageInput');
            const sendButton = document.getElementById('sendButton');
            const agentModeCheckbox = document.getElementById('agentModeCheckbox');

            marked.setOptions({
                breaks: true,
                gfm: true,
                headerIds: false,
                mangle: false
            });

            function addMessage(message) {
                const role = message.role;
                const content = typeof message.content === 'string' ? message.content : (message.content[0]?.text || '[Unsupported Content]');
                
                const messageDiv = document.createElement('div');
                messageDiv.className = \`message \${role}-message\`;
                messageDiv.dataset.messageId = message.id;

                const headerDiv = document.createElement('div');
                headerDiv.className = 'message-header';
                headerDiv.textContent = role;
                
                const contentDiv = document.createElement('div');
                contentDiv.className = 'message-content';
                contentDiv.innerHTML = DOMPurify.sanitize(marked.parse(content));

                const actionsDiv = document.createElement('div');
                actionsDiv.className = 'message-actions';

                if (role === 'user' || role === 'assistant' || role === 'system') {
                    const deleteBtn = document.createElement('button');
                    deleteBtn.className = 'msg-action-btn';
                    deleteBtn.innerHTML = '🗑️';
                    deleteBtn.title = 'Delete Message';
                    deleteBtn.onclick = () => requestDelete(message.id);
                    actionsDiv.appendChild(deleteBtn);
                }

                const saveBtn = document.createElement('button');
                saveBtn.className = 'msg-action-btn';
                saveBtn.innerHTML = '💾';
                saveBtn.title = 'Save as Prompt';
                saveBtn.onclick = () => {
                    vscode.postMessage({ command: 'saveMessageAsPrompt', content: content });
                };
                actionsDiv.appendChild(saveBtn);
                
                messageDiv.appendChild(headerDiv);
                messageDiv.appendChild(contentDiv);
                messageDiv.appendChild(actionsDiv);
                messagesDiv.appendChild(messageDiv);
                
                enhanceCodeBlocks(contentDiv);
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
            }

            function requestDelete(messageId) {
                vscode.postMessage({ command: 'requestDeleteMessage', messageId });
            }
            
            function getStatusIcon(status) {
                switch(status) {
                    case 'pending': return '<span class="codicon codicon-circle-large-filled"></span>';
                    case 'in_progress': return '<span class="codicon codicon-sync spin"></span>';
                    case 'completed': return '<span class="codicon codicon-check"></span>';
                    case 'failed': return '<span class="codicon codicon-error"></span>';
                    default: return '<span class="codicon codicon-circle-slash"></span>';
                }
            }
            
            function renderPlan(plan) {
                let planHtml = \`
                    <div class="plan-header" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'">
                        📝 Agent Execution Plan
                        <div class="plan-objective">\${plan.objective}</div>
                    </div>
                    <div class="plan-tasks">
                \`;

                plan.tasks.forEach(task => {
                    planHtml += \`
                        <div class="plan-task" data-task-id="\${task.id}">
                            <div class="task-status">\${getStatusIcon(task.status)}</div>
                            <div class="task-description">
                                <strong>\${task.id}. \${task.description}</strong>
                                <div class="task-details">\${task.action}</div>
                            </div>
                        </div>
                    \`;
                });

                planHtml += '</div>';
                return planHtml;
            }

            function displayPlan(plan) {
                let planContainer = document.getElementById('plan-container');
                if (!planContainer) {
                    const messageDiv = document.createElement('div');
                    messageDiv.className = 'message system-message';
                    messageDiv.innerHTML = \`
                        <div class="message-header">Agent Plan</div>
                        <div class="plan-container" id="plan-container"></div>
                    \`;
                    messagesDiv.appendChild(messageDiv);
                    planContainer = document.getElementById('plan-container');
                }
                
                planContainer.innerHTML = renderPlan(plan);
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
            }

            function enhanceCodeBlocks(container) {
                container.querySelectorAll('pre > code').forEach(codeBlock => {
                    const pre = codeBlock.parentElement;
                    const codeContent = codeBlock.innerText;
                    
                    let language = [...codeBlock.classList]
                        .find(c => c.startsWith('language-'))
                        ?.replace('language-', '').toLowerCase() || '';

                    const header = document.createElement('div');
                    header.className = 'code-header';
                    header.innerHTML = \`<span class="language-label">\${language || 'text'}</span>\`;
                    
                    const actions = document.createElement('div');
                    actions.className = 'code-actions';

                    const copyBtn = document.createElement('button');
                    copyBtn.className = 'code-action-btn';
                    copyBtn.innerHTML = '📋 Copy';
                    copyBtn.title = 'Copy Code';
                    copyBtn.onclick = async () => {
                        await navigator.clipboard.writeText(codeContent);
                        copyBtn.innerHTML = '✅ Copied!';
                        setTimeout(() => { copyBtn.innerHTML = '📋 Copy'; }, 2000);
                    };
                    actions.appendChild(copyBtn);

                    const saveBtn = document.createElement('button');
                    saveBtn.className = 'code-action-btn';
                    saveBtn.innerHTML = '💾 Save';
                    saveBtn.title = 'Save to File';
                    saveBtn.onclick = () => {
                        vscode.postMessage({
                            command: 'saveCodeToFile',
                            content: codeContent,
                            language: language
                        });
                    };
                    actions.appendChild(saveBtn);
                    
                    header.appendChild(actions);
                    pre.parentNode.insertBefore(header, pre);
                    
                    Prism.highlightElement(codeBlock);
                });
            }

            function showLoadingIndicator() {
                const loadingDiv = document.createElement('div');
                loadingDiv.className = 'message assistant-message loading';
                loadingDiv.id = 'loading-message';
                loadingDiv.innerHTML = \`<div class="message-header">Lollms</div><div class="message-content"><div class="spinner"></div><span>🤔 Thinking...</span></div>\`;
                messagesDiv.appendChild(loadingDiv);
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
            }

            function sendMessage() {
                const messageText = messageInput.value.trim();
                if (!messageText) return;

                sendButton.disabled = true;
                messageInput.disabled = true;

                if (agentModeCheckbox.checked) {
                    vscode.postMessage({ command: 'runAgent', objective: messageText });
                } else {
                    const userMessage = { role: 'user', content: messageText };
                    vscode.postMessage({ command: 'sendMessage', message: userMessage });
                }
                
                addMessage({ role: 'user', content: messageText, id: 'temp-' + Date.now() }); 
                messageInput.value = '';
                showLoadingIndicator();
            }
            
            agentModeCheckbox.addEventListener('change', () => {
                vscode.postMessage({ command: 'toggleAgentMode' });
            });

            sendButton.addEventListener('click', sendMessage);
            messageInput.addEventListener('keypress', (e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            });

            window.addEventListener('message', event => {
              const message = event.data;
              const loadingIndicator = document.getElementById('loading-message');

              switch(message.command) {
                case 'showLoading':
                    showLoadingIndicator();
                    break;
                case 'addMessage':
                    if (loadingIndicator) {
                        loadingIndicator.remove();
                    }
                    const tempUserMsg = document.querySelector('[data-message-id^="temp-"]');
                    if (tempUserMsg && message.message.role !== 'user') tempUserMsg.remove();
                    
                    if (!agentModeCheckbox.checked) {
                        sendButton.disabled = false;
                        messageInput.disabled = false;
                        messageInput.focus();
                    }
                    addMessage(message.message);
                    break;
                case 'displayPlan':
                    if (loadingIndicator) {
                        loadingIndicator.remove();
                    }
                    displayPlan(message.plan);
                    break;
                case 'loadDiscussion':
                    if (loadingIndicator) loadingIndicator.remove();
                    messagesDiv.innerHTML = '';
                    if (Array.isArray(message.messages)) {
                        message.messages.forEach(msg => addMessage(msg));
                    }
                    sendButton.disabled = false;
                    messageInput.disabled = false;
                    messageInput.focus();
                    break;
                case 'updateAgentMode':
                    agentModeCheckbox.checked = message.isActive;
                    if (!message.isActive) {
                        sendButton.disabled = false;
                        messageInput.disabled = false;
                        messageInput.focus();
                    }
                    break;
                case 'error':
                    if (loadingIndicator) loadingIndicator.remove();
                    sendButton.disabled = false;
                    messageInput.disabled = false;
                    addMessage({ role: 'system', content: '❌ Error: ' + message.content });
                    break;
              }
            });
        </script>
    </body>
    </html>`;
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
    try {
      const apiMessages: ChatMessage[] = [];
      const systemPrompt = `You are Lollms, a helpful AI coding assistant integrated into VS Code. Be helpful, concise, and use emojis to make the conversation more engaging. Respond in Markdown.`;
      apiMessages.push({ role: 'system', content: systemPrompt });

      if (includeProjectContext) {
        const context: ContextResult = this._contextManager ? await this._contextManager.getContextContent() : { text: '', images: [] };
        if (context.text && context.text.trim().length > 0) {
            apiMessages.push({ role: 'system', content: `## Project Context\n${context.text}` });
        }
      }

      apiMessages.push(...messages);
      
      const responseText = await this._lollmsAPI.sendChat(apiMessages);
      const assistantMessage: ChatMessage = { role: 'assistant', content: responseText };
      
      await this.addMessageToDiscussion(assistantMessage);
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
      const errorResponseMessage: ChatMessage = { role: 'system', content: `Sorry, I encountered an error: ${errorMessage}` };
      await this.addMessageToDiscussion(errorResponseMessage);
    }
  }

  public async sendMessage(userMessage: ChatMessage) {
    if (!this._currentDiscussion) {
        vscode.window.showErrorMessage("No active discussion. Please start a new one.");
        return;
    }

    const isFirstMessage = this._currentDiscussion.messages.length === 0;

    userMessage.id = Date.now().toString() + Math.random().toString(36).substring(2);

    this._currentDiscussion.messages.push(userMessage);
    this._currentDiscussion.timestamp = Date.now();
    await this._discussionManager.saveDiscussion(this._currentDiscussion);
    vscode.commands.executeCommand('lollms-vs-coder.refreshDiscussions');

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

  private async deleteMessage(messageId: string) {
    if (!this._currentDiscussion) return;

    this._currentDiscussion.messages = this._currentDiscussion.messages.filter(msg => msg.id !== messageId);
    await this._discussionManager.saveDiscussion(this._currentDiscussion);

    this._panel.webview.postMessage({ command: 'loadDiscussion', messages: this._currentDiscussion.messages });
    vscode.commands.executeCommand('lollms-vs-coder.refreshDiscussions');
  }

  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'sendMessage':
          await this.sendMessage(message.message);
          break;
        case 'toggleAgentMode':
          this.agentManager.toggleAgentMode();
          break;
        case 'runAgent':
          await this.agentManager.run(message.objective, this._currentDiscussion?.messages || []);
          break;
        case 'requestDeleteMessage':
            const confirm = await vscode.window.showWarningMessage(
                'Are you sure you want to delete this message?',
                { modal: true },
                'Delete'
            );
            if (confirm === 'Delete') {
                await this.deleteMessage(message.messageId);
            }
            break;
        case 'saveMessageAsPrompt':
          vscode.commands.executeCommand('lollms-vs-coder.saveMessageAsPrompt', message.content);
          break;
        case 'saveCodeToFile':
            vscode.commands.executeCommand('lollms-vs-coder.saveCodeToFile', message.content, message.language);
            break;
      }
    });
  }
}