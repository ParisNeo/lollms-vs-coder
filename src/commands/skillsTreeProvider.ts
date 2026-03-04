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
        const allSkills = await this.skillsManager.getSkills();

        if (!element) {
            // Root Level: Show the two libraries
            return [
                new SkillRootItem("Global Library", "global", vscode.TreeItemCollapsibleState.Expanded),
                new SkillRootItem("Project Library", "local", vscode.TreeItemCollapsibleState.Expanded)
            ];
        }

        if (element instanceof SkillRootItem) {
            // Level 1: Root categories for a specific scope
            return this.getNodes(allSkills.filter(s => s.scope === element.scope), '', element.scope);
        }

        if (element instanceof SkillCategoryItem) {
            // Level N: Nested categories/skills
            return this.getNodes(allSkills.filter(s => s.scope === element.scope), element.fullPath, element.scope);
        }

        return [];
    }

    private getNodes(skills: Skill[], parentPath: string, scope: 'global' | 'local'): vscode.TreeItem[] {
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
                    items.push(new SkillCategoryItem(nextCategorySegment, fullCategoryPath, scope));
                    seenCategories.add(nextCategorySegment);
                }
            }
        });

        return items.sort((a, b) => {
            // 1. Categories (Folders) always come before individual Skills
            if (a instanceof SkillCategoryItem && b instanceof SkillItem) return -1;
            if (a instanceof SkillItem && b instanceof SkillCategoryItem) return 1;
            
            // 2. Sort by Label (alphabetical)
            const labelA = String(a.label || "");
            const labelB = String(b.label || "");
            return labelA.localeCompare(labelB, undefined, { sensitivity: 'base', numeric: true });
        });
    }
}

class SkillRootItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly scope: 'global' | 'local',
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
        this.contextValue = `skillRoot:${scope}`;
        this.iconPath = new vscode.ThemeIcon(scope === 'global' ? 'globe' : 'root-folder');
    }
}

class SkillCategoryItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly fullPath: string,
        public readonly scope: 'global' | 'local'
    ) {
        super(label, vscode.TreeItemCollapsibleState.Collapsed);
        this.contextValue = `skillCategory:${scope}`;
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
