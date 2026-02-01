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
}

export class SkillsManager {
    private skillsDir!: vscode.Uri;
    private extensionUri?: vscode.Uri;

    constructor() {}

    /**
     * Initializes the manager for the current workspace and loads bootstrap skills.
     */
    public async switchWorkspace(workspaceRoot: vscode.Uri, extensionUri: vscode.Uri) {
        this.skillsDir = vscode.Uri.joinPath(workspaceRoot, '.lollms', 'skills');
        this.extensionUri = extensionUri;
        
        try {
            await vscode.workspace.fs.createDirectory(this.skillsDir);
        } catch (e) {}

        await this.ensureBootstrapSkills();
    }

    /**
     * Loads default skills from the extension's src/skills folder if they don't exist.
     */
    private async ensureBootstrapSkills() {
        if (!this.extensionUri) return;

        const bootstrapDir = vscode.Uri.joinPath(this.extensionUri, 'src', 'skills');
        try {
            const entries = await vscode.workspace.fs.readDirectory(bootstrapDir);
            const currentSkills = await this.getSkills();

            for (const [name, type] of entries) {
                if (type === vscode.FileType.File && name.endsWith('.json')) {
                    const fileUri = vscode.Uri.joinPath(bootstrapDir, name);
                    const content = await vscode.workspace.fs.readFile(fileUri);
                    const bootstrapSkill = JSON.parse(content.toString()) as Skill;

                    // If a bootstrap skill doesn't exist in the workspace, we provide it.
                    // Workspace skills (in .lollms/skills) override bootstrap skills if IDs match.
                    if (!currentSkills.some(s => s.id === bootstrapSkill.id)) {
                        await this.writeSkillToFile(bootstrapSkill);
                    }
                }
            }
        } catch (e) {
            console.warn("No bootstrap skills found in extension source.");
        }
    }

    private async writeSkillToFile(skill: Skill): Promise<void> {
        const fileName = `${skill.id}.json`;
        let targetDir = this.skillsDir;

        if (skill.category) {
            const relativeCategory = skill.category.replace(/\\/g, '/');
            targetDir = vscode.Uri.joinPath(this.skillsDir, ...relativeCategory.split('/'));
            try {
                await vscode.workspace.fs.createDirectory(targetDir);
            } catch (e) {}
        }

        const filePath = vscode.Uri.joinPath(targetDir, fileName);
        const content = Buffer.from(JSON.stringify(skill, null, 2), 'utf8');
        await vscode.workspace.fs.writeFile(filePath, content);
    }

    public async getSkills(): Promise<Skill[]> {
        if (!this.skillsDir) return [];
        const skills: Skill[] = [];

        const walk = async (uri: vscode.Uri) => {
            let entries;
            try {
                entries = await vscode.workspace.fs.readDirectory(uri);
            } catch (e) {
                return;
            }

            for (const [name, type] of entries) {
                const entryUri = vscode.Uri.joinPath(uri, name);
                if (type === vscode.FileType.Directory) {
                    await walk(entryUri);
                } else if (type === vscode.FileType.File && name.endsWith('.json')) {
                    try {
                        const content = await vscode.workspace.fs.readFile(entryUri);
                        const skill = JSON.parse(content.toString()) as Skill;
                        skills.push(skill);
                    } catch (e) {
                        console.error(`Error reading skill file ${name}:`, e);
                    }
                }
            }
        };

        await walk(this.skillsDir);
        return skills.sort((a, b) => b.timestamp - a.timestamp);
    }

    public async addSkill(skillData: Omit<Skill, 'timestamp'>): Promise<Skill> {
        const skill: Skill = {
            ...skillData,
            timestamp: Date.now()
        };

        await this.writeSkillToFile(skill);
        return skill;
    }

    public async getSkillById(id: string): Promise<Skill | undefined> {
        const skills = await this.getSkills();
        return skills.find(s => s.id === id);
    }

    public async deleteSkill(skillId: string): Promise<void> {
        const walkAndDelete = async (uri: vscode.Uri): Promise<boolean> => {
            let entries;
            try {
                entries = await vscode.workspace.fs.readDirectory(uri);
            } catch (e) { return false; }

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

        await walkAndDelete(this.skillsDir);
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

    public async importSkills() {
        const uris = await vscode.window.showOpenDialog({
            title: "Import Skills Library",
            filters: { "JSON": ["json"] },
            canSelectMany: false
        });

        if (!uris || uris.length === 0) return;

        try {
            const content = await vscode.workspace.fs.readFile(uris[0]);
            const imported = JSON.parse(content.toString());
            const skills = Array.isArray(imported) ? imported : [imported];

            let count = 0;
            for (const s of skills) {
                if (s.name && s.content) {
                    if (!s.id || s.id.startsWith('lollms-')) {
                         s.id = 'imported-' + Date.now() + Math.random().toString(36).substring(7);
                    }
                    await this.addSkill(s);
                    count++;
                }
            }
            vscode.window.showInformationMessage(`Imported ${count} skills successfully.`);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to import skills: ${e.message}`);
        }
    }
}
