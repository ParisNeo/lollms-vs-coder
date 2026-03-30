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
        const l = vscode.l10n;

        const actions: ActionItem[] = [
            new ActionItem(l.t('Settings'), 'lollms-vs-coder.showConfigView', 'gear', 'Open Lollms Configuration'),
            new ActionItem(l.t('Help'), 'lollms-vs-coder.showHelp', 'question', 'View Documentation'),
            new ActionItem(l.t('Log'), 'lollms-vs-coder.showLog', 'output', 'Show Internal Logs'),
        ];

        if (hasWorkspace) {
            actions.unshift(new ActionItem(l.t('Git Dashboard'), 'lollms-vs-coder.showGitDashboard', 'git-merge', 'Manage Git repository'));
            actions.unshift(new ActionItem(l.t('Fix Errors'), 'lollms-vs-coder.fixAllErrors', 'zap', 'Iteratively repair project errors'));
            actions.unshift(new ActionItem(l.t('Deep Search'), 'lollms-vs-coder.showFileSearch', 'search', 'Power search across project content'));
            actions.unshift(new ActionItem(l.t('Generate Notebook'), 'lollms-vs-coder.generateEducativeNotebookFromAction', 'book', 'Create a pedagogical tutorial notebook'));
            actions.push(new ActionItem(l.t('Architecture Graph'), 'lollms-vs-coder.showCodeGraphPanel', 'git-compare', 'Visualize code structure'));
            actions.push(new ActionItem(l.t('Auto Context'), 'lollms-vs-coder.autoSelectContextFiles', 'wand', 'AI-assisted context gathering'));
            actions.push(new ActionItem('Export Context', 'lollms-vs-coder.exportContextContent', 'clippy', 'Copy the full project context to the clipboard'));
            actions.push(new ActionItem('Save Context Selection', 'lollms-vs-coder.saveContextSelection', 'save', 'Save the current file selection to a .lollms-ctx file'));
            actions.push(new ActionItem('Load Context Selection', 'lollms-vs-coder.loadContextSelection', 'folder-opened', 'Load a file selection from a .lollms-ctx file'));
            actions.push(new ActionItem('Reset Included Files', 'lollms-vs-coder.resetContextSelection', 'clear-all', 'Deselect all included files (keeps exclusions)'));
            actions.push(new ActionItem('Full Context Reset', 'lollms-vs-coder.fullResetContext', 'trash', 'Reset entire context state to defaults'));
        }

        return Promise.resolve(actions);
    }
}
