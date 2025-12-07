import * as vscode from 'vscode';
import { CodeGraphManager, CodeGraphNode, CodeGraph } from '../codeGraphManager';

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
        const graph = this.codeGraphManager.getGraphData();

        if (!element) { // Root level: show files
            if (this.codeGraphManager.getBuildState() === 'idle') {
                const placeholder = new vscode.TreeItem("Click the refresh icon to build the graph", vscode.TreeItemCollapsibleState.None);
                placeholder.iconPath = new vscode.ThemeIcon('info');
                return Promise.resolve([placeholder]);
            }
            const fileNodes = graph.nodes.filter(n => n.type === 'file');
            return Promise.resolve(fileNodes.map(n => new CodeGraphItem(n, 'file', graph)));
        }

        if (element instanceof CodeGraphItem) {
            return Promise.resolve(element.getChildren(graph));
        }
        
        return Promise.resolve([]);
    }
}

class CodeGraphItem extends vscode.TreeItem {
    constructor(
        public readonly node: CodeGraphNode,
        public readonly itemType: 'file' | 'symbol' | 'calls-group' | 'called-by-group' | 'call-site',
        private graph: CodeGraph | null = null // Only root nodes need the full graph
    ) {
        let collapsibleState = vscode.TreeItemCollapsibleState.None;
        if (itemType === 'file' || itemType === 'symbol' || itemType === 'calls-group' || itemType === 'called-by-group') {
            collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        }

        super(node.label, collapsibleState);
        
        this.id = node.id;
        this.command = node.command;
        this.tooltip = node.docstring;

        const iconMapping = {
            file: 'file-code',
            symbol: node.type === 'class' ? 'symbol-class' : (node.type === 'interface' ? 'symbol-interface' : (node.type === 'property' ? 'symbol-property' : 'symbol-method')),
            'calls-group': 'arrow-right',
            'called-by-group': 'arrow-left',
            'call-site': 'symbol-method',
        };
        // @ts-ignore
        this.iconPath = new vscode.ThemeIcon(iconMapping[itemType] || 'circle-outline');
    }

    getChildren(graph: CodeGraph): CodeGraphItem[] {
        const children: CodeGraphItem[] = [];

        if (this.itemType === 'file' && this.graph) {
            // Children of a file are its symbols
            this.graph.edges.filter(e => e.source === this.node.id && e.label === 'contains').forEach(edge => {
                const targetNode = this.graph!.nodes.find(n => n.id === edge.target);
                if (targetNode) {
                    children.push(new CodeGraphItem(targetNode, 'symbol', this.graph));
                }
            });
        } else if (this.itemType === 'symbol' && this.graph) {
            // Children of a symbol are "Calls" and "Called By" groups
            // But only if it's a function/method
            if (this.node.type === 'function') {
                const calls = this.graph.edges.filter(e => e.source === this.node.id && e.label === 'calls');
                const calledBy = this.graph.edges.filter(e => e.target === this.node.id && e.label === 'calls');
                if (calls.length > 0) {
                     children.push(new CodeGraphItem({ ...this.node, id: `${this.node.id}:calls`, label: 'Calls' }, 'calls-group', this.graph));
                }
                if (calledBy.length > 0) {
                     children.push(new CodeGraphItem({ ...this.node, id: `${this.node.id}:called-by`, label: 'Called By' }, 'called-by-group', this.graph));
                }
            }
            // If it's a class, show its members (methods/properties)
            if (this.node.type === 'class' || this.node.type === 'interface') {
                 this.graph.edges.filter(e => e.source === this.node.id && e.label === 'contains').forEach(edge => {
                    const targetNode = this.graph!.nodes.find(n => n.id === edge.target);
                    if (targetNode) {
                        children.push(new CodeGraphItem(targetNode, 'symbol', this.graph));
                    }
                });
            }
        } else if (this.itemType === 'calls-group' && this.graph) {
            // Children of "Calls" are the functions it calls
            this.graph.edges.filter(e => e.source === this.node.id.replace(':calls', '') && e.label === 'calls').forEach(edge => {
                const targetNode = this.graph!.nodes.find(n => n.id === edge.target);
                if (targetNode) {
                    children.push(new CodeGraphItem(targetNode, 'call-site', this.graph));
                }
            });
        } else if (this.itemType === 'called-by-group' && this.graph) {
            // Children of "Called By" are the functions that call it
            this.graph.edges.filter(e => e.target === this.node.id.replace(':called-by', '') && e.label === 'calls').forEach(edge => {
                const sourceNode = this.graph!.nodes.find(n => n.id === edge.source);
                if (sourceNode) {
                    children.push(new CodeGraphItem(sourceNode, 'call-site', this.graph));
                }
            });
        }
        return children;
    }
}
