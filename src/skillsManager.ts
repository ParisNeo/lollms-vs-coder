import * as vscode from 'vscode';
import * as path from 'path';

export interface Skill {
    id: string;
    name: string;
    description: string;
    content: string;
    language?: string;
    timestamp: number;
    category?: string;
    scope: 'global' | 'local'; // Added scope
}

export class SkillsManager {
    private globalSkillsDir: vscode.Uri;
    private localSkillsDir: vscode.Uri | undefined;
    private extensionUri?: vscode.Uri;

    constructor(globalStorageUri: vscode.Uri) {
        this.globalSkillsDir = vscode.Uri.joinPath(globalStorageUri, 'skills');
        this.initializeGlobalStorage();
    }

    private async initializeGlobalStorage() {
        try {
            await vscode.workspace.fs.createDirectory(this.globalSkillsDir);
        } catch (e) {}
    }

    public async switchWorkspace(workspaceRoot: vscode.Uri, extensionUri: vscode.Uri) {
        this.localSkillsDir = vscode.Uri.joinPath(workspaceRoot, '.lollms', 'skills');
        this.extensionUri = extensionUri;
        
        try {
            if (this.localSkillsDir) {
                await vscode.workspace.fs.createDirectory(this.localSkillsDir);
            }
        } catch (e) {}

        await this.ensureBootstrapSkills();
    }

    private async ensureBootstrapSkills() {
        if (!this.extensionUri) return;

        /**
         * FIX: Point to 'out/skills' instead of 'src/skills'.
         * The 'src' directory is excluded from the final package via .vscodeignore,
         * but the 'copy-assets' script places the JSON files in 'out/skills'.
         */
        const bootstrapDir = vscode.Uri.joinPath(this.extensionUri, 'out', 'skills');
        try {
            const entries = await vscode.workspace.fs.readDirectory(bootstrapDir);
            const currentGlobalSkills = await this.getGlobalSkills();

            for (const [name, type] of entries) {
                if (type === vscode.FileType.File && name.endsWith('.json')) {
                    const fileUri = vscode.Uri.joinPath(bootstrapDir, name);
                    const content = await vscode.workspace.fs.readFile(fileUri);
                    const bootstrapSkill = JSON.parse(content.toString()) as Skill;
                    bootstrapSkill.scope = 'global'; // Force scope

                    // Only add if not exists in Global
                    if (!currentGlobalSkills.some(s => s.id === bootstrapSkill.id)) {
                        await this.writeSkillToFile(bootstrapSkill);
                    }
                }
            }
        } catch (e) {
            console.warn("No bootstrap skills found in 'out/skills' or error loading them.", e);
        }
    }

    private async writeSkillToFile(skill: Skill): Promise<void> {
        const fileName = `${skill.id}.json`;
        let targetDir = skill.scope === 'global' ? this.globalSkillsDir : this.localSkillsDir;

        if (!targetDir) {
            if (skill.scope === 'local') throw new Error("No active workspace for local skill.");
            targetDir = this.globalSkillsDir;
        }

        if (skill.category) {
            const relativeCategory = skill.category.replace(/\\/g, '/');
            targetDir = vscode.Uri.joinPath(targetDir, ...relativeCategory.split('/'));
            try {
                await vscode.workspace.fs.createDirectory(targetDir);
            } catch (e) {}
        }

        const filePath = vscode.Uri.joinPath(targetDir, fileName);
        const content = Buffer.from(JSON.stringify(skill, null, 2), 'utf8');
        await vscode.workspace.fs.writeFile(filePath, content);
    }

    private async loadSkillsFromDir(dir: vscode.Uri, scope: 'global' | 'local'): Promise<Skill[]> {
        const skills: Skill[] = [];
        const walk = async (uri: vscode.Uri) => {
            let entries;
            try { entries = await vscode.workspace.fs.readDirectory(uri); } catch (e) { return; }

            for (const [name, type] of entries) {
                const entryUri = vscode.Uri.joinPath(uri, name);
                if (type === vscode.FileType.Directory) {
                    await walk(entryUri);
                } else if (type === vscode.FileType.File && name.endsWith('.json')) {
                    try {
                        const content = await vscode.workspace.fs.readFile(entryUri);
                        const skill = JSON.parse(content.toString()) as Skill;
                        skill.scope = scope; // Ensure scope is set correctly based on location
                        skills.push(skill);
                    } catch (e) {}
                }
            }
        };
        await walk(dir);
        return skills;
    }
    /**
     * Adds multiple skills at once to the library.
     */
    public async addSkills(skills: Omit<Skill, 'timestamp'>[]): Promise<Skill[]> {
        const addedSkills: Skill[] = [];
        for (const skillData of skills) {
            const skill: Skill = {
                ...skillData,
                timestamp: Date.now()
            };
            await this.writeSkillToFile(skill);
            addedSkills.push(skill);
        }
        return addedSkills;
    }

