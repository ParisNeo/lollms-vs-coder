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

        const actions: ActionItem[] = [];

        if (hasWorkspace) {
            actions.push(new ActionItem(l.t('Lollms Studio (Personas, Skills, Tools)'), 'lollms-vs-coder.openStudio', 'beaker', 'Open Lollms Studio'));
            actions.push(new ActionItem(l.t('Fix All Errors'), 'lollms-vs-coder.fixAllErrors', 'zap', 'Iteratively repair all workspace errors'));
            actions.push(new ActionItem(l.t('Copy Problems List'), 'lollms-vs-coder.copyAllErrors', 'clippy', 'Copy all current workspace problems to clipboard'));
            actions.push(new ActionItem(l.t('Deep Search'), 'lollms-vs-coder.showFileSearch', 'search', 'Power search across project content'));
            actions.push(new ActionItem(l.t('Generate Notebook'), 'lollms-vs-coder.generateEducativeNotebookFromAction', 'book', 'Create a pedagogical tutorial notebook'));
            actions.push(new ActionItem(l.t('Log'), 'lollms-vs-coder.showLog', 'output', 'Show Internal Logs'));
            actions.push(new ActionItem(l.t('Help'), 'lollms-vs-coder.showHelp', 'question', 'View Documentation'));
        }

        return Promise.resolve(actions);
    }
}
