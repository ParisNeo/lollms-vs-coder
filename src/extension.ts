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

  const configProvider = new ConfigViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ConfigViewProvider.viewType,
      configProvider
    )
  );

    const contextManager = new ContextManager(context);

  const addFileCommand = vscode.commands.registerCommand('lollms-vs-coder.addFileToContext', () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      contextManager.addFileToContext(editor.document.uri);
    } else {
      vscode.window.showInformationMessage('No active editor file to add.');
    }
  });

  const removeFileCommand = vscode.commands.registerCommand('lollms-vs-coder.removeFileFromContext', () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      contextManager.removeFileFromContext(editor.document.uri);
    } else {
      vscode.window.showInformationMessage('No active editor file to remove.');
    }
  });

  context.subscriptions.push(addFileCommand, removeFileCommand);
}

export function deactivate() {}
