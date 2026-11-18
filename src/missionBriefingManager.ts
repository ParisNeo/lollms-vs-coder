import * as vscode from 'vscode';
import { LollmsAPI } from './lollmsAPI';
import { stripThinkingTags } from './utils';
import { Logger } from './logger';

export type BriefingCategory = 'doctrine' | 'architecture' | 'decisions' | 'pitfalls' | 'tasks' | 'custom';

export interface BriefingSection {
    name: string;
    title: string;
    content: string;
    relatedFiles?: string[];
    updatedAt: number;
}

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
    sections: BriefingSection[];
    lastCompactedAt: number;
}

export class MissionBriefingManager {
    public static readonly BRIEFING_JSON_FILE = 'mission_briefing.json';
    public static readonly WORKSPACE_STATE_KEY = 'lollms_global_briefing';
    public static readonly DESCRIPTION_SECTION = 'description';
    public static readonly MAX_TOTAL_CHARS = 3600;
    public static readonly MAX_RENDERED_CHARS = 3600;
    public static readonly MAX_SECTIONS = 12;
    public static readonly MAX_SECTION_CHARS = 550;
    public static readonly MAX_DESCRIPTION_CHARS = 750;

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
            version: 2,
            sections: [],
            lastCompactedAt: 0
        };
    }

    private normalizeSectionName(rawName: string, fallbackTitle?: string): string {
        const base = (rawName || fallbackTitle || '')
            .toLowerCase()
            .replace(/[^a-z0-9_]+/g, '_')
            .replace(/^_+|_+$/g, '');
        if (!base) return `section_${Date.now().toString(36)}`;
        if (base === 'project_description' || base === 'overview' || base === 'purpose' || base === 'project_doctrine' || base === 'doctrine') {
            return MissionBriefingManager.DESCRIPTION_SECTION;
        }
        return base.slice(0, 48);
    }

    private formatSectionTitle(name: string, explicitTitle?: string): string {
        if (name === MissionBriefingManager.DESCRIPTION_SECTION) {
            return 'Description';
        }
        if (explicitTitle && explicitTitle.trim()) {
            return explicitTitle.trim().slice(0, 60);
        }
        return name
            .split('_')
            .filter(Boolean)
            .map(w => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');
    }

    private extractFilePathsFromText(text: string): string[] {
        const matches = text.match(/`([a-zA-Z0-9_.\-/]+\.[a-zA-Z0-9]{1,8})`/g) || [];
        return Array.from(new Set(matches.map(m => m.slice(1, -1).replace(/\\/g, '/'))));
    }

    /**
     * Detects episodic/event-reporting logs (session recaps, test outcomes, failure narratives, TODOs)
     * so they cannot overwrite or bloat the project workings reference.
     */
    public static isEpisodicEventReport(text: string, titleOrName?: string): boolean {
        const combined = `${titleOrName || ''} ${text || ''}`.trim();
        if (!combined) return false;
        const lower = combined.toLowerCase();

        if (/^(?:session|turn|step|attempt|phase)\s*(?:#?\d+|:)/i.test(lower)) return true;
        if (/^\s*(?:\*\*task\*\*|task:|todo:|next step:|status:|resolved bug:|fixed in)\b/im.test(lower)) return true;
        if (/\b(?:in this session|in the previous turn|previous attempt|earlier turns|just fixed|just updated|just added|was fixed in|failed to apply|test run (?:passed|failed)|we resolved|i have updated|i modified|user asked to)\b/i.test(lower)) {
            return true;
        }
        return false;
    }

    private ensureDescriptionFirst(sections: BriefingSection[]): BriefingSection[] {
        const cleaned = sections.filter(s => s && s.name && s.content && s.content.trim().length > 0);
        const descIdx = cleaned.findIndex(s => s.name === MissionBriefingManager.DESCRIPTION_SECTION);
        if (descIdx > 0) {
            const [desc] = cleaned.splice(descIdx, 1);
            cleaned.unshift(desc);
        } else if (descIdx === -1 && cleaned.length > 0) {
            cleaned.unshift({
                name: MissionBriefingManager.DESCRIPTION_SECTION,
                title: 'Description',
                content: 'Project overview not yet described. Update the `description` section with general purpose and main features.',
                updatedAt: Date.now()
            });
        }
        return cleaned;
    }

    private capSectionContent(name: string, content: string): string {
        const maxLen = name === MissionBriefingManager.DESCRIPTION_SECTION
            ? MissionBriefingManager.MAX_DESCRIPTION_CHARS
            : MissionBriefingManager.MAX_SECTION_CHARS;
        const trimmed = content.trim();
        if (trimmed.length <= maxLen) return trimmed;
        return trimmed.slice(0, maxLen - 3).trimEnd() + '...';
    }

    private migrateLegacyStore(parsed: any): ProjectBriefingStore {
        const sections: BriefingSection[] = [];
        const now = Date.now();

        if (typeof parsed.doctrine === 'string' && parsed.doctrine.trim()) {
            const cleanDoc = parsed.doctrine.trim();
            if (!MissionBriefingManager.isEpisodicEventReport(cleanDoc, 'description')) {
                sections.push({
                    name: MissionBriefingManager.DESCRIPTION_SECTION,
                    title: 'Description',
                    content: this.capSectionContent(MissionBriefingManager.DESCRIPTION_SECTION, cleanDoc),
                    relatedFiles: this.extractFilePathsFromText(cleanDoc),
                    updatedAt: now
                });
            }
        }

        if (Array.isArray(parsed.entries)) {
            for (const e of parsed.entries) {
                if (!e || !e.content) continue;
                const id = String(e.id || '');
                if (id.startsWith('session_') || e.category === 'tasks') continue;
                if (MissionBriefingManager.isEpisodicEventReport(e.content, e.title)) continue;

                const name = this.normalizeSectionName(id, e.title);
                if (sections.some(s => s.name === name)) continue;

                sections.push({
                    name,
                    title: this.formatSectionTitle(name, e.title),
                    content: this.capSectionContent(name, String(e.content)),
                    relatedFiles: Array.isArray(e.relatedFiles) ? e.relatedFiles : this.extractFilePathsFromText(String(e.content)),
                    updatedAt: e.updatedAt || now
                });
            }
        }

        return {
            version: 2,
            sections: this.ensureDescriptionFirst(sections),
            lastCompactedAt: parsed.lastCompactedAt || 0
        };
    }

    public async loadStore(workspaceFolder?: vscode.WorkspaceFolder): Promise<ProjectBriefingStore> {
        const uri = this.getStoreUri(workspaceFolder);
        if (uri) {
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
                if (parsed && typeof parsed === 'object') {
                    if (Array.isArray(parsed.sections)) {
                        const store: ProjectBriefingStore = {
                            version: 2,
                            sections: this.ensureDescriptionFirst(
                                parsed.sections.map((s: any) => ({
                                    name: this.normalizeSectionName(s.name || '', s.title),
                                    title: this.formatSectionTitle(this.normalizeSectionName(s.name || '', s.title), s.title),
                                    content: this.capSectionContent(this.normalizeSectionName(s.name || '', s.title), String(s.content || '')),
                                    relatedFiles: Array.isArray(s.relatedFiles) ? s.relatedFiles : this.extractFilePathsFromText(String(s.content || '')),
                                    updatedAt: s.updatedAt || Date.now()
                                }))
                            ),
                            lastCompactedAt: parsed.lastCompactedAt || 0
                        };
                        this.cachedStore = store;
                        return store;
                    }
                    const migrated = this.migrateLegacyStore(parsed);
                    this.cachedStore = migrated;
                    return migrated;
                }
            } catch {}
        }

        const legacyText = this.context.workspaceState.get<string>(MissionBriefingManager.WORKSPACE_STATE_KEY, '').trim();
        const empty = this.createEmptyStore();
        if (legacyText) {
            const parsedFromText = this.parseRenderedOrRawText(legacyText, empty);
            if (uri) {
                await this.saveStore(parsedFromText, workspaceFolder);
            }
            this.cachedStore = parsedFromText;
            return parsedFromText;
        }
        this.cachedStore = empty;
        return empty;
    }

    public async saveStore(store: ProjectBriefingStore, workspaceFolder?: vscode.WorkspaceFolder): Promise<string> {
        store.sections = this.ensureDescriptionFirst(store.sections);
        this.enforceTotalSizeCap(store);
        this.cachedStore = store;
        const rendered = this.renderStore(store);

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

    /**
     * Enforces hard cap on section count and total rendered character length.
     * The mandatory `description` section is always preserved first.
     */
    private enforceTotalSizeCap(store: ProjectBriefingStore): void {
        store.sections = this.ensureDescriptionFirst(store.sections);

        // Cap individual section sizes first
        for (const sec of store.sections) {
            sec.content = this.capSectionContent(sec.name, sec.content);
        }

        // Evict oldest non-description sections if exceeding MAX_SECTIONS
        while (store.sections.length > MissionBriefingManager.MAX_SECTIONS) {
            const removable = store.sections
                .filter(s => s.name !== MissionBriefingManager.DESCRIPTION_SECTION)
                .sort((a, b) => a.updatedAt - b.updatedAt);
            if (removable.length === 0) break;
            const victim = removable[0];
            store.sections = store.sections.filter(s => s.name !== victim.name);
        }

        // Evict oldest non-description sections if total rendered size exceeds MAX_TOTAL_CHARS
        while (
            store.sections.length > 1 &&
            this.renderStore(store).length > MissionBriefingManager.MAX_TOTAL_CHARS
        ) {
            const removable = store.sections
                .filter(s => s.name !== MissionBriefingManager.DESCRIPTION_SECTION)
                .sort((a, b) => a.updatedAt - b.updatedAt);
            if (removable.length === 0) break;
            const victim = removable[0];
            store.sections = store.sections.filter(s => s.name !== victim.name);
        }
    }

    /**
     * Adds or updates a single named section without disturbing other sections.
     */
    public async upsertSection(
        sectionName: string,
        content: string,
        options?: {
            title?: string;
            relatedFiles?: string[];
            mode?: 'add' | 'edit' | 'upsert';
            workspaceFolder?: vscode.WorkspaceFolder;
        }
    ): Promise<string> {
        const store = await this.loadStore(options?.workspaceFolder);
        const cleanContent = (content || '').trim();
        if (!cleanContent) {
            return this.renderStore(store);
        }

        const normName = this.normalizeSectionName(sectionName, options?.title);

        if (
            normName !== MissionBriefingManager.DESCRIPTION_SECTION &&
            MissionBriefingManager.isEpisodicEventReport(cleanContent, options?.title || normName)
        ) {
            Logger.info(`[MissionBriefingManager] Rejected episodic event report for section '${normName}'.`);
            return this.renderStore(store);
        }

        const title = this.formatSectionTitle(normName, options?.title);
        const boundedContent = this.capSectionContent(normName, cleanContent);
        const detectedFiles = this.extractFilePathsFromText(boundedContent);
        const relatedFiles = Array.from(new Set([...(options?.relatedFiles || []), ...detectedFiles]));
        const now = Date.now();

        const existingIdx = store.sections.findIndex(s => s.name === normName);
        if (existingIdx !== -1) {
            store.sections[existingIdx] = {
                ...store.sections[existingIdx],
                title: normName === MissionBriefingManager.DESCRIPTION_SECTION ? 'Description' : (options?.title?.trim() || store.sections[existingIdx].title),
                content: boundedContent,
                relatedFiles: relatedFiles.length > 0 ? relatedFiles : store.sections[existingIdx].relatedFiles,
                updatedAt: now
            };
        } else {
            const newSection: BriefingSection = {
                name: normName,
                title,
                content: boundedContent,
                relatedFiles,
                updatedAt: now
            };
            if (normName === MissionBriefingManager.DESCRIPTION_SECTION) {
                store.sections.unshift(newSection);
            } else {
                store.sections.push(newSection);
            }
        }

        return await this.saveStore(store, options?.workspaceFolder);
    }

    public async deleteSection(sectionOrTitle: string, workspaceFolder?: vscode.WorkspaceFolder): Promise<string> {
        const store = await this.loadStore(workspaceFolder);
        const clean = this.normalizeSectionName(sectionOrTitle);
        if (clean === MissionBriefingManager.DESCRIPTION_SECTION) {
            Logger.warn(`[MissionBriefingManager] Blocked attempt to delete mandatory 'description' section.`);
            return this.renderStore(store);
        }

        const rawLower = (sectionOrTitle || '').toLowerCase().trim();
        store.sections = store.sections.filter(s =>
            s.name !== clean &&
            s.name.toLowerCase() !== rawLower &&
            s.title.toLowerCase() !== rawLower
        );
        return await this.saveStore(store, workspaceFolder);
    }

    /**
     * Backward-compatible wrapper routing keyed entries to sections.
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
        const sectionName = this.normalizeSectionName(input.id || '', input.title);
        return await this.upsertSection(sectionName, input.content, {
            title: input.title,
            relatedFiles: input.relatedFiles,
            mode: 'upsert',
            workspaceFolder: options?.workspaceFolder
        });
    }

    public async removeEntry(idOrTitle: string, workspaceFolder?: vscode.WorkspaceFolder): Promise<string> {
        return await this.deleteSection(idOrTitle, workspaceFolder);
    }

    /**
     * Applies a <mission_briefing> mutation (add | edit | delete | write | patch | upsert | remove).
     */
    public async applyUpdate(
        content: string,
        action: 'add' | 'edit' | 'delete' | 'write' | 'patch' | 'upsert' | 'remove' = 'upsert',
        meta?: { category?: BriefingCategory; id?: string; section?: string; title?: string; isUserModalSave?: boolean },
        workspaceFolder?: vscode.WorkspaceFolder
    ): Promise<string> {
        const store = await this.loadStore(workspaceFolder);
        const trimmed = (content || '').trim();
        const targetSection = (meta?.section || meta?.id || '').trim();

        if (action === 'delete' || action === 'remove') {
            const nameToDelete = targetSection || meta?.title || trimmed;
            if (!nameToDelete) return this.renderStore(store);
            return await this.deleteSection(nameToDelete, workspaceFolder);
        }

        if (action === 'add' || action === 'edit' || action === 'upsert') {
            // Support Aider SEARCH/REPLACE patch inside an edit section call
            if (action === 'edit' && trimmed.includes('<<<<<<< SEARCH')) {
                const normName = this.normalizeSectionName(targetSection || MissionBriefingManager.DESCRIPTION_SECTION, meta?.title);
                const existing = store.sections.find(s => s.name === normName);
                if (existing) {
                    const { normalizeAiderContent, parseAiderHunks, applySearchReplace } = require('./utils');
                    const hunks = parseAiderHunks(normalizeAiderContent(trimmed));
                    if (hunks.length > 0) {
                        let patched = existing.content;
                        let anyApplied = false;
                        for (const h of hunks) {
                            const res = applySearchReplace(patched, h.searchPart, h.replacePart);
                            if (res.success) {
                                patched = res.result;
                                anyApplied = true;
                            }
                        }
                        if (anyApplied) {
                            return await this.upsertSection(normName, patched, { title: meta?.title || existing.title, workspaceFolder });
                        }
                    }
                }
            }

            const effectiveSection = targetSection || (meta?.title ? this.normalizeSectionName('', meta.title) : (store.sections.length === 0 ? MissionBriefingManager.DESCRIPTION_SECTION : ''));
            if (!effectiveSection) {
                Logger.warn('[MissionBriefingManager] Ignored add/edit without a target section name.');
                return this.renderStore(store);
            }
            return await this.upsertSection(effectiveSection, trimmed, { title: meta?.title, mode: action, workspaceFolder });
        }

        if (action === 'patch') {
            const { normalizeAiderContent, parseAiderHunks, applySearchReplace } = require('./utils');
            const normalizedAider = normalizeAiderContent(trimmed);
            const hunks = parseAiderHunks(normalizedAider);
            const normTarget = targetSection ? this.normalizeSectionName(targetSection, meta?.title) : '';

            if (hunks.length > 0) {
                // Target either the named section or search across sections to patch in place
                const candidates = normTarget
                    ? store.sections.filter(s => s.name === normTarget)
                    : store.sections;
                for (const sec of candidates) {
                    let updated = sec.content;
                    let applied = false;
                    for (const h of hunks) {
                        const res = applySearchReplace(updated, h.searchPart, h.replacePart);
                        if (res.success) {
                            updated = res.result;
                            applied = true;
                        }
                    }
                    if (applied) {
                        return await this.upsertSection(sec.name, updated, { title: sec.title, workspaceFolder });
                    }
                }
                const additions = hunks.map((h: any) => h.replacePart || '').filter(Boolean).join('\n').trim();
                if (additions && (normTarget || meta?.title)) {
                    return await this.upsertSection(normTarget || '', additions, { title: meta?.title, workspaceFolder });
                }
            }

            if (normTarget || meta?.title) {
                return await this.upsertSection(normTarget || '', trimmed, { title: meta?.title, workspaceFolder });
            }
            return this.renderStore(store);
        }

        // action === 'write':
        // Only overwrite the entire store when explicitly saved by the user in the modal OR when parsing ### sections cleanly.
        if (targetSection && !meta?.isUserModalSave) {
            return await this.upsertSection(targetSection, trimmed, { title: meta?.title, workspaceFolder });
        }

        if (!trimmed) {
            if (meta?.isUserModalSave) {
                store.sections = [];
                return await this.saveStore(store, workspaceFolder);
            }
            return this.renderStore(store);
        }

        const parsed = this.parseRenderedOrRawText(trimmed, store);
        return await this.saveStore(parsed, workspaceFolder);
    }

    private parseRenderedOrRawText(text: string, existingStore: ProjectBriefingStore): ProjectBriefingStore {
        const hasSectionHeaders = /^###\s+/m.test(text);
        if (!hasSectionHeaders) {
            // Treat plain prose as the mandatory 'description' section, preserving other sections if already present
            const updatedSections = existingStore.sections.filter(s => s.name !== MissionBriefingManager.DESCRIPTION_SECTION);
            updatedSections.unshift({
                name: MissionBriefingManager.DESCRIPTION_SECTION,
                title: 'Description',
                content: this.capSectionContent(MissionBriefingManager.DESCRIPTION_SECTION, text.trim()),
                relatedFiles: this.extractFilePathsFromText(text),
                updatedAt: Date.now()
            });
            return {
                version: 2,
                sections: this.ensureDescriptionFirst(updatedSections),
                lastCompactedAt: existingStore.lastCompactedAt
            };
        }

        const nextSections: BriefingSection[] = [];
        const rawBlocks = text.split(/(?=^###\s+)/m);
        const now = Date.now();

        for (const block of rawBlocks) {
            const lines = block.trim().split('\n');
            const headerLine = (lines[0] || '').replace(/^###\s+/, '').trim();
            const body = lines.slice(1).join('\n').trim();
            if (!headerLine || !body) continue;

            const slugMatch = headerLine.match(/\[`([^`]+)`\]/);
            const cleanTitle = headerLine
                .replace(/\[`[^`]+`\]/g, '')
                .replace(/^[\p{Emoji}\u2600-\u27BF\uFE0F\s]+/u, '')
                .trim();

            const name = this.normalizeSectionName(slugMatch ? slugMatch[1] : '', cleanTitle);
            if (nextSections.some(s => s.name === name)) continue;

            nextSections.push({
                name,
                title: this.formatSectionTitle(name, cleanTitle),
                content: this.capSectionContent(name, body),
                relatedFiles: this.extractFilePathsFromText(body),
                updatedAt: now
            });
        }

        return {
            version: 2,
            sections: this.ensureDescriptionFirst(nextSections),
            lastCompactedAt: existingStore.lastCompactedAt
        };
    }

    /**
     * Prunes sections whose referenced files no longer exist on disk, enforces size caps,
     * and optionally consolidates via LLM when forced.
     */
    public async compactStore(workspaceFolder?: vscode.WorkspaceFolder, force: boolean = false): Promise<{
        rendered: string;
        prunedStaleCount: number;
        deduplicatedCount: number;
        compactedViaLlm: boolean;
    }> {
        const store = await this.loadStore(workspaceFolder);
        let prunedStaleCount = 0;
        let deduplicatedCount = 0;
        let compactedViaLlm = false;

        const folder = workspaceFolder || vscode.workspace.workspaceFolders?.[0];

        // 1. Prune episodic reports & sections referencing exclusively deleted files (except mandatory description)
        const surviving: BriefingSection[] = [];
        for (const sec of store.sections) {
            if (sec.name === MissionBriefingManager.DESCRIPTION_SECTION) {
                surviving.push(sec);
                continue;
            }
            if (MissionBriefingManager.isEpisodicEventReport(sec.content, sec.title)) {
                prunedStaleCount++;
                continue;
            }
            const files = sec.relatedFiles || [];
            if (folder && files.length > 0) {
                let anyExists = false;
                for (const rel of files) {
                    const cleanRel = rel.replace(/\\/g, '/').replace(/^\.?\//, '');
                    try {
                        await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, cleanRel));
                        anyExists = true;
                        break;
                    } catch {}
                }
                if (!anyExists) {
                    prunedStaleCount++;
                    continue;
                }
            }
            surviving.push(sec);
        }
        store.sections = surviving;

        // 2. Deduplicate by section name
        const deduped: BriefingSection[] = [];
        const seenNames = new Set<string>();
        for (const sec of store.sections) {
            if (seenNames.has(sec.name)) {
                deduplicatedCount++;
                continue;
            }
            seenNames.add(sec.name);
            deduped.push(sec);
        }
        store.sections = deduped;

        // 3. Optional AI condensation when forced or bloated
        const currentLen = this.renderStore(store).length;
        if ((force || currentLen > MissionBriefingManager.MAX_TOTAL_CHARS) && store.sections.length > 2 && this.lollmsAPI) {
            try {
                const prompt = `Compact these project architecture briefing sections so total size is concise (< ${MissionBriefingManager.MAX_TOTAL_CHARS} chars).
RULES:
1. Keep 'description' as the FIRST section (general project purpose and main features).
2. Each section must describe timeless factual project workings (e.g., which files handle which actions/endpoints/modules).
3. Remove ALL episodic events, failure logs, session summaries, or task statuses.
SECTIONS (JSON):
${JSON.stringify(store.sections.map(s => ({ name: s.name, title: s.title, content: s.content })))}
Output ONLY a valid JSON array of { "name", "title", "content" }.`;

                const resp = await this.lollmsAPI.sendChat([
                    { role: 'system', content: 'Output ONLY a valid JSON array. Zero prose.' },
                    { role: 'user', content: prompt }
                ], null, undefined, undefined, { thinking: false });

                const clean = stripThinkingTags(resp).trim();
                const jsonMatch = clean.match(/\[[\s\S]*\]/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        const now = Date.now();
                        store.sections = this.ensureDescriptionFirst(
                            parsed.slice(0, MissionBriefingManager.MAX_SECTIONS).map((item: any) => {
                                const name = this.normalizeSectionName(String(item.name || ''), String(item.title || ''));
                                const content = this.capSectionContent(name, String(item.content || ''));
                                return {
                                    name,
                                    title: this.formatSectionTitle(name, String(item.title || '')),
                                    content,
                                    relatedFiles: this.extractFilePathsFromText(content),
                                    updatedAt: now
                                };
                            })
                        );
                        store.lastCompactedAt = now;
                        compactedViaLlm = true;
                    }
                }
            } catch (err: any) {
                Logger.warn(`[MissionBriefingManager] Consolidation fallback: ${err.message}`);
            }
        }

        this.enforceTotalSizeCap(store);
        const rendered = await this.saveStore(store, workspaceFolder);
        return { rendered, prunedStaleCount, deduplicatedCount, compactedViaLlm };
    }

    public async clearAll(workspaceFolder?: vscode.WorkspaceFolder): Promise<void> {
        const empty = this.createEmptyStore();
        await this.saveStore(empty, workspaceFolder);
    }

    public renderStore(store: ProjectBriefingStore): string {
        if (!store || !Array.isArray(store.sections) || store.sections.length === 0) {
            return '';
        }

        const ordered = this.ensureDescriptionFirst(store.sections);
        return ordered.map(sec => {
            if (sec.name === MissionBriefingManager.DESCRIPTION_SECTION) {
                return `### 📖 Description [\`description\`]\n${sec.content.trim()}`;
            }
            return `### 🧩 ${sec.title} [\`${sec.name}\`]\n${sec.content.trim()}`;
        }).join('\n\n').trim();
    }
}