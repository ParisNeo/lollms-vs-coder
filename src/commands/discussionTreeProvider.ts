import * as vscode from 'vscode';
import { Discussion, DiscussionGroup, DiscussionManager } from '../discussionManager';

type TreeItem = DiscussionGroupItem | DiscussionItem;

export class DiscussionTreeProvider implements vscode.TreeDataProvider<TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<TreeItem | undefined | null | void> = new vscode.EventEmitter<TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private discussionManager: DiscussionManager) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TreeItem): Promise<TreeItem[]> {
        if (element instanceof DiscussionGroupItem) {
            // Children of a group are its discussions
            const discussions = await this.discussionManager.getDiscussions(element.group.id);
            return discussions.map(d => new DiscussionItem(d));
        }

        // Top-level items are groups and ungrouped discussions
        const groups = await this.discussionManager.getGroups();
        const ungroupedDiscussions = await this.discussionManager.getDiscussions(null);

        const groupItems = groups.map(g => new DiscussionGroupItem(g));
        const discussionItems = ungroupedDiscussions.map(d => new DiscussionItem(d));
        
        return [...groupItems, ...discussionItems];
    }
}

export class DiscussionGroupItem extends vscode.TreeItem {
    constructor(public readonly group: DiscussionGroup) {
        super(group.title, vscode.TreeItemCollapsibleState.Collapsed);
        this.id = group.id;
        this.description = group.description;
        this.tooltip = `Group created: ${new Date(group.timestamp).toLocaleString()}`;
        this.contextValue = 'discussionGroup';
        this.iconPath = new vscode.ThemeIcon('folder');
    }
}

export class DiscussionItem extends vscode.TreeItem {
    constructor(public readonly discussion: Discussion) {
        super(discussion.title, vscode.TreeItemCollapsibleState.None);
        this.id = discussion.id;
        this.tooltip = `Started: ${new Date(discussion.timestamp).toLocaleString()}`;
        this.description = new Date(discussion.timestamp).toLocaleDateString();
        this.contextValue = 'discussion';
        this.iconPath = new vscode.ThemeIcon('comment-discussion');
        
        this.command = {
            command: 'lollms-vs-coder.switchDiscussion',
            title: 'Switch Discussion',
            arguments: [this.id],
        };
    }
}