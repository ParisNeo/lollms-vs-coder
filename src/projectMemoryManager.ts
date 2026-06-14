import * as vscode from 'vscode';
import * as path from 'path';
import { Logger } from './logger';

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

    constructor(private context: vscode.ExtensionContext) {}

    public async switchWorkspace(folder: vscode.Uri) {
        // We now handle all workspace folders dynamically
        await this.getMemories(); // Pre-load cache
        this._onDidChange.fire();
    }

    private _cache: MemoryEntry[] =[];

    public async getMemories(): Promise<MemoryEntry[]> {
        const { getLollmsStorageUri } = require('./utils');
        const storageRoot = getLollmsStorageUri(this.context);
        const memoryPath = vscode.Uri.joinPath(storageRoot, 'project_memory.json');

        try {
            const content = await vscode.workspace.fs.readFile(memoryPath);
            const data = JSON.parse(Buffer.from(content).toString('utf8'));
            let rawEntries = Array.isArray(data) ? data : [];
            
            // --- 🛡️ RESILIENT PURGE: ONLY CLEAN AUTOMATED SKILLS ---
            // Tag nodes and user-added memories are now protected from deletion!
            const originalLength = rawEntries.length;
            rawEntries = rawEntries.filter(m => {
                const id = String(m.id || '');
                return !id.startsWith('skill_'); // ONLY remove virtual skills, preserve tags & engrams!
            });

            if (rawEntries.length !== originalLength) {
                Logger.warn(`[Memory Leak Purge] Cleaned ${originalLength - rawEntries.length} virtual skill nodes from database.`);
            }

            let migrated = false;
            
            // 1. Structural Migration
            rawEntries.forEach(m => {
                if (!m.predicates) {
                    m.predicates = [];
                    if (m.category) {
                        m.predicates.push({ verb: "categorized_under", targetId: `cat_${m.category}` });
                    }
                    migrated = true;
                }
            });

            this._cache = rawEntries;

            if (migrated || rawEntries.length !== originalLength) {
                await this.saveEngrams(this._cache);
            }
        } catch (error) {
            this._cache = [];
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
        predicates?: MemoryPredicate[]
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

            if (index === -1) {
                // ADD or UPSERT
                this._cache.push({
                    id,
                    title: title || id,
                    content: content || "",
                    timestamp: Date.now(),
                    importance: finalImportance !== undefined ? Math.max(0, Math.min(100, finalImportance)) : 50,
                    lastUsed: Date.now(),
                    category: category,
                    tier: 1,
                    scope: 'local',
                    predicates: predicates || []
                });
            } else {
                // UPDATE
                const entry = this._cache[index];
                if (title) entry.title = title;
                if (content) entry.content = content;
                if (predicates) entry.predicates = predicates;

                if (finalImportance !== undefined) {
                    entry.importance = Math.max(0, Math.min(100, finalImportance));
                } else {
                    entry.importance = Math.min(100, (entry.importance || 0) + 10);
                }

                entry.timestamp = Date.now();
                entry.lastUsed = Date.now();
            }
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
     * TIERED NEURAL MEMORY RECOVERY (UPGRADED)
     * Injects memory based on context-aware relevance.
     * Deep Memory is automatically searched and matching nodes are promoted 
     * to Tier 1 (Working Memory) on-demand.
     */
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
            documentTags.add(match[1].toLowerCase());
        }

        const docPredicates: MemoryPredicate[] = Array.from(documentTags).map(t => ({
            verb: "has_tag",
            targetId: `tag_${t}`
        }));

        this._cache = this._cache.filter(m => m.id !== cleanDocId && m.metadata?.sourceDocId !== cleanDocId);

        this._cache.push({
            id: cleanDocId,
            title,
            content: `Document Summary: ${title} by ${author || 'Unknown'}. Domain: ${domain || 'General'}. Topics: ${Array.from(documentTags).join(', ')}`,
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
                chunkTags.add(chunkMatch[1].toLowerCase());
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
    public async getProjectedGraph(skillsManager?: any): Promise<MemoryEntry[]> {
        const engrams = await this.getMemories();

        // Deep copy core engrams to ensure the dynamic projection has zero write-back leakage
        const projected = JSON.parse(JSON.stringify(engrams));

        // 1. Project Hashtags from Core Engrams (VOLATILE RUNTIME-ONLY PROJECTION)
        projected.forEach(m => {
            const tagRegex = /#([\w_]+)/g;
            let match;
            const foundTags = new Set<string>();

            while ((match = tagRegex.exec(m.content)) !== null) {
                foundTags.add(match[1].toLowerCase());
            }

            foundTags.forEach(tagId => {
                const fullTagId = `tag_${tagId}`;
                const exists = projected.some(x => x.id === fullTagId);
                if (!exists) {
                    projected.push({
                        id: fullTagId,
                        title: `#${tagId}`,
                        content: `Shared semantic hub for #${tagId} relationships.`,
                        timestamp: Date.now(),
                        importance: 10,
                        lastUsed: Date.now(),
                        category: 'tag',
                        scope: 'local',
                        predicates: []
                    });
                }

                if (!m.predicates) m.predicates = [];
                const hasLink = m.predicates.some(p => p.verb === 'has_tag' && p.targetId === fullTagId);
                if (!hasLink) {
                    m.predicates.push({ verb: 'has_tag', targetId: fullTagId });
                }
            });
        });

        if (!skillsManager) return projected;

        // 2. Project Skills from SkillsManager (VOLATILE RUNTIME-ONLY PROJECTION)
        try {
            const skills = await skillsManager.getSkills();
            skills.forEach((s: any) => {
                const virtId = `skill_${s.id}`;

                const tagRegex = /#([\w_]+)/g;
                let match;
                const predicates: MemoryPredicate[] = [];

                while ((match = tagRegex.exec(s.content)) !== null) {
                    const tagId = `tag_${match[1].toLowerCase()}`;
                    predicates.push({ verb: "has_tag", targetId: tagId });

                    if (!projected.some(x => x.id === tagId)) {
                        projected.push({
                            id: tagId,
                            title: `#${match[1]}`,
                            content: `Shared semantic hub for #${match[1]} relationships.`,
                            timestamp: Date.now(),
                            importance: 10,
                            lastUsed: Date.now(),
                            category: 'tag',
                            scope: 'local',
                            predicates: []
                        });
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
     * TIERED NEURAL MEMORY RECOVERY (UPGRADED)
     * Injects memory based on context-aware relevance.
     * Both Deep Memories are searched and promoted on-demand.
     * Strictly enforces a budget cap to protect attention maps from bloat.
     */
    public async getFormattedMemoryBlock(userPrompt?: string, skillsManager?: any): Promise<string> {
        // Fetch raw memories (excluding projected skills to prevent massive duplicate bloat)
        const engrams = await this.getMemories();
        const affective = await this.getAffectiveMatrix();

        // Extract lowercase keywords for semantic matching
        const keywords = userPrompt 
            ? userPrompt.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3)
            : [];

        let block = `\n# 🧠 NEURAL MEMORY SYSTEM (KNOWLEDGE GRAPH)\n`;
        block += `[AFFECTIVE MATRIX]: Relationship state is "${affective.label}" (${affective.relationshipScore}/100).\n`;

        // Tier 0: Immutable ROM (Hardcoded Specs)
        block += `\n## TIER 0: IMMUTABLE ROM\n`;
        block += `- Hub Purpose: Sovereign Local Engineering\n`;
        block += `- Protocol: LCP (LoLLMs Communication Protocol) Active\n`;

        // Dynamic Hydration Pass with Scope Protection
        const hydratedEngrams: MemoryEntry[] = [];
        const latentHandles: MemoryEntry[] = [];

        // --- SCOPE PROTECTION SEARCH ---
        let isolatedDocId: string | null = null;
        for (const e of engrams) {
            if (e.category === 'document') {
                const wordsInTitle = e.title.toLowerCase().split(/\s+/);
                const hasOverlap = wordsInTitle.some(w => w.length > 3 && keywords.includes(w));
                if (hasOverlap) {
                    isolatedDocId = e.id;
                    break;
                }
            }
        }

        engrams.forEach(e => {
            if (isolatedDocId && e.category === 'chunk' && e.metadata?.sourceDocId !== isolatedDocId) {
                latentHandles.push(e);
                return;
            }

            const isBaseLive = e.importance >= this.TIER_THRESHOLD;
            const semanticScore = this.calculateRelevanceScore(e, keywords);
            const isSemanticallyRelevant = semanticScore > 35;

            if (isBaseLive || isSemanticallyRelevant) {
                hydratedEngrams.push(e);
            } else {
                latentHandles.push(e);
            }
        });

        // --- COGNITIVE BUDGET CAP ---
        // Hard-cap on active working memory size.
        // Sort hydrated entries so highly relevant/important ones are prioritized first.
        const sortedHydrated = hydratedEngrams.sort((a, b) => {
            const scoreA = this.calculateRelevanceScore(a, keywords) + (a.importance || 0);
            const scoreB = this.calculateRelevanceScore(b, keywords) + (b.importance || 0);
            return scoreB - scoreA;
        });

        const BUDGET_LIMIT_CHARACTERS = 8000; // ~2,000 tokens limit for active memory injection
        let currentSize = 0;
        const activeEngrams: MemoryEntry[] = [];

        for (const e of sortedHydrated) {
            const entrySize = e.content.length + e.title.length;
            if (currentSize + entrySize < BUDGET_LIMIT_CHARACTERS) {
                activeEngrams.push(e);
                currentSize += entrySize;
            } else {
                // Demote over-budget items to latent storage handles
                latentHandles.push(e);
            }
        }

        if (activeEngrams.length > 0) {
            block += `\n## TIER 1: ACTIVE WORKING SUBGRAPH\n`;
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

        if (latentHandles.length > 0) {
            block += `\n## TIER 2: DEEP STORAGE HANDLES (LATENT GRAPH)\n`;
            block += `The following nodes exist in your deep storage. Use 'query_architecture' with SPARQL to extract full content when needed:\n`;

            const categories = [...new Set(latentHandles.map(e => e.category))];
            categories.forEach(cat => {
                const items = latentHandles.filter(e => e.category === cat);
                block += `- s:${cat}/: [${items.map(i => `s:${i.id}`).join(', ')}]\n`;
            });
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
     * 2. Consolidation: Refreshed engrams stay in T1, others move to T2.
     * 3. Forgetting: Importance 0 is deleted.
     */
    /**
     * THE DREAM CYCLE: Reorganizes and consolidates neural connections.
     * 1. Decay: Reduces importance of all engrams.
     * 2. Consolidation: Refreshed engrams stay in T1, others move to T2.
     * 3. Forgetting: Importance 0 is deleted.
     */
    public async performDreamCycle(onProgress?: (event: { type: 'decay' | 'reinforce' | 'archive' | 'forget' | 'fuse' | 'summary', id?: string, title?: string, value?: number, data?: any }) => void): Promise<void> {
        const engrams = await this.getMemories();
        let decayed = 0, consolidated = 0, forgotten = 0, fused = 0;
        const logs: string[] = [];

        const updatedEngrams: MemoryEntry[] = [];

        for (const e of engrams) {
            const oldImp = e.importance;
            // 🛡️ ANTI-POISONING PROTOCOL
            let decayPenalty = this.DECAY_STEP;

            // 1. Identify Process Noise (Self-generated failure loops)
            const isFailureLesson = e.content.toLowerCase().includes('previous attempt') || 
                                   e.content.toLowerCase().includes('failed because') ||
                                   e.title.toLowerCase().includes('lesson');

            // 2. Identify Meta-Noise (Agent talking about its own tags)
            const isMetaNoise = e.content.includes('<project_memory') || e.content.includes('<milestone');

            if (isFailureLesson || isMetaNoise) {
                // Decay these 5x faster. Failure context is only useful for 1-2 turns.
                decayPenalty = this.DECAY_STEP * 5;

                // If it's very old or importance is already low, drop it to zero immediately
                if (oldImp < 40) decayPenalty = 100; 
            }

            // 3. Persistent Facts (User provided or high importance)
            if (e.importance >= 90) decayPenalty = 0.1; // Rule-tier engrams are nearly permanent

            const newImp = Math.max(0, oldImp - decayPenalty);

            if (onProgress) {
                // Determine action for animation
                if (newImp === 0) {
                    onProgress({ type: 'forget', id: e.id, title: e.title });
                    forgotten++;
                } else if (newImp < this.TIER_THRESHOLD && oldImp >= this.TIER_THRESHOLD) {
                    onProgress({ type: 'archive', id: e.id, title: e.title, value: newImp });
                    consolidated++;
                } else {
                    onProgress({ type: 'decay', id: e.id, title: e.title, value: newImp });
                    decayed++;
                }
                // Simulate neural processing time for cool visual flow
                await new Promise(r => setTimeout(r, 150));
            }

            if (newImp > 0) {
                updatedEngrams.push({ ...e, importance: newImp });
            }
        }

        // 🧬 NEW PHASE: SYNAPTIC FUSION (AI CONSOLIDATION)
        // Find "Lessons" that can be merged
        const lessons = updatedEngrams.filter(e => e.title.toLowerCase().includes('lesson') || e.content.toLowerCase().includes('failed because'));

        if (lessons.length >= 2) {
            if (onProgress) onProgress({ type: 'fuse', title: "Consolidating Failure Patterns..." });

            const lollms = (this as any).lollmsAPI || (vscode.extensions.getExtension('parisneo.lollms-vs-coder')?.exports?.lollmsAPI);

            if (lollms) {
                const fusionPrompt = `You are the Neural Architect. Consolidate these redundant technical lessons into a single, high-density "Sovereign Rule". 
                - Strip all narrative fluff ("Previous attempt failed", "The model should").
                - Use clear, imperative technical language.
                - Keep the importance high.

                LESSONS TO MERGE:
                ${lessons.map(l => `- [${l.title}]: ${l.content}`).join('\n')}

                OUTPUT FORMAT: JSON only: {"title": "Sovereign Rule: [Topic]", "content": "..."}`;

                try {
                    const response = await lollms.sendChat([{ role: 'system', content: fusionPrompt }]);
                    const result = JSON.parse(response.replace(/```json|```/g, ''));

                    // Create the new "Fused" memory
                    const newId = 'rule_' + Date.now();
                    updatedEngrams.push({
                        id: newId,
                        title: result.title,
                        content: result.content,
                        timestamp: Date.now(),
                        importance: 95, // High initial power
                        lastUsed: Date.now(),
                        category: "rules",
                        tier: 1,
                        scope: 'local',
                        origin: 'architect'
                    });

                    // Remove the old source lessons
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
        }

        // Save back
        await this.saveEngrams(updatedEngrams);

        const summary = { decayed, consolidated, forgotten, fused, total: updatedEngrams.length };
        if (onProgress) onProgress({ type: 'summary', data: summary });

        // Store maintenance log
        await this.context.workspaceState.update('lollms_dream_log', {
            timestamp: Date.now(),
            events: logs
        });
    }

    private async saveEngrams(engrams: MemoryEntry[]) {
        const { getLollmsStorageUri } = require('./utils');
        const storageRoot = getLollmsStorageUri(this.context);
        const memoryPath = vscode.Uri.joinPath(storageRoot, 'project_memory.json');
        const buffer = Buffer.from(JSON.stringify(engrams, null, 2), 'utf8');

        try {
            const dir = vscode.Uri.joinPath(memoryPath, '..');
            await vscode.workspace.fs.createDirectory(dir);
            await vscode.workspace.fs.writeFile(memoryPath, buffer);
        } catch (e) {
            Logger.error("Failed to save neural engrams", e);
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
        const memoryRegex = /<project_memory\s+([^>]*?)>([\s\S]*?)<\/project_memory>/gi;
        let match;
        while ((match = memoryRegex.exec(content)) !== null) {
            const attrStr = match[1];
            const memoryContent = match[2].trim();
            const attrs: any = {};
            
            const attrRegex = /(\w+)\s*=\s*["']([^"']*)["']/g;
            let m;
            while ((m = attrRegex.exec(attrStr)) !== null) {
                attrs[m[1]] = m[2];
            }

            const { action, id, title, importance } = attrs;
            if (action && id) {
                const imp = importance ? parseFloat(importance) : 1.0;
                await this.updateMemory(action as any, id, title || id, memoryContent, "general", imp);
            }
        }
    }
}