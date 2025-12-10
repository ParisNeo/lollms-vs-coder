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

        // Map skills to a tree structure based on category
        // Format: category/subcategory/skill
        
        if (!element) {
            // Root level
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
            
            // Check if skill belongs to the current parent path
            if (parentPath === '' && !category) {
                // Root level skill (no category)
                items.push(new SkillItem(skill));
            } else if (category.startsWith(parentPath)) {
                // Calculate relative path from current parent
                const relativePath = parentPath ? category.substring(parentPath.length + 1) : category;
                
                if (!relativePath) {
                    // Exact match (shouldn't happen if logic is correct for folders vs items, unless skill has same name as category?)
                    // Actually if category matches parentPath exactly, it means the skill is IN this category.
                    // But we stripped parentPath. If relativePath is empty, it means we are IN the category.
                    items.push(new SkillItem(skill));
                } else {
                    // It's a subfolder or a skill in a subfolder
                    const parts = relativePath.split('/');
                    const nextCategorySegment = parts[0];
                    
                    if (parts.length > 0 && !seenCategories.has(nextCategorySegment)) {
                        const fullCategoryPath = parentPath ? `${parentPath}/${nextCategorySegment}` : nextCategorySegment;
                        items.push(new SkillCategoryItem(nextCategorySegment, fullCategoryPath));
                        seenCategories.add(nextCategorySegment);
                    }
                }
            }
        });

        // Sort: Categories first, then skills
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
    }
}
