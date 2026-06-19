import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { Logger } from './logger';

export function isValidSemanticTag(tag: string): boolean {
    const clean = tag.replace('#', '').trim().toLowerCase();
    
    // 1. Must be at least 2 characters
    if (clean.length < 2) return false;
    
    // 2. Block purely numeric tags (e.g. 10, 12, 15)
    if (/^\d+$/.test(clean)) return false;
    
    // 3. Block hexadecimal color codes (3, 4, 6, or 8 digits)
    if (/^[0-9a-f]{3}$/i.test(clean) || 
        /^[0-9a-f]{4}$/i.test(clean) || 
        /^[0-9a-f]{6}$/i.test(clean) || 
        /^[0-9a-f]{8}$/i.test(clean)) {
        return false;
    }
    
    // 4. Block other common short meaningless alphanumeric patterns
    if (clean.length === 2 && /\d/.test(clean)) return false;

    return true;
}

export type MemoryTier = 0 | 1 | 2 | 3;

export interface MemoryPredicate {
    verb: string;       // e.g. "depends_on", "implements", "part_of", "has_tag"
    targetId: string;   // The ID of another memory node
}

export interface MemoryEntry {
    id: string;
    title: string;
    content: string;
    timestamp: number;
    importance: number; // 0 - 100
    lastUsed: number;
    category: string;
    tier: MemoryTier;
    scope: 'local' | 'global';
    origin?: 'architect' | 'agent' | 'user'; // Track who created the engram
    predicates?: MemoryPredicate[]; // Upgraded Graph Relationship links
    lastAudited?: number; // Timestamp of last successful AI semantic audit

    // --- MULTIMODAL RESEARCH METADATA ---
    metadata?: {
        sourceDocId?: string;  // ID of s:Document parent
        author?: string;       // Author of article
        chunkIndex?: number;   // Sequence order
        domain?: string;       // e.g. "Security", "ML"
        tags?: string[];       // Associated hashtags
    };
}

export interface AffectiveMatrix {
    relationshipScore: number; // 0 (Hostile) to 100 (Worship)
    label: string;
}

export class ProjectMemoryManager {
    private readonly DECAY_STEP = 2; // Importance lost per dream cycle
    private readonly TIER_THRESHOLD = 25; // Points to stay in Tier 1
    private memoryStore: Map<string, any> = new Map();
    private _onDidChange = new vscode.EventEmitter<void>();
    public readonly onDidChange = this._onDidChange.event;

    constructor(private context: vscode.ExtensionContext, public lollmsAPI?: any) {}

    public async switchWorkspace(folder: vscode.Uri) {
        // We now handle all workspace folders dynamically
        await this.getMemories(); // Pre-load cache
        this._onDidChange.fire();
    }

    private _cache: MemoryEntry[] = [];

    private getGlobalMemoryPath(): vscode.Uri {
        return vscode.Uri.joinPath(vscode.Uri.file(os.homedir()), '.lollms', 'global_memory.json');
    }

    private getBootstrapOntology(): MemoryEntry[] {
        const timestamp = Date.now();
        return [
            {
                id: "concept_template_engram",
                title: "Engram",
                content: "Represents an individual unit of captured project knowledge, such as an architectural decision, technical fact, or lesson learned.",
                timestamp,
                importance: 80,
                lastUsed: timestamp,
                category: "concept",
                tier: 1,
                scope: "local",
                predicates: [
                    { verb: "has_tag", targetId: "concept_template_tag" },
                    { verb: "part_of", targetId: "concept_template_document" },
                    { verb: "enforces", targetId: "concept_template_rule" }
                ]
            },
            {
                id: "concept_template_tag",
                title: "Tag",
                content: "Represents a semantic hub or hashtag used to index and group related units of knowledge.",
                timestamp,
                importance: 80,
                lastUsed: timestamp,
                category: "concept",
                tier: 1,
                scope: "local",
                predicates: [
                    { verb: "associates_with", targetId: "concept_template_tag" }
                ]
            },
            {
                id: "concept_template_document",
                title: "Document",
                content: "Represents an external reference document, web scrape, or research source from which knowledge was extracted.",
                timestamp,
                importance: 80,
                lastUsed: timestamp,
                category: "concept",
                tier: 1,
                scope: "local",
                predicates: [
                    { verb: "contains", targetId: "concept_template_engram" }
                ]
            },
            {
                id: "concept_template_rule",
                title: "Rule",
                content: "Represents an active project constraint, standard, or 'Sovereign Rule' that must be strictly enforced during engineering.",
                timestamp,
                importance: 80,
                lastUsed: timestamp,
                category: "concept",
                tier: 1,
                scope: "local",
                predicates: [
                    { verb: "supersedes", targetId: "concept_template_rule" }
                ]
            },
            {
                id: "concept_template_skill",
                title: "Skill",
                content: "Represents a projected technical capability or Action Protocol imported from the Skills Library.",
                timestamp,
                importance: 80,
                lastUsed: timestamp,
                category: "concept",
                tier: 1,
                scope: "local",
                predicates: [
                    { verb: "enforces", targetId: "concept_template_rule" }
                ]
            }
        ];
    }

    public async resetToDefaultOntology(): Promise<void> {
        const { getLollmsStorageUri } = require('./utils');
        const storageRoot = getLollmsStorageUri(this.context);
        const projectMemoryPath = vscode.Uri.joinPath(storageRoot, 'project_memory.json');

        try {
            const dir = vscode.Uri.joinPath(projectMemoryPath, '..');
            await vscode.workspace.fs.createDirectory(dir);
            // Complete Wipeout: Write empty array to completely clear ABox
            await vscode.workspace.fs.writeFile(projectMemoryPath, Buffer.from('[]', 'utf8'));
            this._cache = []; // Clear in-memory engrams cache
            this._onDidChange.fire(); // Notify listeners to refresh the tree provider
        } catch (e: any) {
            Logger.error("Failed to clear memory vault", e);
            throw e;
        }
    }

