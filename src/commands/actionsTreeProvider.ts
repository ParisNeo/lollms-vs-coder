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
            actions.push(new ActionItem(vscode.l10n.t('Lollms Studio (Skills/Personas)'), 'lollms-vs-coder.openStudio', 'beaker', 'Open the building studio'));
            actions.push(new ActionItem(vscode.l10n.t('CVE Report Builder'), 'lollms-vs-coder.openCveBuilder', 'shield', 'Build a vulnerability report'));
            actions.push(new ActionItem(vscode.l10n.t('Fix All Workspace Errors'), 'lollms-vs-coder.fixAllErrors', 'zap', 'Autonomous repair loop'));
            actions.push(new ActionItem(vscode.l10n.t('Copy All Problems'), 'lollms-vs-coder.copyAllErrors', 'clippy', 'Copy error list to clipboard'));
            actions.push(new ActionItem(vscode.l10n.t('Deep Workspace Search'), 'lollms-vs-coder.showFileSearch', 'search', 'Search code content'));
            actions.push(new ActionItem(vscode.l10n.t('Generate Tutorial Notebook'), 'lollms-vs-coder.generateEducativeNotebookFromAction', 'book', 'Generate ipynb file'));
            actions.push(new ActionItem(vscode.l10n.t('Show System Logs'), 'lollms-vs-coder.showLog', 'output', 'Open output channel'));
            actions.push(new ActionItem('Clear System Logs', 'lollms-vs-coder.clearLog', 'trash', 'Wipe all log files and in-memory entries'));
            actions.push(new ActionItem(l.t('label.showHelp'), 'lollms-vs-coder.showHelp', 'question', l.t('tooltip.showHelp')));
        }

        return Promise.resolve(actions);
    }
}