    // Refactored importSkills to return the skills so they can be immediately used by the UI
    public async importSkills(): Promise<Skill[]> {
        const uris = await vscode.window.showOpenDialog({
            title: "Import Skill Pack (JSON)",
            filters: { "JSON": ["json"] },
            canSelectMany: false
        });

        if (!uris || uris.length === 0) return [];

        try {
            const content = await vscode.workspace.fs.readFile(uris[0]);
            const imported = JSON.parse(content.toString());
            const skillDatas = Array.isArray(imported) ? imported : [imported];

            const added = await this.addSkills(skillDatas);
            vscode.window.showInformationMessage(`Imported ${added.length} skills successfully.`);
            return added;
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to import skills: ${e.message}`);
            return [];
        }
    }
    public async getGlobalSkills(): Promise<Skill[]> {
        return this.loadSkillsFromDir(this.globalSkillsDir, 'global');
    }

    public async getLocalSkills(): Promise<Skill[]> {
        if (!this.localSkillsDir) return [];
        return this.loadSkillsFromDir(this.localSkillsDir, 'local');
    }

    public async getSkills(): Promise<Skill[]> {
        const global = await this.getGlobalSkills();
        const local = await this.getLocalSkills();
        
        // Return combined, sorting by timestamp
        return [...global, ...local].sort((a, b) => b.timestamp - a.timestamp);
    }

    public async addSkill(skillData: Omit<Skill, 'timestamp'>): Promise<Skill> {
        const skill: Skill = {
            ...skillData,
            timestamp: Date.now()
        };
        await this.writeSkillToFile(skill);
        return skill;
    }

    public async addOrUpdateSkill(skill: Skill): Promise<void> {
        await this.writeSkillToFile(skill);
    }

    public async deleteSkill(skillId: string, scope: 'global' | 'local'): Promise<void> {
        const targetRoot = scope === 'global' ? this.globalSkillsDir : this.localSkillsDir;
        if (!targetRoot) return;

        const walkAndDelete = async (uri: vscode.Uri): Promise<boolean> => {
            let entries;
            try { entries = await vscode.workspace.fs.readDirectory(uri); } catch (e) { return false; }

            for (const [name, type] of entries) {
                const entryUri = vscode.Uri.joinPath(uri, name);
                if (type === vscode.FileType.Directory) {
                    if (await walkAndDelete(entryUri)) return true;
                } else if (type === vscode.FileType.File && name === `${skillId}.json`) {
                    await vscode.workspace.fs.delete(entryUri);
                    return true;
                }
            }
            return false;
        };

        await walkAndDelete(targetRoot);
    }
    /**
     * Retrieves all skills that belong to a specific category or its subcategories.
     */
    public async getSkillsInBundle(categoryPath: string): Promise<Skill[]> {
        const allSkills = await this.getSkills();
        const normalizedPath = categoryPath.replace(/\\/g, '/');
        
        return allSkills.filter(s => {
            if (!s.category) return false;
            const skillCat = s.category.replace(/\\/g, '/');
            return skillCat === normalizedPath || skillCat.startsWith(normalizedPath + '/');
        });
    }

    public async exportSkills(skillIds?: string[]) {
        const allSkills = await this.getSkills();
        const toExport = skillIds 
            ? allSkills.filter(s => skillIds.includes(s.id))
            : allSkills;

        if (toExport.length === 0) {
            vscode.window.showInformationMessage("No skills selected for export.");
            return;
        }

        const fileUri = await vscode.window.showSaveDialog({
            title: "Export Skills Library",
            filters: { "JSON": ["json"] },
            defaultUri: vscode.Uri.file("lollms_skills_library.json")
        });

        if (fileUri) {
            const content = Buffer.from(JSON.stringify(toExport, null, 2), 'utf8');
            await vscode.workspace.fs.writeFile(fileUri, content);
            vscode.window.showInformationMessage(`Exported ${toExport.length} skills to ${path.basename(fileUri.fsPath)}`);
        }
    }

}
