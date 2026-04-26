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
            actions.push(new ActionItem(l.t('label.lollmsStudio'), 'lollms-vs-coder.openStudio', 'beaker', l.t('tooltip.openStudio')));
            actions.push(new ActionItem(l.t('label.cveBuilder'), 'lollms-vs-coder.openCveBuilder', 'shield', l.t('tooltip.cveBuilder')));
            actions.push(new ActionItem(l.t('label.fixAllErrors'), 'lollms-vs-coder.fixAllErrors', 'zap', l.t('tooltip.fixAllErrors')));
            actions.push(new ActionItem(l.t('label.copyErrors'), 'lollms-vs-coder.copyAllErrors', 'clippy', l.t('tooltip.copyErrors')));
            actions.push(new ActionItem(l.t('label.deepSearch'), 'lollms-vs-coder.showFileSearch', 'search', l.t('tooltip.deepSearch')));
            actions.push(new ActionItem(l.t('label.generateNotebook'), 'lollms-vs-coder.generateEducativeNotebookFromAction', 'book', l.t('tooltip.generateNotebook')));
            actions.push(new ActionItem(l.t('label.showLog'), 'lollms-vs-coder.showLog', 'output', l.t('tooltip.showLog')));
            actions.push(new ActionItem('Clear System Logs', 'lollms-vs-coder.clearLog', 'trash', 'Wipe all log files and in-memory entries'));
            actions.push(new ActionItem(l.t('label.showHelp'), 'lollms-vs-coder.showHelp', 'question', l.t('tooltip.showHelp')));
        }

        return Promise.resolve(actions);
    }
}
