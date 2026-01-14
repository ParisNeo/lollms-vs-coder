import * as vscode from 'vscode';
import { LollmsAPI } from '../lollmsAPI';

export class LollmsStatusBar implements vscode.Disposable {
    private activeWorkspaceItem: vscode.StatusBarItem;
    private chatItem: vscode.StatusBarItem;
    private quickEditItem: vscode.StatusBarItem;
    private connectionItem: vscode.StatusBarItem;
    private modelItem: vscode.StatusBarItem;
    private processesItem: vscode.StatusBarItem;
    private disposables: vscode.Disposable[] = [];

    constructor(private context: vscode.ExtensionContext, private lollmsAPI: LollmsAPI) {
        // Active Workspace
        this.activeWorkspaceItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
        this.activeWorkspaceItem.command = 'lollms-vs-coder.selectActiveWorkspace';
        context.subscriptions.push(this.activeWorkspaceItem);

        // Chat
        this.chatItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.chatItem.text = '$(comment-discussion) Lollms Chat';
        this.chatItem.command = 'lollms-vs-coder.startChat';
        this.chatItem.tooltip = vscode.l10n.t('tooltip.startNewDiscussion');
        this.chatItem.show();
        context.subscriptions.push(this.chatItem);

        // Quick Edit
        this.quickEditItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
        this.quickEditItem.text = '$(sparkle) lollms';
        this.quickEditItem.command = 'lollms-vs-coder.quickEdit';
        this.quickEditItem.tooltip = 'Open Lollms Companion (Quick Edit/Ask) - Ctrl+Shift+L';
        this.quickEditItem.show();
        context.subscriptions.push(this.quickEditItem);

        // Connection Status
        this.connectionItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
        this.connectionItem.command = 'lollms-vs-coder.checkConnection';
        this.connectionItem.text = '$(sync~spin) Lollms: Checking...';
        this.connectionItem.tooltip = 'Click to re-check connection to Lollms Server';
        this.connectionItem.show();
        context.subscriptions.push(this.connectionItem);

        // Model
        this.modelItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
        this.modelItem.command = 'lollms-vs-coder.selectModel';
        this.modelItem.tooltip = vscode.l10n.t('tooltip.selectModel');
        context.subscriptions.push(this.modelItem);
        this.updateModel();

        // Processes
        this.processesItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 97);
        this.processesItem.command = 'lollms-vs-coder.showRunningProcesses';
        context.subscriptions.push(this.processesItem);

        // Initial Check
        this.checkConnection();

        // Listen for configuration changes to update the model name in status bar
        this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('lollmsVsCoder.modelName')) {
                this.updateModel();
            }
        }));
    }

    public updateModel() {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const modelName = config.get('modelName') as string || vscode.l10n.t('label.notSet');
        this.modelItem.text = `$(chip) ${modelName}`;
        this.modelItem.show();
    }

    public async checkConnection() {
        this.connectionItem.text = '$(sync~spin) Lollms: Checking...';
        this.connectionItem.backgroundColor = undefined;
        try {
            await this.lollmsAPI.getModels(true);
            this.connectionItem.text = '$(pulse) Lollms: Online';
            this.connectionItem.tooltip = 'Lollms Server is Online. Click to re-check.';
        } catch (error) {
            this.connectionItem.text = '$(circle-slash) Lollms: Offline';
            this.connectionItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            this.connectionItem.tooltip = 'Lollms Server is Offline. Click to retry connection.';
        }
    }

    public updateActiveWorkspace(folder: vscode.WorkspaceFolder | undefined) {
        if (folder && (vscode.workspace.workspaceFolders?.length || 0) > 1) {
            this.activeWorkspaceItem.text = `$(root-folder) Lollms: ${folder.name}`;
            this.activeWorkspaceItem.tooltip = `Lollms is active in this workspace. Click to switch.`;
            this.activeWorkspaceItem.show();
        } else {
            this.activeWorkspaceItem.hide();
        }
    }

    public updateProcesses(count: number) {
        if (count > 0) {
            this.processesItem.text = `$(sync~spin) Lollms: ${count} Running`;
            this.processesItem.show();
        } else {
            this.processesItem.hide();
        }
    }

    public dispose() {
        this.disposables.forEach(d => d.dispose());
    }
}
