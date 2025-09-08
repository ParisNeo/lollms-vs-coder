import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  console.log('Lollms VS Coder is now active!');

  const startChatCommand = vscode.commands.registerCommand('lollms-vs-coder.startChat', () => {
    vscode.window.showInformationMessage('Lollms chat started (placeholder)');
    // TODO: Initialize chat panel and Lollms API interaction here
  });

  context.subscriptions.push(startChatCommand);
}

export function deactivate() {}
