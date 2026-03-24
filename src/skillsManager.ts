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
    return `<skill title="${escapeXml(skill.name)}" description="${escapeXml(skill.description)}" category="${escapeXml(skill.category || '')}" language="${escapeXml(skill.language || '')}" id="${skill.id}" timestamp="${skill.timestamp}">
${skill.content}
</skill>`;
}

function xmlToSkill(xml: string, forcedScope?: 'global' | 'local'): Skill {
    const getAttr = (attrName: string) => {
        // Improved regex: handles spaces around '=', escaped quotes, and multi-line tags
        const regex = new RegExp(`\\b${attrName}\\s*=\\s*(["'])(.*?)\\1`, 'is');
        const match = xml.match(regex);
        return match ? unescapeXml(match[2]) : '';
    };

    // 1. Extract content first so we can use it as a fallback for the name
    let content = extractContentTag(xml);
    if (!content) {
        content = xml.replace(/^<skill[^>]*>/i, '').replace(/<\/skill>\s*$/i, '').trim();
    }

    // 2. Identify properties (Attribute -> Tag -> Default/Content Fallback)
    const id = getAttr('id') || 'skill-' + Math.random().toString(36).substring(2, 9);
    
    let name = getAttr('title') || extractTag(xml, 'name');
    if (!name) {
        // If no name found, take the first line of content (stripping markdown headers)
        name = content.split('\n')[0].replace(/[#*`]/g, '').trim().substring(0, 40) || 'Untitled Skill';
    }

    const description = getAttr('description') || extractTag(xml, 'description') || 'No description provided.';
    let category = getAttr('category') || extractTag(xml, 'category');

    // SMART CATEGORY FALLBACK
    if (!category || category.trim() === "") {
        const lowerName = name.toLowerCase();
        if (lowerName.includes('python')) category = 'python';
        else if (lowerName.includes('safe_store') || lowerName.includes('safestore')) category = 'safe_store';
        else if (lowerName.includes('api') || lowerName.includes('lollms')) category = 'lollms/api';
        else if (lowerName.includes('css') || lowerName.includes('html') || lowerName.includes('react')) category = 'frontend';
        else category = 'general'; // Move everything else into a "general" folder
    }

    const language = getAttr('language') || extractTag(xml, 'language') || 'markdown';
    const timestamp = parseInt(getAttr('timestamp')) || parseInt(extractTag(xml, 'timestamp')) || Date.now();

    return { id, name, description, category, language, timestamp, content, scope: forcedScope || 'global' };
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
                    console.log(`[Lollms Debug] Reading bootstrap skill: ${fileUri.fsPath}`);
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

    /**
     * Finds the URI of a skill file by its ID by searching through the directory structure.
     */
    private async findSkillFileUri(skillId: string, root: vscode.Uri): Promise<vscode.Uri | null> {
        const walk = async (uri: vscode.Uri): Promise<vscode.Uri | null> => {
            let entries;
            try { entries = await vscode.workspace.fs.readDirectory(uri); } catch (e) { return null; }
            for (const [name, type] of entries) {
                const entryUri = vscode.Uri.joinPath(uri, name);
                if (type === vscode.FileType.Directory) {
                    const found = await walk(entryUri);
                    if (found) return found;
                } else if (type === vscode.FileType.File && name === `${skillId}.xml`) {
                    return entryUri;
                }
            }
            return null;
        };
        return walk(root);
    }

    private async writeSkillToFile(skill: Skill): Promise<void> {
        // 1. Determine target directory based on scope and category
        let rootDir = skill.scope === 'global' ? this.globalSkillsDir : this.localSkillsDir;
        if (!rootDir) {
            if (skill.scope === 'local') throw new Error("No active workspace for local skill.");
            rootDir = this.globalSkillsDir;
        }

        // 2. CRITICAL: Find and delete existing file with this ID to prevent duplicates if category changed
        const existingFile = await this.findSkillFileUri(skill.id, rootDir);
        if (existingFile) {
            try { await vscode.workspace.fs.delete(existingFile); } catch (e) {}
        }

        // 3. Construct new path
        let targetDir = rootDir;
        if (skill.category) {
            const relativeCategory = skill.category.replace(/\\/g, '/');
            const segments = relativeCategory.split('/').filter(s => s.length > 0);
            
            // Create directories one by one to ensure parent existance
            let currentDir = rootDir;
            for (const segment of segments) {
                currentDir = vscode.Uri.joinPath(currentDir, segment);
                try {
                    await vscode.workspace.fs.createDirectory(currentDir);
                } catch (e) {}
            }
            targetDir = currentDir;
        }

        const filePath = vscode.Uri.joinPath(targetDir, `${skill.id}.xml`);
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
            title: "Import Skills (XML or Claude Markdown)",
            filters: { "Skills": ["xml", "md"] },
            canSelectMany: true
        });

        if (!uris || uris.length === 0) return [];

        // Ask for scope once for the batch
        const scopeChoice = await vscode.window.showQuickPick(
            [{ label: 'Global', value: 'global' }, { label: 'Local (Project)', value: 'local' }],
            { placeHolder: 'Where should these skills be imported?' }
        );
        const scope = (scopeChoice?.value as 'global' | 'local') || 'global';

        const addedSkills: Skill[] = [];
        try {
            for (const uri of uris) {
                const bytes = await vscode.workspace.fs.readFile(uri);
                const content = Buffer.from(bytes).toString('utf8');
                const format = this.detectFormat(content);
                
                let skill: any;
                if (format === 'claude') {
                    skill = this.claudeMarkdownToSkill(content, scope);
                } else {
                    skill = xmlToSkill(content, scope);
                }

                if (skill && skill.id) {
                    await this.writeSkillToFile(skill as Skill);
                    addedSkills.push(skill as Skill);
                }
            }
            vscode.window.showInformationMessage(`Successfully detected and imported ${addedSkills.length} skills.`);
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

    /**
     * Converts a Lollms Skill to Claude Code Markdown format.
     */
    public skillToClaudeMarkdown(skill: Skill): string {
        const frontmatter = [
            '---',
            `name: ${skill.name}`,
            `version: 1.0.0`,
            `description: |`,
            `  ${skill.description.replace(/\n/g, '\n  ')}`,
            'allowed-tools:',
            '  - Read',
            '  - Write',
            '  - Edit',
            '---',
            '',
            skill.content
        ].join('\n');
        return frontmatter;
    }

    /**
     * Detects if content is LoLLMs XML or Claude Markdown.
     */
    private detectFormat(content: string): 'lollms' | 'claude' {
        const trimmed = content.trim();
        if (trimmed.startsWith('<skill')) return 'lollms';
        if (trimmed.startsWith('---') && trimmed.includes('name:')) return 'claude';
        return 'lollms'; // Default fallback
    }

    /**
     * Converts Claude Code Markdown format back to a Lollms Skill.
     */
    public claudeMarkdownToSkill(mdContent: string, scope: 'global' | 'local' = 'local'): Omit<Skill, 'timestamp'> {
        const parts = mdContent.split('---');
        // Extract content (everything after the second ---)
        const content = parts.length >= 3 ? parts.slice(2).join('---').trim() : mdContent;
        const yamlPart = parts.length >= 3 ? parts[1] : "";

        const nameMatch = yamlPart.match(/name:\s*["']?(.*?)["']?(\n|$)/);
        const descMatch = yamlPart.match(/description:\s*(?:\||>)?\n?\s*([\s\S]*?)(?=\n\w+:|$)/);
        const catMatch = yamlPart.match(/category:\s*["']?(.*?)["']?(\n|$)/);

        const name = nameMatch ? nameMatch[1].trim() : "Imported Claude Skill";
        const description = descMatch ? descMatch[1].trim().replace(/^\s+/gm, '') : "No description provided.";
        const category = catMatch ? catMatch[1].trim() : "imported/claude";
        const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Date.now();

        return {
            id,
            name,
            description,
            content,
            category,
            language: 'markdown',
            scope
        };
    }

    public async exportSkills(skillIds?: string[], format: 'lollms' | 'claude' = 'lollms') {
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
                const isClaude = format === 'claude';
                const fileName = `${skill.id}${isClaude ? '.md' : '.xml'}`;
                const fileUri = vscode.Uri.joinPath(folderUri[0], fileName);
                
                const fileContent = isClaude 
                    ? this.skillToClaudeMarkdown(skill) 
                    : skillToXml(skill);

                await vscode.workspace.fs.writeFile(fileUri, Buffer.from(fileContent, 'utf8'));
            }
            vscode.window.showInformationMessage(`Exported ${toExport.length} skills to ${folderUri[0].fsPath}`);
        }
    }
}
