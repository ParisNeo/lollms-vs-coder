import * as vscode from 'vscode';
import * as path from 'path';
import { LollmsAPI } from './lollmsAPI';
import { stripThinkingTags } from './utils';
import { Logger } from './logger';

export type BriefingCategory = 'doctrine' | 'architecture' | 'decisions' | 'pitfalls' | 'tasks' | 'custom';

export interface BriefingEntry {
    id: string;
    category: BriefingCategory;
    title: string;
    content: string;
    relatedFiles?: string[];
    confidence: number;
    createdAt: number;
    updatedAt: number;
    sessionCount: number;
}

export interface ProjectBriefingStore {
    version: number;
    doctrine: string;
    entries: BriefingEntry[];
    lastCompactedAt: number;
}

export class MissionBriefingManager {
    public static readonly BRIEFING_JSON_FILE = 'mission_briefing.json';
    public static readonly WORKSPACE_STATE_KEY = 'lollms_global_briefing';
    public static readonly MAX_RENDERED_CHARS = 7000;
    public static readonly MAX_ENTRIES = 24;
    public static readonly MAX_ENTRY_CHARS = 900;

    private cachedStore: ProjectBriefingStore | null = null;

    constructor(
        private context: vscode.ExtensionContext,
        private lollmsAPI?: LollmsAPI
    ) {}

    private getStoreUri(workspaceFolder?: vscode.WorkspaceFolder): vscode.Uri | null {
        const folder = workspaceFolder || vscode.workspace.workspaceFolders?.[0];
        if (!folder) return null;
        return vscode.Uri.joinPath(folder.uri, '.lollms', MissionBriefingManager.BRIEFING_JSON_FILE);
    }

    private createEmptyStore(): ProjectBriefingStore {
        return {
            version: 1,
            doctrine: '',
            entries: [],
            lastCompactedAt: 0
        };
    }

    public async loadStore(workspaceFolder?: vscode.WorkspaceFolder): Promise<ProjectBriefingStore> {
        const uri = this.getStoreUri(workspaceFolder);
        if (uri) {
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
                if (parsed && typeof parsed === 'object') {
                    const store: ProjectBriefingStore = {
                        version: parsed.version || 1,
                        doctrine: typeof parsed.doctrine === 'string' ? parsed.doctrine : '',
                        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
                        lastCompactedAt: parsed.lastCompactedAt || 0
                    };
                    this.cachedStore = store;
                    return store;
                }
            } catch {}
        }

