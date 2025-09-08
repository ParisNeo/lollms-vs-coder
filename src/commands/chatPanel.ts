// src/commands/chatPanel.ts

import * as vscode from 'vscode';
import { LollmsAPI, ChatMessage } from '../lollmsAPI';
import { ContextManager } from '../contextManager';

export class ChatPanel {
  public static currentPanel: ChatPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _lollmsAPI: LollmsAPI;
  private _contextManager!: ContextManager;


  public static createOrShow(extensionUri: vscode.Uri, lollmsAPI: LollmsAPI) {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

    if (ChatPanel.currentPanel) {
      ChatPanel.currentPanel._panel.reveal(column);
      return;
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

    ChatPanel.currentPanel = new ChatPanel(panel, extensionUri, lollmsAPI);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, lollmsAPI: LollmsAPI) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._lollmsAPI = lollmsAPI;
    // Get context manager - you'll need to pass the actual context here
    // For now, we'll create a new one but in practice, you should inject it
    
    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
    this._setWebviewMessageListener(this._panel.webview);
    this._panel.onDidDispose(() => this.dispose(), null, []);
  }

  public setContextManager(contextManager: ContextManager) {
    this._contextManager = contextManager;
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
  <style>
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
    }
    .user-message { 
      background-color: var(--vscode-inputOption-activeBackground);
      border-left: 4px solid var(--vscode-inputOption-activeBorder);
    }
    .assistant-message { 
      background-color: var(--vscode-textBlockQuote-background);
      border-left: 4px solid var(--vscode-textBlockQuote-border);
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
    }
    
    /* Markdown styling */
    .message-content h1, .message-content h2, .message-content h3, .message-content h4, .message-content h5, .message-content h6 {
      color: var(--vscode-textPreformat-foreground);
      margin-top: 20px;
      margin-bottom: 10px;
      line-height: 1.3;
    }
    .message-content h1 { font-size: 1.8em; }
    .message-content h2 { font-size: 1.5em; }
    .message-content h3 { font-size: 1.3em; }
    .message-content h4 { font-size: 1.1em; }
    
