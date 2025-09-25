import * as vscode from 'vscode';
import { Prompt, PromptGroup } from '../promptManager';
import { RunningProcess } from '../processManager';

export class PromptItem extends vscode.TreeItem {
    constructor(
        public readonly prompt: Prompt
    ) {
        super(prompt.title, vscode.TreeItemCollapsibleState.None);
        this.id = prompt.id;
        this.contextValue = 'prompt';
        this.tooltip = `▶ ${this.prompt.title}\n\n${this.prompt.content}`;
        
        // Use description if available, otherwise truncate content
        this.description = this.prompt.description || (this.prompt.content.substring(0, 40).replace(/\r?\n|\r/g, ' ') + '...');
        
        if (this.prompt.is_default) {
            this.iconPath = new vscode.ThemeIcon('lock');
        } else {
            this.iconPath = new vscode.ThemeIcon(this.prompt.type === 'code_action' ? 'wrench' : 'comment');
        }

        // The command is set to trigger the appropriate action when the item is clicked
        if (this.prompt.type === 'chat') {
            this.command = {
                command: 'lollms-vs-coder.useChatPrompt',
                title: 'Use Chat Prompt',
                arguments: [this.prompt]
            };
        } else if (this.prompt.type === 'code_action') {
            // For code actions, clicking it might not be the primary way to trigger it,
            // but we can set it for consistency. The main trigger is via CodeLens/command palette.
            this.command = {
                command: 'lollms-vs-coder.triggerCodeAction',
                title: 'Use Code Action',
                arguments: [this.prompt]
            };
        }
    }
}

export class PromptGroupItem extends vscode.TreeItem {
    constructor(
        public readonly group: PromptGroup
    ) {
        super(group.title, vscode.TreeItemCollapsibleState.Collapsed);
        this.id = group.id;
        this.contextValue = 'promptGroup';
        this.iconPath = vscode.ThemeIcon.Folder;
    }
}

export class ProcessItem extends vscode.TreeItem {
    constructor(
        public readonly process: RunningProcess
    ) {
        super(process.description, vscode.TreeItemCollapsibleState.None);
        this.id = process.id;
        this.contextValue = 'process';
        this.iconPath = new vscode.ThemeIcon('sync~spin');
        
        const startTime = new Date(process.startTime).toLocaleTimeString();
        this.tooltip = `Started: ${startTime}\nDiscussion ID: ${process.discussionId}`;

        this.command = {
            command: 'lollms-vs-coder.switchDiscussion',
            title: 'Go to Discussion',
            arguments: [process.discussionId]
        };
    }
}