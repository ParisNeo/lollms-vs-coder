import * as vscode from 'vscode';
import { LollmsAPI, ChatMessage, ChatMessageContentPart } from '../lollmsAPI';
import { ContextManager, ContextResult } from '../contextManager';
import { Discussion, DiscussionManager } from '../discussionManager';

export class ChatPanel {
  public static currentPanel: ChatPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _lollmsAPI: LollmsAPI;
  private _contextManager!: ContextManager;
  private _discussionManager!: DiscussionManager;
  private _currentDiscussion: Discussion | null = null;

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
        localResourceRoots: [extensionUri]
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

  public async loadDiscussion(id: string): Promise<void> {
    const discussion = await this._discussionManager.getDiscussion(id);
    if (discussion) {
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
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Lollms Chat</title>
        
        <link href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css" rel="stylesheet" />
        
        <style>
            :root {
                --code-bg: #1e1e1e;
                --code-border: #3e3e3e;
            }
            body { 
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif; 
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
                font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
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
            .input-container {
                display: flex;
                gap: 10px;
            }
            .input-container input {
                flex: 1;
                padding: 12px;
                border: 1px solid var(--vscode-input-border);
                background-color: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                border-radius: 6px;
                font-size: 14px;
            }
            .input-container button {
                padding: 12px 20px;
                background-color: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-weight: 600;
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
            }
            .message:hover .message-actions {
                display: block;
            }
            .msg-action-btn {
                background: var(--vscode-sideBar-background);
                opacity: 0.7;
            }
            .msg-action-btn:hover {
                opacity: 1;
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
            <div class="input-container">
                <input type="text" id="messageInput" placeholder="Ask Lollms anything..." />
                <button id="sendButton">Send</button>
            </div>
        </div>

        <script>
            const vscode = acquireVsCodeApi();
            const messagesDiv = document.getElementById('messages');
            const messageInput = document.getElementById('messageInput');
            const sendButton = document.getElementById('sendButton');
            const executableLanguages = ['python', 'javascript', 'typescript', 'bash', 'sh', 'shell'];

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
                
                const headerDiv = document.createElement('div');
                headerDiv.className = 'message-header';
                headerDiv.textContent = role;
                
                const contentDiv = document.createElement('div');
                contentDiv.className = 'message-content';
                contentDiv.innerHTML = DOMPurify.sanitize(marked.parse(content));

                const actionsDiv = document.createElement('div');
                actionsDiv.className = 'message-actions';
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
                    
                    if (executableLanguages.includes(language)) {
                        const runBtn = document.createElement('button');
                        runBtn.className = 'code-action-btn';
                        runBtn.innerHTML = '🚀 Run';
                        runBtn.title = 'Run Script';
                        runBtn.onclick = () => {
                            vscode.postMessage({
                                command: 'runScript',
                                content: codeContent,
                                language: language
                            });
                        };
                        actions.appendChild(runBtn);
                    }

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
              if (messageText) {
                const userMessage = { role: 'user', content: messageText };
                addMessage(userMessage);
                vscode.postMessage({ command: 'sendMessage', message: userMessage });
                messageInput.value = '';
                sendButton.disabled = true;
                showLoadingIndicator();
              }
            }

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
                case 'addMessage':
                    if (loadingIndicator) {
                        loadingIndicator.remove();
                    }
                    sendButton.disabled = false;
                    messageInput.focus();
                    addMessage(message.message);
                    break;

                case 'loadDiscussion':
                    if (loadingIndicator) {
                        loadingIndicator.remove();
                    }
                    messagesDiv.innerHTML = '';
                    if (Array.isArray(message.messages)) {
                        message.messages.forEach(msg => addMessage(msg));
                    }
                    sendButton.disabled = false;
                    messageInput.focus();
                    break;
                
                case 'setInputText':
                    messageInput.value = message.text;
                    messageInput.focus();
                    break;

                case 'error':
                    if (loadingIndicator) {
                        loadingIndicator.remove();
                    }
                    sendButton.disabled = false;
                    addMessage({ role: 'system', content: '❌ Error: ' + message.content });
                    break;
              }
            });
        </script>
    </body>
    </html>`;
  }

  public async sendMessage(userMessage: ChatMessage) {
    if (!this._currentDiscussion) {
      vscode.window.showErrorMessage("No active discussion. Please start a new one.");
      return;
    }
  
    // Add user message to the persistent state
    this._currentDiscussion.messages.push(userMessage);
    if (this._currentDiscussion.messages.length <= 2 && typeof userMessage.content === 'string') {
        this._currentDiscussion.title = userMessage.content.substring(0, 30).trim() + (userMessage.content.length > 30 ? '...' : '');
    }
    this._currentDiscussion.timestamp = Date.now();
    await this._discussionManager.saveDiscussion(this._currentDiscussion);
    vscode.commands.executeCommand('lollms-vs-coder.refreshDiscussions');
  
    try {
      const context: ContextResult = this._contextManager ? await this._contextManager.getContextContent() : { text: '', images: [] };
  
      const apiMessages: ChatMessage[] = [];
      const systemPrompt = `You are Lollms, a helpful AI coding assistant integrated into VS Code. Be helpful, concise, and use emojis to make the conversation more engaging. Respond in Markdown.`;
      apiMessages.push({ role: 'system', content: systemPrompt });
  
      this._currentDiscussion.messages.slice(1).forEach(msg => {
        if (msg.role !== 'system') {
            apiMessages.push(msg);
        }
      });
      
      const responseText = await this._lollmsAPI.sendChat(apiMessages);
      const assistantMessage: ChatMessage = { role: 'assistant', content: responseText };
      
      await this.addMessageToDiscussion(assistantMessage);
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
      const errorResponseMessage: ChatMessage = { role: 'system', content: `Sorry, I encountered an error: \${errorMessage}` };
      await this.addMessageToDiscussion(errorResponseMessage);
    }
  }

  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'sendMessage':
          await this.sendMessage(message.message);
          break;
        case 'runScript':
          vscode.commands.executeCommand('lollms-vs-coder.runScript', message.content, message.language);
          break;
        case 'saveMessageAsPrompt':
          vscode.commands.executeCommand('lollms-vs-coder.saveMessageAsPrompt', message.content);
          break;
        case 'saveCode':
          vscode.commands.executeCommand('lollms-vs-coder.saveCodeToFile', message.content, message.language);
          break;
        case 'applyDiff':
          vscode.commands.executeCommand('lollms-vs-coder.applyDiff', message.content);
          break;
      }
    });
  }
}