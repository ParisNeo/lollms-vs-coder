import * as vscode from 'vscode';
import * as path from 'path';
import { Logger } from './logger';

export type MemoryTier = 0 | 1 | 2 | 3;

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
            this._cache = Array.isArray(data) ? data : [];
        } catch (error) {
            this._cache = [];
        }

        return this._cache;
    }

    public async updateMemory(action: 'add' | 'update' | 'delete', id: string, title?: string, content?: string, category: string = "general", importance?: number) {
        await this.getMemories();

        // --- IMPORTANCE NORMALIZATION ---
        // AI agents often use a 0.0 - 5.0 scale. The manager uses 0 - 100.
        let finalImportance = importance;
        if (finalImportance !== undefined && finalImportance <= 5.0 && finalImportance > 0) {
            finalImportance = finalImportance * 20; // Scale 2.0 -> 40%
        }

        if (action === 'delete') {
            this._cache = this._cache.filter(m => m.id !== id);
        } else {
            const index = this._cache.findIndex(m => m.id === id);

            if (index === -1) {
                // ADD or UPSERT (if update was called on non-existent ID)
                this._cache.push({
                    id,
                    title: title || id,
                    content: content || "",
                    timestamp: Date.now(),
                    importance: finalImportance !== undefined ? Math.max(0, Math.min(100, finalImportance)) : 50,
                    lastUsed: Date.now(),
                    category: category,
                    tier: 1,
                    scope: 'local'
                });
            } else {
                // UPDATE
                const entry = this._cache[index];
                if (title) entry.title = title;
                if (content) entry.content = content;

                if (finalImportance !== undefined) {
                    entry.importance = Math.max(0, Math.min(100, finalImportance));
                } else {
                    // Implicit reinforcement
                    entry.importance = Math.min(100, (entry.importance || 0) + 10);
                }

                entry.timestamp = Date.now();
                entry.lastUsed = Date.now();
            }
        }

        // 2. Persist
        const folders = vscode.workspace.workspaceFolders ||[];
        for (const folder of folders) {
            const localPath = vscode.Uri.joinPath(folder.uri, '.lollms', 'project_memory.json');
            try {
                const dir = vscode.Uri.joinPath(localPath, '..');
                await vscode.workspace.fs.createDirectory(dir);
                const buffer = Buffer.from(JSON.stringify(this._cache, null, 2), 'utf8');
                await vscode.workspace.fs.writeFile(localPath, buffer);
            } catch (e) {
                console.error(`Failed to save project memory to ${folder.name}`, e);
            }
        }

        // 3. Notify UI (Both Sidebar Tree and Webview Panel)
        this._onDidChange.fire();
        
        // Force the Webview to update if it's open
        const { ProjectMemoryPanel } = require('./commands/projectMemoryPanel');
        if (ProjectMemoryPanel.currentPanel) {
            // This is a hacky but effective way to trigger the private _update in the currentPanel
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
     * TIERED NEURAL MEMORY RECOVERY
     * Injects memory based on the Neural System Specification (Tier 0-2).
     * Tier 3 remains hidden unless explicitly searched.
     */
    public async getFormattedMemoryBlock(): Promise<string> {
        const engrams = await this.getMemories();
        const affective = await this.getAffectiveMatrix();
        
        let block = `\n# 🧠 NEURAL MEMORY SYSTEM (TIERED RLM)\n`;
        block += `[AFFECTIVE MATRIX]: Relationship state is "${affective.label}" (${affective.relationshipScore}/100).\n`;

        // Tier 0: Immutable ROM (Hardcoded Specs)
        block += `\n## TIER 0: IMMUTABLE ROM\n`;
        block += `- Hub Purpose: Sovereign Local Engineering\n`;
        block += `- Protocol: LCP (LoLLMs Communication Protocol) Active\n`;

        // Tier 1: Working Memory (Active Engrams >= 25%)
        const tier1 = engrams.filter(e => e.importance >= this.TIER_THRESHOLD);
        if (tier1.length > 0) {
            block += `\n## TIER 1: WORKING MEMORY (ACTIVE)\n`;
            tier1.forEach(e => {
                block += `### [${e.category.toUpperCase()}] ${e.title}\n${e.content}\n`;
            });
        }

        // Tier 2: Latent Handles (1% - 24%)
        // These are injected as an index so the agent knows what it can "remember"
        const tier2 = engrams.filter(e => e.importance > 0 && e.importance < this.TIER_THRESHOLD);
        if (tier2.length > 0) {
            block += `\n## TIER 2: LATENT HANDLES (DEEP MEMORY)\n`;
            block += `The following IDs exist in your deep storage. Use 'search_deep_memory' to retrieve full content if relevant.\n`;

            // Group by category for cleaner index
            const categories = [...new Set(tier2.map(e => e.category))];
            categories.forEach(cat => {
                const items = tier2.filter(e => e.category === cat);
                block += `- ${cat}/: [${items.map(i => i.id).join(', ')}]\n`;
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