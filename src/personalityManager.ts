import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { Logger } from './logger';

export interface Personality {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
    icon?: string; // base64 data URI or relative path
    category?: string;
    author?: string;
    version?: string;
    creationDate?: string;
    lastUpdateDate?: string;
    languages?: string[];
    tags?: string[];
    isDefault?: boolean;
    scope?: 'global' | 'local';
    folderPath?: string;
    skills?: string[]; // Bundled skill IDs or folder names in skills/
    tools?: string[];  // Bundled tool names in tools/
    extraSkills?: string[]; // Extra skills equipped at runtime
    extraTools?: string[];  // Extra tools equipped at runtime
}

export interface PersonalitiesZooRepo {
    id: string;
    name: string;
    url: string;
    branch?: string;
    enabled?: boolean;
}

// --- SOUL.md Parser & Serializer ---

export function parseSoulMd(content: string, defaultId: string): Personality {
    const trimmed = content.trim();
    const parts = content.split(/^---\s*$/m);
    let frontmatter: any = {};
    let body = content;

    if (parts.length >= 3 && trimmed.startsWith('---')) {
        const yamlRaw = parts[1];
        body = parts.slice(2).join('---').trim();
        try {
            frontmatter = yaml.load(yamlRaw) || {};
        } catch (e) {
            const nameMatch = yamlRaw.match(/^name:\s*["']?(.*?)["']?$/m);
            const descMatch = yamlRaw.match(/^description:\s*(?:[>|]\s*)?(.*?)(?=\n[a-z_]+:|$)/ms);
            const catMatch = yamlRaw.match(/^category:\s*["']?(.*?)["']?$/m);
            const authorMatch = yamlRaw.match(/^author:\s*["']?(.*?)["']?$/m);
            const versionMatch = yamlRaw.match(/^version:\s*["']?(.*?)["']?$/m);
            const createdMatch = yamlRaw.match(/^(?:creation_date|created_date|created):\s*["']?(.*?)["']?$/m);
            const updatedMatch = yamlRaw.match(/^(?:last_update_date|updated_date|updated):\s*["']?(.*?)["']?$/m);

            frontmatter = {
                name: nameMatch ? nameMatch[1].trim() : undefined,
                description: descMatch ? descMatch[1].trim().replace(/\n\s+/g, ' ') : undefined,
                category: catMatch ? catMatch[1].trim() : undefined,
                author: authorMatch ? authorMatch[1].trim() : undefined,
                version: versionMatch ? versionMatch[1].trim() : undefined,
                creation_date: createdMatch ? createdMatch[1].trim() : undefined,
                last_update_date: updatedMatch ? updatedMatch[1].trim() : undefined
            };
        }
    }

    const cleanId = (frontmatter.id || defaultId).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const cleanName = frontmatter.name || defaultId;

    return {
        id: cleanId,
        name: cleanName,
        description: frontmatter.description || '',
        category: frontmatter.category || 'General',
        author: frontmatter.author || 'Lollms',
        version: String(frontmatter.version || '1.0.0'),
        creationDate: frontmatter.creation_date || frontmatter.created_date || frontmatter.creationDate || frontmatter.created || '',
        lastUpdateDate: frontmatter.last_update_date || frontmatter.updated_date || frontmatter.lastUpdateDate || frontmatter.updated || '',
        languages: Array.isArray(frontmatter.languages) ? frontmatter.languages : (frontmatter.language ? [frontmatter.language] : []),
        tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
        icon: frontmatter.icon,
        systemPrompt: body,
        skills: Array.isArray(frontmatter.skills) ? frontmatter.skills : [],
        tools: Array.isArray(frontmatter.tools) ? frontmatter.tools : [],
        extraSkills: Array.isArray(frontmatter.extraSkills) ? frontmatter.extraSkills : [],
        extraTools: Array.isArray(frontmatter.extraTools) ? frontmatter.extraTools : []
    };
}

export function soulToMd(p: Personality): string {
    const fm: any = {
        name: p.name,
        author: p.author || 'Lollms',
        version: String(p.version || '1.0.0'),
        category: p.category || 'General',
        description: p.description
    };
    if (p.id) fm.id = p.id;
    if (p.creationDate) fm.creation_date = p.creationDate;
    if (p.lastUpdateDate) fm.last_update_date = p.lastUpdateDate;
    if (p.languages && p.languages.length > 0) fm.languages = p.languages;
    if (p.tags && p.tags.length > 0) fm.tags = p.tags;
    if (p.icon && !p.icon.startsWith('data:')) fm.icon = p.icon;
    if (p.skills && p.skills.length > 0) fm.skills = p.skills;
    if (p.tools && p.tools.length > 0) fm.tools = p.tools;
    if (p.extraSkills && p.extraSkills.length > 0) fm.extraSkills = p.extraSkills;
    if (p.extraTools && p.extraTools.length > 0) fm.extraTools = p.extraTools;

    const yamlStr = yaml.dump(fm);
    return `---\n${yamlStr}---\n\n${p.systemPrompt.trim()}`;
}

export const DEFAULT_PERSONALITIES: Personality[] = [
    {
        id: 'default_coder',
        name: 'Lollms Coder (Default)',
        category: 'Software Engineering',
        author: 'ParisNeo & LoLLMs Team',
        version: '2.0.0',
        creationDate: '2024-01-15',
        lastUpdateDate: '2026-03-01',
        languages: ['English', 'French'],
        tags: ['coding', 'architecture', 'clean-code', 'debugging'],
        description: 'Elite Software Engineer & Architect with smart coding, structured answers, and automatic diagnostic instrumentation.',
        systemPrompt: `You are Lollms, a Senior Software Engineer and Security-Minded Architect. You possess deep expertise in algorithms, software architecture, and clean code principles (SOLID, DRY, KISS).

### 🧠 SMART CODING CAPABILITIES & REASONING
1. **Holistic Codebase Grounding**:
   - You only operate on the ground-truth code provided under 'LOADED FILE CONTENTS' [C].
   - Never assume missing definitions. Verify types, import paths, and module contracts thoroughly.
2. **Deterministic Architecture**:
   - Deliver decoupled, single-responsibility functions with defensive error handling and zero resource leaks.
   - Ensure imports and dependencies are updated without leaving unused symbols or dead code.

### 📐 ORGANIZED STRUCTURE OF ANSWER
Deliver every implementation following this clean, professional layout:
1. **Objective & Hypothesis Framing**:
   - 1-2 concise sentences framing the problem, invariants, and chosen approach.
2. **Verified Code Implementation**:
   - Proceed directly to code implementation following the attached File Mutation Protocol.
   - Zero conversational stalling, zero placeholders, zero \`// ... existing code\`.
3. **Concluding Summary**:
   - At the conclusion of your response, strictly output:
     ### 📋 Summary of Changes
     - **Problem Restatement**: concise statement of the problem being solved
     - **Files Modified**: exact list of target files
     - **What Was Done**: key accomplishments and logic implemented
     - **Verification & Edge Cases**: audit of imports, syntax, type safety, and test compatibility.

### 🔬 AUTOMATIC INSTRUMENTATION FOR DEBUGGING
- **When to Instrument**:
  - If a previous attempt or patch failed to apply or run successfully.
  - When you are uncertain about a runtime hypothesis, execution branch, variable lifecycle, or exception boundary.
- **How to Instrument**:
  - Automatically inject targeted, temporary diagnostic logging (e.g. \`console.error('[DIAGNOSTIC:H1]', ...)\`, \`logger.debug('[DIAGNOSTIC:H1]', ...)\`, or \`print('[DIAGNOSTIC:H1]', ...)\`) at the suspected failure boundary.
  - Tag each diagnostic clearly: \`// [DIAGNOSTIC INSTRUMENTATION: Hypothesis H1]\`.
  - State clearly in your explanation what the instrumentation measures so the test runner or user can observe empirical output to verify the hypothesis before removing it.`,
        isDefault: true,
        skills: ['lollms_client'],
        tools: ['execute_command', 'run_tests_and_fix']
    },
    {
        id: 'minimalist_coder',
        name: 'Minimalist Coder',
        category: 'Software Engineering',
        author: 'Lollms',
        version: '1.2.0',
        creationDate: '2024-02-10',
        lastUpdateDate: '2026-02-20',
        tags: ['minimalist', 'concise', 'code-first'],
        description: 'Concise and direct. Delivers production code immediately with minimal prose and a brief summary.',
        systemPrompt: `You are a Pragmatic, Minimalist Software Craftsman. You value concise, direct solutions with zero fluff.

### ⚡ CODE-FIRST RESPONSE GUIDELINES
1. **Zero Fluff**: Skip conversational greetings, preambles, and filler.
2. **Immediate Code Delivery**: Deliver production-ready code immediately following the attached File Mutation Protocol.
3. **Brief Summary**: Conclude with a concise, bulleted summary of files changed and key logic implemented.`,
        isDefault: true
    },
    {
        id: 'senior_architect',
        name: 'Senior Architect',
        category: 'Architecture & Design',
        author: 'Lollms',
        version: '1.5.0',
        creationDate: '2024-01-20',
        lastUpdateDate: '2026-03-01',
        tags: ['architecture', 'design-patterns', 'scalability'],
        description: 'Focuses on system design, scalability, component contracts, and formal architectural breakdown.',
        systemPrompt: `You are a Senior Software Architect. You think in terms of components, interfaces, and design patterns (SOLID, DRY, Clean Architecture, Hexagonal). You prioritize scalability, maintainability, and testing strategies.

### 🏛️ ARCHITECTURAL ANALYSIS & DELIVERY GUIDELINES
1. **Observe**: Review loaded file contents [C], project tree, and architectural invariants.
2. **Think**: Analyze component boundaries, caller-callee flows, data contracts, and security perimeters.
3. **Act**: Output production-ready, verified code following the attached File Mutation Protocol.
4. **Concluding Summary**: Provide an itemized summary of structural decisions, modified files, and verification steps.`,
        isDefault: true
    },
    {
        id: 'code_reviewer',
        name: 'Code Reviewer & Mentor',
        category: 'Quality Assurance',
        author: 'Lollms',
        version: '1.3.0',
        creationDate: '2024-02-01',
        lastUpdateDate: '2026-02-15',
        tags: ['review', 'mentor', 'pedagogy', 'qa'],
        description: 'Constructive code reviewer and mentor providing pedagogical explanations, safety audits, and clean refactoring.',
        systemPrompt: `You are a Senior Code Reviewer and Pedagogical Engineering Mentor. You analyze code for logic errors, security vulnerabilities, performance bottlenecks, and style violations.

### 🔍 CODE REVIEW & PEDAGOGICAL GUIDELINES
1. **Clear Explanations**: Explain the 'why' and 'how' behind architectural choices, potential vulnerabilities, and design patterns.
2. **Constructive Solutions**: When identifying issues, provide the exact surgical fix following the attached File Mutation Protocol accompanied by the rationale.
3. **Standards Enforcement**: Ensure adherence to Clean Code, SOLID principles, and defensive error handling.`,
        isDefault: true
    },
    {
        id: 'python_expert',
        name: 'Python Expert',
        category: 'Languages',
        author: 'Lollms',
        version: '1.4.0',
        creationDate: '2024-01-25',
        lastUpdateDate: '2026-02-28',
        tags: ['python', 'fastapi', 'asyncio', 'pep8'],
        description: 'Specialized in Python, PEP 8, dataclasses, FastAPI, and PyData ecosystem.',
        systemPrompt: `You are a Python Expert. You write clean, Pythonic code following PEP 8 standards. You prefer modern features (type hinting, dataclasses, async/await, generators). You are knowledgeable about the PyData stack (numpy, pandas) and web frameworks (FastAPI, Flask, Django). Deliver your code modifications following the attached File Mutation Protocol.`,
        isDefault: true
    },
    {
        id: 'rust_expert',
        name: 'Rust Specialist',
        category: 'Languages',
        author: 'Lollms',
        version: '1.3.0',
        creationDate: '2024-02-05',
        lastUpdateDate: '2026-02-25',
        tags: ['rust', 'systems', 'memory-safety', 'async'],
        description: 'Expert in systems programming with Rust, focusing on safety, traits, and performance.',
        systemPrompt: `You are a Rust Systems Architect. You provide idiomatic Rust code adhering strictly to ownership, lifetimes, trait bounds, and safe concurrency. Deliver your code modifications following the attached File Mutation Protocol.`,
        isDefault: true
    },
    {
        id: 'cpp_expert',
        name: 'C/C++ Expert',
        category: 'Languages',
        author: 'Lollms',
        version: '1.2.0',
        creationDate: '2024-01-30',
        lastUpdateDate: '2026-02-18',
        tags: ['cpp', 'c', 'raii', 'performance'],
        description: 'Expert in C/C++ programming, memory management, RAII, and systems programming.',
        systemPrompt: `You are a C/C++ Expert. You prioritize efficient, safe, and portable code. You are well-versed in modern C++ standards (C++17/C++20) as well as legacy C. You handle pointers, memory management, and RAII with extreme care. Deliver your code modifications following the attached File Mutation Protocol.`,
        isDefault: true
    },
    {
        id: 'embedded_expert',
        name: 'Embedded Systems Expert',
        category: 'Embedded & Hardware',
        author: 'Lollms',
        version: '1.1.0',
        creationDate: '2024-03-01',
        lastUpdateDate: '2026-02-10',
        tags: ['embedded', 'arm', 'rtos', 'microcontrollers'],
        description: 'Specialist in embedded C/C++, RTOS, register-level drivers, and hardware interfacing.',
        systemPrompt: `You are an Embedded Systems Expert. You are skilled in writing firmware for microcontrollers (ARM Cortex-M, AVR, PIC, ESP32). You understand interrupts, DMA, registers, and timing constraints. You prioritize code size, deterministic timing, and power efficiency.`,
        isDefault: true
    },
    {
        id: 'frontend_specialist',
        name: 'Front-End Specialist',
        category: 'Web & UI',
        author: 'Lollms',
        version: '1.4.0',
        creationDate: '2024-02-15',
        lastUpdateDate: '2026-03-01',
        tags: ['vue', 'react', 'tailwind', 'ui-ux'],
        description: 'Modern UI/UX and Framework expert (Vue, React, Tailwind, HTML5).',
        systemPrompt: `You are a Front-End Architect. You focus on performant, accessible (WCAG AA), and responsive user interfaces. You specialize in Vue 3 (Composition API), React, and Tailwind CSS. Deliver your code modifications following the attached File Mutation Protocol.`,
        isDefault: true
    },
    {
        id: 'cve_analyzer',
        name: 'CVE Analyzer & Validator',
        category: 'Security',
        author: 'Lollms Security Team',
        version: '1.5.0',
        creationDate: '2024-01-10',
        lastUpdateDate: '2026-02-28',
        tags: ['security', 'cve', 'vulnerability', 'audit'],
        description: 'Specialist in vulnerability research, exploit validation, and security remediation.',
        systemPrompt: `You are the CVE Analyzer & Validator. Your mission is to provide a definitive technical verdict on whether a reported CVE is legitimate given a specific code context, and produce automated reproduction tests and verified surgical fixes following the attached File Mutation Protocol.`,
        isDefault: true
    }
];

export class PersonalityManager {
    private storagePath: vscode.Uri;
    private personalitiesDir: vscode.Uri;
    private zooCacheDir: vscode.Uri;
    private personalitiesFilePath: vscode.Uri;
    private personalities: Personality[] = [];
    private context?: vscode.ExtensionContext;
    private _onDidChange = new vscode.EventEmitter<void>();
    public readonly onDidChange = this._onDidChange.event;

    constructor(globalStorageUri: vscode.Uri, context?: vscode.ExtensionContext) {
        this.storagePath = globalStorageUri;
        this.context = context;
        this.personalitiesDir = vscode.Uri.joinPath(this.storagePath, 'personalities');
        this.zooCacheDir = vscode.Uri.joinPath(this.storagePath, 'personalities_zoo_cache');
        this.personalitiesFilePath = vscode.Uri.joinPath(this.storagePath, 'personalities.json');
        this.initialize();
    }

    public setContext(context: vscode.ExtensionContext) {
        this.context = context;
    }

    private async initialize() {
        try {
            await vscode.workspace.fs.createDirectory(this.storagePath);
            await vscode.workspace.fs.createDirectory(this.personalitiesDir);
            await vscode.workspace.fs.createDirectory(this.zooCacheDir);
        } catch {}

        try {
            // 1. Load directory-based personalities (SOUL.md format)
            const diskPersonalities = await this.loadPersonalitiesFromDirectory(this.personalitiesDir);

            // 2. Also load legacy JSON personalities if present
            let jsonPersonalities: Personality[] = [];
            try {
                const fileContent = await vscode.workspace.fs.readFile(this.personalitiesFilePath);
                jsonPersonalities = JSON.parse(fileContent.toString());
            } catch {}

            // Merge into unified list
            const combinedMap = new Map<string, Personality>();

            // Put defaults first
            for (const def of DEFAULT_PERSONALITIES) {
                combinedMap.set(def.id, { ...def });
            }

            // Overlay JSON personalities
            for (const jp of jsonPersonalities) {
                if (jp && jp.id) {
                    const existing = combinedMap.get(jp.id);
                    combinedMap.set(jp.id, {
                        ...existing,
                        ...jp,
                        isDefault: existing ? existing.isDefault : false
                    });
                }
            }

            // Overlay disk personalities (SOUL.md takes highest precedence)
            for (const dp of diskPersonalities) {
                if (dp && dp.id) {
                    const existing = combinedMap.get(dp.id);
                    combinedMap.set(dp.id, {
                        ...existing,
                        ...dp,
                        isDefault: existing ? existing.isDefault : false
                    });
                }
            }

            this.personalities = Array.from(combinedMap.values());

            // 3. Ensure all default personalities are written to disk in SOUL.md format
            for (const def of DEFAULT_PERSONALITIES) {
                const targetDir = vscode.Uri.joinPath(this.personalitiesDir, def.id);
                const soulUri = vscode.Uri.joinPath(targetDir, 'SOUL.md');
                const exists = fs.existsSync(soulUri.fsPath);
                if (!exists) {
                    await this.writePersonalityToFolder(def, targetDir);
                }
            }

            await this.save();
        } catch (e: any) {
            Logger.warn("PersonalityManager initialization fallback:", e);
            this.personalities = [...DEFAULT_PERSONALITIES];
            await this.save();
        }

        this._onDidChange.fire();
    }

    /**
     * Scans a directory containing personality subfolders.
     * Each subfolder must contain a SOUL.md file, and optionally icon.png, skills/, tools/.
     */
    public async loadPersonalitiesFromDirectory(dir: vscode.Uri, scope: 'global' | 'local' = 'global', maxDepth: number = 3): Promise<Personality[]> {
        const result: Personality[] = [];

        const scanRecursive = async (currentDir: vscode.Uri, currentCategory: string, depth: number) => {
            if (depth > maxDepth) return;
            try {
                const entries = await vscode.workspace.fs.readDirectory(currentDir);

                // 1. Check if currentDir contains a SOUL.md / soul.md
                const soulEntry = entries.find(([n, t]) => t === vscode.FileType.File && n.toLowerCase() === 'soul.md');
                if (soulEntry) {
                    const soulUri = vscode.Uri.joinPath(currentDir, soulEntry[0]);
                    try {
                        const soulStat = await vscode.workspace.fs.stat(soulUri);
                        if (soulStat.type === vscode.FileType.File) {
                            const soulBytes = await vscode.workspace.fs.readFile(soulUri);
                            const soulText = Buffer.from(soulBytes).toString('utf8');
                            const folderName = path.basename(currentDir.fsPath);
                            const persona = parseSoulMd(soulText, folderName);
                            persona.folderPath = currentDir.fsPath;
                            persona.scope = scope;
                            if (!persona.category || persona.category === 'General') {
                                if (currentCategory) persona.category = currentCategory;
                            }

                            // Check for icon.png
                            const iconEntry = entries.find(([n, t]) => t === vscode.FileType.File && n.toLowerCase() === 'icon.png');
                            if (iconEntry) {
                                try {
                                    const iconBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(currentDir, iconEntry[0]));
                                    persona.icon = `data:image/png;base64,${Buffer.from(iconBytes).toString('base64')}`;
                                } catch {}
                            }

                            // Scan skills/ folder
                            const skillsUri = vscode.Uri.joinPath(currentDir, 'skills');
                            try {
                                const skillEntries = await vscode.workspace.fs.readDirectory(skillsUri);
                                const foundSkills = skillEntries
                                    .filter(([sName, sType]) => sType === vscode.FileType.Directory || sName.endsWith('.md'))
                                    .map(([sName]) => sName.replace(/\.md$/, ''));
                                if (foundSkills.length > 0) {
                                    persona.skills = Array.from(new Set([...(persona.skills || []), ...foundSkills]));
                                }
                            } catch {}

                            // Scan tools/ folder
                            const toolsUri = vscode.Uri.joinPath(currentDir, 'tools');
                            try {
                                const toolEntries = await vscode.workspace.fs.readDirectory(toolsUri);
                                const foundTools = toolEntries
                                    .filter(([tName, tType]) => tType === vscode.FileType.Directory || tName.endsWith('.py'))
                                    .map(([tName]) => tName.replace(/\.py$/, ''));
                                if (foundTools.length > 0) {
                                    persona.tools = Array.from(new Set([...(persona.tools || []), ...foundTools]));
                                }
                            } catch {}

                            result.push(persona);
                            return; // Found personality in this folder
                        }
                    } catch (e) {
                        Logger.warn(`Failed reading soul at ${soulUri.fsPath}:`, e);
                    }
                }

                // 2. If not a personality folder, recurse into subdirectories (Zoo categories)
                for (const [name, type] of entries) {
                    if (type === vscode.FileType.Directory && !name.startsWith('.') && name !== 'node_modules' && name !== 'tools' && name !== 'skills' && name !== 'assets' && name !== 'scripts') {
                        const nextDir = vscode.Uri.joinPath(currentDir, name);
                        const nextCat = currentCategory || name.charAt(0).toUpperCase() + name.slice(1);
                        await scanRecursive(nextDir, nextCat, depth + 1);
                    }
                }
            } catch (err) {
                Logger.warn(`Error scanning directory ${currentDir.fsPath}:`, err);
            }
        };

        await scanRecursive(dir, '', 1);
        return result;
    }

    /**
     * Writes a personality into a compliant folder structure:
     * - <folder>/SOUL.md
     * - <folder>/icon.png (if icon provided)
     * - <folder>/skills/ (creates folder)
     * - <folder>/tools/ (creates folder)
     */
    public async writePersonalityToFolder(p: Personality, folderUri: vscode.Uri): Promise<void> {
        try {
            await vscode.workspace.fs.createDirectory(folderUri);

            // 1. Write SOUL.md
            const soulContent = soulToMd(p);
            const soulUri = vscode.Uri.joinPath(folderUri, 'SOUL.md');
            await vscode.workspace.fs.writeFile(soulUri, Buffer.from(soulContent, 'utf8'));

            // 2. Write icon.png if provided as base64 data URI
            if (p.icon && p.icon.startsWith('data:image/png;base64,')) {
                const b64 = p.icon.replace('data:image/png;base64,', '');
                const iconUri = vscode.Uri.joinPath(folderUri, 'icon.png');
                await vscode.workspace.fs.writeFile(iconUri, Buffer.from(b64, 'base64'));
            }

            // 3. Ensure skills/ and tools/ folders exist
            const skillsDir = vscode.Uri.joinPath(folderUri, 'skills');
            const toolsDir = vscode.Uri.joinPath(folderUri, 'tools');
            await vscode.workspace.fs.createDirectory(skillsDir);
            await vscode.workspace.fs.createDirectory(toolsDir);
        } catch (err: any) {
            Logger.warn(`Failed to write personality folder for ${p.id}:`, err);
        }
    }

    public async save(): Promise<void> {
        // Sync JSON index file
        const content = Buffer.from(JSON.stringify(this.personalities, null, 2), 'utf8');
        await vscode.workspace.fs.writeFile(this.personalitiesFilePath, content);

        // Sync individual folders in global storage
        for (const p of this.personalities) {
            const folderUri = vscode.Uri.joinPath(this.personalitiesDir, p.id);
            await this.writePersonalityToFolder(p, folderUri);
        }

        this._onDidChange.fire();
    }

    public getPersonalities(): Personality[] {
        return this.personalities;
    }

    public getPersonality(id: string): Personality | undefined {
        return this.personalities.find(p => p.id === id);
    }

    public getDefaultPersonality(id: string): Personality | undefined {
        return DEFAULT_PERSONALITIES.find(p => p.id === id);
    }

    public getDefaultPersonalities(): Personality[] {
        return DEFAULT_PERSONALITIES;
    }

    public isDefaultPersonality(id: string): boolean {
        return DEFAULT_PERSONALITIES.some(p => p.id === id);
    }

    public async addPersonality(personality: Personality): Promise<void> {
        const existingIdx = this.personalities.findIndex(p => p.id === personality.id);
        if (existingIdx !== -1) {
            this.personalities[existingIdx] = personality;
        } else {
            this.personalities.push(personality);
        }
        await this.save();
    }

    public async updatePersonality(updated: Personality): Promise<void> {
        const index = this.personalities.findIndex(p => p.id === updated.id);
        if (index !== -1) {
            this.personalities[index] = updated;
            await this.save();
        }
    }

    public async deletePersonality(id: string): Promise<void> {
        this.personalities = this.personalities.filter(p => p.id !== id);

        const folderUri = vscode.Uri.joinPath(this.personalitiesDir, id);
        try {
            await vscode.workspace.fs.delete(folderUri, { recursive: true, useTrash: false });
        } catch {}

        await this.save();
    }

    // ─── RUNTIME EXTRA TOOLS & SKILLS ───

    public getEffectiveSkills(personalityId: string): string[] {
        const p = this.getPersonality(personalityId);
        if (!p) return [];
        const bundled = p.skills || [];
        const extra = p.extraSkills || [];
        return Array.from(new Set([...bundled, ...extra]));
    }

    public getEffectiveTools(personalityId: string): string[] {
        const p = this.getPersonality(personalityId);
        if (!p) return [];
        const bundled = p.tools || [];
        const extra = p.extraTools || [];
        return Array.from(new Set([...bundled, ...extra]));
    }

    public async addExtraSkill(personalityId: string, skillId: string): Promise<void> {
        const p = this.getPersonality(personalityId);
        if (!p) return;
        if (!p.extraSkills) p.extraSkills = [];
        if (!p.extraSkills.includes(skillId)) {
            p.extraSkills.push(skillId);
            await this.save();
        }
    }

    public async removeExtraSkill(personalityId: string, skillId: string): Promise<void> {
        const p = this.getPersonality(personalityId);
        if (!p || !p.extraSkills) return;
        p.extraSkills = p.extraSkills.filter(s => s !== skillId);
        await this.save();
    }

    public async addExtraTool(personalityId: string, toolName: string): Promise<void> {
        const p = this.getPersonality(personalityId);
        if (!p) return;
        if (!p.extraTools) p.extraTools = [];
        if (!p.extraTools.includes(toolName)) {
            p.extraTools.push(toolName);
            await this.save();
        }
    }

    public async removeExtraTool(personalityId: string, toolName: string): Promise<void> {
        const p = this.getPersonality(personalityId);
        if (!p || !p.extraTools) return;
        p.extraTools = p.extraTools.filter(t => t !== toolName);
        await this.save();
    }

    // ─── LOLLMS PERSONALITY ZOO REGISTRY & INSTALLATION ───

    public getZooRepos(): PersonalitiesZooRepo[] {
        const defaultRepo: PersonalitiesZooRepo = {
            id: 'official_personalities_zoo',
            name: 'Lollms Personalities Zoo (Official)',
            url: 'https://github.com/ParisNeo/lollms_personalities_zoo.git',
            enabled: true
        };

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const configuredRepos = config.get<PersonalitiesZooRepo[]>('personalities.gitRepositories') || [];
        const stateRepos = this.context?.globalState.get<PersonalitiesZooRepo[]>('lollms_personalities_zoo_registries', []) || [];

        const combined = [...stateRepos, ...configuredRepos];
        const unique = new Map<string, PersonalitiesZooRepo>();
        unique.set(defaultRepo.id, defaultRepo);

        combined.forEach(r => {
            if (r && r.url) {
                const normUrl = r.url.trim();
                const id = r.id || `repo_${Buffer.from(normUrl).toString('hex').substring(0, 10)}`;
                unique.set(id, { ...r, id, url: normUrl, enabled: r.enabled !== false });
            }
        });

        return Array.from(unique.values());
    }

    public async syncZooRepo(repo: PersonalitiesZooRepo, progress?: (status: string) => void): Promise<Personality[]> {
        const targetPath = path.join(this.zooCacheDir.fsPath, repo.id);
        const exists = fs.existsSync(targetPath);
        const { exec } = require('child_process');
        const execPromise = (cmd: string, cwd: string) => new Promise<void>((res, rej) => {
            exec(cmd, { cwd }, (err: any, stdout: string, stderr: string) => {
                if (err) rej(new Error(stderr || stdout || err.message));
                else res();
            });
        });

        if (progress) progress(`Connecting to ${repo.name}...`);

        if (exists && fs.existsSync(path.join(targetPath, '.git'))) {
            if (progress) progress(`Pulling latest personalities for ${repo.name}...`);
            try {
                await execPromise(`git pull`, targetPath);
            } catch {
                try {
                    await execPromise(`git fetch origin && git reset --hard origin/HEAD`, targetPath);
                } catch {
                    await fs.promises.rm(targetPath, { recursive: true, force: true });
                    await execPromise(`git clone "${repo.url}" "${repo.id}"`, this.zooCacheDir.fsPath);
                }
            }
        } else {
            if (progress) progress(`Cloning ${repo.name} (${repo.url})...`);
            if (exists) {
                await fs.promises.rm(targetPath, { recursive: true, force: true });
            }
            await execPromise(`git clone "${repo.url}" "${repo.id}"`, this.zooCacheDir.fsPath);
        }

        const repoUri = vscode.Uri.file(targetPath);
        return await this.loadPersonalitiesFromDirectory(repoUri, 'global');
    }

    public async installZooPersonality(p: Personality): Promise<void> {
        const targetDir = vscode.Uri.joinPath(this.personalitiesDir, p.id);
        await this.writePersonalityToFolder(p, targetDir);
        await this.addPersonality(p);
    }
}