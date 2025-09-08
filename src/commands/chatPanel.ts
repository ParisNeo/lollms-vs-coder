import * as vscode from 'vscode';
import { LollmsAPI, ChatMessage } from '../lollmsAPI';

export class ChatPanel {
  public static currentPanel: ChatPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _lollmsAPI: LollmsAPI;
  private _disposables: vscode.Disposable[] = [];
  private _chatHistory: ChatMessage[] = [];

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
        enableScripts: true
      }
    );

    ChatPanel.currentPanel = new ChatPanel(panel, extensionUri, lollmsAPI);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, lollmsAPI: LollmsAPI) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._lollmsAPI = lollmsAPI;

    // Set initial HTML content
    this._panel.webview.html = this._getHtmlForWebview();

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      async message => {
        switch (message.command) {
          case 'sendMessage':
            await this.handleUserMessage(message.text);
            return;
        }
      },
      null,
      this._disposables
    );

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  public dispose() {
    ChatPanel.currentPanel = undefined;

    // Clean up
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) d.dispose();
    }
  }

  private async handleUserMessage(text: string) {
    // Add user message to chat history and show it
    this._chatHistory.push({ role: 'user', content: text });
    this._postMessage({ role: 'user', content: text });

    // Call Lollms API
    try {
      const reply = await this._lollmsAPI.sendChat(this._chatHistory);
      this._chatHistory.push({ role: 'assistant', content: reply });
      this._postMessage({ role: 'assistant', content: reply });
    } catch (error) {
      this._postMessage({ role: 'error', content: (error as Error).message });
    }
  }

  private _postMessage(message: { role: string; content: string }) {
    this._panel.webview.postMessage(message);
  }

  private _getHtmlForWebview() {
    // Basic HTML chat UI with scripts to send and receive messages
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Lollms Chat</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 0; padding: 0; display: flex; flex-direction: column; height: 100vh; }
          #messages { flex: 1; padding: 10px; overflow-y: auto; background: #1e1e1e; color: white; }
          .message { margin-bottom: 10px; }
          .user { color: #4fc1ff; }
          .assistant { color: #a5e844; }
          .error { color: #f48771; }
          #input { display: flex; }
          input { flex: 1; padding: 10px; border: none; outline: none; font-size: 14px; }
          button { padding: 10px; }
        </style>
      </head>
      <body>
        <div id="messages"></div>
        <div id="input">
          <input type="text" id="messageInput" placeholder="Type your message here..." />
          <button id="sendButton">Send</button>
        </div>

        <script>
          const vscode = acquireVsCodeApi();
          const messagesDiv = document.getElementById('messages');
          const input = document.getElementById('messageInput');
          const sendButton = document.getElementById('sendButton');

          function addMessage(role, content) {
            const messageElement = document.createElement('div');
            messageElement.classList.add('message');
            messageElement.classList.add(role);
            messageElement.textContent = content;
            messagesDiv.appendChild(messageElement);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
          }

          sendButton.addEventListener('click', () => {
            const text = input.value.trim();
            if (!text) return;
            addMessage('user', text);
            vscode.postMessage({ command: 'sendMessage', text });
            input.value = '';
          });

          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              sendButton.click();
            }
          });

          window.addEventListener('message', event => {
            const message = event.data;
            if (message.role === 'user') {
              // Already added by input handler
              return;
            } else if (message.role === 'assistant') {
              addMessage('assistant', message.content);
            } else if (message.role === 'error') {
              addMessage('error', 'Error: ' + message.content);
            }
          });
        </script>
      </body>
      </html>
    `;
  }
}

