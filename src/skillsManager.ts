import * as vscode from 'vscode';
import * as path from 'path';

export interface Skill {
    id: string;
    name: string;
    description: string;
    content: string;
    language?: string;
    timestamp: number;
}

export class SkillsManager {
    private skillsFile!: vscode.Uri;

    constructor() {}

    public async switchWorkspace(workspaceRoot: vscode.Uri) {
        const lollmsDir = vscode.Uri.joinPath(workspaceRoot, '.lollms');
        this.skillsFile = vscode.Uri.joinPath(lollmsDir, 'skills.json');
        await this.initialize(lollmsDir);
    }

    private async initialize(lollmsDir: vscode.Uri) {
        try {
            await vscode.workspace.fs.createDirectory(lollmsDir);
        } catch (e) {
            // Directory likely already exists
        }
        try {
            await vscode.workspace.fs.stat(this.skillsFile);
        } catch {
            // File doesn't exist, create it with an empty array
            await this.saveSkills([]);
        }
    }

    public async getSkills(): Promise<Skill[]> {
        if (!this.skillsFile) return [];
        try {
            const content = await vscode.workspace.fs.readFile(this.skillsFile);
            const skills = JSON.parse(content.toString());
            return Array.isArray(skills) ? skills.sort((a, b) => b.timestamp - a.timestamp) : [];
        } catch (error) {
            console.error("Error reading skills file:", error);
            return [];
        }
    }

    public async saveSkills(skills: Skill[]): Promise<void> {
        if (!this.skillsFile) return;
        const content = Buffer.from(JSON.stringify(skills, null, 2), 'utf8');
        await vscode.workspace.fs.writeFile(this.skillsFile, content);
    }

    public async addSkill(skillData: Omit<Skill, 'id' | 'timestamp'>): Promise<Skill> {
        const skills = await this.getSkills();
        const newSkill: Skill = {
            ...skillData,
            id: Date.now().toString() + Math.random().toString(36).substring(2),
            timestamp: Date.now()
        };
        skills.push(newSkill);
        await this.saveSkills(skills);
        return newSkill;
    }

    public async deleteSkill(skillId: string): Promise<void> {
        let skills = await this.getSkills();
        skills = skills.filter(s => s.id !== skillId);
        await this.saveSkills(skills);
    }

    // New: Export skills to a JSON file
    public async exportSkills() {
        const skills = await this.getSkills();
        if (skills.length === 0) {
            vscode.window.showInformationMessage("No skills to export.");
            return;
        }

        const fileUri = await vscode.window.showSaveDialog({
            title: "Export Skills",
            filters: { "JSON": ["json"] },
            defaultUri: vscode.Uri.file("skills_export.json")
        });

        if (fileUri) {
            const content = Buffer.from(JSON.stringify(skills, null, 2), 'utf8');
            await vscode.workspace.fs.writeFile(fileUri, content);
            vscode.window.showInformationMessage(`Successfully exported ${skills.length} skills.`);
        }
    }

    // New: Import skills from a JSON file
    public async importSkills() {
        const fileUris = await vscode.window.showOpenDialog({
            title: "Import Skills",
            filters: { "JSON": ["json"] },
            canSelectMany: false
        });

        if (!fileUris || fileUris.length === 0) return;

        try {
            const content = await vscode.workspace.fs.readFile(fileUris[0]);
            const importedSkills = JSON.parse(content.toString());

            if (!Array.isArray(importedSkills)) {
                throw new Error("Invalid format: expected an array of skills.");
            }

            const currentSkills = await this.getSkills();
            let addedCount = 0;

            for (const skill of importedSkills) {
                if (skill.name && skill.content) {
                    // Generate new ID to avoid collisions
                    skill.id = Date.now().toString() + Math.random().toString(36).substring(2);
                    skill.timestamp = Date.now();
                    currentSkills.push(skill);
                    addedCount++;
                }
            }

            await this.saveSkills(currentSkills);
            vscode.window.showInformationMessage(`Successfully imported ${addedCount} skills.`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to import skills: ${error.message}`);
        }
    }
}
