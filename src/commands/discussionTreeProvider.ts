import * as vscode from 'vscode';
import { DiscussionManager, Discussion, DiscussionGroup } from '../discussionManager';

export class DiscussionTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private filterQuery: string | undefined;
    private _view?: vscode.TreeView<vscode.TreeItem>;
    private _activeProjectName: string = "";

    constructor(
        private discussionManager: DiscussionManager,
        private extensionUri: vscode.Uri
    ) {
        // Automatically refresh tree whenever the manager signals a state change
        this.discussionManager.onDidChangeDiscussions(() => {
            this.refresh();
        });
    }

    public bindView(view: vscode.TreeView<vscode.TreeItem>) {
        this._view = view;
        this.updateViewDescription();
    }

    public setActiveProject(name: string) {
        this._activeProjectName = name;
        this.updateViewDescription();
    }

    private updateViewDescription() {
        if (this._view) {
            const folders = vscode.workspace.workspaceFolders || [];
            if (folders.length > 1) {
                this._view.description = this._activeProjectName ? `[${this._activeProjectName}]` : "";
            } else {
                this._view.description = "";
            }
        }
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    setFilter(query: string | undefined) {
        this.filterQuery = query?.trim().toLowerCase();
        // Set a context key so we can show/hide the "Clear Search" button in the UI
        vscode.commands.executeCommand('setContext', 'lollms:isSearchingDiscussions', !!this.filterQuery);
        this.refresh();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        if (this.filterQuery && element instanceof DiscussionItem) {
            element.description = `[Match] ${element.description}`;
        }
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        let allDiscussions: Discussion[] = [];
        try {
            allDiscussions = await this.discussionManager.getAllDiscussions();
        } catch (e) {
            return [new vscode.TreeItem("Error loading discussions.", vscode.TreeItemCollapsibleState.None)];
        }

        if (allDiscussions.length === 0 && !element) {
            const item = new vscode.TreeItem("No discussions yet. Click + to start.", vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('info');
            return [item];
        }

        // If we are searching, we flatten the view to show only matches
        if (this.filterQuery) {
            if (element) return []; // Searching is flat
            const filtered = allDiscussions.filter(d => {
                const titleMatch = (d.title || "Untitled").toLowerCase().includes(this.filterQuery!);
                const contentMatch = d.messages.some(m => 
                    typeof m.content === 'string' && m.content.toLowerCase().includes(this.filterQuery!)
                );
                return titleMatch || contentMatch;
            });
            
            if (filtered.length === 0) {
                return [new vscode.TreeItem("No matching discussions found.", vscode.TreeItemCollapsibleState.None)];
            }
            return filtered.map((d: Discussion) => new DiscussionItem(d, this.extensionUri));
        }

        if (element instanceof DiscussionGroupItem) {
            const discussionsInGroup = allDiscussions.filter(d => d.groupId === element.group.id);
            return discussionsInGroup.map((d: Discussion) => new DiscussionItem(d, this.extensionUri));
        }

        if (!element) {
            const groups = await this.discussionManager.getGroups();
            const groupItems = groups.map(g => new DiscussionGroupItem(g));
            const ungroupedDiscussions = allDiscussions.filter(d => !d.groupId || !groups.some(g => g.id === d.groupId));
            const discussionItems = ungroupedDiscussions.map((d: Discussion) => new DiscussionItem(d, this.extensionUri));
            
            return [...groupItems, ...discussionItems];
        }

        return [];
    }
}


export class DiscussionItem extends vscode.TreeItem {
    constructor(
        public readonly discussion: Discussion,
        private readonly extensionUri: vscode.Uri
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

        const isAgent = discussion.capabilities?.agentMode === true;
        this.iconPath = isAgent 
            ? new vscode.ThemeIcon('robot') 
            : vscode.Uri.joinPath(this.extensionUri, 'media', 'lollms-icon.svg');
    }
}

// Placeholder for search provider imported by viewRegistry
export class DiscussionSearchProvider {
    refresh() {}
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