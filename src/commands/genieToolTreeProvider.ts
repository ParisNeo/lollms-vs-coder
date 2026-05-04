import * as vscode from 'vscode';
import { ToolManager } from '../tools/toolManager';
import { AgentManager } from '../agentManager';
import { ChatPanel } from './chatPanel/chatPanel';

export class GenieToolTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private toolManager: ToolManager) {}

    refresh() { this._onDidChangeTreeData.fire(undefined); }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        const agent = ChatPanel.currentPanel?.agentManager;
        if (!agent) return [];

        const session = agent.sessionState as any;
        const activeIds = session.activeToolIds || new Set();

        if (!element) {
            return [
                new vscode.TreeItem("Foreground (Live)", vscode.TreeItemCollapsibleState.Expanded),
                new vscode.TreeItem("Background (Latent)", vscode.TreeItemCollapsibleState.Collapsed)
            ];
        }

        const isLiveGroup = element.label === "Foreground (Live)";
        const tools = this.toolManager.getAllTools().filter(t => {
            const isActive = activeIds.has(t.name);
            return isLiveGroup ? isActive : !isActive;
        });

        return tools.map(t => {
            const item = new vscode.TreeItem(t.name, vscode.TreeItemCollapsibleState.None);
            item.description = t.description;
            item.iconPath = new vscode.ThemeIcon(isLiveGroup ? 'zap' : 'archive');
            item.contextValue = isLiveGroup ? 'activeGenieTool' : 'latentGenieTool';
            return item;
        });
    }
}