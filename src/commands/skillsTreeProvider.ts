import * as vscode from 'vscode';
import * as fs from 'fs';
import { SkillsManager, Skill, SkillsZooRepo } from '../skillsManager';

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
            return [
                new SkillRootItem("Global Library", "global", vscode.TreeItemCollapsibleState.Expanded),
                new SkillRootItem("Project Library", "local", vscode.TreeItemCollapsibleState.Expanded),
                new SkillRootItem("Skills Zoo (Git Repos)", "zoo", vscode.TreeItemCollapsibleState.Collapsed)
            ];
        }

        if (element instanceof SkillRootItem) {
            if (element.scope === 'zoo') {
                const repos = this.skillsManager.getZooRepos();
                return repos.map(r => new ZooRepoItem(r));
            }
            return this.getNodes(allSkills.filter(s => s.scope === element.scope), '', element.scope);
        }

        if (element instanceof ZooRepoItem) {
            return await this.getZooRepoNodes(element.repo, '');
        }

        if (element instanceof SkillCategoryItem) {
            if (element.scope === 'zoo' && element.repo) {
                return await this.getZooRepoNodes(element.repo, element.fullPath);
            }
            return this.getNodes(allSkills.filter(s => s.scope === element.scope), element.fullPath, element.scope);
        }

        return [];
    }

    private async getZooRepoNodes(repo: SkillsZooRepo, parentPath: string): Promise<vscode.TreeItem[]> {
        const targetPath = this.skillsManager.getZooRepoPath(repo.id);
        if (!fs.existsSync(targetPath)) {
            const syncPromptItem = new vscode.TreeItem(`Click to sync "${repo.name}"...`, vscode.TreeItemCollapsibleState.None);
            syncPromptItem.iconPath = new vscode.ThemeIcon('sync');
            syncPromptItem.command = {
                command: 'lollms-vs-coder.manageSkillsRepos',
                title: 'Sync Repository'
            };
            return [syncPromptItem];
        }

        const allZooSkills = await (this.skillsManager as any).loadSkillsFromDir(vscode.Uri.file(targetPath), 'global');
        const items: vscode.TreeItem[] = [];
        const seenCategories = new Set<string>();

        allZooSkills.forEach((skill: Skill) => {
            const category = skill.category ? skill.category.replace(/\\/g, '/') : '';

            if (parentPath === '' && !category) {
                items.push(new ZooSkillItem(skill, repo));
            } else if (category === parentPath) {
                items.push(new ZooSkillItem(skill, repo));
            } else if (category.startsWith(parentPath ? parentPath + '/' : '')) {
                const relativePath = parentPath ? category.substring(parentPath.length + 1) : category;
                const parts = relativePath.split('/');
                const nextCategorySegment = parts[0];

                if (nextCategorySegment && !seenCategories.has(nextCategorySegment)) {
                    const fullCategoryPath = parentPath ? `${parentPath}/${nextCategorySegment}` : nextCategorySegment;
                    items.push(new SkillCategoryItem(nextCategorySegment, fullCategoryPath, 'zoo', repo));
                    seenCategories.add(nextCategorySegment);
                }
            }
        });

        return items.sort((a, b) => {
            if (a instanceof SkillCategoryItem && b instanceof ZooSkillItem) return -1;
            if (a instanceof ZooSkillItem && b instanceof SkillCategoryItem) return 1;
            const labelA = String(a.label || "");
            const labelB = String(b.label || "");
            return labelA.localeCompare(labelB, undefined, { sensitivity: 'base', numeric: true });
        });
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
            if (a instanceof SkillCategoryItem && b instanceof SkillItem) return -1;
            if (a instanceof SkillItem && b instanceof SkillCategoryItem) return 1;
            const labelA = String(a.label || "");
            const labelB = String(b.label || "");
            return labelA.localeCompare(labelB, undefined, { sensitivity: 'base', numeric: true });
        });
    }
}

class SkillRootItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly scope: 'global' | 'local' | 'zoo',
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
        this.contextValue = `skillRoot:${scope}`;
        this.iconPath = new vscode.ThemeIcon(
            scope === 'global' ? 'globe' : (scope === 'local' ? 'root-folder' : 'repo')
        );
    }
}

class ZooRepoItem extends vscode.TreeItem {
    constructor(public readonly repo: SkillsZooRepo) {
        super(repo.name, vscode.TreeItemCollapsibleState.Collapsed);
        this.contextValue = 'zooRepo';
        this.iconPath = new vscode.ThemeIcon('repo');
        this.description = repo.id === 'official_zoo' ? 'Official' : 'Custom';
        this.tooltip = `${repo.name}\n${repo.url}`;
    }
}

class SkillCategoryItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly fullPath: string,
        public readonly scope: 'global' | 'local' | 'zoo',
        public readonly repo?: SkillsZooRepo
    ) {
        super(label, vscode.TreeItemCollapsibleState.Collapsed);
        this.contextValue = `skillCategory:${scope}`;
        this.iconPath = vscode.ThemeIcon.Folder;
        this.tooltip = `Category: ${fullPath}`;
    }
}

class SkillItem extends vscode.TreeItem {
    constructor(public readonly skill: Skill) {
        const cleanName = skill.name.replace(/SOURCE OF TRUTH:\s*/gi, '').trim();
        super(cleanName, vscode.TreeItemCollapsibleState.None);
        this.id = skill.id;
        this.description = skill.description;
        this.tooltip = new vscode.MarkdownString(`**${skill.name}**\n\n*${skill.description}*\n\n\`\`\`${skill.language || ''}\n${skill.content}\n\`\`\``);
        this.iconPath = new vscode.ThemeIcon('lightbulb');
        this.contextValue = 'skill';
        
        this.command = {
            command: 'lollms-vs-coder.editSkill',
            title: 'Edit Skill',
            arguments: [this.skill]
        };
    }
}

class ZooSkillItem extends vscode.TreeItem {
    constructor(public readonly skill: Skill, public readonly repo: SkillsZooRepo) {
        const cleanName = skill.name.replace(/SOURCE OF TRUTH:\s*/gi, '').trim();
        super(cleanName, vscode.TreeItemCollapsibleState.None);
        this.id = `zoo_${repo.id}_${skill.id}`;
        this.description = skill.description ? skill.description.substring(0, 45) + '...' : undefined;
        this.tooltip = new vscode.MarkdownString(`**${skill.name}** (from ${repo.name})\n\n*${skill.description}*\n\n\`\`\`${skill.language || 'markdown'}\n${skill.content}\n\`\`\``);
        this.iconPath = new vscode.ThemeIcon('cloud-download');
        this.contextValue = 'zooSkill';

        this.command = {
            command: 'lollms-vs-coder.installZooSkillPrompt',
            title: 'Install Skill',
            arguments: [this.skill]
        };
    }
}