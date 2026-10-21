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
    origin?: 'architect' | 'agent' | 'user' | 'system'; // Track who created the engram
    predicates?: MemoryPredicate[]; // Upgraded Graph Relationship links
    lastAudited?: number; // Timestamp of last successful AI semantic audit

    // --- EPISODIC CONTEXT ANCHORS ---
    discussionId?: string;       // Causal chat session ID where this was learned
    triggerPrompt?: string;      // The specific user prompt/error that caused this write
    historicalLog?: string[];    // Chronological trail: ["Date: Created...", "Date: Refined..."]

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
        let projectFileExists = false;
        try {
            await vscode.workspace.fs.stat(projectMemoryPath);
            projectFileExists = true;
        } catch {}

        if (projectFileExists) {
            try {
                const content = await vscode.workspace.fs.readFile(projectMemoryPath);
                const data = JSON.parse(Buffer.from(content).toString('utf8'));
                projectEntries = Array.isArray(data) ? data : [];
                projectEntries.forEach(e => e.scope = 'local');
            } catch (error: any) {
                Logger.error(`Failed to read or parse project_memory.json: ${error.message}`);
                // Restore in-memory cache to prevent writing an empty state over a corrupt file
                projectEntries = this._cache.filter(e => e.scope !== 'global');
            }
        } else {
            try {
                const dir = vscode.Uri.joinPath(projectMemoryPath, '..');
                await vscode.workspace.fs.createDirectory(dir);
                // Initialize with a clean, empty ABox instance array ONLY if the file did not exist
                await vscode.workspace.fs.writeFile(projectMemoryPath, Buffer.from('[]', 'utf8'));
                projectEntries = [];
            } catch (e) {
                Logger.error("Failed to initialize empty memory vault", e);
            }
        }

        // 2. Read Global Cross-project Memories
        let globalFileExists = false;
        try {
            await vscode.workspace.fs.stat(globalMemoryPath);
            globalFileExists = true;
        } catch {}

        if (globalFileExists) {
            try {
                const content = await vscode.workspace.fs.readFile(globalMemoryPath);
                const data = JSON.parse(Buffer.from(content).toString('utf8'));
                globalEntries = Array.isArray(data) ? data : [];
                globalEntries.forEach(e => e.scope = 'global');
            } catch (error: any) {
                Logger.error(`Failed to read or parse global_memory.json: ${error.message}`);
                globalEntries = this._cache.filter(e => e.scope === 'global');
            }
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

    /**
     * Fast Heuristic-Based Belief Inconsistency Resolver (Zero Background LLM Queries)
     * Uses TF-IDF cosine similarity and hashtag overlap to detect exact/near duplicate engrams
     * in microseconds without stalling the user or wasting token generations.
     */
    private resolveBeliefInconsistency(
        candidateId: string,
        candidateTitle: string,
        candidateContent: string,
        _candidateCategory: string,
        _scope: 'local' | 'global',
        _activeDiscussionId: string,
        _activeTriggerPrompt: string
    ): { action: 'add' | 'update' | 'supersede' | 'none'; targetId?: string; mergedContent?: string; mergedTitle?: string } {
        if (this._cache.length === 0) {
            return { action: 'add' };
        }

        const cleanCandText = `${candidateTitle} ${candidateContent}`.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
        const candWords = new Set(cleanCandText.split(/\s+/).filter(w => w.length > 2));

        if (candWords.size === 0) {
            return { action: 'add' };
        }

        for (const existing of this._cache) {
            if (existing.id === candidateId || existing.category === 'tag' || existing.category === 'concept' || existing.category === 'chunk') {
                continue;
            }

            const cleanExistText = `${existing.title} ${existing.content}`.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
            const existWords = new Set(cleanExistText.split(/\s+/).filter(w => w.length > 2));
            if (existWords.size === 0) continue;

            // Calculate Jaccard similarity
            let intersection = 0;
            candWords.forEach(w => {
                if (existWords.has(w)) intersection++;
            });

            const union = new Set([...candWords, ...existWords]).size;
            const jaccard = union > 0 ? intersection / union : 0;

            // Exact or near-duplicate (> 85% overlap)
            if (jaccard > 0.85) {
                return { action: 'none', targetId: existing.id };
            }

            // High overlap on the same specific topic (> 65% overlap) -> Update/Refine in place
            if (jaccard > 0.65) {
                return {
                    action: 'update',
                    targetId: existing.id,
                    mergedTitle: candidateTitle.length > existing.title.length ? candidateTitle : existing.title,
                    mergedContent: `${existing.content}\n\n[Updated]: ${candidateContent}`
                };
            }
        }

        return { action: 'add' };
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

        // Normalize importance values
        let finalImportance = importance !== undefined ? importance : 90;
        if (finalImportance <= 5.0 && finalImportance > 0) {
            finalImportance = finalImportance * 20; 
        }
        finalImportance = Math.max(0, Math.min(100, finalImportance));

        const finalScope = scope || (id.startsWith('global_') || ['user', 'global'].includes(category) ? 'global' : 'local');

        if (action === 'delete') {
            this._cache = this._cache.filter(m => m.id !== id);
            this._cache.forEach(m => {
                if (m.predicates) {
                    m.predicates = m.predicates.filter(p => p.targetId !== id);
                }
            });
        } else {
            const targetContent = content || "";
            let targetPredicates = predicates || [];

            // --- ⚙️ AUTO-WIRING HASHTAG RELATIONS ---
            const tagRegex = /#([\w_]+)/g;
            let match;
            const extractedTags = new Set<string>();
            while ((match = tagRegex.exec(targetContent)) !== null) {
                const tag = match[1].toLowerCase();
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

            // Strip invalid tag predicates
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

            // --- DYNAMIC EPISODIC ANCHORS RECOVERY ---
            const { ChatPanel } = require('./commands/chatPanel/chatPanel');
            const activePanel = ChatPanel.currentPanel;
            const activeDiscussion = activePanel?.getCurrentDiscussion();
            const activeDiscussionId = activeDiscussion?.id || "unspecified_chat_session";

            // Extract the last prompt message text as the episodic trigger
            const lastMessageObj = activeDiscussion?.messages ? [...activeDiscussion.messages].reverse().find(m => m.role === 'user') : null;
            const activeTriggerPrompt = lastMessageObj 
                ? (typeof lastMessageObj.content === 'string' ? lastMessageObj.content : 'Multi-modal instruction')
                : 'Manual user creation';

            const originRole = lastMessageObj ? 'agent' : 'user';

            // --- LIVE BELIEF REVISION CHECK (AUDN Gating) ---
            let finalId = id;
            let finalTitle = title || id;
            let finalWriteContent = targetContent;
            let currentHistoricalLog: string[] = [];

            if (action === 'add') {
                // Instant heuristic consistency resolution (zero background LLM requests)
                const audit = this.resolveBeliefInconsistency(id, finalTitle, targetContent, category, finalScope, activeDiscussionId, activeTriggerPrompt);

                if (audit.action === 'none') {
                    Logger.info(`[Belief Revision] Ignored redundant memory addition: "${finalTitle}"`);
                    return; // Short-circuit, ignore write
                }

                if (audit.action === 'update' && audit.targetId) {
                    finalId = audit.targetId;
                    finalTitle = audit.mergedTitle || finalTitle;
                    finalWriteContent = audit.mergedContent || finalWriteContent;
                    action = 'update';
                    Logger.info(`[Belief Revision] Refined existing engram node '${finalId}' with new information.`);
                }
            }

            const index = this._cache.findIndex(m => m.id === finalId);

            if (index === -1) {
                // ADD (Fresh Episodic Creation)
                currentHistoricalLog = [
                    `[${new Date().toISOString()}] Created as ${category} engram in session ${activeDiscussionId} by ${originRole}. Trigger: "${activeTriggerPrompt.substring(0, 50)}..."`
                ];

                this._cache.push({
                    id: finalId,
                    title: finalTitle,
                    content: finalWriteContent,
                    timestamp: Date.now(),
                    importance: finalImportance,
                    lastUsed: Date.now(),
                    category: category,
                    tier: 1,
                    scope: finalScope,
                    origin: originRole,
                    discussionId: activeDiscussionId,
                    triggerPrompt: activeTriggerPrompt,
                    historicalLog: currentHistoricalLog,
                    predicates: targetPredicates
                });
            } else {
                // UPDATE (Episodic Refinement)
                const entry = this._cache[index];
                entry.title = finalTitle;
                entry.content = finalWriteContent;
                entry.predicates = targetPredicates;
                entry.scope = finalScope;
                entry.importance = Math.max(entry.importance, finalImportance); // Preserve/boost highest importance
                entry.timestamp = Date.now();
                entry.lastUsed = Date.now();

                // Append the refinement action to the node's historical episodic log
                if (!entry.historicalLog) entry.historicalLog = [];
                entry.historicalLog.push(
                    `[${new Date().toISOString()}] Refined in session ${activeDiscussionId}. Causal prompt: "${activeTriggerPrompt.substring(0, 50)}..."`
                );
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
     * TIERED NEURAL MEMORY RECOVERY: FAST HEURISTIC-BASED TF-IDF & HASHTAG ENGINE
     * Hydrates memories strictly using local term frequencies, hashtag indexing, and keyword overlap.
     * Zero background LLM queries: runs in microseconds.
     * Returns a formatted block packaged inside a collapsible details tag (collapsed by default).
     */
    public async getFormattedMemoryBlock(userPrompt?: string, _skillsManager?: any): Promise<string> {
        const engrams = await this.getMemories();
        if (engrams.length === 0) return "";

        // Extract prompt hashtag tags (#tag) and keywords (> 2 chars)
        const promptTags = new Set<string>();
        const promptWords = new Set<string>();

        if (userPrompt) {
            const tagRegex = /#([\w_]+)/g;
            let m;
            while ((m = tagRegex.exec(userPrompt)) !== null) {
                promptTags.add(m[1].toLowerCase());
            }

            const cleanWords = userPrompt.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
            cleanWords.forEach(w => promptWords.add(w));
        }

        // Active workspace files
        const activeFiles = this.context.workspaceState.get<any[]>('lollms_active_context_files', []) || [];
        const activePaths = activeFiles.map(f => String(f.path || '').toLowerCase());

        // Fast TF-IDF / hashtag heuristic score per engram
        const scored = engrams.map(e => {
            if (e.category === 'concept' && e.id.startsWith('concept_template_')) {
                return { engram: e, score: 0 };
            }

            let score = 0;
            const titleLower = e.title.toLowerCase();
            const contentLower = e.content.toLowerCase();
            const categoryLower = e.category.toLowerCase();

            // 1. Direct Hashtag Match (+50 points)
            if (e.predicates && Array.isArray(e.predicates)) {
                for (const p of e.predicates) {
                    if (p.verb === 'has_tag' && p.targetId.startsWith('tag_')) {
                        const tag = p.targetId.substring(4).toLowerCase();
                        if (promptTags.has(tag)) score += 50;
                    }
                }
            }

            // 2. Term Overlap
            promptWords.forEach(w => {
                if (titleLower.includes(w)) score += 15;
                if (contentLower.includes(w)) score += 5;
                if (categoryLower.includes(w)) score += 10;
            });

            // 3. Spatial File Match (+25 points)
            if (activePaths.length > 0 && e.id) {
                const idClean = e.id.toLowerCase().replace(/_rules|_protocol|_std/g, '');
                if (activePaths.some(p => p.includes(idClean) || idClean.includes(path.basename(p)))) {
                    score += 25;
                }
            }

            // 4. Base Importance weight (Max 10 points)
            score += (e.importance / 100) * 10;

            return { engram: e, score };
        });

        // Retain matching engrams or high-importance permanent standards (>= 90)
        const matched = scored
            .filter(s => s.score >= 25 || s.engram.importance >= 90)
            .sort((a, b) => b.score - a.score)
            .slice(0, 8) // Limit to top 8 most relevant engrams to prevent context bloat
            .map(s => s.engram);

        if (matched.length === 0) return "";

        let memoryLines = "";
        matched.forEach(e => {
            memoryLines += `- **[${e.category.toUpperCase()}] ${e.title}**: ${e.content}\n`;
        });

        // Present cleanly inside a standard collapsible markdown block (collapsed by default)
        return `
<details class="memory-hydration-block">
<summary>🧠 <b>Hydrated Neural Memories & Standards (${matched.length} engrams matched)</b></summary>

${memoryLines.trim()}
</details>
`.trim();
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

        // --- PHASE 2: LOCAL DETERMINISTIC HYGIENE (ZERO INVISIBLE BACKGROUND LLM GENERATIONS) ---
        // We clean hashtags and prune noise deterministically without wasting any LLM queries.
        for (let i = 0; i < updatedEngrams.length; i++) {
            const e = updatedEngrams[i];
            if (e.category === 'tag') continue;

            // Extract tags directly from content
            const tagRegex = /#([\w_]+)/g;
            let m;
            const validTags: string[] = [];
            while ((m = tagRegex.exec(e.content)) !== null) {
                const tag = m[1].toLowerCase();
                if (isValidSemanticTag(tag) && !validTags.includes(tag)) {
                    validTags.push(tag);
                }
            }

            if (!e.predicates) e.predicates = [];

            // Wire tags deterministically
            validTags.forEach(tag => {
                const tagNodeId = `tag_${tag}`;
                if (!e.predicates!.some(p => p.verb === 'has_tag' && p.targetId === tagNodeId)) {
                    e.predicates!.push({ verb: 'has_tag', targetId: tagNodeId });
                }

                const tagExists = updatedEngrams.some(x => x.id === tagNodeId);
                if (!tagExists) {
                    updatedEngrams.push({
                        id: tagNodeId,
                        title: `#${tag}`,
                        content: `Shared semantic hub for #${tag} relationships.`,
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
        }

        // --- PHASE 3: EPISODIC SYNAPTIC FUSION (AI CONSOLIDATION) ---
        if (lollms && updatedEngrams.length >= 2) {
            if (onProgress) onProgress({ type: 'fuse', title: "Analyzing semantic duplicates (Vectorization)..." });

            // 1. Pure-JS TF-IDF Vectorizer & Cosine Similarity Engine
            const stopwords = new Set(['and', 'the', 'for', 'with', 'this', 'that', 'from', 'your', 'will', 'have', 'been', 'should', 'always']);

            const tokenize = (text: string): string[] => {
                return text.toLowerCase()
                    .replace(/[^a-z0-9\s]/g, ' ')
                    .split(/\s+/)
                    .filter(w => w.length > 2 && !stopwords.has(w));
            };

            const documents = updatedEngrams.map(e => ({
                id: e.id,
                terms: tokenize(`${e.title} ${e.content}`)
            }));

            // Calculate Document Frequencies (DF)
            const df: Record<string, number> = {};
            documents.forEach(doc => {
                const uniqueTerms = new Set(doc.terms);
                uniqueTerms.forEach(term => {
                    df[term] = (df[term] || 0) + 1;
                });
            });

            // Calculate TF-IDF Vectors
            const N = documents.length;
            const vectors = documents.map(doc => {
                const tf: Record<string, number> = {};
                doc.terms.forEach(t => tf[t] = (tf[t] || 0) + 1);

                const tfIdf: Record<string, number> = {};
                let magnitudeSq = 0;

                Object.entries(tf).forEach(([term, count]) => {
                    const tfVal = count / doc.terms.length;
                    const idfVal = Math.log(1 + (N / (1 + (df[term] || 0))));
                    const weight = tfVal * idfVal;
                    tfIdf[term] = weight;
                    magnitudeSq += weight * weight;
                });

                return {
                    id: doc.id,
                    tfIdf,
                    magnitude: Math.sqrt(magnitudeSq)
                };
            });

            // 2. Pairwise Cosine Similarity Check
            const similarityThreshold = 0.78; // Sensitive threshold to catch "Pathlib Over OS" duplicates
            const redundantPairs: [MemoryEntry, MemoryEntry, number][] = [];

            for (let i = 0; i < vectors.length; i++) {
                for (let j = i + 1; j < vectors.length; j++) {
                    const vA = vectors[i];
                    const vB = vectors[j];
                    if (vA.magnitude === 0 || vB.magnitude === 0) continue;

                    // Dot Product
                    let dotProduct = 0;
                    Object.entries(vA.tfIdf).forEach(([term, weight]) => {
                        if (vB.tfIdf[term]) {
                            dotProduct += weight * vB.tfIdf[term];
                        }
                    });

                    const cosineSim = dotProduct / (vA.magnitude * vB.magnitude);

                    if (cosineSim >= similarityThreshold) {
                        const engramA = updatedEngrams.find(e => e.id === vA.id);
                        const engramB = updatedEngrams.find(e => e.id === vB.id);
                        // Skip if one of them is a system concept template
                        if (engramA && engramB && !engramA.id.startsWith('concept_template') && !engramB.id.startsWith('concept_template')) {
                            redundantPairs.push([engramA, engramB, cosineSim]);
                        }
                    }
                }
            }

            // 3. AI-Guided Fusion Loop
            for (const [engramA, engramB, similarity] of redundantPairs) {
                // Ensure both still exist in our active array (they might have been merged in a previous iteration)
                const idxA = updatedEngrams.findIndex(e => e.id === engramA.id);
                const idxB = updatedEngrams.findIndex(e => e.id === engramB.id);
                if (idxA === -1 || idxB === -1) continue;

                // Chronological resolution: Find which engram is newer based on its timestamp
                const newerEngram = engramA.timestamp >= engramB.timestamp ? engramA : engramB;
                const olderEngram = engramA.timestamp < engramB.timestamp ? engramA : engramB;

                if (onProgress) {
                    onProgress({ 
                        type: 'fuse', 
                        title: `Evaluating duplicate: "${engramA.title}" vs "${engramB.title}" (Sim: ${Math.round(similarity * 100)}%) - Chronological Preference: "${newerEngram.title}"` 
                    });
                }

                const fusionPrompt = `You are the Neural Synaptic Architect. We have identified two highly similar memory engrams in our project graph representing redundant or overlapping facts.
Your goal is to perform a detailed semantic audit to merge them.

### 🕒 CHRONOLOGICAL MATRIX (IMPORTANT):
- **NEWER ENGRAM (More likely to contain correct, updated or refined facts)**:
  ID: "${newerEngram.id}"
  Title: "${newerEngram.title}"
  Content: "${newerEngram.content}"
  Timestamp: ${newerEngram.timestamp} (${new Date(newerEngram.timestamp).toLocaleString()})
  Category: "${newerEngram.category}"

- **OLDER ENGRAM (Might contain outdated or superseded constraints)**:
  ID: "${olderEngram.id}"
  Title: "${olderEngram.title}"
  Content: "${olderEngram.content}"
  Timestamp: ${olderEngram.timestamp} (${new Date(olderEngram.timestamp).toLocaleString()})
  Category: "${olderEngram.category}"

**INSTRUCTIONS:**
1. If they are NOT redundant and cover distinct, separate concepts, return {"is_duplicate": false}.
2. If they are redundant, return {"is_duplicate": true}.
3. **CHRONOLOGICAL OVERRIDE**: You MUST let the facts in the **NEWER ENGRAM** override or refine any outdated or conflicting facts in the **OLDER ENGRAM**. 
4. Produce a single consolidated, extremely cohesive engram that merges all facts, standards, and hashtags from both while prioritizing the latest rules.
5. Keep the most descriptive ID (or select a clean, lowercase merged ID).
6. Output valid JSON only inside a code block.

**OUTPUT FORMAT:**
\`\`\`json
{
  "is_duplicate": true,
  "keep_id": "the_id_to_keep",
  "delete_id": "the_id_to_delete",
  "title": "Consolidated Title",
  "content": "Consolidated fact body... #merged_tags",
  "category": "standards" | "rules" | "user" | "general"
}
\`\`\``;

                try {
                    const response = await lollms.sendChat([
                        { role: 'system', content: "You are a JSON-only synaptic organizer. Output only JSON." },
                        { role: 'user', content: fusionPrompt }
                    ], null, undefined, dreamModel, { thinking: false });

                    const cleanJson = stripThinkingTags(response).replace(/```json|```/g, '').trim();
                    const result = JSON.parse(cleanJson);

                    if (result.is_duplicate === true) {
                        const keepId = result.keep_id;
                        const deleteId = result.delete_id;

                        const targetKeepIdx = updatedEngrams.findIndex(e => e.id === keepId);
                        const targetDeleteIdx = updatedEngrams.findIndex(e => e.id === deleteId);

                        if (targetKeepIdx !== -1 && targetDeleteIdx !== -1) {
                            const engramToKeep = updatedEngrams[targetKeepIdx];
                            const engramToDelete = updatedEngrams[targetDeleteIdx];

                            // 🧬 CONSOLIDATE RELATIONSHIPS (PREDICATES)
                            // Merge all relationship links from both engrams, avoiding duplicates
                            const mergedPredicates = [...(engramToKeep.predicates || [])];

                            (engramToDelete.predicates || []).forEach(p => {
                                // Do not copy self-referential relations
                                if (p.targetId === keepId) return;

                                const exists = mergedPredicates.some(kp => kp.verb === p.verb && kp.targetId === p.targetId);
                                if (!exists) {
                                    mergedPredicates.push(p);
                                }
                            });

                            // Re-wire any other nodes pointing to the deleted ID to point to the kept ID
                            updatedEngrams.forEach(e => {
                                if (e.predicates) {
                                    e.predicates.forEach(p => {
                                        if (p.targetId === deleteId) {
                                            p.targetId = keepId;
                                        }
                                    });
                                }
                            });

                            // --- EPISODIC LOG MERGER ---
                            // Fuse the chronological records of both engrams into a single coherent timeline
                            const keepLog = engramToKeep.historicalLog || [];
                            const deleteLog = engramToDelete.historicalLog || [];
                            const mergedLog = [...keepLog, ...deleteLog];

                            // Sort logs chronologically by extracting ISO-timestamp prefix if possible
                            mergedLog.sort((a, b) => {
                                const matchA = a.match(/\[(.*?)\]/);
                                const matchB = b.match(/\[(.*?)\]/);
                                if (matchA && matchB) {
                                    return new Date(matchA[1]).getTime() - new Date(matchB[1]).getTime();
                                }
                                return 0;
                            });

                            mergedLog.push(`[${new Date().toISOString()}] Consolidated/Fused duplicate engram '${deleteId}' into '${keepId}' during Dream Cycle.`);

                            // Update the kept node with merged text, relationships, and history
                            engramToKeep.title = result.title;
                            engramToKeep.content = result.content;
                            engramToKeep.category = result.category;
                            engramToKeep.predicates = mergedPredicates;
                            engramToKeep.historicalLog = mergedLog;
                            engramToKeep.importance = Math.min(100, Math.max(engramToKeep.importance, engramToDelete.importance) + 5); // Boost importance on fusion
                            // Update timestamp and lastUsed to match the newest parent for accurate decay calculations
                            engramToKeep.timestamp = Math.max(engramToKeep.timestamp, engramToDelete.timestamp);
                            engramToKeep.lastUsed = Math.max(engramToKeep.lastUsed, engramToDelete.lastUsed);

                            // Remove the deleted node from memory
                            updatedEngrams.splice(targetDeleteIdx, 1);

                            fused++;
                            if (onProgress) {
                                onProgress({ 
                                    type: 'fuse', 
                                    title: `🧬 Fused Synapses: "${engramToDelete.title}" merged into "${result.title}"` 
                                });
                            }
                        }
                    }
                } catch (err) {
                    console.error("Synaptic fusion failed", err);
                }
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
                        const rawPreds = JSON.parse(cleanJson);
                        if (Array.isArray(rawPreds)) {
                            // SELF-HEALING: Strip redundant s: prefix hallucinations from AI output
                            parsedPreds = rawPreds.map((p: any) => ({
                                verb: (p.verb || '').replace(/^s:/i, '').trim(),
                                targetId: (p.targetId || '').replace(/^s:/i, '').trim()
                            }));
                        }
                    } catch (e) {
                        Logger.warn("Failed to parse predicates from project_memory tag", e);
                    }
                }

                // Strip leading s: from the main id too if it snuck in
                const cleanId = id.replace(/^s:/i, '').trim();

                await this.updateMemory(
                    action as any, 
                    cleanId, 
                    title || cleanId, 
                    memoryContent, 
                    category || "general", 
                    imp,
                    parsedPreds
                );
            }
        }
    }
}