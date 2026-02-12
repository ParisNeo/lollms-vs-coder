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

// --- XML Helpers ---

function escapeXml(unsafe: string): string {
    if (!unsafe) return '';
    return unsafe.replace(/[<>&'"]/g, (c) => {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
        }
        return c;
    });
}

function unescapeXml(safe: string): string {
    if (!safe) return '';
    return safe.replace(/&(lt|gt|amp|apos|quot);/g, (match, entity) => {
        switch (entity) {
            case 'lt': return '<';
            case 'gt': return '>';
            case 'amp': return '&';
            case 'apos': return '\'';
            case 'quot': return '"';
        }
        return match;
    });
}

function wrapCData(content: string): string {
    if (content.includes(']]>')) {
        // Fallback for content containing CDATA end sequence: escape it or just use XML escaping without CDATA
        // Simplest strategy: split the CDATA or just raw escape. 
        // For simplicity, if ]]> exists, we rely on standard escaping instead of CDATA
        return escapeXml(content);
    }
    return `<![CDATA[\n${content}\n]]>`;
}

function extractTag(xml: string, tag: string): string {
    const regex = new RegExp(`<${tag}>(.*?)<\/${tag}>`, 's');
    const match = xml.match(regex);
    return match ? unescapeXml(match[1].trim()) : '';
}

function extractContentTag(xml: string): string {
    // Try CDATA
    const cdataRegex = /<content>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/content>/;
    const cdataMatch = xml.match(cdataRegex);
    if (cdataMatch) return cdataMatch[1].trim();

    // Fallback to normal escaping
    const regex = /<content>([\s\S]*?)<\/content>/;
    const match = xml.match(regex);
    return match ? unescapeXml(match[1].trim()) : '';
}

function skillToXml(skill: Skill): string {
    // Indentation for content handled by wrapCData adding newlines
    return `<skill id="${skill.id}">
    <name>${escapeXml(skill.name)}</name>
    <description>${escapeXml(skill.description)}</description>
    <category>${escapeXml(skill.category || '')}</category>
    <language>${escapeXml(skill.language || '')}</language>
    <timestamp>${skill.timestamp}</timestamp>
    <content>
        ${wrapCData(skill.content)}
    </content>
</skill>`;
}

function xmlToSkill(xml: string, forcedScope?: 'global' | 'local'): Skill {
    const idMatch = xml.match(/<skill id="([^"]+)">/);
    const id = idMatch ? idMatch[1] : 'unknown-' + Date.now();
    
    return {
        id,
        name: extractTag(xml, 'name'),
        description: extractTag(xml, 'description'),
        category: extractTag(xml, 'category'),
        language: extractTag(xml, 'language'),
        timestamp: parseInt(extractTag(xml, 'timestamp')) || Date.now(),
        content: extractContentTag(xml),
        scope: forcedScope || 'global'
    };
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

        // Use 'out/skills' and look for .xml files
        const bootstrapDir = vscode.Uri.joinPath(this.extensionUri, 'out', 'skills');
        try {
            const entries = await vscode.workspace.fs.readDirectory(bootstrapDir);
            const currentGlobalSkills = await this.getGlobalSkills();

            for (const [name, type] of entries) {
                if (type === vscode.FileType.File && name.endsWith('.xml')) {
                    const fileUri = vscode.Uri.joinPath(bootstrapDir, name);
                    const content = await vscode.workspace.fs.readFile(fileUri);
                    const xmlStr = content.toString();
                    const bootstrapSkill = xmlToSkill(xmlStr, 'global');

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
        const fileName = `${skill.id}.xml`;
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
        const xmlContent = skillToXml(skill);
        await vscode.workspace.fs.writeFile(filePath, Buffer.from(xmlContent, 'utf8'));
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
                } else if (type === vscode.FileType.File && name.endsWith('.xml')) {
                    try {
                        const content = await vscode.workspace.fs.readFile(entryUri);
                        const skill = xmlToSkill(content.toString(), scope);
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

    public async importSkills(): Promise<Skill[]> {
        const uris = await vscode.window.showOpenDialog({
            title: "Import Skill Pack (XML)",
            filters: { "XML": ["xml"] },
            canSelectMany: true
        });

        if (!uris || uris.length === 0) return [];

        const addedSkills: Skill[] = [];
        try {
            for (const uri of uris) {
                const content = await vscode.workspace.fs.readFile(uri);
                const xmlStr = content.toString();
                // Simple heuristic: check if it's a single skill or list?
                // For now assuming single file = single skill per file or handle simple concat
                // But generally users might want to import one skill file at a time or select multiple.
                const skill = xmlToSkill(xmlStr, 'global'); // Default to global for import?
                if (skill.id) {
                    // Ask scope? Defaulting to global for now as per previous logic
                    await this.writeSkillToFile(skill);
                    addedSkills.push(skill);
                }
            }
            vscode.window.showInformationMessage(`Imported ${addedSkills.length} skills successfully.`);
            return addedSkills;
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
                } else if (type === vscode.FileType.File && name === `${skillId}.xml`) {
                    await vscode.workspace.fs.delete(entryUri);
                    return true;
                }
            }
            return false;
        };

        await walkAndDelete(targetRoot);
    }

    public async deleteAllSkills(): Promise<void> {
        // Delete all from Global
        if (this.globalSkillsDir) {
            try {
                await vscode.workspace.fs.delete(this.globalSkillsDir, { recursive: true, useTrash: false });
                await vscode.workspace.fs.createDirectory(this.globalSkillsDir);
            } catch {}
        }
        // Delete all from Local
        if (this.localSkillsDir) {
            try {
                await vscode.workspace.fs.delete(this.localSkillsDir, { recursive: true, useTrash: false });
                await vscode.workspace.fs.createDirectory(this.localSkillsDir);
            } catch {}
        }
    }

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

        const folderUri = await vscode.window.showOpenDialog({
            title: "Select Folder to Export Skills",
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false
        });

        if (folderUri && folderUri[0]) {
            for (const skill of toExport) {
                const fileName = `${skill.id}.xml`;
                const fileUri = vscode.Uri.joinPath(folderUri[0], fileName);
                const xmlContent = skillToXml(skill);
                await vscode.workspace.fs.writeFile(fileUri, Buffer.from(xmlContent, 'utf8'));
            }
            vscode.window.showInformationMessage(`Exported ${toExport.length} skills to ${folderUri[0].fsPath}`);
        }
    }
}
