import * as vscode from 'vscode';
import { PromptManager } from '../promptManager';
import { PromptItem, PromptGroupItem } from './treeItems';

export class ChatPromptTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private promptManager: PromptManager) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        const data = await this.promptManager.getData();
        const chatPrompts = data.prompts.filter(p => p.type === 'chat');

        if (element instanceof PromptGroupItem) {
            return chatPrompts
                .filter(p => p.groupId === element.group.id)
                .map(p => new PromptItem(p));
        }

        if (!element) {
            const groups = data.groups.map(g => new PromptGroupItem(g, vscode.TreeItemCollapsibleState.Collapsed));
            const ungroupedPrompts = chatPrompts
                .filter(p => p.groupId === null)
                .map(p => new PromptItem(p));
            
            return [...groups, ...ungroupedPrompts];
        }

        return [];
    }
}