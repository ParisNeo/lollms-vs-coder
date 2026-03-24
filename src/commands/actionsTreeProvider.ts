import * as vscode from 'vscode';

class ActionItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly commandId: string,
        public readonly icon: string,
        public readonly tooltip: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(icon);
        this.command = {
            command: commandId,
            title: label,
            tooltip: tooltip
        };
    }
}

export class ActionsTreeProvider implements vscode.TreeDataProvider<ActionItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ActionItem | undefined | null | void> = new vscode.EventEmitter<ActionItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ActionItem | undefined | null | void> = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ActionItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ActionItem): Thenable<ActionItem[]> {
        if (element) {
            return Promise.resolve([]);
        }

        const hasWorkspace = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;

        const { LocalizationManager: l } = require('../utils/localizationManager');

        const actions: ActionItem[] = [
            new ActionItem(l.t('action.settings'), 'lollms-vs-coder.showConfigView', 'gear', l.t('action.settings.tooltip')),
            new ActionItem(l.t('action.help'), 'lollms-vs-coder.showHelp', 'question', l.t('action.help.tooltip')),
            new ActionItem(l.t('action.log'), 'lollms-vs-coder.showLog', 'output', l.t('action.log.tooltip')),
        ];

        if (hasWorkspace) {
            actions.unshift(new ActionItem(l.t('action.git'), 'lollms-vs-coder.showGitDashboard', 'git-merge', l.t('action.git.tooltip')));
            actions.unshift(new ActionItem(l.t('action.fixErrors'), 'lollms-vs-coder.fixAllErrors', 'zap', l.t('action.fixErrors.tooltip')));
            actions.unshift(new ActionItem(l.t('action.search'), 'lollms-vs-coder.showFileSearch', 'search', l.t('action.search.tooltip')));
            actions.unshift(new ActionItem(l.t('action.notebook'), 'lollms-vs-coder.generateEducativeNotebookFromAction', 'book', l.t('action.notebook.tooltip')));
            actions.push(new ActionItem(l.t('action.graph'), 'lollms-vs-coder.showCodeGraphPanel', 'git-compare', l.t('action.graph.tooltip')));
            actions.push(new ActionItem(l.t('action.autoContext'), 'lollms-vs-coder.autoSelectContextFiles', 'wand', l.t('action.autoContext.tooltip')));
            actions.push(new ActionItem('Export Context', 'lollms-vs-coder.exportContextContent', 'clippy', 'Copy the full project context to the clipboard'));
            actions.push(new ActionItem('Save Context Selection', 'lollms-vs-coder.saveContextSelection', 'save', 'Save the current file selection to a .lollms-ctx file'));
            actions.push(new ActionItem('Load Context Selection', 'lollms-vs-coder.loadContextSelection', 'folder-opened', 'Load a file selection from a .lollms-ctx file'));
            actions.push(new ActionItem('Reset Included Files', 'lollms-vs-coder.resetContextSelection', 'clear-all', 'Deselect all included files (keeps exclusions)'));
            actions.push(new ActionItem('Full Context Reset', 'lollms-vs-coder.fullResetContext', 'trash', 'Reset entire context state to defaults'));
        }

        return Promise.resolve(actions);
    }
}
