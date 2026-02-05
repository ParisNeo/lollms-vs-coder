import * as vscode from 'vscode';
import { RLMDatabaseManager, KnowledgeNode } from '../rlmDatabaseManager';

export class RLMDatabaseTreeProvider implements vscode.TreeDataProvider<RLMItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<RLMItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private manager: RLMDatabaseManager) {
        this.manager.onDidChange(() => this._onDidChangeTreeData.fire(undefined));
    }

    getTreeItem(element: RLMItem): vscode.TreeItem { return element; }

    async getChildren(element?: RLMItem): Promise<RLMItem[]> {
        if (!element) {
            return [
                new RLMItem("Global Knowledge", vscode.TreeItemCollapsibleState.Collapsed, true, true),
                new RLMItem("Project Knowledge", vscode.TreeItemCollapsibleState.Collapsed, false, true)
            ];
        }

        const data = await this.manager.getHierarchy(element.isGlobal);
        let target = data;
        
        if (element.path.length > 0) {
            let current: any = data;
            for (const seg of element.path) {
                current = current[seg]?.children || {};
            }
            target = current;
        }

        return Object.entries(target).map(([key, node]) => {
            const hasChildren = node.children && Object.keys(node.children).length > 0;
            const item = new RLMItem(
                key, 
                hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                element.isGlobal,
                false,
                [...element.path, key],
                node
            );
            return item;
        });
    }
}

class RLMItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly isGlobal: boolean,
        public readonly isRoot: boolean,
        public readonly path: string[] = [],
        public readonly node?: KnowledgeNode
    ) {
        super(label, collapsibleState);
        this.contextValue = isRoot ? 'rlmRoot' : 'rlmEntry';
        this.iconPath = new vscode.ThemeIcon(node?.value ? 'book' : 'folder');
        if (node?.summary) this.description = node.summary;
        
        if (node?.value) {
            this.command = {
                command: 'lollms-vs-coder.viewKnowledge',
                title: 'View Knowledge',
                arguments: [label, node.value]
            };
        }
    }
}
