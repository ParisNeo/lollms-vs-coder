import * as vscode from 'vscode';
import { LollmsAPI } from './lollmsAPI';
import { ChatPanel } from './commands/chatPanel';
import { ConfigViewProvider } from './commands/configView';
import { ContextManager } from './contextManager';
import { GitIntegration } from './gitIntegration';

let lollmsAPI: LollmsAPI = new LollmsAPI({
        apiUrl: "",
        apiKey: "",
        modelName: ""
      });

export function activate(context: vscode.ExtensionContext) {
  console.log('Lollms VS Coder is now active!');

  const config = vscode.workspace.getConfiguration('lollmsVsCoder');
  const apiKey = config.get<string>('apiKey')?.trim() || '';
  const apiUrl = config.get<string>('apiUrl') || 'http://localhost:9642';
  const modelName = config.get<string>('modelName') || 'ollama/mistral';

  lollmsAPI = new LollmsAPI({
    apiUrl: `${apiUrl}/v1/chat/completions`,
    apiKey: apiKey,
    modelName: modelName
  });
  console.log('Lollms API created!');

  // Register start chat command
  const startChatCommand = vscode.commands.registerCommand('lollms-vs-coder.startChat', () => {
    ChatPanel.createOrShow(context.extensionUri, lollmsAPI);
  });
  context.subscriptions.push(startChatCommand);
  console.log(ConfigViewProvider.viewType)
  // Register the Config View Provider (only once)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ConfigViewProvider.viewType,
      new ConfigViewProvider(context.extensionUri)
    )
  );
  vscode.commands.registerCommand('lollmsSettings.fetchModels', async (apiUrl: string, apiKey: string) => {
    const fetch = require('node-fetch');
    try {
      const url = apiUrl.replace(/\/+$/, '') + '/v1/models';
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      });
      if (!response.ok) {
        throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
      }
      const data = await response.json();
      return data.data || []; // OpenAI models list is in data.data
    } catch (err) {
      console.error('Error fetching models in extension:', err);
      return [];
    }
  });
  const contextManager = new ContextManager(context);

  // Register add file to context command
  const addFileCommand = vscode.commands.registerCommand('lollms-vs-coder.addFileToContext', () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      contextManager.addFileToContext(editor.document.uri);
    } else {
      vscode.window.showInformationMessage('No active editor file to add.');
    }
  });

  // Register remove file from context command
  const removeFileCommand = vscode.commands.registerCommand('lollms-vs-coder.removeFileFromContext', () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      contextManager.removeFileFromContext(editor.document.uri);
    } else {
      vscode.window.showInformationMessage('No active editor file to remove.');
    }
  });

  context.subscriptions.push(addFileCommand, removeFileCommand);

  const gitIntegration = new GitIntegration(lollmsAPI);

  // Generate AI commit message command
  const generateCommitCommand = vscode.commands.registerCommand('lollms-vs-coder.generateCommitMessage', async () => {
    if (!(await gitIntegration.isGitRepo())) {
      vscode.window.showErrorMessage('This workspace is not a git repository.');
      return;
    }
    const message = await gitIntegration.generateCommitMessage();
    if (message) {
      vscode.window.showInformationMessage('AI Commit Message: ' + message);
      await vscode.env.clipboard.writeText(message);
      vscode.window.showInformationMessage('Commit message copied to clipboard.');
    }
  });

  // Commit with AI message command
  const commitWithAICommand = vscode.commands.registerCommand('lollms-vs-coder.commitWithAIMessage', async () => {
    if (!(await gitIntegration.isGitRepo())) {
      vscode.window.showErrorMessage('This workspace is not a git repository.');
      return;
    }
    const message = await gitIntegration.generateCommitMessage();
    if (message) {
      const confirmed = await vscode.window.showQuickPick(['Yes', 'No'], { placeHolder: `Commit with message:\n\n${message}\n\nConfirm?` });
      if (confirmed === 'Yes') {
        await gitIntegration.commitWithMessage(message);
      }
    }
  });

  context.subscriptions.push(generateCommitCommand, commitWithAICommand);
  vscode.commands.registerCommand('lollmsApi.recreateClient', async (config: any) => {
    try {
      if (!config || typeof config !== 'object') {
        vscode.window.showErrorMessage('Invalid config passed to recreateClient command.');
        throw new Error('Invalid config argument');
      }
  
      // Example type assertion or runtime cast
      const cfg = config as { apiKey: string, apiUrl: string, modelName: string };
  
      // Create the new client with typed config
      lollmsAPI = createLollmsApiClient(cfg);
  
      vscode.window.showInformationMessage('LollmsAPI client recreated successfully.');
    } catch (error: any) {
      vscode.window.showErrorMessage('Failed to recreate LollmsAPI client: ' + error.message);
      console.error('Error recreating LollmsAPI client:', error);
    }
  });
  
  // Create and show a status bar item for quick access to chat
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.text = '$(rocket) Lollms Chat';
  statusBar.command = 'lollms-vs-coder.startChat';
  statusBar.tooltip = 'Start Lollms AI Chat';
  statusBar.show();
  context.subscriptions.push(statusBar);

  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    const fileTreeProvider = contextManager.getFileTreeProvider();
    if (fileTreeProvider) {
      context.subscriptions.push(
        vscode.window.createTreeView('lollmsSettings.fileTreeView', {
          treeDataProvider: fileTreeProvider,
          showCollapseAll: true
        })
      );
  
      // Register toggle file context command
      const cycleFileStateCommand = vscode.commands.registerCommand(
        'lollms-vs-coder.cycleFileState', 
        (item: any) => {
          fileTreeProvider.cycleFileState(item);
        }
      );
      context.subscriptions.push(cycleFileStateCommand);
    }
  }
  
  // Add refresh command
  const refreshTreeCommand = vscode.commands.registerCommand('lollms-vs-coder.refreshTree', () => {
    const fileTreeProvider = contextManager.getFileTreeProvider();
    if (fileTreeProvider) {
      fileTreeProvider.refresh();
    }
  });
  context.subscriptions.push(refreshTreeCommand);

  
  console.log('Extension activation complete.');
}

function createLollmsApiClient(config: { apiKey: string, apiUrl: string, modelName: string }) {
  // Dummy example:
  return new LollmsAPI({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      modelName: config.modelName,
  });
}
export function getLollmsApiClient() {
  return lollmsAPI;
}
export function deactivate() {}