        // Migrate seamlessly from legacy workspaceState flat string if present
        const legacyText = this.context.workspaceState.get<string>(MissionBriefingManager.WORKSPACE_STATE_KEY, '').trim();
        const migrated = this.createEmptyStore();
        if (legacyText) {
            migrated.doctrine = legacyText;
            if (uri) {
                await this.saveStore(migrated, workspaceFolder);
            }
        }
        this.cachedStore = migrated;
        return migrated;
    }

    public async saveStore(store: ProjectBriefingStore, workspaceFolder?: vscode.WorkspaceFolder): Promise<string> {
        this.cachedStore = store;
        const rendered = this.renderStore(store);

        // Keep workspaceState synchronously readable for fast HUD/prompt construction
        await this.context.workspaceState.update(MissionBriefingManager.WORKSPACE_STATE_KEY, rendered);

        const uri = this.getStoreUri(workspaceFolder);
        if (uri) {
            try {
                const dir = vscode.Uri.joinPath(uri, '..');
                await vscode.workspace.fs.createDirectory(dir);
                await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(store, null, 2), 'utf8'));
            } catch (err: any) {
                Logger.warn(`[MissionBriefingManager] Could not persist ${MissionBriefingManager.BRIEFING_JSON_FILE}: ${err.message}`);
            }
        }
        return rendered;
    }

    public getCachedBriefingText(): string {
        if (this.cachedStore) {
            return this.renderStore(this.cachedStore);
        }
        return this.context.workspaceState.get<string>(MissionBriefingManager.WORKSPACE_STATE_KEY, '').trim();
    }

    private normalizeId(rawId: string, category: BriefingCategory, title: string): string {
        const base = (rawId || `${category}_${title}` || `${category}_${Date.now()}`)
            .toLowerCase()
            .replace(/[^a-z0-9_]+/g, '_')
            .replace(/^_+|_+$/g, '');
        return base.slice(0, 64) || `${category}_${Date.now()}`;
    }

    private extractFilePathsFromText(text: string): string[] {
        const matches = text.match(/`([a-zA-Z0-9_.\-/]+\.[a-zA-Z0-9]{1,8})`/g) || [];
        return Array.from(new Set(matches.map(m => m.slice(1, -1).replace(/\\/g, '/'))));
    }

    private tokenSimilarity(a: string, b: string): number {
        const tokenize = (s: string) => new Set(
            s.toLowerCase().replace(/[^a-z0-9_]+/g, ' ').split(/\s+/).filter(w => w.length > 2)
        );
        const setA = tokenize(a);
        const setB = tokenize(b);
        if (setA.size === 0 || setB.size === 0) return 0;
        let overlap = 0;
        for (const t of setA) {
            if (setB.has(t)) overlap++;
        }
        return overlap / Math.max(setA.size, setB.size);
    }

    /**
     * Upserts a structured cross-session entry without stacking duplicates.
     * Automatically prunes stale references and compacts if exceeding budget.
     */
    public async upsertEntry(
        input: {
            id?: string;
            category?: BriefingCategory;
            title?: string;
            content: string;
            relatedFiles?: string[];
            confidence?: number;
        },
        options?: { compact?: boolean; workspaceFolder?: vscode.WorkspaceFolder }
    ): Promise<string> {
        const store = await this.loadStore(options?.workspaceFolder);
        const category: BriefingCategory = input.category || 'decisions';
        const cleanContent = (input.content || '').trim();
        if (!cleanContent) {
            return this.renderStore(store);
        }

        const title = (input.title || cleanContent.split('\n')[0].replace(/^[#*\-\s]+/, '').slice(0, 60)).trim();
        const normId = this.normalizeId(input.id || '', category, title);
        const detectedFiles = this.extractFilePathsFromText(cleanContent);
        const relatedFiles = Array.from(new Set([...(input.relatedFiles || []), ...detectedFiles]));
        const now = Date.now();

        const boundedContent = cleanContent.length > MissionBriefingManager.MAX_ENTRY_CHARS
            ? cleanContent.slice(0, MissionBriefingManager.MAX_ENTRY_CHARS - 3) + '...'
            : cleanContent;

        // Match by exact ID or high semantic similarity in the same category to prevent duplicate crumbling
        let existingIdx = store.entries.findIndex(e => e.id === normId);
        if (existingIdx === -1) {
            existingIdx = store.entries.findIndex(e =>
                e.category === category && (
                    e.title.toLowerCase() === title.toLowerCase() ||
                    this.tokenSimilarity(`${e.title} ${e.content}`, `${title} ${boundedContent}`) >= 0.72
                )
            );
        }

        if (existingIdx !== -1) {
            const existing = store.entries[existingIdx];
            store.entries[existingIdx] = {
                ...existing,
                title: title || existing.title,
                content: boundedContent,
                relatedFiles: relatedFiles.length > 0 ? relatedFiles : existing.relatedFiles,
                confidence: Math.min(100, Math.max(existing.confidence, input.confidence ?? 80) + 5),
                updatedAt: now,
                sessionCount: (existing.sessionCount || 1) + 1
            };
        } else {
            store.entries.push({
                id: normId,
                category,
                title,
                content: boundedContent,
                relatedFiles,
                confidence: input.confidence ?? 75,
                createdAt: now,
                updatedAt: now,
                sessionCount: 1
            });
        }

        if (options?.compact !== false) {
            await this.compactIfNeeded(store, options?.workspaceFolder);
        }

        return await this.saveStore(store, options?.workspaceFolder);
    }

    public async removeEntry(idOrTitle: string, workspaceFolder?: vscode.WorkspaceFolder): Promise<string> {
        const store = await this.loadStore(workspaceFolder);
        const clean = idOrTitle.toLowerCase().trim();
        store.entries = store.entries.filter(e =>
            e.id.toLowerCase() !== clean && e.title.toLowerCase() !== clean
        );
        return await this.saveStore(store, workspaceFolder);
    }

    /**
     * Applies a <mission_briefing> mutation or manual modal save cleanly.
     */
    public async applyUpdate(
        content: string,
        action: 'write' | 'patch' | 'upsert' | 'remove' = 'upsert',
        meta?: { category?: BriefingCategory; id?: string; title?: string },
        workspaceFolder?: vscode.WorkspaceFolder
    ): Promise<string> {
        const store = await this.loadStore(workspaceFolder);
        const trimmed = (content || '').trim();

        if (action === 'remove') {
            return await this.removeEntry(meta?.id || meta?.title || trimmed, workspaceFolder);
        }

        if (action === 'upsert' || meta?.category || meta?.id) {
            return await this.upsertEntry({
                id: meta?.id,
                category: meta?.category || 'decisions',
                title: meta?.title,
                content: trimmed
            }, { workspaceFolder });
        }

        if (action === 'patch') {
            const { normalizeAiderContent, parseAiderHunks, applySearchReplace } = require('./utils');
            const currentRendered = this.renderStore(store);
            const normalizedAider = normalizeAiderContent(trimmed);
            const hunks = parseAiderHunks(normalizedAider);

            if (hunks.length > 0 && store.doctrine) {
                let updatedDoctrine = store.doctrine;
                let applied = false;
                for (const hunk of hunks) {
                    const res = applySearchReplace(updatedDoctrine, hunk.searchPart, hunk.replacePart);
                    if (res.success) {
                        updatedDoctrine = res.result;
                        applied = true;
                    }
                }
                if (applied) {
                    store.doctrine = updatedDoctrine.trim();
                    await this.compactIfNeeded(store, workspaceFolder);
                    return await this.saveStore(store, workspaceFolder);
                }
            }

            // Fallback: treat patch additions as a keyed decision entry instead of appending messy raw text to doctrine
            const additions = hunks.length > 0
                ? hunks.map((h: any) => h.replacePart || '').filter(Boolean).join('\n').trim()
                : trimmed;

            if (currentRendered && additions) {
                return await this.upsertEntry({
                    category: 'decisions',
                    content: additions
                }, { workspaceFolder });
            }
        }

        // action === 'write': If the user edited the full rendered briefing in the modal, parse back sections cleanly
        if (!trimmed) {
            store.doctrine = '';
            store.entries = [];
            return await this.saveStore(store, workspaceFolder);
        }

        const parsed = this.parseRenderedOrRawText(trimmed, store);
        await this.compactIfNeeded(parsed, workspaceFolder);
        return await this.saveStore(parsed, workspaceFolder);
    }

    private parseRenderedOrRawText(text: string, existingStore: ProjectBriefingStore): ProjectBriefingStore {
        const hasStructuredHeaders = /^###\s+(?:🎯|🏛️|⚠️|📌)/m.test(text);
        if (!hasStructuredHeaders) {
            return {
                ...existingStore,
                doctrine: text.trim()
            };
        }

        const nextStore: ProjectBriefingStore = {
            version: existingStore.version,
            doctrine: '',
            entries: [],
            lastCompactedAt: existingStore.lastCompactedAt
        };

        const sections = text.split(/(?=^###\s+)/m);
        for (const sec of sections) {
            const lines = sec.trim().split('\n');
            const header = lines[0] || '';
            const body = lines.slice(1).join('\n').trim();
            if (!body) continue;

            if (header.includes('Project Doctrine')) {
                nextStore.doctrine = body;
            } else {
                let category: BriefingCategory = 'decisions';
                if (header.includes('Architecture')) category = 'architecture';
                else if (header.includes('Pitfalls')) category = 'pitfalls';
                else if (header.includes('Objectives') || header.includes('Tasks')) category = 'tasks';

                const bulletBlocks = body.split(/(?=^- \*\*)/m).map(b => b.trim()).filter(Boolean);
                for (const block of bulletBlocks) {
                    const titleMatch = block.match(/^- \*\*([^*]+)\*\*(?:\s*\[`([^`]+)`\])?:?\s*([\s\S]*)/);
                    if (titleMatch) {
                        const title = titleMatch[1].trim();
                        const id = titleMatch[2]?.trim() || this.normalizeId('', category, title);
                        const content = titleMatch[3].trim();
                        const existing = existingStore.entries.find(e => e.id === id);
                        nextStore.entries.push({
                            id,
                            category,
                            title,
                            content,
                            relatedFiles: this.extractFilePathsFromText(content),
                            confidence: existing?.confidence ?? 80,
                            createdAt: existing?.createdAt ?? Date.now(),
                            updatedAt: Date.now(),
                            sessionCount: existing?.sessionCount ?? 1
                        });
                    } else {
                        nextStore.entries.push({
                            id: this.normalizeId('', category, block.slice(0, 40)),
                            category,
                            title: block.slice(0, 50),
                            content: block.replace(/^- /, '').trim(),
                            relatedFiles: this.extractFilePathsFromText(block),
                            confidence: 75,
                            createdAt: Date.now(),
                            updatedAt: Date.now(),
                            sessionCount: 1
                        });
                    }
                }
            }
        }

        return nextStore;
    }

    /**
     * Anti-Crumble Engine:
     * 1. Prunes entries whose referenced project files no longer exist on disk.
     * 2. Deduplicates overlapping entries in the same category.
     * 3. Consolidates excess entries via LLM (with deterministic fallback) when exceeding token budget.
     */
    public async compactStore(workspaceFolder?: vscode.WorkspaceFolder, force: boolean = false): Promise<{
        rendered: string;
        prunedStaleCount: number;
        deduplicatedCount: number;
        compactedViaLlm: boolean;
    }> {
        const store = await this.loadStore(workspaceFolder);
        const stats = await this.compactIfNeeded(store, workspaceFolder, force);
        const rendered = await this.saveStore(store, workspaceFolder);
        return { rendered, ...stats };
    }

    private async compactIfNeeded(
        store: ProjectBriefingStore,
        workspaceFolder?: vscode.WorkspaceFolder,
        force: boolean = false
    ): Promise<{ prunedStaleCount: number; deduplicatedCount: number; compactedViaLlm: boolean }> {
        let prunedStaleCount = 0;
        let deduplicatedCount = 0;
        let compactedViaLlm = false;

        const folder = workspaceFolder || vscode.workspace.workspaceFolders?.[0];

        // 1. Prune stale entries pointing exclusively to deleted workspace files
        if (folder && store.entries.length > 0) {
            const surviving: BriefingEntry[] = [];
            for (const entry of store.entries) {
                const files = entry.relatedFiles || [];
                if (files.length === 0) {
                    surviving.push(entry);
                    continue;
                }
                let anyExists = false;
                for (const rel of files) {
                    const cleanRel = rel.replace(/\\/g, '/').replace(/^\.?\//, '');
                    try {
                        await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, cleanRel));
                        anyExists = true;
                        break;
                    } catch {}
                }
                if (anyExists) {
                    surviving.push(entry);
                } else {
                    prunedStaleCount++;
                    Logger.info(`[MissionBriefingManager] Pruned stale briefing entry '${entry.id}' (referenced files deleted).`);
                }
            }
            store.entries = surviving;
        }

        // 2. Deduplicate overlapping entries in the same category
        const deduped: BriefingEntry[] = [];
        const sortedByRecency = [...store.entries].sort((a, b) => b.updatedAt - a.updatedAt);
        for (const entry of sortedByRecency) {
            const duplicate = deduped.find(kept =>
                kept.category === entry.category &&
                this.tokenSimilarity(`${kept.title} ${kept.content}`, `${entry.title} ${entry.content}`) >= 0.65
            );
            if (duplicate) {
                deduplicatedCount++;
                duplicate.confidence = Math.min(100, Math.max(duplicate.confidence, entry.confidence) + 5);
                duplicate.sessionCount = Math.max(duplicate.sessionCount, entry.sessionCount);
            } else {
                deduped.push(entry);
            }
        }
        store.entries = deduped;

        // 3. Check budget and consolidate if bloated (or forced)
        const currentLen = this.renderStore(store).length;
        const needsCompaction = force || currentLen > MissionBriefingManager.MAX_RENDERED_CHARS || store.entries.length > MissionBriefingManager.MAX_ENTRIES;

        if (needsCompaction && store.entries.length > 3) {
            if (this.lollmsAPI) {
                try {
                    const prompt = `You are a Software Architecture Memory Consolidator.
The project's cross-session Mission Briefing has accumulated ${store.entries.length} entries (~${Math.ceil(currentLen / 3.5)} tokens).
Consolidate and merge them into at most 12 crisp, non-overlapping, high-signal entries without losing critical architectural decisions, invariants, or bug pitfalls.

EXISTING ENTRIES (JSON):
${JSON.stringify(store.entries.map(e => ({ id: e.id, category: e.category, title: e.title, content: e.content, relatedFiles: e.relatedFiles })))}

Output ONLY a valid JSON array of consolidated objects with keys: "id", "category" ("architecture"|"decisions"|"pitfalls"|"tasks"), "title", "content", "relatedFiles".`;

                    const response = await this.lollmsAPI.sendChat([
                        { role: 'system', content: 'Output ONLY a valid JSON array. Zero prose.' },
                        { role: 'user', content: prompt }
                    ], null, undefined, undefined, { thinking: false });

                    const clean = stripThinkingTags(response).trim();
                    const jsonMatch = clean.match(/\[[\s\S]*\]/);
                    if (jsonMatch) {
                        const parsed = JSON.parse(jsonMatch[0]);
                        if (Array.isArray(parsed) && parsed.length > 0) {
                            const now = Date.now();
                            store.entries = parsed.slice(0, 14).map((item: any) => ({
                                id: this.normalizeId(item.id || '', item.category || 'decisions', item.title || 'note'),
                                category: (['doctrine', 'architecture', 'decisions', 'pitfalls', 'tasks', 'custom'].includes(item.category) ? item.category : 'decisions') as BriefingCategory,
                                title: String(item.title || 'Architectural Note').slice(0, 70),
                                content: String(item.content || '').slice(0, MissionBriefingManager.MAX_ENTRY_CHARS),
                                relatedFiles: Array.isArray(item.relatedFiles) ? item.relatedFiles : this.extractFilePathsFromText(String(item.content || '')),
                                confidence: 85,
                                createdAt: now,
                                updatedAt: now,
                                sessionCount: 2
                            }));
                            store.lastCompactedAt = now;
                            compactedViaLlm = true;
                        }
                    }
                } catch (err: any) {
                    Logger.warn(`[MissionBriefingManager] LLM consolidation fallback triggered: ${err.message}`);
                }
            }

            // Deterministic LRU + Confidence eviction fallback if still over budget
            if (this.renderStore(store).length > MissionBriefingManager.MAX_RENDERED_CHARS || store.entries.length > MissionBriefingManager.MAX_ENTRIES) {
                store.entries.sort((a, b) => (b.confidence * 10 + b.sessionCount * 5) - (a.confidence * 10 + a.sessionCount * 5) || b.updatedAt - a.updatedAt);
                while (
                    store.entries.length > 4 &&
                    (this.renderStore(store).length > MissionBriefingManager.MAX_RENDERED_CHARS || store.entries.length > MissionBriefingManager.MAX_ENTRIES)
                ) {
                    store.entries.pop();
                }
                store.lastCompactedAt = Date.now();
            }
        }

        // Trim doctrine itself if extraordinarily oversized
        if (store.doctrine.length > 3500) {
            store.doctrine = store.doctrine.slice(0, 3450).trim() + '\n... [trimmed to fit briefing budget]';
        }

        return { prunedStaleCount, deduplicatedCount, compactedViaLlm };
    }

    public async clearAll(workspaceFolder?: vscode.WorkspaceFolder): Promise<void> {
        const empty = this.createEmptyStore();
        await this.saveStore(empty, workspaceFolder);
    }

    public renderStore(store: ProjectBriefingStore): string {
        const parts: string[] = [];

        if (store.doctrine && store.doctrine.trim()) {
            parts.push(`### 🎯 Project Doctrine & Invariants\n${store.doctrine.trim()}`);
        }

        const groups: { cat: BriefingCategory; header: string }[] = [
            { cat: 'architecture', header: '### 🏛️ Architecture & Module Contracts' },
            { cat: 'decisions', header: '### 🧭 Cross-Session Design Decisions' },
            { cat: 'pitfalls', header: '### ⚠️ Known Pitfalls & Resolved Bugs' },
            { cat: 'tasks', header: '### 📌 Active Multi-Session Objectives' },
            { cat: 'custom', header: '### 📝 Project Notes' }
        ];

        for (const g of groups) {
            const items = store.entries.filter(e => e.category === g.cat);
            if (items.length === 0) continue;
            const lines = items.map(e => `- **${e.title}** [\`${e.id}\`]: ${e.content}`);
            parts.push(`${g.header}\n${lines.join('\n')}`);
        }

        return parts.join('\n\n').trim();
    }
}