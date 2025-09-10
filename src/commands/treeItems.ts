import * as vscode from 'vscode';
import { Prompt, PromptGroup } from '../promptManager';

export class PromptItem extends vscode.TreeItem {
    constructor(
        public readonly prompt: Prompt,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
    ) {
        super(prompt.is_default ? `$(lock) ${prompt.title}` : prompt.title, collapsibleState);
        this.id = prompt.id;
        this.tooltip = `Type: ${prompt.type}\nAction: ${prompt.action_type || 'N/A'}\n\n${prompt.content}`;
        this.description = this.prompt.description || '';
        
        // Use a different context value for default prompts to hide certain actions
        this.contextValue = prompt.is_default ? 'defaultPrompt' : 'prompt';

        if (prompt.type === 'chat') {
            this.command = {
                command: 'lollms-vs-coder.useChatPrompt',
                title: 'Use Chat Prompt',
                arguments: [this.prompt],
            };
        } else if (prompt.type === 'code_action') {
            this.command = {
                command: 'lollms-vs-coder.triggerCodeAction',
                title: 'Trigger Code Action',
                arguments: [this.prompt],
            };
        }
    }
}

export class PromptGroupItem extends vscode.TreeItem {
    constructor(
        public readonly group: PromptGroup,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(group.title, collapsibleState);
        this.id = group.id;
        this.contextValue = 'promptGroup';
        this.iconPath = new vscode.ThemeIcon('folder');
    }
}