    public async getMemories(): Promise<MemoryEntry[]> {
        const { getLollmsStorageUri } = require('./utils');
        const storageRoot = getLollmsStorageUri(this.context);
        const projectMemoryPath = vscode.Uri.joinPath(storageRoot, 'project_memory.json');
        const globalMemoryPath = this.getGlobalMemoryPath();

        let projectEntries: MemoryEntry[] = [];
        let globalEntries: MemoryEntry[] = [];

        // 1. Read Project-specific Memories
        try {
            const content = await vscode.workspace.fs.readFile(projectMemoryPath);
            const data = JSON.parse(Buffer.from(content).toString('utf8'));
            projectEntries = Array.isArray(data) ? data : [];
            projectEntries.forEach(e => e.scope = 'local');
        } catch (error) {
            projectEntries = [];
        }

        if (projectEntries.length === 0) {
            try {
                const dir = vscode.Uri.joinPath(projectMemoryPath, '..');
                await vscode.workspace.fs.createDirectory(dir);
                // Initialize with a clean, empty ABox instance array
                await vscode.workspace.fs.writeFile(projectMemoryPath, Buffer.from('[]', 'utf8'));
            } catch (e) {
                Logger.error("Failed to initialize empty memory vault", e);
            }
        }

        // 2. Read Global Cross-project Memories
        try {
            const content = await vscode.workspace.fs.readFile(globalMemoryPath);
            const data = JSON.parse(Buffer.from(content).toString('utf8'));
            globalEntries = Array.isArray(data) ? data : [];
            globalEntries.forEach(e => e.scope = 'global');
        } catch (error) {
            globalEntries = [];
        }

        let combined = [...projectEntries, ...globalEntries];

        // --- 🛡️ RESILIENT PURGE: ONLY CLEAN AUTOMATED SKILLS, MEANINGLESS TAGS & ALL ONTOLOGY NODES ---
        const originalLength = combined.length;
        combined = combined.filter(m => {
            const id = String(m.id || '');
            // Strictly exclude all schema concept templates from the physical ABox instance context
            if (id.startsWith('concept_template_') || id.startsWith('schema_triplet_')) {
                return false; 
            }
            if (id.startsWith('tag_')) {
                const tagLabel = id.substring(4);
                return isValidSemanticTag(tagLabel);
            }
            return !id.startsWith('skill_') && !id.startsWith('cat_');
        });

        // --- 🧹 ORPHAN TAG PURGE (RESILIENT) ---
        // Identify all tag IDs that are actually referenced by at least one other active node
        const referencedTagIds = new Set<string>();
        combined.forEach(m => {
            if (m.predicates && Array.isArray(m.predicates)) {
                m.predicates.forEach(p => {
                    if (p.targetId && p.targetId.toLowerCase().startsWith('tag_')) {
                        referencedTagIds.add(p.targetId.toLowerCase());
                    }
                });
            }
        });

        // Filter out any tag node that is not referenced by anything (case-insensitive check)
        combined = combined.filter(m => {
            const lowerId = String(m.id || '').toLowerCase();
            if (lowerId.startsWith('tag_') || m.category === 'tag') {
                return referencedTagIds.has(lowerId);
            }
            return true;
        });


        // Self-healing: Strip purely numeric/meaningless/color tags and relations from old memory storage
        combined.forEach(m => {
            if (m.predicates) {
                m.predicates = m.predicates.filter(p => {
                    if (p.verb === 'has_tag' && p.targetId.startsWith('tag_')) {
                        const tagLabel = p.targetId.substring(4);
                        return isValidSemanticTag(tagLabel);
                    }
                    return true;
                });
            }
            if (m.content) {
                m.content = m.content.replace(/#([\w_]+)/g, (match, tag) => {
                    return isValidSemanticTag(tag) ? match : '';
                }).trim();
            }
        });

        let migrated = false;
        combined.forEach(m => {
            if (!m.scope) {
                m.scope = m.id.startsWith('global_') || ['user', 'global'].includes(m.category) ? 'global' : 'local';
                migrated = true;
            }
            if (!m.predicates) {
                m.predicates = [];
                if (m.category) {
                    m.predicates.push({ verb: "categorized_under", targetId: `cat_${m.category}` });
                }
                migrated = true;
            }
        });

        this._cache = combined;

        if (migrated || combined.length !== originalLength) {
            await this.saveEngrams(this._cache);
        }

