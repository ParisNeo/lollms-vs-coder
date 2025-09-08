import * as vscode from 'vscode';
import { ChatPanel } from './commands/chatPanel';
import { LollmsAPI } from './lollmsAPI';

export function activate(context: vscode.ExtensionContext) {
  console.log('Lollms VS Coder is now active!');

  // Initialize Lollms API with config (example - to replace with actual config management)
  const lollmsAPI = new LollmsAPI({
    apiUrl: 'http://localhost:9642/v1/chat/completions',
    apiKey: 'YOUR_API_KEY_HERE'
  });

  const startChatCommand = vscode.commands.registerCommand('lollms-vs-coder.startChat', () => {
    ChatPanel.createOrShow(context.extensionUri, lollmsAPI);
  });

  context.subscriptions.push(startChatCommand);
}

export function deactivate() {}
