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
        const skills = await this.skillsManager.getSkills();
        
        if (skills.length === 0 && !element) {
            const placeholder = new vscode.TreeItem("No skills learned yet.", vscode.TreeItemCollapsibleState.None);
            placeholder.iconPath = new vscode.ThemeIcon('info');
            return [placeholder];
        }

        if (!element) {
            return this.getNodes(skills, '');
        } else if (element instanceof SkillCategoryItem) {
            return this.getNodes(skills, element.fullPath);
        }

        return [];
    }

    private getNodes(skills: Skill[], parentPath: string): vscode.TreeItem[] {
        const items: vscode.TreeItem[] = [];
        const seenCategories = new Set<string>();

        skills.forEach(skill => {
            const category = skill.category ? skill.category.replace(/\\/g, '/') : '';
            
            if (parentPath === '' && !category) {
                items.push(new SkillItem(skill));
            } else if (category === parentPath) {
                items.push(new SkillItem(skill));
            } else if (category.startsWith(parentPath ? parentPath + '/' : '')) {
                const relativePath = parentPath ? category.substring(parentPath.length + 1) : category;
                const parts = relativePath.split('/');
                const nextCategorySegment = parts[0];
                
                if (nextCategorySegment && !seenCategories.has(nextCategorySegment)) {
                    const fullCategoryPath = parentPath ? `${parentPath}/${nextCategorySegment}` : nextCategorySegment;
                    items.push(new SkillCategoryItem(nextCategorySegment, fullCategoryPath));
                    seenCategories.add(nextCategorySegment);
                }
            }
        });

        return items.sort((a, b) => {
            if (a instanceof SkillCategoryItem && b instanceof SkillItem) return -1;
            if (a instanceof SkillItem && b instanceof SkillCategoryItem) return 1;
            return (a.label as string).localeCompare(b.label as string);
        });
    }
}

class SkillCategoryItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly fullPath: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.Collapsed);
        this.contextValue = 'skillCategory';
        this.iconPath = vscode.ThemeIcon.Folder;
        this.tooltip = `Category: ${fullPath}`;
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
        
        /**
         * Trigger the Skill Editor Panel when clicking the skill in the sidebar
         */
        this.command = {
            command: 'lollms-vs-coder.editSkill',
            title: 'Edit Skill',
            arguments: [this.skill]
        };
    }
}
