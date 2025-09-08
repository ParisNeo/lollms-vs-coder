import * as vscode from 'vscode';
import { ChatPanel } from './commands/chatPanel';
import { LollmsAPI } from './lollmsAPI';

export function activate(context: vscode.ExtensionContext) {
  console.log('Lollms VS Coder is now active!');

  const config = vscode.workspace.getConfiguration('lollmsVsCoder');
  const apiKey = config.get<string>('apiKey') || '';
  const apiHost = config.get<string>('apiHost') || 'http://localhost:9642';

  const lollmsAPI = new LollmsAPI({
    apiUrl: `${apiHost}/v1/chat/completions`,
    apiKey: apiKey
  });

  const startChatCommand = vscode.commands.registerCommand('lollms-vs-coder.startChat', () => {
    ChatPanel.createOrShow(context.extensionUri, lollmsAPI);
  });

  context.subscriptions.push(startChatCommand);
}

export function deactivate() {}
