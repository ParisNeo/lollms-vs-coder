import * as vscode from 'vscode';
import { PromptManager, Prompt, PromptGroup } from '../promptManager';
import { PromptItem, PromptGroupItem } from './treeItems';

export class ChatPromptTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private promptManager: PromptManager) {
        this.promptManager.getData().then(() => this.refresh());
    }

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
            // Children of a group are the prompts in that group
            return chatPrompts
                .filter(p => p.groupId === element.group.id)
                .map(p => new PromptItem(p));
        }

        if (!element) {
            // Root level: show groups and ungrouped prompts
            const groups = data.groups.map(g => new PromptGroupItem(g));
            const ungroupedPrompts = chatPrompts
                .filter(p => !p.groupId || !data.groups.some(g => g.id === p.groupId))
                .map(p => new PromptItem(p));
            
            return [...groups, ...ungroupedPrompts];
        }

        return [];
    }
}