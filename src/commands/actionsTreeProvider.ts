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

        const actions: ActionItem[] = [
            new ActionItem('Generate Educative Notebook', 'lollms-vs-coder.generateEducativeNotebookFromAction', 'book', 'Generate a comprehensive notebook from a prompt'),
            new ActionItem('Settings', 'lollms-vs-coder.showConfigView', 'gear', 'Open Lollms settings panel'),
            new ActionItem('Help', 'lollms-vs-coder.showHelp', 'question', 'Show the help panel'),
            new ActionItem('Show Debug Log', 'lollms-vs-coder.showLog', 'output', 'Show the debug log for the active chat'),
            new ActionItem('Show Code Graph', 'lollms-vs-coder.showCodeGraphPanel', 'git-compare', 'Show the interactive code graph'),
            new ActionItem('Auto-Select Context', 'lollms-vs-coder.autoSelectContextFiles', 'wand', 'Let the AI select relevant files for an objective'),
            new ActionItem('Export Context', 'lollms-vs-coder.exportContextContent', 'clippy', 'Copy the full project context to the clipboard'),
            new ActionItem('Save Context Selection', 'lollms-vs-coder.saveContextSelection', 'save', 'Save the current file selection to a .lollms-ctx file'),
            new ActionItem('Load Context Selection', 'lollms-vs-coder.loadContextSelection', 'folder-opened', 'Load a file selection from a .lollms-ctx file'),
            new ActionItem('Reset Context', 'lollms-vs-coder.resetContextSelection', 'clear-all', 'Reset all file context states to default'),
        ];

        return Promise.resolve(actions);
    }
}