        return this._cache;
    }

    public async updateMemory(
        action: 'add' | 'update' | 'delete', 
        id: string, 
        title?: string, 
        content?: string, 
        category: string = "general", 
        importance?: number,
        predicates?: MemoryPredicate[],
        scope?: 'global' | 'local'
    ) {
        await this.getMemories();

        // --- IMPORTANCE NORMALIZATION ---
        let finalImportance = importance;
        if (finalImportance !== undefined && finalImportance <= 5.0 && finalImportance > 0) {
            finalImportance = finalImportance * 20; 
        }

        if (action === 'delete') {
            this._cache = this._cache.filter(m => m.id !== id);
            // Cascading deletion of orphan relations
            this._cache.forEach(m => {
                if (m.predicates) {
                    m.predicates = m.predicates.filter(p => p.targetId !== id);
                }
            });
        } else {
            const index = this._cache.findIndex(m => m.id === id);
            const targetContent = content || "";
            let targetPredicates = predicates || [];

            // --- ⚙️ AUTO-WIRING HASHTAG RELATIONS ---
            const tagRegex = /#([\w_]+)/g;
            let match;
            const extractedTags = new Set<string>();
            while ((match = tagRegex.exec(targetContent)) !== null) {
                const tag = match[1].toLowerCase();
                // Enforce meaningful non-numeric tags
                if (isValidSemanticTag(tag)) {
                    extractedTags.add(tag);
                }
            }

            targetPredicates.forEach(p => {
                if (p.verb === 'has_tag' && p.targetId.startsWith('tag_')) {
                    const tagLabel = p.targetId.substring(4).toLowerCase();
                    if (isValidSemanticTag(tagLabel)) {
                        extractedTags.add(tagLabel);
                    }
                }
            });

            // Strip invalid predicates
            targetPredicates = targetPredicates.filter(p => {
                if (p.verb === 'has_tag' && p.targetId.startsWith('tag_')) {
                    const tagLabel = p.targetId.substring(4);
                    return isValidSemanticTag(tagLabel);
                }
                return true;
            });

            extractedTags.forEach(tag => {
                const tagNodeId = `tag_${tag}`;
                if (!targetPredicates.some(p => p.verb === 'has_tag' && p.targetId === tagNodeId)) {
                    targetPredicates.push({ verb: 'has_tag', targetId: tagNodeId });
                }
            });

            // Infer scope: default to global if category is user/global or explicitly requested
            const finalScope = scope || (id.startsWith('global_') || ['user', 'global'].includes(category) ? 'global' : 'local');

            if (index === -1) {
                // ADD or UPSERT
                this._cache.push({
                    id,
                    title: title || id,
                    content: targetContent,
                    timestamp: Date.now(),
                    importance: finalImportance !== undefined ? Math.max(0, Math.min(100, finalImportance)) : 50,
                    lastUsed: Date.now(),
                    category: category,
                    tier: 1,
                    scope: finalScope,
                    predicates: targetPredicates
                });
            } else {
                // UPDATE
                const entry = this._cache[index];
                if (title) entry.title = title;
                entry.content = targetContent;
                entry.predicates = targetPredicates;
                entry.scope = finalScope;

                if (finalImportance !== undefined) {
                    entry.importance = Math.max(0, Math.min(100, finalImportance));
                } else {
                    entry.importance = Math.min(100, (entry.importance || 0) + 10);
                }

                entry.timestamp = Date.now();
                entry.lastUsed = Date.now();
            }

            // Create tag nodes in the same scope
            extractedTags.forEach(tag => {
                const tagNodeId = `tag_${tag}`;
                const tagExists = this._cache.some(m => m.id === tagNodeId);
                if (!tagExists) {
                    this._cache.push({
                        id: tagNodeId,
                        title: `#${tag}`,
                        content: `Shared semantic hub for #${tag} relationships.`,
                        timestamp: Date.now(),
                        importance: 15,
                        lastUsed: Date.now(),
                        category: 'tag',
                        tier: 2,
                        scope: finalScope,
                        predicates: []
                    });
                }
            });
        }

        // 2. Persist to storage
        await this.saveEngrams(this._cache);

        // 3. Notify UI
        this._onDidChange.fire();

        const { ProjectMemoryPanel } = require('./commands/projectMemoryPanel');
        if (ProjectMemoryPanel.currentPanel) {
            (ProjectMemoryPanel.currentPanel as any)._update();
        }
    }

    /**
     * Scans the project structure and common config files to build a "DNA" profile.
     * This makes Lollms smarter than generic indexers.
     */
    public async extractProjectDNA(contextManager: any): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return;

        let dnaContent = "## 🧬 PROJECT DNA (Architectural Standards)\n";
        
        // 1. Detect Stack
        const tree = await contextManager.getContextContent({ includeTree: true });
        dnaContent += `- Structure: \n${tree.projectTree.substring(0, 500)}...\n`;

        // 2. Identify core rules
        await this.updateMemory('add', 'scripting_protocol', 'Clean Scripting Protocol', 'Complex logic must never be executed inline via terminal one-liners. Always generate a script file in .lollms/scripts/ first, then execute it. This prevents shell-escaping and character-encoding failures.', 'standards', 100);

        await this.updateMemory('add', 'asset_usage_protocol', 'User-Provided Assets', 'If the user provides an image or file in the chat, prioritize using `save_chat_image` to persist it to the workspace instead of generating a new one with AI. This preserves user intent and saves tokens.', 'standards', 100);

        await this.updateMemory('add', 'headless_pygame_protocol', 'Headless Testing', 'When working on Pygame projects, DO NOT use `execute_python_script` to run the main game loop, as it will hang in this headless environment. Instead, use `check_python_syntax` or run small isolated logic tests.', 'standards', 100);

        await this.updateMemory('add', 'ui_validation_protocol', 'UI Validation', 'To test User Interfaces, prefer the `interactive_ui_test` tool. This allows the user to perform manual interactions without a timeout. This is the SAFEST way to test complex event loops (Pygame, PyQt, React). If logs are excessive, the system will automatically provide you with a compressed summary.', 'standards', 100);

        await this.updateMemory('add', 'asset_usage_protocol', 'User-Provided Assets', 'If the user provides an image or file in the chat, prioritize using `save_chat_image` to persist it to the workspace instead of generating a new one with AI. This preserves user intent and saves tokens.', 'standards', 100);

        const filesToPeek = ['package.json', 'requirements.txt', 'tsconfig.json', '.eslintrc', 'pyproject.toml'];
        for (const file of filesToPeek) {
            try {
                const uri = vscode.Uri.joinPath(workspaceFolder.uri, file);
                const content = await vscode.workspace.fs.readFile(uri);
                dnaContent += `- Found ${file}: Standard configs extracted.\n`;
            } catch {}
        }

        await this.updateMemory('update', 'project_dna', 'Project DNA & Standards', dnaContent);
    }

    /**
     * CONTEXT-AWARE SEMANTIC OVERLAP ENGINE
     * Dynamically calculates Jaccard overlap between the prompt keywords 
     * and memory engrams to score relevance and hydrate deep memory on-demand.
     */
    public calculateRelevanceScore(engram: MemoryEntry, keywords: string[]): number {
        if (keywords.length === 0) return 0;
        const text = `${engram.title} ${engram.content} ${engram.category}`.toLowerCase();
        let matches = 0;
        keywords.forEach(kw => {
            if (text.includes(kw)) matches++;
        });
        return (matches / keywords.length) * 100;
    }

    /**
     * DOCUMENT CHUNKING ENGINE
     * Surgically splits a long document into attributed chunks and
     * links them to the parent s:Document node to prevent cross-document pollution.
     */
    public async ingestResearchDocument(
        docId: string, 
        title: string, 
        content: string, 
        author?: string, 
        domain?: string
    ): Promise<void> {
        await this.getMemories();

        // 1. Create the parent Document Node
        const cleanDocId = `doc_${docId.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

        // Extract tags from the document body to link the parent to global topics
        const tagRegex = /#([\w_]+)/g;
        let match;
        const documentTags = new Set<string>();
        while ((match = tagRegex.exec(content)) !== null) {
            const tag = match[1].toLowerCase();
            if (isValidSemanticTag(tag)) {
                documentTags.add(tag);
            }
        }

        const docPredicates: MemoryPredicate[] = Array.from(documentTags).map(t => ({
            verb: "has_tag",
            targetId: `tag_${t}`
        }));

        this._cache = this._cache.filter(m => m.id !== cleanDocId && m.metadata?.sourceDocId !== cleanDocId);

        this._cache.push({
            id: cleanDocId,
            title,
            content: `Document Summary: ${title} by ${author || 'Unknown'}. Domain: ${domain || 'General'}. Topics: ${Array.from(documentTags).map(t => `#${t}`).join(', ')}`,
            timestamp: Date.now(),
            importance: 30, // Latent Tier 2
            lastUsed: Date.now(),
            category: 'document',
            scope: 'local',
            predicates: docPredicates,
            metadata: {
                author,
                domain,
                tags: Array.from(documentTags)
            }
        });

        // 2. Split into structured, attributed chunks (Approx 1000 chars per chunk)
        const CHUNK_SIZE = 1000;
        const OVERLAP = 150;
        let chunkIdx = 0;

        for (let i = 0; i < content.length; i += (CHUNK_SIZE - OVERLAP)) {
            const chunkContent = content.substring(i, i + CHUNK_SIZE);
            const chunkId = `${cleanDocId}_chunk_${chunkIdx}`;

            const chunkPredicates: MemoryPredicate[] = [
                { verb: "part_of", targetId: cleanDocId }
            ];

            // Extract tags inside the specific chunk to link it to localized topics
            const chunkTags = new Set<string>();
            let chunkMatch;
            while ((chunkMatch = tagRegex.exec(chunkContent)) !== null) {
                const tag = chunkMatch[1].toLowerCase();
                if (isValidSemanticTag(tag)) {
                    chunkTags.add(tag);
                }
            }
            chunkTags.forEach(t => chunkPredicates.push({ verb: "has_tag", targetId: `tag_${t}` }));

            this._cache.push({
                id: chunkId,
                title: `${title} (Part ${chunkIdx + 1})`,
                content: chunkContent,
                timestamp: Date.now(),
                importance: 20, // Keep in Latent Deep Storage
                lastUsed: Date.now(),
                category: 'chunk',
                scope: 'local',
                predicates: chunkPredicates,
                metadata: {
                    sourceDocId: cleanDocId,
                    chunkIndex: chunkIdx,
                    author,
                    domain,
                    tags: Array.from(chunkTags)
                }
            });

            chunkIdx++;
            if (i + CHUNK_SIZE >= content.length) break;
        }

        await this.saveEngrams(this._cache);
        this._onDidChange.fire();
    }

    /**
     * VIRTUAL SKILL PROJECTION ENGINE
     * Imports all active skills from SkillsManager and projects them
     * as Virtual Memory Nodes inside our Knowledge Graph with on-the-fly
     * hashtag-to-node association.
     */
    public async getProjectedGraph(skillsManager?: any, activeSkillIds?: string[]): Promise<MemoryEntry[]> {
        const engrams = await this.getMemories();

        // Deep copy core engrams to ensure the dynamic projection has zero write-back leakage
        const projected = JSON.parse(JSON.stringify(engrams));

        // --- DYNAMIC TBOX ONTOLOGY PROJECTION ---
        // Project the static TBox concepts (schema templates) dynamically so they appear 
        // in the Ontology View but are never written or saved to the physical project memory file.
        const ontologyConcepts = this.getBootstrapOntology();
        ontologyConcepts.forEach(c => {
            const exists = projected.some((x: any) => x.id === c.id);
            if (!exists) {
                projected.push(c);
            }
        });

        // --- SELF-HEALING TAG PROJECTION ---
        // Scan all engrams for has_tag predicates and project any missing tag nodes dynamically
        const uniqueTags = new Set<string>();
        projected.forEach((m: any) => {
            if (m.predicates && Array.isArray(m.predicates)) {
                m.predicates.forEach((p: any) => {
                    if (p.verb === 'has_tag' && p.targetId.startsWith('tag_')) {
                        const targetId = p.targetId;
                        const tagLabel = targetId.substring(4);
                        if (isValidSemanticTag(tagLabel)) {
                            const exists = projected.some((x: any) => x.id === targetId);
                            if (!exists && !uniqueTags.has(targetId)) {
                                uniqueTags.add(targetId);
                            }
                        }
                    }
                });
            }
        });

        uniqueTags.forEach(tagId => {
            const tagLabel = tagId.substring(4);
            projected.push({
                id: tagId,
                title: `#${tagLabel}`,
                content: `Dynamic semantic hub for #${tagLabel} relationships.`,
                timestamp: Date.now(),
                importance: 15,
                lastUsed: Date.now(),
                category: 'tag',
                tier: 2,
                scope: 'local',
                predicates: []
            });
        });

        // --- SELF-HEALING CATEGORY PROJECTION ---
        // Scan all engrams and project missing category nodes dynamically to resolve parent/folder links
        const uniqueCategories = new Set<string>();
        projected.forEach((m: any) => {
            if (m.category && m.category !== 'tag' && m.category !== 'chunk' && m.category !== 'document' && m.category !== 'concept') {
                uniqueCategories.add(m.category);
            }
        });

        uniqueCategories.forEach(cat => {
            const catNodeId = `cat_${cat}`;
            const exists = projected.some((x: any) => x.id === catNodeId);
            if (!exists) {
                projected.push({
                    id: catNodeId,
                    title: cat.toUpperCase(),
                    content: `Category folder for ${cat} engrams.`,
                    timestamp: Date.now(),
                    importance: 15,
                    lastUsed: Date.now(),
                    category: 'concept', // Style as a TBox concept node
                    tier: 2,
                    scope: 'local',
                    predicates: []
                });
            }
        });

        if (!skillsManager) return projected;

        // Project Skills from SkillsManager (VOLATILE RUNTIME-ONLY PROJECTION)
        try {
            const skills = await skillsManager.getSkills();
            // Filter skills so that only the explicitly selected/active ones are projected
            const activeIds = activeSkillIds || [];
            const filteredSkills = skills.filter((s: any) => activeIds.includes(s.id));

            filteredSkills.forEach((s: any) => {
                const virtId = `skill_${s.id}`;

                const tagRegex = /#([\w_]+)/g;
                let match;
                const predicates: MemoryPredicate[] = [];

                while ((match = tagRegex.exec(s.content)) !== null) {
                    const tag = match[1].toLowerCase();
                    // Enforce meaningful non-numeric tags for skills too
                    if (isValidSemanticTag(tag)) {
                        const tagId = `tag_${tag}`;
                        predicates.push({ verb: "has_tag", targetId: tagId });

                        if (!projected.some(x => x.id === tagId)) {
                            projected.push({
                                id: tagId,
                                title: `#${tag}`,
                                content: `Shared semantic hub for #${tag} relationships.`,
                                timestamp: Date.now(),
                                importance: 15,
                                lastUsed: Date.now(),
                                category: 'tag',
                                scope: 'local',
                                predicates: []
                            });
                        }
                    }
                }

                if (s.category) {
                    predicates.push({ verb: "categorized_under", targetId: `cat_${s.category}` });
                }

                projected.push({
                    id: virtId,
                    title: s.name,
                    content: s.content,
                    timestamp: s.timestamp || Date.now(),
                    importance: 20, 
                    lastUsed: s.timestamp || Date.now(),
                    category: s.category || 'skills',
                    scope: s.scope || 'global',
                    predicates: predicates
                });
            });
        } catch (e) {
            Logger.warn("[Memory] Failed to project skills into Knowledge Graph", e);
        }

        return projected;
    }

    /**
     * TIERED NEURAL MEMORY RECOVERY & HYDRO-COGNITIVE PRE-CALCULATION
     * Hydrates memories using a multi-factorial relevance calculation:
     * S_total = S_keyword + S_spatial + S_temporal + S_recency + S_importance
     */
    public async getFormattedMemoryBlock(userPrompt?: string, skillsManager?: any): Promise<string> {
        // Fetch core engrams
        const engrams = await this.getMemories();
        const affective = await this.getAffectiveMatrix();

        // Extract active concepts and relationship verbs for agent awareness
        const activeConcepts = new Set<string>();
        const activeVerbs = new Set<string>();
        engrams.forEach(e => {
            if (e.category && e.category !== 'tag' && e.category !== 'chunk' && e.category !== 'document') {
                activeConcepts.add(e.category);
            }
            if (e.predicates && Array.isArray(e.predicates)) {
                e.predicates.forEach(p => activeVerbs.add(p.verb));
            }
        });

        const conceptsList = Array.from(activeConcepts).map(c => `s:${c.toUpperCase()}`).join(', ') || 's:GENERAL';
        const verbsList = Array.from(activeVerbs).map(v => `s:${v}`).join(', ') || 's:has_tag';

        // 1. FACTORIAL 1: Temporal / Prompt Keywords (Stemmed lookup)
        const promptKeywords = userPrompt 
            ? userPrompt.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3)
            : [];

        // 2. FACTORIAL 2: Spatial / Active Files in Context
        const activeFiles = this.context.workspaceState.get<any[]>('lollms_active_context_files', []) || [];
        const activePaths = activeFiles.map(f => String(f.path || '').toLowerCase());

        const scoreFactors = engrams.map(e => {
            const cleanContent = e.content.toLowerCase();
            const cleanTitle = e.title.toLowerCase();

            // Factor A: Jaccard Keyword Overlap
            let semanticScore = 0;
            if (promptKeywords.length > 0) {
                const matches = promptKeywords.filter(kw => cleanContent.includes(kw) || cleanTitle.includes(kw)).length;
                semanticScore = (matches / promptKeywords.length) * 45; // Max 45 points
            }

            // Factor B: Spatial File Association
            let spatialScore = 0;
            if (activePaths.length > 0 && e.id) {
                const idClean = e.id.toLowerCase().replace(/_rules|_protocol|_std/g, '');
                const hasPathMatch = activePaths.some(p => p.includes(idClean) || idClean.includes(path.basename(p)));
                if (hasPathMatch) spatialScore = 30; // Max 30 points
            }

            // Factor C: Recency weighting (Preventing long-idle memory bloat)
            const ageDays = (Date.now() - e.lastUsed) / (1000 * 60 * 60 * 24);
            const recencyScore = Math.max(0, 15 - ageDays); // Max 15 points

            // Factor D: Base Retentiveness Weight
            const importanceScore = (e.importance / 100) * 10; // Max 10 points

            const totalScore = semanticScore + spatialScore + recencyScore + importanceScore;

            return { engram: e, score: totalScore };
        });

        // Filter and sort by calculated multi-factorial score
        const sortedEngrams = scoreFactors
            .filter(f => f.score >= 20 || f.engram.importance >= 80) // Safety baseline
            .sort((a, b) => b.score - a.score)
            .map(f => f.engram);

        // Core formatting buffer
        let block = `\n# 🧠 NEURAL MEMORY SYSTEM (KNOWLEDGE GRAPH)\n`;
        block += `[AFFECTIVE MATRIX]: Relationship state is "${affective.label}" (${affective.relationshipScore}/100).\n`;

        block += `\n## 🧊 ACTIVE ONTOLOGY SCHEMA (METADATA CONTEXT)\n`;
        block += `- **Concepts (Classes)**: [ ${conceptsList} ]\n`;
        block += `- **Relationship Verbs (Properties)**: [ ${verbsList} ]\n\n`;
        block += `**AGENT MANDATE**: When recording new architectural engrams or lessons, you MUST align them with the schema above. Categorize under one of the active Concepts, and link related nodes using the available Relationship Verbs. Use this XML format:\n`;
        block += `\`<project_memory action="add" id="unique_id" title="Title" category="concept_name" predicates='[{"verb": "verb_name", "targetId": "target_id"}]'>Fact content...</project_memory>\`\n`;

        // Tier 0: Immutable ROM (Self-Protection & Tool Hygiene)
        block += `\n## TIER 0: IMMUTABLE ROM\n`;
        block += `- Hub Purpose: Sovereign Local Engineering\n`;
        block += `- Protocol: LCP (LoLLMs Communication Protocol) Active\n`;

        // Cognitive budget constraint (Max 2000 tokens / 8000 chars)
        const BUDGET_LIMIT_CHARACTERS = 8000;
        let currentSize = 0;
        const activeEngrams: MemoryEntry[] = [];
        const latentHandles: MemoryEntry[] = [];

        sortedEngrams.forEach(e => {
            const size = e.content.length + e.title.length;
            if (currentSize + size < BUDGET_LIMIT_CHARACTERS) {
                activeEngrams.push(e);
                currentSize += size;
            } else {
                latentHandles.push(e);
            }
        });

        // Add remaining non-matched engrams as latent handles
        engrams.forEach(e => {
            if (!activeEngrams.some(x => x.id === e.id) && !latentHandles.some(x => x.id === e.id)) {
                latentHandles.push(e);
            }
        });

        if (activeEngrams.length > 0) {
            block += `\n## TIER 1: ACTIVE WORKING SUBGRAPH (HYDRATED MEMORIES)\n`;
            activeEngrams.forEach(e => {
                block += `### [${e.category.toUpperCase()}] ${e.title} (${e.id})\n`;
                block += `${e.content}\n`;
                if (e.predicates && e.predicates.length > 0) {
                    block += `**Relationships**:\n`;
                    e.predicates.forEach(p => {
                        const target = engrams.find(x => x.id === p.targetId);
                        block += `- s:${e.id} s:${p.verb} s:${p.targetId} ("${target ? target.title : p.targetId}")\n`;
                    });
                }
                block += `\n`;
            });
        }

        // --- THE HINT LAYER (LATENT GRAPHS PREVENTING BLIND SPARQLS) ---
        if (latentHandles.length > 0) {
            block += `\n## TIER 2: DEEP STORAGE INDEX HANDLES (LATENT GRAPH)\n`;
            block += `Do NOT make blind SPARQL queries. The following specific tags and memory categories exist in deep storage.\n`;
            block += `If you need to query these, write a targeted SPARQL on \`query_architecture\` matching these precise identifiers:\n\n`;

            const tagsList = latentHandles
                .filter(e => e.category === 'tag')
                .map(e => `#${e.title.replace('#', '')}`)
                .join(', ');

            const categoriesMap = new Map<string, string[]>();
            latentHandles.forEach(e => {
                if (e.category !== 'tag') {
                    if (!categoriesMap.has(e.category)) categoriesMap.set(e.category, []);
                    categoriesMap.get(e.category)!.push(e.id);
                }
            });

            if (tagsList) {
                block += `**Available Latent Tags**: [ ${tagsList} ]\n`;
            }

            if (categoriesMap.size > 0) {
                block += `**Available Latent Categories**:\n`;
                for (const [cat, ids] of categoriesMap.entries()) {
                    block += `- **${cat.toUpperCase()}**: [ ${ids.map(id => `s:${id}`).join(', ')} ]\n`;
                }
            }
        }

        return block;
    }
    public async getAffectiveMatrix(): Promise<AffectiveMatrix> {
        const score = this.context.globalState.get<number>('lollms_affective_score', 50);
        let label = "Neutral/Professional";
        if (score > 80) label = "Worship/Respect";
        else if (score > 60) label = "Trusting";
        else if (score < 20) label = "Hostile";
        else if (score < 40) label = "Suspicious";
        return { relationshipScore: score, label };
    }

    /**
     * THE DREAM CYCLE: Reorganizes and consolidates neural connections.
     * 1. Decay: Reduces importance of all engrams.
     * 2. Semantic Clean: Detects and prunes useless process noise.
     * 3. Auto-Tag: Generates connecting hashtags for orphaned engrams.
     * 4. Consolidation: Refreshed engrams stay in T1, others move to T2.
     * 5. Forgetting: Importance 0 is deleted.
     */
    public async performDreamCycle(onProgress?: (event: { type: 'decay' | 'reinforce' | 'archive' | 'forget' | 'fuse' | 'summary', id?: string, title?: string, value?: number, data?: any }) => void): Promise<void> {
        const engrams = await this.getMemories();

        // --- 🧹 INSTANT SEMANTIC HYGIENE PASS ---
        // Strip purely numeric/meaningless tag nodes, tags in text, and relations before starting
        engrams.forEach(e => {
            if (e.predicates) {
                e.predicates = e.predicates.filter(p => {
                    if (p.verb === 'has_tag' && p.targetId.startsWith('tag_')) {
                        const tagLabel = p.targetId.substring(4);
                        return isValidSemanticTag(tagLabel);
                    }
                    return true;
                });
            }
            if (e.content) {
                e.content = e.content.replace(/#([\w_]+)/g, (match, tag) => {
                    return isValidSemanticTag(tag) ? match : '';
                }).trim();
            }
        });

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const lollms = (this as any).lollmsAPI || this.context.extension.exports?.lollmsAPI;

        // Select custom dream model or fall back to main model
        const dreamModel = config.get<string>('dreamModelName') || undefined;

        let decayed = 0, consolidated = 0, forgotten = 0, fused = 0, audited = 0;
        const logs: string[] = [];
        const updatedEngrams: MemoryEntry[] = [];

        // --- PHASE 1: SYSTEMATIC DECAY & SECURITY PURGE ---
        for (const e of engrams) {
            const oldImp = e.importance;
            let decayPenalty = this.DECAY_STEP;

            // Identify transient Process Noise (failure logs/step trackers)
            const isFailureLesson = e.content.toLowerCase().includes('previous attempt') || 
                                   e.content.toLowerCase().includes('failed because') ||
                                   e.title.toLowerCase().includes('lesson');

            const isMetaNoise = e.content.includes('<project_memory') || e.content.includes('<milestone');

            if (isFailureLesson || isMetaNoise) {
                decayPenalty = this.DECAY_STEP * 5;
                if (oldImp < 40) decayPenalty = 100; // Immediate purge
            }

            if (e.importance >= 90) decayPenalty = 0.1; // Rules/Standards are protected

            const newImp = Math.max(0, oldImp - decayPenalty);

            // Determine if this engram is going to be audited in Phase 2
            const wordsCount = e.title ? e.title.split(/\s+/).length : 0;
            const isTooLong = wordsCount > 4 || e.title.length > 25;
            const hasTagLink = e.predicates && e.predicates.some(p => p.verb === 'has_tag');
            const needsAudit = e.category !== 'tag' && (!hasTagLink || isTooLong || e.title.toLowerCase().endsWith('have') || e.title.includes('('));

            // Skip auditing if it was successfully audited within the last 7 days (prevents redundant API calls)
            const wasAuditedRecently = e.lastAudited && (Date.now() - e.lastAudited < 7 * 24 * 60 * 60 * 1000);
            const willBeAudited = needsAudit && !wasAuditedRecently && lollms;

            if (onProgress) {
                if (newImp === 0) {
                    onProgress({ type: 'forget', id: e.id, title: e.title });
                    forgotten++;
                } else if (newImp < this.TIER_THRESHOLD && oldImp >= this.TIER_THRESHOLD) {
                    onProgress({ type: 'archive', id: e.id, title: e.title, value: newImp });
                    consolidated++;
                } else if (!willBeAudited) {
                    // Only log as decayed if it is NOT going to be actively refined/audited by the AI this cycle
                    onProgress({ type: 'decay', id: e.id, title: e.title, value: newImp });
                    decayed++;
                }
                await new Promise(r => setTimeout(r, 60)); // Faster step timing
            }

            if (newImp > 0) {
                updatedEngrams.push({ ...e, importance: newImp });
            }
        }

        // --- PHASE 2: SEMANTIC AUDIT, TITLE RECONSTRUCTION & AUTO-TAGGING FOR ORPHANS/OLD MEMORIES ---
        if (lollms && updatedEngrams.length > 0) {
            const { stripThinkingTags } = require('./utils');

            for (let i = 0; i < updatedEngrams.length; i++) {
                const e = updatedEngrams[i];
                if (e.category === 'tag') continue;

                const hasTagLink = e.predicates && e.predicates.some(p => p.verb === 'has_tag');
                const wordsCount = e.title ? e.title.split(/\s+/).length : 0;

                // Triggers audit if the engram lacks tags, OR has an excessively long/verbose title (> 4 words), OR is grammatically incomplete
                const isTooLong = wordsCount > 4 || e.title.length > 25;
                const needsAudit = !hasTagLink || isTooLong || e.title.toLowerCase().endsWith('have') || e.title.includes('(');

                // Prevent redundant auditing: Skip if audited recently
                const wasAuditedRecently = e.lastAudited && (Date.now() - e.lastAudited < 7 * 24 * 60 * 60 * 1000);

                if (needsAudit && !wasAuditedRecently) {
                    if (onProgress) {
                        onProgress({ type: 'decay', id: e.id, title: `Auditing engram: "${e.title}"...` });
                    }

                    const systemPrompt = `You are the Neural Synaptic Auditor and Ontologist for the Lollms Memory Vault.
Your goal is to maintain the semantic integrity of the knowledge graph by auditing engram nodes according to our **Sovereign Memory Ontology (TBox)**.

### 🧊 SOVEREIGN MEMORY ONTOLOGY (TBox Schema)
Classes (Concepts):
- \`s:Engram\`: Represents an individual unit of captured project knowledge, such as an architectural decision, technical fact, or lesson learned.
- \`s:Tag\`: Represents a semantic hub or hashtag used to index and group related units of knowledge.
- \`s:Document\`: Represents an external reference document, web scrape, or research source.
- \`s:Rule\`: Represents an active project constraint, standard, or 'Sovereign Rule' that must be strictly enforced.
- \`s:Skill\`: Represents a projected technical capability or Action Protocol.

Properties (Relationship Predicates):
- \`s:has_tag\` (Subject: \`s:Engram\` | Object: \`s:Tag\`): Links an engram to a semantic hashtag.
- \`s:part_of\` (Subject: \`s:Engram\` | Object: \`s:Document\`): Indicates an engram was extracted from a document.
- \`s:contains\` (Subject: \`s:Document\` | Object: \`s:Engram\`): Indicates a document contains a nested engram.
- \`s:enforces\` (Subject: \`s:Engram\` or \`s:Skill\` | Object: \`s:Rule\`): Indicates an engram or skill enforces a rule.
- \`s:supersedes\` (Subject: \`s:Rule\` | Object: \`s:Rule\`): Links a new rule replacing an older one.
- \`s:associates_with\` (Subject: \`s:Tag\` | Object: \`s:Tag\`): Connects related topics.

### 🧹 AUDIT & SANITIZATION RULES (CRITICAL)
1. **TAG HYGIENE (STRICT)**: You are STRICTLY FORBIDDEN from using purely numeric, hexadecimal, or meaningless short tags (e.g. #10, #333, #e05, #1a1a2e). 
   - Replace any numeric/meaningless tags with descriptive, actual semantic terms (e.g., #styling, #theme_color, #animation).
   - If a tag is completely unrelated to the engram, remove/sever the relationship.
2. **ONTOLOGICAL ALIGNMENT**: Classify the node category strictly as one of the active TBox Concepts (lowercase: 'concept', 'tag', 'document', 'rules', 'skills').
3. **TITLE CONDENSATION**: Reconstruct verbose/long titles into professional complete titles of 2 to 4 words.

Output ONLY valid JSON matching this format:
{
  "action": "keep" | "delete",
  "new_title": "condensed complete title...",
  "reason": "explanation of decision...",
  "tags": ["#tag1", "#tag2"]
}`;

                    const auditPrompt = `Analyze this memory engram from our project knowledge graph:
ID: "${e.id}"
Title: "${e.title}"
Content: "${e.content}"

Provide your audit verdict based on the TBox schema and sanitization rules.`;

                    try {
                        const response = await lollms.sendChat([
                            { role: 'system', content: systemPrompt },
                            { role: 'user', content: auditPrompt }
                        ], null, undefined, dreamModel, { thinking: false });

                        // Clean and parse thinking tags safely
                        const cleanJson = stripThinkingTags(response).trim().replace(/```json|```/g, '').trim();
                        const verdict = JSON.parse(cleanJson);

                        if (verdict.action === 'delete') {
                            updatedEngrams.splice(i, 1);
                            i--; // Adjust index
                            forgotten++;
                            if (onProgress) onProgress({ type: 'forget', id: e.id, title: `Pruned noise: "${e.title}"` });
                        } else if (verdict.action === 'keep') {
                            // Tag as successfully audited to prevent re-auditing on every cycle
                            e.lastAudited = Date.now();
                            audited++;

                            // Update title if improved title returned
                            if (verdict.new_title && verdict.new_title.trim().length > 0) {
                                e.title = verdict.new_title.trim();
                            }

                            if (Array.isArray(verdict.tags) && verdict.tags.length > 0) {
                                // Filter out purely numeric or meaningless tags from the LLM response
                                const validTags = verdict.tags.filter((t: string) => {
                                    const clean = t.replace('#', '').trim().toLowerCase();
                                    return isValidSemanticTag(clean);
                                });

                                if (validTags.length > 0) {
                                    // Remove old numeric hashtags from content
                                    let targetContent = e.content.replace(/#\d+\b/g, '').trim();
                                    targetContent = targetContent + " " + validTags.join(' ');
                                    e.content = targetContent;

                                    if (!e.predicates) e.predicates = [];
                                    // Remove old numeric predicates
                                    e.predicates = e.predicates.filter(p => {
                                        if (p.verb === 'has_tag' && p.targetId.startsWith('tag_')) {
                                            const tagLabel = p.targetId.substring(4);
                                            return !/^\d+$/.test(tagLabel);
                                        }
                                        return true;
                                    });

                                    validTags.forEach((tag: string) => {
                                        const cleanTag = tag.replace('#', '').toLowerCase().trim();
                                        const tagNodeId = `tag_${cleanTag}`;

                                        if (!e.predicates!.some(p => p.verb === 'has_tag' && p.targetId === tagNodeId)) {
                                            e.predicates!.push({ verb: 'has_tag', targetId: tagNodeId });
                                        }

                                        // Inject tag hub if missing
                                        const tagExists = updatedEngrams.some(x => x.id === tagNodeId);
                                        if (!tagExists) {
                                            updatedEngrams.push({
                                                id: tagNodeId,
                                                title: `#${cleanTag}`,
                                                content: `Shared semantic hub for #${cleanTag} relationships.`,
                                                timestamp: Date.now(),
                                                importance: 15,
                                                lastUsed: Date.now(),
                                                category: 'tag',
                                                tier: 2,
                                                scope: e.scope,
                                                predicates: []
                                            });
                                        }
                                    });
                                    if (onProgress) onProgress({ type: 'decay', id: e.id, title: `Audited & Wired tags: "${e.title}" [${validTags.join(', ')}]` });
                                }
                            }
                        }
                    } catch (err) {
                        Logger.warn(`Surgical Dream Audit failed for ${e.id}:`, err);
                    }
                }
            }
        }

        // --- PHASE 3: SYNAPTIC FUSION (AI CONSOLIDATION) ---
        const lessons = updatedEngrams.filter(e => e.title.toLowerCase().includes('lesson') || e.content.toLowerCase().includes('failed because'));

        if (lollms && lessons.length >= 2) {
            if (onProgress) onProgress({ type: 'fuse', title: "Consolidating Failure Patterns..." });

            const fusionPrompt = `You are the Neural Architect. Consolidate these redundant technical lessons into a single, high-density "Sovereign Rule". 
            - Strip all narrative fluff ("Previous attempt failed", "The model should").
            - Use clear, imperative technical language.
            - Keep the importance high.

            LESSONS TO MERGE:
            ${lessons.map(l => `- [${l.title}]: ${l.content}`).join('\n')}

            OUTPUT FORMAT: JSON only: {"title": "Sovereign Rule: [Topic]", "content": "..."}`;

            try {
                const response = await lollms.sendChat([
                    { role: 'system', content: "You are a JSON-only synaptic organizer. Output only JSON." }
                ], null, undefined, dreamModel, { thinking: false });

                const result = JSON.parse(stripThinkingTags(response).replace(/```json|```/g, ''));

                const newId = 'rule_' + Date.now();
                updatedEngrams.push({
                    id: newId,
                    title: result.title,
                    content: result.content,
                    timestamp: Date.now(),
                    importance: 95, 
                    lastUsed: Date.now(),
                    category: "rules",
                    tier: 1,
                    scope: 'local',
                    origin: 'architect'
                });

                lessons.forEach(l => {
                    const idx = updatedEngrams.findIndex(ue => ue.id === l.id);
                    if (idx !== -1) updatedEngrams.splice(idx, 1);
                });

                fused = lessons.length;
                if (onProgress) onProgress({ type: 'fuse', title: `Fused ${fused} lessons into 1 Rule: "${result.title}"` });
            } catch (err) {
                console.error("Fusion failed", err);
            }
        }

        // --- ORPHANED TAG PURGER ---
        // Find all tags actually referenced by active engrams in the final array
        const referencedTagIdsInDream = new Set<string>();
        updatedEngrams.forEach(m => {
            if (m.predicates && Array.isArray(m.predicates)) {
                m.predicates.forEach(p => {
                    if (p.verb === 'has_tag' && p.targetId.startsWith('tag_')) {
                        referencedTagIdsInDream.add(p.targetId.toLowerCase());
                    }
                });
            }
        });

        // Filter out any tag node that is completely orphaned (no incoming has_tag relationships)
        const finalCleanedEngrams = updatedEngrams.filter(m => {
            const lowerId = String(m.id || '').toLowerCase();
            if (lowerId.startsWith('tag_') || m.category === 'tag') {
                return referencedTagIdsInDream.has(lowerId);
            }
            return true;
        });

        // Save back and instantly update active in-memory cache
        await this.saveEngrams(finalCleanedEngrams);
        this._cache = finalCleanedEngrams;

        const summary = { decayed, consolidated, forgotten, fused, audited, total: finalCleanedEngrams.length };
        if (onProgress) onProgress({ type: 'summary', data: summary });

        await this.context.workspaceState.update('lollms_dream_log', {
            timestamp: Date.now(),
            events: logs
        });
    }

    private async saveEngrams(engrams: MemoryEntry[]) {
        const { getLollmsStorageUri } = require('./utils');
        const storageRoot = getLollmsStorageUri(this.context);
        const projectMemoryPath = vscode.Uri.joinPath(storageRoot, 'project_memory.json');
        const globalMemoryPath = this.getGlobalMemoryPath();

        // Partition engrams by scope
        const projectEngrams = engrams.filter(e => e.scope !== 'global');
        const globalEngrams = engrams.filter(e => e.scope === 'global');

        // 1. Save Project-specific Memories
        try {
            const projectBuffer = Buffer.from(JSON.stringify(projectEngrams, null, 2), 'utf8');
            const dir = vscode.Uri.joinPath(projectMemoryPath, '..');
            await vscode.workspace.fs.createDirectory(dir);
            await vscode.workspace.fs.writeFile(projectMemoryPath, projectBuffer);
        } catch (e) {
            Logger.error("Failed to save project neural engrams", e);
        }

        // 2. Save Global Cross-project Memories
        try {
            const globalBuffer = Buffer.from(JSON.stringify(globalEngrams, null, 2), 'utf8');
            const dir = vscode.Uri.joinPath(globalMemoryPath, '..');
            await vscode.workspace.fs.createDirectory(dir);
            await vscode.workspace.fs.writeFile(globalMemoryPath, globalBuffer);
        } catch (e) {
            Logger.error("Failed to save global neural engrams", e);
        }
    }

    /**
     * REINFORCEMENT PROTOCOL
     * Resets the decay timer and gives a +5 boost to importance.
     * Block decay by moving the lastUsed to 'now'.
     */
    public async reinforceEngram(id: string): Promise<void> {
        const engrams = await this.getMemories();
        const index = engrams.findIndex(e => e.id === id);
        
        if (index !== -1) {
            engrams[index].lastUsed = Date.now();
            engrams[index].importance = Math.min(100, engrams[index].importance + 5);
            await this.saveEngrams(engrams);
            Logger.info(`Memory Reinforcement: '${id}' refreshed. Decay blocked.`);
        }
    }

    /**
     * Scans text for <project_memory> tags and performs the requested actions.
     */
    public async processTags(content: string): Promise<void> {
        // Exclude markdown code blocks before processing
        const cleanContent = content.replace(/```[\s\S]*?```|`[^`\n\r]+`/g, '');
        const memoryRegex = /^[ \t]*<project_memory\s+([^>]*?)>([\s\S]*?)<\/project_memory>/gim;
        let match;
        while ((match = memoryRegex.exec(cleanContent)) !== null) {
            const attrStr = match[1];
            const memoryContent = match[2].trim();
            const attrs: any = {};

            const attrRegex = /(\w+)\s*=\s*["']([^"']*)["']/g;
            let m;
            while ((m = attrRegex.exec(attrStr)) !== null) {
                attrs[m[1]] = m[2];
            }

            const { action, id, title, importance, category, predicates } = attrs;
            if (action && id) {
                const imp = importance ? parseFloat(importance) : 1.0;

                let parsedPreds = undefined;
                if (predicates) {
                    try {
                        // Unescape any XML quotes before parsing JSON
                        const cleanJson = predicates.replace(/&quot;/g, '"').replace(/&apos;/g, "'");
                        parsedPreds = JSON.parse(cleanJson);
                    } catch (e) {
                        Logger.warn("Failed to parse predicates from project_memory tag", e);
                    }
                }

                await this.updateMemory(
                    action as any, 
                    id, 
                    title || id, 
                    memoryContent, 
                    category || "general", 
                    imp,
                    parsedPreds
                );
            }
        }
    }
}