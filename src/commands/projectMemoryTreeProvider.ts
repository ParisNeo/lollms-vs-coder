import * as vscode from 'vscode';
import { ProjectMemoryManager, MemoryEntry } from '../projectMemoryManager';

export class ProjectMemoryTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private manager: ProjectMemoryManager) {
        this.manager.onDidChange(() => this.refresh());
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (element) return [];

        const memories = await this.manager.getMemories();
        return memories.map(m => new MemoryItem(m));
    }
}

class MemoryItem extends vscode.TreeItem {
    constructor(public readonly memory: MemoryEntry) {
        super(memory.title, vscode.TreeItemCollapsibleState.None);
        this.id = memory.id;
        this.description = memory.id;
        this.tooltip = memory.content;
        this.contextValue = 'projectMemory'; // This matches the 'when' clause in package.json
        this.iconPath = new vscode.ThemeIcon('chip');
        
        this.command = {
            command: 'lollms-vs-coder.manageProjectMemory',
            title: 'Manage Memories'
        };
    }
}