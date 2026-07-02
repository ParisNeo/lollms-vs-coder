import * as vscode from 'vscode';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface Skill {
    id: string;
    name: string;
    description: string;
    content: string;
    language?: string;
    timestamp: number;
    category?: string;
    scope: 'global' | 'local';
    author?: string;
    version?: string;
    tags?: string[];
    icon?: string;
}

// --- Markdown & YAML Helpers ---

export function parseSkillMd(content: string, defaultId: string, scope: 'global' | 'local'): Skill {
    const parts = content.split(/^---\s*$/m);
    let frontmatter: any = {};
    let body = content;
    
    if (parts.length >= 3 && content.trim().startsWith('---')) {
        try {
            frontmatter = yaml.load(parts[1]) || {};
            body = parts.slice(2).join('---').trim();
        } catch (e) {
            console.warn("Failed to parse YAML frontmatter", e);
        }
    }
    
    let tags = frontmatter.tags || [];
    if (typeof tags === 'string') {
        tags = tags.split(',').map((t: string) => t.trim());
    }

    return {
        id: frontmatter.name || defaultId,
        name: frontmatter.name || defaultId,
        description: frontmatter.description || '',
        category: frontmatter.category || 'general',
        author: frontmatter.author || '',
        version: frontmatter.version || '1.0.0',
        tags: tags,
        icon: frontmatter.icon || '',
        content: body,
        scope: scope,
        timestamp: frontmatter.created ? new Date(frontmatter.created).getTime() : Date.now(),
        language: 'markdown'
    };
}

export function skillToMd(skill: Skill): string {
    const fm: any = {
        name: skill.id || skill.name.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        description: skill.description,
        author: skill.author || 'Lollms User',
        version: skill.version || '1.0.0',
        category: skill.category || 'general',
    };
    if (skill.tags && skill.tags.length > 0) fm.tags = skill.tags;
    if (skill.icon) fm.icon = skill.icon;
    fm.created = new Date(skill.timestamp).toISOString().split('T')[0];
    
    const yamlStr = yaml.dump(fm);
    return `---\n${yamlStr}---\n\n${skill.content}`;
}

// --- Legacy XML Helpers ---

