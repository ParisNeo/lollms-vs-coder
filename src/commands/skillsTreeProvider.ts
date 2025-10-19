import * as vscode from 'vscode';
import { SkillsManager, Skill } from '../skillsManager';

export class SkillsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private skillsManager: SkillsManager) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (!element) {
            const skills = await this.skillsManager.getSkills();
            if (skills.length === 0) {
                const placeholder = new vscode.TreeItem("No skills learned yet.", vscode.TreeItemCollapsibleState.None);
                placeholder.iconPath = new vscode.ThemeIcon('info');
                return [placeholder];
            }
            return skills.map(skill => new SkillItem(skill));
        }
        return [];
    }
}

class SkillItem extends vscode.TreeItem {
    constructor(public readonly skill: Skill) {
        super(skill.name, vscode.TreeItemCollapsibleState.None);
        this.id = skill.id;
        this.description = skill.description;
        this.tooltip = new vscode.MarkdownString(`**${skill.name}**\n\n*${skill.description}*\n\n\`\`\`${skill.language || ''}\n${skill.content}\n\`\`\``);
        this.iconPath = new vscode.ThemeIcon('lightbulb');
        this.contextValue = 'skill';
    }
}