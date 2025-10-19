import * as vscode from 'vscode';
import { CodeGraphManager, CodeGraphNode } from '../codeGraphManager';

export class CodeExplorerTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private codeGraphManager: CodeGraphManager) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
        if (element instanceof CodeGraphItem) {
            return Promise.resolve(element.node.children.map(child => new CodeGraphItem(child)));
        }

        if (!element) {
            if (this.codeGraphManager.getBuildState() === 'idle') {
                const placeholder = new vscode.TreeItem("Click 'Build Code Graph' to start...", vscode.TreeItemCollapsibleState.None);
                placeholder.iconPath = new vscode.ThemeIcon('info');
                return Promise.resolve([placeholder]);
            }

            const graphData = this.codeGraphManager.getGraphData();
            if (graphData.length === 0) {
                const placeholder = new vscode.TreeItem("No code elements found in visible files.", vscode.TreeItemCollapsibleState.None);
                placeholder.iconPath = new vscode.ThemeIcon('info');
                return Promise.resolve([placeholder]);
            }

            return Promise.resolve(graphData.map(node => new CodeGraphItem(node)));
        }
        return Promise.resolve([]);
    }
}

class CodeGraphItem extends vscode.TreeItem {
    constructor(public readonly node: CodeGraphNode) {
        super(node.label, node.children.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        
        this.id = node.id;
        this.description = this.node.type === 'file' ? this.node.filePath : '';
        this.contextValue = `codeGraphItem:${node.type}`;

        const iconMapping = {
            file: 'file-code',
            class: 'symbol-class',
            function: 'symbol-method',
            method: 'symbol-method',
            enum: 'symbol-enum'
        };
        this.iconPath = new vscode.ThemeIcon(iconMapping[node.type] || 'symbol-misc');
    }
}