function escapeXml(unsafe: string): string {
    if (!unsafe) return '';
    // Smart escape: Only escape ampersands if they are not part of an existing valid HTML entity
    const withEscapedAmps = unsafe.replace(/&(?!#?\w+;)/g, '&amp;');
    return withEscapedAmps.replace(/[<>'"]/g, (c) => {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
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
        const regex = new RegExp(`${attrName}\\s*=\\s*(["'])(.*?)\\1`, 'is');
        const match = xml.match(regex);
        return match ? unescapeXml(match[2]) : '';
    };

    let content = extractContentTag(xml);
    if (!content) {
        content = xml.replace(/<skill[^>]*>/i, '').replace(/<\/skill>\s*$/i, '').trim();
    }

    const id = getAttr('id') || 'skill-' + Math.random().toString(36).substring(2, 9);
    
    let name = getAttr('title') || extractTag(xml, 'name');
    if (!name) {
        name = content.split('\n')[0].replace(/[#*`]/g, '').trim().substring(0, 40) || 'Untitled Skill';
    }

    const description = getAttr('description') || extractTag(xml, 'description') || 'No description provided.';
    let category = getAttr('category') || extractTag(xml, 'category') || 'general';

    if (category.trim() === "") {
        const lowerName = name.toLowerCase();
        if (lowerName.includes('python')) category = 'python';
        else if (lowerName.includes('safe_store') || lowerName.includes('safestore')) category = 'safe_store';
        else if (lowerName.includes('api') || lowerName.includes('lollms')) category = 'lollms/api';
        else if (lowerName.includes('css') || lowerName.includes('html') || lowerName.includes('react')) category = 'frontend';
        else category = 'general';
    }

    const language = getAttr('language') || extractTag(xml, 'language') || 'markdown';
    
    const rawTimestamp = getAttr('timestamp') || extractTag(xml, 'timestamp');
    const parsedTime = rawTimestamp ? parseInt(rawTimestamp) : Date.now();
    const timestamp = isNaN(parsedTime) ? Date.now() : parsedTime;

    return { id, name, description, category, language, timestamp, content, scope: forcedScope || 'global' };
}

export interface SkillsZooRepo {
    id: string;
    name: string;
    url: string;
}

export class SkillsManager {
    private globalSkillsDir: vscode.Uri;
    private extensionUri?: vscode.Uri;
    private zooCacheDir: vscode.Uri;

    private cachedGlobalSkills: Skill[] | null = null;
    private cachedLocalSkills: Skill[] | null = null;

    constructor(globalStorageUri: vscode.Uri) {
        this.globalSkillsDir = vscode.Uri.joinPath(globalStorageUri, 'skills');
        this.zooCacheDir = vscode.Uri.joinPath(globalStorageUri, 'skills_zoo_cache');
        this.initializeGlobalStorage();
    }

    public invalidateCache(scope?: 'global' | 'local') {
        if (!scope || scope === 'global') this.cachedGlobalSkills = null;
        if (!scope || scope === 'local') this.cachedLocalSkills = null;
    }

    private async initializeGlobalStorage() {
        try {
            await vscode.workspace.fs.createDirectory(this.globalSkillsDir);
            await vscode.workspace.fs.createDirectory(this.zooCacheDir);
        } catch (e) {}
    }

    public async switchWorkspace(workspaceRoot: vscode.Uri, extensionUri: vscode.Uri) {
        this.extensionUri = extensionUri;
        this.invalidateCache('local');

        const folders = vscode.workspace.workspaceFolders ||[];
        for (const folder of folders) {
            const dir = vscode.Uri.joinPath(folder.uri, '.lollms', 'skills');
            try {
                await vscode.workspace.fs.createDirectory(dir);
            } catch (e) {}
        }

        await this.ensureBootstrapSkills();
    }

    /**
     * Advanced Grep Search over all skills' file contents
     */
    public async grepSearchSkills(query: string): Promise<(Skill & { matches: string[] })[]> {
        const skills = await this.getSkills();
        const results: (Skill & { matches: string[] })[] = [];
        const lowerQuery = query.toLowerCase();

        for (const s of skills) {
            const lines = s.content.split(/\r?\n/);
            const matches: string[] = [];

            lines.forEach((line, idx) => {
                if (line.toLowerCase().includes(lowerQuery)) {
                    matches.push(`Line ${idx + 1}: ${line.trim()}`);
                }
            });

            if (matches.length > 0 || s.name.toLowerCase().includes(lowerQuery) || s.description.toLowerCase().includes(lowerQuery)) {
                results.push({
                    ...s,
                    matches: matches.slice(0, 5) // Cap snippets for UI space
                });
            }
        }

        return results;
    }

    /**
     * Parses standard raw document/text files and structures them using the active LLM
     */
    public async ingestDocumentAsSkill(
        fileName: string, 
        rawText: string, 
        scope: 'global' | 'local',
        lollmsAPI: any
    ): Promise<Skill | null> {
        if (!lollmsAPI) throw new Error("AI Engine not configured for document parsing.");

        const prompt = `You are a Senior Technical Curriculum and Knowledge Engineer.
I have extracted raw text from an unstructured document: "${fileName}".
I want you to analyze this text and structure it into a single, high-density Lollms Skill Card.

### 🧹 COMPLIANCE RULES:
1. **Frontmatter**: Generate a valid YAML frontmatter block containing:
   - \`name\`: A clean, lower-case identifier with hyphens (e.g. \`fastapi-security-rules\`).
   - \`description\`: A 1-sentence summary of the rule.
   - \`category\`: A nested category path (e.g. \`security/api\`).
2. **Body**: The body (content) of the skill must be clear, actionable instructions or code snippets for an AI assistant.
3. **No Fluff**: Return ONLY the YAML block and the markdown body. No chat.

**RAW TEXT:**
${rawText.substring(0, 8000)}`;

        const model = lollmsAPI.getModelName();
        const response = await lollmsAPI.sendChat([
            { role: 'system', content: "You are a markdown and YAML formatting expert. Output only the structured skill." },
            { role: 'user', content: prompt }
        ], null, undefined, model);

        const cleanResponse = stripThinkingTags(response).trim();
        const skill = parseSkillMd(cleanResponse, `imported-${Date.now()}`, scope);

        if (skill && skill.content) {
            await this.addSkill(skill);
            return skill;
        }
        return null;
    }

    // --- GIT SKILLS ZOO REGISTRY ENGINE ---

    public getZooRepos(): SkillsZooRepo[] {
        const defaultRepo: SkillsZooRepo = {
            id: 'official_zoo',
            name: 'Lollms Skills Zoo (Official)',
            url: 'https://github.com/ParisNeo/lollms_skills_zoo'
        };
        const saved = this.context.globalState.get<SkillsZooRepo[]>('lollms_skills_zoo_registries', []);
        // Deduplicate official repo if present
        const filtered = saved.filter(r => r.id !== 'official_zoo');
        return [defaultRepo, ...filtered];
    }

    public async addZooRepo(name: string, url: string): Promise<void> {
        const repos = this.getZooRepos().filter(r => r.id !== 'official_zoo');
        const id = `repo_${Date.now()}`;
        repos.push({ id, name, url });
        await this.context.globalState.update('lollms_skills_zoo_registries', repos);
        this.invalidateCache();
    }

    public async deleteZooRepo(id: string): Promise<void> {
        const repos = this.getZooRepos().filter(r => r.id !== 'official_zoo' && r.id !== id);
        await this.context.globalState.update('lollms_skills_zoo_registries', repos);
        this.invalidateCache();
    }

    /**
     * Executes git clone/pull to sync the target repo locally
     */
    public async syncZooRepo(repo: SkillsZooRepo, progress?: (status: string) => void): Promise<void> {
        const targetPath = path.join(this.zooCacheDir.fsPath, repo.id);
        const exists = fs.existsSync(targetPath);
        const { exec } = require('child_process');
        const execPromise = (cmd: string) => new Promise<void>((res, rej) => {
            exec(cmd, { cwd: exists ? targetPath : this.zooCacheDir.fsPath }, (err: any, stdout: string) => {
                if (err) rej(err);
                else res();
            });
        });

        if (progress) progress(`Connecting to ${repo.name} git stream...`);

        if (exists) {
            if (progress) progress(`Pulling latest changes...`);
            await execPromise(`git pull origin main`);
        } else {
            if (progress) progress(`Cloning repository into sandbox...`);
            await execPromise(`git clone "${repo.url}" "${repo.id}"`);
        }
    }

    /**
     * Explores the synchronized repo directory and returns a structured Category Tree of available Zoo Skills.
     */
    public async exploreZooRepo(repo: SkillsZooRepo): Promise<any> {
        const repoPath = vscode.Uri.file(path.join(this.zooCacheDir.fsPath, repo.id));
        const skills = await this.loadSkillsFromDir(repoPath, 'global'); // Read with dummy scope

        const root: any = { id: repo.id, label: repo.name, children: [], isSkill: false };

        skills.forEach(skill => {
            const category = skill.category || 'Uncategorized';
            const parts = category.split('/').filter(p => p);

            let current = root;
            let pathSoFar = repo.id;

            parts.forEach(part => {
                pathSoFar = `${pathSoFar}/${part}`;
                let existing = current.children.find((c: any) => c.label === part && !c.isSkill);
                if (!existing) {
                    existing = { id: pathSoFar, label: part, children: [], isSkill: false, isBundle: true };
                    current.children.push(existing);
                }
                current = existing;
            });

            // Read potential license and icon if present in the target folder
            let licenseText = "";
            let iconUriString = "";

            if (skill.category) {
                const targetFolder = path.join(repoPath.fsPath, skill.category, skill.id);
                try {
                    const lFile = fs.existsSync(path.join(targetFolder, 'LICENSE.txt')) ? 'LICENSE.txt' : (fs.existsSync(path.join(targetFolder, 'LICENSE.md')) ? 'LICENSE.md' : '');
                    if (lFile) {
                        licenseText = fs.readFileSync(path.join(targetFolder, lFile), 'utf8');
                    }
                } catch {}
            }

            current.children.push({
                id: skill.id,
                label: skill.name,
                isSkill: true,
                description: skill.description,
                license: licenseText,
                skill: {
                    ...skill,
                    scope: 'local' // Defaults to local for pulls
                }
            });
        });

        return root;
    }

    private async ensureBootstrapSkills() {
        if (!this.extensionUri) return;

        const bootstrapDir = vscode.Uri.joinPath(this.extensionUri, 'out', 'skills');
        const currentGlobalSkills = await this.getGlobalSkills();

        const walk = async (uri: vscode.Uri) => {
            let entries;
            try { entries = await vscode.workspace.fs.readDirectory(uri); } catch(e) { return; }
            
            for (const [name, type] of entries) {
                const entryUri = vscode.Uri.joinPath(uri, name);
                if (type === vscode.FileType.Directory) {
                    await walk(entryUri);
                } else if (type === vscode.FileType.File) {
                    if (name.endsWith('.xml') || name.endsWith('.md')) {
                        try {
                            const contentBytes = await vscode.workspace.fs.readFile(entryUri);
                            const contentStr = contentBytes.toString();
                            let skill: Skill;
                            
                            if (name.endsWith('.xml')) {
                                skill = xmlToSkill(contentStr, 'global');
                            } else {
                                const skillId = name.toLowerCase() === 'skill.md' ? path.basename(uri.fsPath) : name.replace(/\.md$/, '');
                                skill = parseSkillMd(contentStr, skillId, 'global');
                            }
                            
                            if (!currentGlobalSkills.some(s => s.id === skill.id)) {
                                await this.writeSkillToFile(skill);
                            }
                        } catch (e) {
                            console.warn("Failed to load bootstrap skill", entryUri.fsPath, e);
                        }
                    }
                }
            }
        };
        
        try {
            await walk(bootstrapDir);
        } catch (e) {
            console.warn("Error exploring bootstrap skills directory.", e);
        }
    }

    /**
     * Finds the URI of a skill file by its ID by searching through the directory structure.
     */
    private async findSkillFileUri(skillId: string, root: vscode.Uri): Promise<vscode.Uri | null> {
        const walk = async (uri: vscode.Uri): Promise<vscode.Uri | null> => {
            let entries;
            try { 
                await vscode.workspace.fs.stat(uri);
                entries = await vscode.workspace.fs.readDirectory(uri); 
            } catch (e) { return null; }
            
            // Check Format A (Folder format)
            if (path.basename(uri.fsPath) === skillId) {
                const hasSkillMd = entries.find(([n, t]) => n.toLowerCase() === 'skill.md');
                if (hasSkillMd) return vscode.Uri.joinPath(uri, hasSkillMd[0]);
            }

            for (const [name, type] of entries) {
                const entryUri = vscode.Uri.joinPath(uri, name);
                if (type === vscode.FileType.Directory) {
                    const found = await walk(entryUri);
                    if (found) return found;
                } else if (type === vscode.FileType.File) {
                    if (name === `${skillId}.md` || name === `${skillId}.xml`) {
                        return entryUri;
                    }
                }
            }
            return null;
        };
        return walk(root);
    }

    private async writeSkillToFile(skill: Skill): Promise<void> {
        if (skill.scope === 'global') {
            await this._writeSkillToRoot(skill, this.globalSkillsDir);
        } else {
            const folders = vscode.workspace.workspaceFolders ||[];
            if (folders.length === 0) throw new Error("No active workspace for local skill.");
            
            for (const folder of folders) {
                const dir = vscode.Uri.joinPath(folder.uri, '.lollms', 'skills');
                await this._writeSkillToRoot(skill, dir);
            }
        }
        this.invalidateCache(skill.scope);
    }

    private async _writeSkillToRoot(skill: Skill, rootDir: vscode.Uri): Promise<void> {
        try { await vscode.workspace.fs.createDirectory(rootDir); } catch (e) {}

        const existingUri = await this.findSkillFileUri(skill.id, rootDir);
        if (existingUri) {
            try { 
                if (existingUri.fsPath.toLowerCase().endsWith('skill.md')) {
                    await vscode.workspace.fs.delete(vscode.Uri.joinPath(existingUri, '..'), { recursive: true, useTrash: false });
                } else {
                    await vscode.workspace.fs.delete(existingUri, { useTrash: false }); 
                }
            } catch (e) {}
        }

        let targetDir = rootDir;
        if (skill.category) {
            const segments = skill.category.replace(/\\/g, '/').split('/').filter(s => s.length > 0);
            for (const segment of segments) {
                targetDir = vscode.Uri.joinPath(targetDir, segment);
            }
        }

        try {
            await vscode.workspace.fs.createDirectory(rootDir);
            await vscode.workspace.fs.createDirectory(targetDir);
            
            // Create the skill folder (Format A)
            const skillFolder = vscode.Uri.joinPath(targetDir, skill.id);
            await vscode.workspace.fs.createDirectory(skillFolder);

            const filePath = vscode.Uri.joinPath(skillFolder, `SKILL.md`);
            const mdContent = skillToMd(skill);
            await vscode.workspace.fs.writeFile(filePath, Buffer.from(mdContent, 'utf8'));
        } catch (e) {
            console.error(`[SkillsManager] Failed to create directory hierarchy or file`, e);
        }
    }

    private async loadSkillsFromDir(dir: vscode.Uri, scope: 'global' | 'local'): Promise<Skill[]> {
        const skills: Skill[] = [];
        const visitedPaths = new Set<string>();

        const walk = async (uri: vscode.Uri) => {
            const fsPath = uri.fsPath;
            if (visitedPaths.has(fsPath)) return;
            visitedPaths.add(fsPath);

            let entries;
            try { 
                entries = await vscode.workspace.fs.readDirectory(uri); 
            } catch (e) { return; }

            // Priority: Check if this directory IS a skill (Format A)
            const hasSkillMd = entries.find(([n, t]) => n.toLowerCase() === 'skill.md' && t === vscode.FileType.File);
            if (hasSkillMd) {
                try {
                    const content = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(uri, hasSkillMd[0]));
                    const skillId = path.basename(uri.fsPath);
                    const skill = parseSkillMd(content.toString(), skillId, scope);

                    // Auto-infer category from relative directory structure (e.g. skills/theme/name/SKILL.md)
                    const relPath = path.relative(dir.fsPath, uri.fsPath).replace(/\\/g, '/');
                    const parts = relPath.split('/').filter(p => p);
                    if (parts.length > 1) {
                        skill.category = parts.slice(0, -1).join('/');
                    }

                    skills.push(skill);
                } catch (e) {}
                return; // Stop recursion for this branch, we found the skill leaf
            }

            const promises = entries.map(async ([name, type]) => {
                const entryUri = vscode.Uri.joinPath(uri, name);

                if (type === vscode.FileType.Directory) {
                    // Recurse into subdirectories (categories)
                    await walk(entryUri);
                } else if (type === vscode.FileType.File) {
                    if (name.endsWith('.md') && name.toLowerCase() !== 'skill.md') {
                        try {
                            const content = await vscode.workspace.fs.readFile(entryUri);
                            const skillId = name.replace(/\.md$/, '');
                            const skill = parseSkillMd(content.toString(), skillId, scope);

                            // Auto-infer category for loose files in subdirectories (e.g. skills/theme/file.md)
                            const relPath = path.relative(dir.fsPath, uri.fsPath).replace(/\\/g, '/');
                            const parts = relPath.split('/').filter(p => p);
                            if (parts.length > 0) {
                                skill.category = parts.join('/');
                            }

                            skills.push(skill);
                        } catch (e) {}
                    } else if (name.endsWith('.xml')) {
                        try {
                            const content = await vscode.workspace.fs.readFile(entryUri);
                            const skill = xmlToSkill(content.toString(), scope);

                            // Auto-infer category for XML files in subdirectories
                            const relPath = path.relative(dir.fsPath, uri.fsPath).replace(/\\/g, '/');
                            const parts = relPath.split('/').filter(p => p);
                            if (parts.length > 0) {
                                skill.category = parts.join('/');
                            }

                            skills.push(skill);
                        } catch (e) {}
                    }
                }
            });

            await Promise.all(promises);
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
        if (this.cachedGlobalSkills && this.cachedGlobalSkills.length > 0) return this.cachedGlobalSkills;
        this.cachedGlobalSkills = await this.loadSkillsFromDir(this.globalSkillsDir, 'global');
        return this.cachedGlobalSkills;
    }

    public async getLocalSkills(): Promise<Skill[]> {
        if (this.cachedLocalSkills && this.cachedLocalSkills.length > 0) return this.cachedLocalSkills;
        
        const folders = vscode.workspace.workspaceFolders || [];
        const uniqueLocalSkills = new Map<string, Skill>();
        
        for (const folder of folders) {
            const dir = vscode.Uri.joinPath(folder.uri, '.lollms', 'skills');
            const folderSkills = await this.loadSkillsFromDir(dir, 'local');
            for (const skill of folderSkills) {
                // Deduplicate by ID: Keep the one with the latest timestamp
                if (!uniqueLocalSkills.has(skill.id) || (skill.timestamp > uniqueLocalSkills.get(skill.id)!.timestamp)) {
                    // Cleanup name: Remove repetitive prefix if it snuck into the data
                    skill.name = skill.name.replace(/SOURCE OF TRUTH:\s*/gi, '').trim();
                    uniqueLocalSkills.set(skill.id, skill);
                }
            }
        }
        
        this.cachedLocalSkills = Array.from(uniqueLocalSkills.values());
        return this.cachedLocalSkills;
    }

    public async getSkills(): Promise<Skill[]> {
        const global = await this.getGlobalSkills();
        const local = await this.getLocalSkills();

        // --- STRICT DEDUPLICATION PROTOCOL ---
        // We use the unique 'id' as the primary key.
        const deduplicated = new Map<string, Skill>();

        // 1. Load Global Skills
        global.forEach(s => {
            const cleanId = s.id.trim();
            if (!deduplicated.has(cleanId)) {
                deduplicated.set(cleanId, s);
            }
        });

        // 2. Load Local Skills (Local overrides Global if IDs collide)
        local.forEach(s => {
            const cleanId = s.id.trim();
            // Even if it exists in global, the local one is what we want to see/edit
            deduplicated.set(cleanId, s);
        });

        const finalResults = Array.from(deduplicated.values());

        // 3. Alphabetical sort by clean name to prevent visual scattering
        return finalResults.sort((a, b) => a.name.localeCompare(b.name));
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
        if (scope === 'global') {
            await this._deleteSkillFromRoot(skillId, this.globalSkillsDir);
        } else {
            const folders = vscode.workspace.workspaceFolders ||[];
            for (const folder of folders) {
                const dir = vscode.Uri.joinPath(folder.uri, '.lollms', 'skills');
                await this._deleteSkillFromRoot(skillId, dir);
            }
        }
        this.invalidateCache(scope);
    }

    private async _deleteSkillFromRoot(skillId: string, rootDir: vscode.Uri) {
        const existingUri = await this.findSkillFileUri(skillId, rootDir);
        if (existingUri) {
            try {
                if (existingUri.fsPath.toLowerCase().endsWith('skill.md')) {
                    await vscode.workspace.fs.delete(vscode.Uri.joinPath(existingUri, '..'), { recursive: true, useTrash: false });
                } else {
                    await vscode.workspace.fs.delete(existingUri, { useTrash: false });
                }
            } catch (e) {}
        }
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
        const folders = vscode.workspace.workspaceFolders || [];
        for (const folder of folders) {
            const dir = vscode.Uri.joinPath(folder.uri, '.lollms', 'skills');
            try {
                await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
                await vscode.workspace.fs.createDirectory(dir);
            } catch {}
        }
        this.invalidateCache();
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
     * Converts a Lollms Skill to Claude Code Markdown format (alias for skillToMd).
     */
    public skillToClaudeMarkdown(skill: Skill): string {
        return skillToMd(skill);
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
