import * as vscode from 'vscode';
import { ToolManager } from '../tools/toolManager';
import { ToolDefinition } from '../tools/tool';

export class ToolTesterProvider implements vscode.TreeDataProvider<ToolItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ToolItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private toolManager: ToolManager) {}

    refresh() { this._onDidChangeTreeData.fire(undefined); }

    getTreeItem(element: ToolItem): vscode.TreeItem { return element; }

    async getChildren(element?: ToolItem): Promise<ToolItem[]> {
        if (element) return [];
        if (!this.toolManager) {
            console.error("[ToolTester] ToolManager is undefined");
            return [];
        }
        const tools = this.toolManager.getAllTools() || [];
        return tools.map((t: any) => new ToolItem(t));
    }
}

class ToolItem extends vscode.TreeItem {
    constructor(public readonly tool: ToolDefinition) {
        super(tool.name, vscode.TreeItemCollapsibleState.None);
        this.description = tool.description.substring(0, 40) + "...";
        this.tooltip = tool.description;
        this.iconPath = new vscode.ThemeIcon(tool.isAgentic ? 'bolt' : 'tools');
        this.contextValue = 'toolToTest';
        this.command = {
            command: 'lollms-vs-coder.openToolTester',
            title: 'Test Tool',
            arguments: [tool]
        };
    }
}