    .message-content pre {
      background-color: var(--vscode-textCodeBlock-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 12px;
      overflow-x: auto;
      margin: 12px 0;
      font-family: 'SF Mono', Monaco, Inconsolata, 'Roboto Mono', Consolas, 'Courier New', monospace;
      font-size: 0.9em;
      line-height: 1.4;
    }
    
    .message-content code {
      background-color: var(--vscode-textCodeBlock-background);
      padding: 3px 6px;
      border-radius: 4px;
      font-family: 'SF Mono', Monaco, Inconsolata, 'Roboto Mono', Consolas, 'Courier New', monospace;
      font-size: 0.9em;
    }
    
    .message-content pre code {
      background-color: transparent;
      padding: 0;
      border-radius: 0;
    }
    
    .message-content blockquote {
      border-left: 4px solid var(--vscode-textBlockQuote-border);
      background-color: var(--vscode-textBlockQuote-background);
      margin: 12px 0;
      padding: 12px;
      border-radius: 4px;
    }
    
    .message-content ul, .message-content ol {
      padding-left: 24px;
      margin: 12px 0;
    }
    
    .message-content li {
      margin-bottom: 6px;
    }
    
    .message-content table {
      border-collapse: collapse;
      width: 100%;
      margin: 12px 0;
    }
    
    .message-content th, .message-content td {
      border: 1px solid var(--vscode-panel-border);
      padding: 8px;
      text-align: left;
    }
    
    .message-content th {
      background-color: var(--vscode-textCodeBlock-background);
      font-weight: 600;
    }
    
    .message-content a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    
    .message-content a:hover {
      text-decoration: underline;
    }
    
    .message-content p {
      margin: 8px 0;
    }
    
    .message-content hr {
      border: none;
      border-top: 1px solid var(--vscode-panel-border);
      margin: 20px 0;
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
    
    .input-container input:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }
    
    .input-container button { 
      padding: 12px 20px; 
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      transition: background-color 0.2s;
    }
    
    .input-container button:hover {
      background-color: var(--vscode-button-hoverBackground);
    }
    
    .loading {
      font-style: italic;
      color: var(--vscode-descriptionForeground);
    }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/marked@5.1.1/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/dompurify@3.0.5/dist/purify.min.js"></script>
</head>
<body>
  <div class="chat-container">
    <div class="messages" id="messages"></div>
    <div class="input-container">
      <input type="text" id="messageInput" placeholder="Ask Lollms anything about your code..." />
      <button id="sendButton">Send</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const messagesDiv = document.getElementById('messages');
    const messageInput = document.getElementById('messageInput');
    const sendButton = document.getElementById('sendButton');

    // Configure marked for better rendering
    marked.setOptions({
      breaks: true,
      gfm: true,
      headerIds: false,
      mangle: false
    });

    function addMessage(content, isUser = false) {
      const messageDiv = document.createElement('div');
      messageDiv.className = \`message \${isUser ? 'user-message' : 'assistant-message'}\`;
      
      const headerDiv = document.createElement('div');
      headerDiv.className = 'message-header';
      headerDiv.textContent = isUser ? 'You' : 'Lollms';
      
      const contentDiv = document.createElement('div');
      contentDiv.className = 'message-content';
      
      if (isUser) {
        // User messages as plain text
        contentDiv.textContent = content;
      } else {
        // Parse and sanitize markdown for assistant messages
        try {
          const parsedMarkdown = marked.parse(content);
          // Sanitize the HTML to prevent XSS attacks
          contentDiv.innerHTML = DOMPurify.sanitize(parsedMarkdown);
        } catch (error) {
          console.error('Error parsing markdown:', error);
          contentDiv.textContent = content;
        }
      }
      
      messageDiv.appendChild(headerDiv);
      messageDiv.appendChild(contentDiv);
      messagesDiv.appendChild(messageDiv);
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    function sendMessage() {
      const message = messageInput.value.trim();
      if (message) {
        addMessage(message, true);
        messageInput.value = '';
        sendButton.disabled = true;
        
        // Show loading indicator
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'message assistant-message loading';
        loadingDiv.innerHTML = '<div class="message-header">Lollms</div><div class="message-content">Thinking...</div>';
        loadingDiv.id = 'loading-message';
        messagesDiv.appendChild(loadingDiv);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
        
        vscode.postMessage({ command: 'sendMessage', message: message });
      }
    }

    sendButton.addEventListener('click', sendMessage);
    
    messageInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Handle messages from the extension
    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.command) {
        case 'addMessage':
          // Remove loading indicator
          const loading = document.getElementById('loading-message');
          if (loading) {
            loading.remove();
          }
          sendButton.disabled = false;
          addMessage(message.content, false);
          break;
        case 'error':
          // Remove loading indicator
          const loadingError = document.getElementById('loading-message');
          if (loadingError) {
            loadingError.remove();
          }
          sendButton.disabled = false;
          addMessage('❌ Error: ' + message.content, false);
          break;
      }
    });

    // Focus input on load
    messageInput.focus();
    
    // Add welcome message
    addMessage('Hello! I\\'m Lollms, your AI coding assistant. I can help you with:\\n\\n• **Code analysis** and debugging\\n• **Explaining** complex code\\n• **Generating** code snippets\\n• **Refactoring** suggestions\\n• **Architecture** advice\\n\\nI have access to your project files through the context manager. What can I help you with?', false);
  </script>
</body>
</html>`;
  }

  public async sendMessage(message: string) {
    try {
      let contextContent = '';
      if (this._contextManager) {
        contextContent = await this._contextManager.getContextContent();
      }

      const chatMessages: ChatMessage[] = [
        {
          role: 'system',
          content: `You are Lollms, an AI assistant integrated into VS Code. You help with coding, debugging, and development tasks.

You respond in Markdown format. Use proper formatting for:
- Code blocks with language specification
- Headers for organizing information
- Lists for structured data
- Tables when appropriate
- Bold and italic text for emphasis

${contextContent ? `Here is the current project context:\n\n${contextContent}` : ''}`
        },
        {
          role: 'user',
          content: message
        }
      ];

      const response = await this._lollmsAPI.sendChat(chatMessages);
      
      this._panel.webview.postMessage({
        command: 'addMessage',
        content: response
      });
      
    } catch (error) {
      this._panel.webview.postMessage({
        command: 'error',
        content: error instanceof Error ? error.message : 'Unknown error occurred'
      });
    }
  }

  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'sendMessage':
          await this.sendMessage(message.message);
          break;
      }
    });
  }
}
