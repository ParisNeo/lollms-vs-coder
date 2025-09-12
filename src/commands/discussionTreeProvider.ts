import * as vscode from 'vscode';
import { DiscussionManager, Discussion, DiscussionGroup } from '../discussionManager';

export class DiscussionTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private discussionManager: DiscussionManager) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        const allDiscussions = await this.discussionManager.getAllDiscussions();

        if (element instanceof DiscussionGroupItem) {
            // Children of a group are the discussions in that group
            const discussionsInGroup = allDiscussions.filter(d => d.groupId === element.group.id);
            return discussionsInGroup.map((d: Discussion) => new DiscussionItem(d));
        }

        if (!element) {
            // Root level: show groups and ungrouped discussions
            const groups = await this.discussionManager.getGroups();
            const groupItems = groups.map(g => new DiscussionGroupItem(g));

            const ungroupedDiscussions = allDiscussions.filter(d => !d.groupId || !groups.some(g => g.id === d.groupId));
            const discussionItems = ungroupedDiscussions.map((d: Discussion) => new DiscussionItem(d));
            
            return [...groupItems, ...discussionItems];
        }

        return [];
    }
}


export class DiscussionItem extends vscode.TreeItem {
    constructor(
        public readonly discussion: Discussion
    ) {
        super(discussion.title, vscode.TreeItemCollapsibleState.None);
        this.id = discussion.id;
        this.contextValue = 'discussion';
        this.description = new Date(discussion.timestamp).toLocaleString();
        this.command = {
            command: 'lollms-vs-coder.switchDiscussion',
            title: 'Switch Discussion',
            arguments: [this.id]
        };
        this.iconPath = new vscode.ThemeIcon('comment-discussion');
    }
}

export class DiscussionGroupItem extends vscode.TreeItem {
    constructor(
        public readonly group: DiscussionGroup
    ) {
        super(group.title, vscode.TreeItemCollapsibleState.Expanded);
        this.id = group.id;
        this.contextValue = 'discussionGroup';
        this.description = group.description;
        this.iconPath = vscode.ThemeIcon.Folder;
    }
}