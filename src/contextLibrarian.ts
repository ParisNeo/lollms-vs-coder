import * as vscode from 'vscode';
import * as path from 'path';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { ContextManager, ContextResult } from './contextManager';
import { DiscussionManager, Discussion } from './discussionManager';
import { DiscussionCapabilities, stripThinkingTags, extractFileBlocks, parseFileTagAttributes, applySearchReplace, normalizeAiderContent, parseAiderHunks } from './utils';
import { Logger } from './logger';

export interface MultiPartPhase {
    partIndex: number;
    totalParts: number;
    editFiles: string[];
    partInstruction: string;
}

export interface MultiPartPlan {
    totalParts: number;
    currentPartIndex: number;
    parts: MultiPartPhase[];
}

export interface GovernorArbitrationResult {
    selectedFilesContent: string;
    messagesToSend: ChatMessage[];
    totalTokens: number;
    contextSize: number;
    history: ChatMessage[];
    chunkingNotice?: string;
    signatures?: string;
    governorReport?: string;
    multiPartPlan?: MultiPartPlan;
}

export type LibrarianArbitrationResult = GovernorArbitrationResult;

export interface ArbitrateOptions {
    lollmsAPI: LollmsAPI;
    contextManager: ContextManager;
    discussionManager: DiscussionManager;
    currentDiscussion: Discussion;
    contextData: ContextResult;
    baseInstructions: string;
    history: ChatMessage[];
    currentPromptMessage: ChatMessage | undefined;
    userPromptText: string;
    targetModel: string;
    capabilities: DiscussionCapabilities;
    currentPromptAddedFiles: Set<string>;
    signal: AbortSignal;
    governorDirectives?: string[];
    isMultiPartContinuation?: boolean;
    onStatusUpdate?: (status: string) => void;
    onAddMessage?: (message: ChatMessage) => Promise<void>;
    onUpdateMessage?: (messageId: string, content: string) => Promise<void>;
}

interface ParsedFileCandidate {
    fullMatch: string;
    path: string;
    tokens: number;
    bytes: number;
    linesCount: number;
    isCurrentPromptFile: boolean;
    isCoreOrInterface: boolean;
    relevanceScore: number;
    matchedKeywords: string[];
    extractedSymbols: string[];
    keep: boolean;
    role: 'edit' | 'context' | 'unneeded';
    isNewlyAdded?: boolean;
    justification?: string;
    evictionReason?: string;
}

export class ContextLibrarian {
    private static readonly STOP_WORDS = new Set([
        'the', 'and', 'for', 'with', 'this', 'that', 'from', 'your', 'will', 'have', 'been', 'should',
        'what', 'when', 'where', 'which', 'who', 'how', 'why', 'can', 'could', 'would', 'file', 'files',
        'code', 'function', 'class', 'const', 'let', 'var', 'import', 'export', 'return', 'true', 'false',
        'null', 'undefined', 'async', 'await', 'type', 'interface', 'please', 'help', 'need', 'want', 'like'
    ]);

    public static isBroadOrStructuralQuery(prompt: string): boolean {
        const lower = prompt.toLowerCase();
        const structuralPatterns = [
            'structure', 'overview', 'explain the project', 'explain this project',
            'explain the code', 'explain this code', 'explain the app', 'explain this app',
            'architecture', 'how does this work', 'how does the app work', 'how does the project work',
            'walk me through', 'understand the project', 'understand the codebase',
            'summarize the project', 'codebase summary', 'audit project', 'code review',
            'what does this project do', 'what does this app do', 'system design',
            'map of the project', 'explore the project', 'project layout', 'analyze the structure'
        ];
        return structuralPatterns.some(p => lower.includes(p));
    }

    public static isClutterOrCosmeticFile(filePath: string): boolean {
        const lower = filePath.toLowerCase();
        return lower.endsWith('.min.css') ||
               lower.endsWith('.min.js') ||
               lower.endsWith('.map') ||
               lower.endsWith('.bundle.js') ||
               lower.includes('/vendor/') ||
               (lower.endsWith('.css') && !lower.includes('custom') && !lower.includes('main'));
    }

    public static async getStructureGuide(): Promise<string> {
        const folders = vscode.workspace.workspaceFolders || [];
        if (folders.length === 0) return "";
        try {
            const rootKnowledge = vscode.Uri.joinPath(folders[0].uri, '.lollms', 'KNOWLEDGE.md');
            const bytes = await vscode.workspace.fs.readFile(rootKnowledge);
            const text = Buffer.from(bytes).toString('utf8');
            if (text.trim()) return text;
        } catch {}

        try {
            const structUri = vscode.Uri.joinPath(folders[0].uri, '.lollms', 'structure.md');
            const bytes = await vscode.workspace.fs.readFile(structUri);
            return Buffer.from(bytes).toString('utf8');
        } catch {
            return "";
        }
    }

    public static cleanStructureContent(content: string): string {
        if (!content) return "";
        const lines = content.split('\n');
        const cleanedLines: string[] = [];
        let skippingMuteSection = false;

        for (const line of lines) {
            const lower = line.toLowerCase().trim();
            if (lower.match(/^#+\s*(?:muted\s+files|active\s+files|files\s+kept|files\s+to\s+edit|priority\s+edit\s+files|evicted\s+files|token\s+budget|governor\s+selection|librarian\s+selection|session\s+events)/i)) {
                skippingMuteSection = true;
                continue;
            }
            if (skippingMuteSection && lower.startsWith('#')) {
                skippingMuteSection = false;
            }
            if (skippingMuteSection) continue;

            if (lower.match(/^(?:-\s*)?(?:i(?:'ll| will)\s+keep\s+.*(?:muted|active)|priority\s+edit\s+files|files?\s+kept\s+active|muted\s+files?|total\s+budget:|budget\s+remaining:)/i)) {
                continue;
            }
            if (lower.includes('kept with structure') || lower.includes('muted with structure') || lower.includes('keep active or reference')) {
                continue;
            }

            cleanedLines.push(line);
        }
        return cleanedLines.join('\n').trim();
    }

    public static async saveStructureGuide(content: string): Promise<boolean> {
        const folders = vscode.workspace.workspaceFolders || [];
        if (folders.length === 0 || !content.trim()) return false;
        try {
            const cleaned = this.cleanStructureContent(content);
            if (!cleaned.trim()) return false;
            const lollmsDir = vscode.Uri.joinPath(folders[0].uri, '.lollms');
            await vscode.workspace.fs.createDirectory(lollmsDir);

            const knowledgeUri = vscode.Uri.joinPath(lollmsDir, 'KNOWLEDGE.md');
            await vscode.workspace.fs.writeFile(knowledgeUri, Buffer.from(cleaned, 'utf8'));

            const structUri = vscode.Uri.joinPath(lollmsDir, 'structure.md');
            await vscode.workspace.fs.writeFile(structUri, Buffer.from(cleaned, 'utf8'));
            return true;
        } catch (err: any) {
            Logger.warn("Failed to write .lollms/KNOWLEDGE.md", err);
            return false;
        }
    }

    /**
     * Surgically patches or updates .lollms/structure.md so obsolete findings are replaced.
     */
    public static async updateStructureGuide(
        content: string, 
        action: 'write' | 'patch' = 'write'
    ): Promise<{ success: boolean; content: string; error?: string }> {
        const folders = vscode.workspace.workspaceFolders || [];
        if (folders.length === 0 || !content.trim()) {
            return { success: false, content: '', error: 'No workspace folder open or empty content.' };
        }

        const currentStructure = await this.getStructureGuide();
        let updatedText = "";

        const isPatch = action === 'patch' || content.includes('<<<<<<< SEARCH');

        if (isPatch && currentStructure.trim().length > 0) {
            const normalizedAider = normalizeAiderContent(content);
            const hunks = parseAiderHunks(normalizedAider);

            if (hunks.length > 0) {
                updatedText = currentStructure;
                let anyHunkApplied = false;
                for (const hunk of hunks) {
                    const res = applySearchReplace(updatedText, hunk.searchPart, hunk.replacePart);
                    if (res.success) {
                        updatedText = res.result;
                        anyHunkApplied = true;
                    }
                }
                if (!anyHunkApplied) {
                    const additions = hunks.map((h: any) => h.replacePart || '').filter(Boolean).join('\n\n');
                    updatedText = `${currentStructure.trim()}\n\n${additions}`.trim();
                }
            } else {
                updatedText = currentStructure ? `${currentStructure.trim()}\n\n${content.trim()}` : content.trim();
            }
        } else {
            updatedText = content.trim();
        }

        const saved = await this.saveStructureGuide(updatedText);
        return { success: saved, content: updatedText };
    }

    public static async filterFilesByPrompt(options: {
        lollmsAPI: LollmsAPI;
        contextManager: ContextManager;
        discussionManager: DiscussionManager;
        currentDiscussion: Discussion;
        targetModel: string;
        prompt: string;
        signal: AbortSignal;
        candidateFiles?: string[];
        currentMutedFiles?: string[];
        history?: any[];
        customCapacity?: number;
        targetPercent?: number;
        reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
        pruneMsgId?: string;
        onStatusUpdate?: (status: string) => void;
        onRoundProgress?: (progress: { round: number; maxRounds: number; status: string; discoverySteps?: any[] }) => void;
        onStreamChunk?: (data: { round: number; maxRounds: number; chunk: string; fullText: string; messageId: string }) => void;
        onDiscoveryAction?: (data: { type: string; label: string; detail?: string; output?: string }) => void;
        onUpdateMessage?: (messageId: string, content: string) => Promise<void>;
    }): Promise<{
        keptFiles: string[];
        mutedFiles: string[];
        addedFiles: string[];
        rationale: string;
        advice?: string;
        signatures?: string;
        governorReport?: string;
        discoverySteps?: { type: string; label: string; detail?: string }[];
        totalTokens: number;
        liberatedTokens: number;
        roundsUsed: number;
        maxRounds: number;
        multiPartPlan?: MultiPartPlan;
    }> {
        const { lollmsAPI, contextManager, targetModel, prompt, signal, candidateFiles, onStatusUpdate, onRoundProgress, onStreamChunk, onDiscoveryAction } = options;

        const provider = contextManager.getContextStateProvider();
        let rawIncluded: { path: string; state?: any; bytes?: number; tokens?: number }[] = [];
        if (candidateFiles !== undefined) {
            rawIncluded = candidateFiles.map(p => ({ path: p, state: 'included' as any }));
        } else {
            rawIncluded = provider ? provider.getIncludedFiles().filter(f => f && f.path) : [];
        }

        if (onStatusUpdate) onStatusUpdate("Librarian: Initializing token budget & reading files...");

        const isStructural = this.isBroadOrStructuralQuery(prompt);
        const keywords = this.extractQueryKeywords(prompt, []);
        const fileCandidates: ParsedFileCandidate[] = [];
        const newlyAddedFiles: string[] = [];

        for (const f of rawIncluded) {
            if (signal.aborted) throw new Error("Operation cancelled");
            let text = "";
            let bytesCount = f.bytes || 0;
            const cached = (contextManager as any)._fileContentCache?.get(f.path);
            if (cached?.content) {
                text = cached.content;
                bytesCount = cached.size || cached.content.length;
            } else {
                const res = await contextManager.resolveWorkspaceFromPath(f.path);
                if (res) {
                    try {
                        const fileBytes = await vscode.workspace.fs.readFile(res.uri);
                        text = Buffer.from(fileBytes).toString('utf8');
                        bytesCount = fileBytes.length;
                    } catch {}
                }
            }

            const tokens = f.tokens || Math.max(1, Math.ceil(bytesCount > 0 ? bytesCount / 3.5 : text.length / 3.5));
            const candidate = this.buildCandidate("", f.path, text, tokens, new Set(), keywords, contextManager);
            candidate.bytes = bytesCount || Math.round(tokens * 3.5);
            candidate.linesCount = text.split('\n').length;

            if (isStructural) {
                const lowerPath = f.path.toLowerCase();
                const isCoreSourceCode = lowerPath.endsWith('.js') || lowerPath.endsWith('.ts') ||
                                         lowerPath.endsWith('.py') || lowerPath.endsWith('.html') ||
                                         lowerPath.endsWith('.json') || lowerPath.endsWith('.md');
                if (isCoreSourceCode && !this.isClutterOrCosmeticFile(f.path)) {
                    candidate.relevanceScore += 1000;
                    candidate.isCoreOrInterface = true;
                }
            }

            fileCandidates.push(candidate);
        }

        const maxTokensRes = await lollmsAPI.getContextSize(targetModel).catch(() => null);
        const modelMaxTokens = (maxTokensRes && maxTokensRes.context_size > 0)
            ? maxTokensRes.context_size
            : (options.currentDiscussion?.lastTokenMetrics?.contextSize || 128000);

        const maxTokens = (typeof options.customCapacity === 'number' && options.customCapacity > 0)
            ? options.customCapacity
            : modelMaxTokens;

        const targetPercent = (typeof options.targetPercent === 'number' && options.targetPercent > 0)
            ? options.targetPercent
            : (options.currentDiscussion?.capabilities?.contextGovernorTargetThreshold || 70);
        const targetBudget = Math.round(maxTokens * (targetPercent / 100));

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const configuredRounds = options.currentDiscussion?.capabilities?.contextGovernorMaxRounds;
        const fallbackConfigRounds = config.get<number>('contextGovernorMaxRounds');
        const effectiveRounds = (configuredRounds && configuredRounds >= 1) ? configuredRounds : (fallbackConfigRounds || 5);
        const maxRounds = Math.min(20, Math.max(2, effectiveRounds));

        const totalCandidateTokens = fileCandidates.reduce((sum, c) => sum + c.tokens, 0);

        const negotiationResult = await this.runGovernorNegotiation({
            lollmsAPI,
            contextManager,
            targetModel,
            signal,
            userPromptText: prompt,
            fileCandidates,
            currentMuted: options.currentMutedFiles || [],
            totalEstimated: totalCandidateTokens,
            maxTokens,
            triggerThresholdPercent: targetPercent,
            objectiveThresholdPercent: targetPercent,
            objectiveThreshold: targetBudget,
            overflow: Math.max(0, totalCandidateTokens - targetBudget),
            canAvoidEvictingCurrentPrompt: false,
            keywords,
            maxRounds,
            pruneMsgId: options.pruneMsgId,
            optionsUpdateMessage: options.onUpdateMessage,
            onStatusUpdate,
            onStreamChunk,
            onDiscoveryAction,
            onRoundProgress
        });

        const { decision, workerAdvice, signatures, governorReport, discoverySteps, addedFiles, multiPartPlan } = negotiationResult;

        const keptFiles: string[] = [];
        const mutedFiles: string[] = [];
        let totalTokens = 0;
        let liberatedTokens = 0;

        const hasEditFiles = fileCandidates.some(c => c.role === 'edit');
        for (const candidate of fileCandidates) {
            // Mandate: Only load files that are needed for patching exactly. Reference files are compressed into the report and kept muted.
            const keep = candidate.role === 'edit' || (!hasEditFiles && candidate.role === 'context' && decision?.status === 'fit_all');
            if (keep) {
                keptFiles.push(candidate.path);
                totalTokens += candidate.tokens;
            } else {
                mutedFiles.push(candidate.path);
                liberatedTokens += candidate.tokens;
            }
        }

        return {
            keptFiles,
            mutedFiles,
            addedFiles: addedFiles || newlyAddedFiles,
            rationale: decision?.rationale || workerAdvice || `Context optimized for target budget (${targetBudget.toLocaleString()} tok).`,
            advice: workerAdvice,
            signatures,
            governorReport,
            discoverySteps,
            totalTokens,
            liberatedTokens,
            roundsUsed: negotiationResult.roundsUsed || 1,
            maxRounds,
            multiPartPlan
        };
    }

    public static async arbitrate(options: ArbitrateOptions): Promise<GovernorArbitrationResult | null> {
        const {
            lollmsAPI,
            contextManager,
            discussionManager,
            currentDiscussion,
            contextData,
            baseInstructions,
            currentPromptMessage,
            userPromptText,
            targetModel,
            capabilities,
            currentPromptAddedFiles,
            signal,
            isMultiPartContinuation,
            onStatusUpdate,
            onAddMessage
        } = options;

        let history = [...options.history];

        const ctxSizeRes = await lollmsAPI.getContextSize(targetModel).catch(() => null);
        const authoritativeMaxTokens = (ctxSizeRes && ctxSizeRes.context_size > 0)
            ? ctxSizeRes.context_size
            : (currentDiscussion?.lastTokenMetrics?.contextSize || 128000);

        const maxTokens = authoritativeMaxTokens;
        const triggerThresholdPercent = capabilities.contextGovernorThreshold !== undefined ? capabilities.contextGovernorThreshold : 95;
        const triggerThreshold = Math.round(maxTokens * (triggerThresholdPercent / 100));

        const objectiveThresholdPercent = capabilities.contextGovernorTargetThreshold !== undefined
            ? capabilities.contextGovernorTargetThreshold
            : Math.min(triggerThresholdPercent, 70);
        const objectiveThreshold = Math.round(maxTokens * (objectiveThresholdPercent / 100));

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const configuredRounds = capabilities.contextGovernorMaxRounds;
        const fallbackConfigRounds = config.get<number>('contextGovernorMaxRounds');
        const effectiveRounds = (configuredRounds && configuredRounds >= 1) ? configuredRounds : (fallbackConfigRounds || 5);
        const maxNegotiationRounds = Math.min(20, Math.max(2, effectiveRounds));
        const hardCap120 = Math.round(maxTokens * 1.2);

        const getCleanHistoryText = (msgs: ChatMessage[]) => msgs
            .filter(m => !m.skipInPrompt)
            .map(m => {
                const c = m.content;
                if (typeof c === 'string') return stripThinkingTags(c);
                if (Array.isArray(c)) return c.filter((p: any) => p && p.type === 'text').map((p: any) => stripThinkingTags(p.text)).join('\n');
                return '';
            }).filter(t => t.trim().length > 0).join('\n');

        const cleanUserPromptText = (userPromptText || '')
            .replace(/data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=]{50,}/g, '[Attached Image]')
            .trim();

        const systemTokens = Math.ceil((baseInstructions || '').length / 3.5);
        let historyTokens = Math.ceil(getCleanHistoryText(history).length / 3.5);
        const treeTokens = Math.ceil((contextData.projectTree || '').length / 3.5);
        const skillsTokens = Math.ceil((contextData.skillsContent || '').length / 3.5);
        const { KnowledgeManager } = require('./knowledgeManager');
        const km = new KnowledgeManager(this.context);
        const knowledgeContent = await km.renderContextKnowledge();
        const briefingContent = knowledgeContent || contextManager.renderBriefing(currentDiscussion);
        const briefingTokens = Math.ceil((briefingContent || '').length / 3.5);
        const promptTokens = Math.ceil(cleanUserPromptText.length / 3.5);

        const { estimateImageTokens } = require('./utils');
        const visionCostPerImage = estimateImageTokens(targetModel) || 600;
        let visionTokens = 0;
        if (capabilities.enableImages !== false) {
            if (contextData.images) {
                visionTokens += contextData.images.length * visionCostPerImage;
            }
            if (Array.isArray(currentPromptMessage?.content)) {
                const promptImages = currentPromptMessage.content.filter((p: any) => p && p.type === 'image_url');
                visionTokens += promptImages.length * visionCostPerImage;
            }
        }

        let fixedLoad = systemTokens + historyTokens + treeTokens + skillsTokens + briefingTokens + promptTokens + visionTokens;

        if (isMultiPartContinuation) {
            const passingTotal = fixedLoad + Math.ceil((contextData.selectedFilesContent || '').length / 3.5);
            return this.buildPassingResult(
                contextData, baseInstructions, history, currentPromptMessage, passingTotal, maxTokens,
                systemTokens, briefingTokens, treeTokens, skillsTokens, capabilities, briefingContent, userPromptText
            );
        }

        const provider = contextManager.getContextStateProvider();
        const allIncludedFiles = provider ? provider.getIncludedFiles().filter(f => f && f.path) : [];

        if (capabilities.contextGovernorEnabled === false) {
            const activeFilesTokens = Math.ceil((contextData.selectedFilesContent || '').length / 3.5);
            const totalLoad = fixedLoad + activeFilesTokens;
            if (totalLoad > maxTokens) {
                if (onAddMessage) {
                    await onAddMessage({
                        role: 'system',
                        content: `🛑 **Context Limit Exceeded (>100%)**\nActive context load (~${totalLoad.toLocaleString()} tokens) exceeds model capacity (**${maxTokens.toLocaleString()}** tokens).\n\nEnable Context Librarian in settings or mute unneeded files.`
                    });
                }
                return null;
            }
            return this.buildPassingResult(
                contextData, baseInstructions, history, currentPromptMessage, totalLoad, maxTokens,
                systemTokens, briefingTokens, treeTokens, skillsTokens, capabilities, briefingContent, userPromptText
            );
        }

        const currentMutedSet = new Set<string>();
        const addMuted = (list?: string[]) => {
            if (Array.isArray(list)) {
                list.forEach(p => {
                    if (p) currentMutedSet.add(p.replace(/\\/g, '/').toLowerCase().trim().replace(/^\.?\/+/, ''));
                });
            }
        };
        addMuted(currentDiscussion?.mutedFiles);
        addMuted(capabilities?.mutedFiles);
        const currentMuted = Array.from(currentMutedSet);

        const isCandidateMuted = (candidatePath: string): boolean => {
            return currentMuted.some(m => this.pathsMatch(m, candidatePath));
        };

        const { extractGovernorDirectives } = require('./utils');
        const extractedFromPrompt = extractGovernorDirectives(userPromptText);
        const allGovernorDirectives: string[] = [
            ...(options.governorDirectives || []),
            ...extractedFromPrompt.governorDirectives
        ];
        const hasGovernorDirective = allGovernorDirectives.length > 0;
        const keywords = this.extractQueryKeywords(`${userPromptText} ${allGovernorDirectives.join(' ')}`, history);

        const fileCandidates: ParsedFileCandidate[] = [];

        for (const f of allIncludedFiles) {
            let fullMatch = "";
            let fileBody = "";
            let tokens = (f as any).tokens || 0;
            let bytesCount = (f as any).bytes || 0;
            const isMuted = isCandidateMuted(f.path);

            const cached = (contextManager as any)._fileContentCache?.get(f.path);
            if (cached?.content) {
                fileBody = cached.content;
                bytesCount = cached.size || cached.content.length;
            } else {
                const res = await contextManager.resolveWorkspaceFromPath(f.path);
                if (res) {
                    try {
                        const fileBytes = await vscode.workspace.fs.readFile(res.uri);
                        fileBody = Buffer.from(fileBytes).toString('utf8');
                        bytesCount = fileBytes.length;
                    } catch {}
                }
            }

            tokens = tokens || Math.max(1, Math.ceil(fileBody.length / 3.5));

            if (!isMuted) {
                const formatted = fileBody.endsWith('\n') ? fileBody : fileBody + '\n';
                fullMatch = `<file path="${f.path}">\n${formatted}</file>

\n\n`;
            } else {
                fullMatch = `### 📄 \`${f.path}\` [M] [MUTED IN CONTEXT]\n> Content is currently muted to save context tokens (0 tokens). If you need to inspect or edit this file's code, output:\n> <unmute_files>\n> ${f.path}\n </unmute_files>\n\n`;
            }

            const candidate = this.buildCandidate(fullMatch, f.path, fileBody, tokens, currentPromptAddedFiles, keywords, contextManager);
            candidate.bytes = bytesCount || Math.round(tokens * 3.5);
            candidate.linesCount = fileBody.split('\n').length;
            fileCandidates.push(candidate);
        }

        const currentUnmutedTokens = fileCandidates.filter(c => !isCandidateMuted(c.path)).reduce((sum, c) => sum + c.tokens, 0);
        const totalCandidateTokens = fileCandidates.reduce((sum, c) => sum + c.tokens, 0);
        const activeContextLoad = fixedLoad + currentUnmutedTokens;

        if (!hasGovernorDirective && activeContextLoad <= triggerThreshold) {
            this.updateDiscussionMetrics(
                currentDiscussion, discussionManager, activeContextLoad, maxTokens,
                systemTokens, briefingTokens, treeTokens, skillsTokens, currentUnmutedTokens, historyTokens
            );

            return this.buildPassingResult(
                contextData, baseInstructions, history, currentPromptMessage, activeContextLoad, maxTokens,
                systemTokens, briefingTokens, treeTokens, skillsTokens, capabilities, briefingContent, userPromptText
            );
        }

        // Fast, deterministic budget balancing: Mute lowest-relevance candidates so active load fits budget.
        // Zero pre-turn LLM calls, zero wasted tokens! The assistant itself discovers what it needs in Stage 1.
        const overflow = Math.max(0, activeContextLoad - objectiveThreshold);
        const fallbackDecision = this.buildDeterministicFallback(
            fileCandidates,
            overflow,
            true,
            objectiveThresholdPercent,
            objectiveThreshold,
            currentMuted
        );

        const keptBlocks = fileCandidates.filter(c => c.keep);
        const mutedBlocks = fileCandidates.filter(c => !c.keep);

        currentDiscussion.mutedFiles = mutedBlocks.map(b => b.path);
        if (!currentDiscussion.id.startsWith('temp-')) {
            discussionManager.saveDiscussion(currentDiscussion).catch(() => {});
        }

        const newSelectedFilesContent = keptBlocks.map(b => {
            const formatted = (b as any).body ? ((b as any).body.endsWith('\n') ? (b as any).body : (b as any).body + '\n') : '';
            return formatted ? `<file path="${b.path}">\n${formatted}</file>

\n\n` : b.fullMatch;
        }).join('\n\n');

        const newActiveFilesTokens = keptBlocks.reduce((sum, b) => sum + b.tokens, 0);
        const newTotal = fixedLoad + newActiveFilesTokens;

        return this.buildPassingResult(
            contextData, baseInstructions, history, currentPromptMessage, newTotal, maxTokens,
            systemTokens, briefingTokens, treeTokens, skillsTokens, capabilities, briefingContent, userPromptText,
            contextData.governorReport, newSelectedFilesContent
        );
    }

    private static async runGovernorNegotiation(options: {
        lollmsAPI: LollmsAPI;
        contextManager: ContextManager;
        targetModel: string;
        signal: AbortSignal;
        userPromptText: string;
        fileCandidates: ParsedFileCandidate[];
        currentMuted: string[];
        totalEstimated: number;
        maxTokens: number;
        triggerThresholdPercent: number;
        objectiveThresholdPercent: number;
        objectiveThreshold: number;
        overflow: number;
        canAvoidEvictingCurrentPrompt: boolean;
        keywords: string[];
        maxRounds: number;
        governorDirectives?: string[];
        pruneMsgId?: string;
        onStatusUpdate?: (status: string) => void;
        onRoundProgress?: (progress: { round: number; maxRounds: number; status: string; discoverySteps?: any[] }) => void;
        onStreamChunk?: (data: { round: number; maxRounds: number; chunk: string; fullText: string; messageId: string }) => void;
        onDiscoveryAction?: (data: { type: string; label: string; detail?: string; output?: string }) => void;
        onAddMessage?: (message: ChatMessage) => Promise<void>;
        optionsUpdateMessage?: (messageId: string, content: string) => Promise<void>;
        onRoundUsed?: (rounds: number) => void;
    }): Promise<{
        decision: any;
        workerAdvice?: string;
        signatures?: string;
        governorReport?: string;
        discoverySteps?: { type: string; label: string; detail?: string }[];
        addedFiles?: string[];
        multiPartPlan?: MultiPartPlan;
        roundsUsed?: number;
    }> {
        const {
            lollmsAPI,
            contextManager,
            targetModel,
            signal,
            userPromptText,
            fileCandidates,
            maxTokens,
            objectiveThresholdPercent,
            objectiveThreshold,
            maxRounds,
            governorDirectives,
            onStatusUpdate,
            onRoundProgress,
            onStreamChunk,
            onDiscoveryAction,
            onRoundUsed
        } = options;

        interface CompletedRoundLog {
            round: number;
            thoughts: string;
            toolAction?: string;
            toolObservation?: string;
        }

        const completedRounds: CompletedRoundLog[] = [];
        let currentRound = 0;
        let lastDecision: any = null;
        let extractedReport = "";
        let extractedAdvice = "";
        let extractedSignatures = "";
        const newlyAddedFiles: string[] = [];
        const discoverySteps: { type: string; label: string; detail?: string }[] = [];

        const cleanActionTagsFromText = (text: string) => {
            let cleaned = text
                .replace(/<read_full_file\b[^>]*\/>/gi, '')
                .replace(/<read_file\b[^>]*\/>/gi, '')
                .replace(/<peek_files\b[^>]*\/>/gi, '')
                .replace(/<peek_files\b[^>]*>[\s\S]*?<\/peek_files>/gi, '')
                .replace(/<grep\b[^>]*\/>/gi, '')
                .replace(/<grep\b[^>]*>[\s\S]*?<\/grep>/gi, '')
                .replace(/<sparql\b[^>]*\/>/gi, '')
                .replace(/<sparql\b[^>]*>[\s\S]*?<\/sparql>/gi, '')
                .replace(/<add_files_to_context\b[^>]*>[\s\S]*?<\/add_files_to_context>/gi, '')
                .replace(/<structure\b[^>]*>[\s\S]*?<\/structure>/gi, '')
                .replace(/<librarian_decision\b[^>]*>[\s\S]*?<\/librarian_decision>/gi, '')
                .replace(/<governor_decision\b[^>]*>[\s\S]*?<\/governor_decision>/gi, '')
                .replace(/<reveal_only\b[^>]*>[\s\S]*?<\/reveal_only>/gi, '')
                .replace(/<mute_only\b[^>]*>[\s\S]*?<\/mute_only>/gi, '')
                .replace(/<edit_files>[\s\S]*?<\/edit_files>/gi, '')
                .replace(/<context_files>[\s\S]*?<\/context_files>/gi, '')
                .replace(/<unneeded_files>[\s\S]*?<\/unneeded_files>/gi, '')
                .replace(/<librarian_report>[\s\S]*?<\/librarian_report>/gi, '');

            // Strip in-progress / unclosed XML tags from live streaming view
            cleaned = cleaned.replace(/<(?:librarian_decision|governor_decision|edit_files|context_files|unneeded_files|read_full_file|read_file|peek_files|grep|sparql|structure|librarian_report)\b[\s\S]*$/i, '');
            return cleaned.trim();
        };

        const formatAccumulatedRoundsMarkdown = (liveRoundIndex?: number, liveStreamContent?: string) => {
            let md = `### 📚 **Lead Librarian Investigation**\n`;
            md += `*Pool: ~${totalCandidateTokens.toLocaleString()} tok &middot; Unmuted: ~${currentUnmutedTokens.toLocaleString()} tok &middot; Target: ~${objectiveThreshold.toLocaleString()} tok (${objectiveThresholdPercent}%)*\n\n`;

            if (completedRounds.length > 0) {
                md += completedRounds.map(r => {
                    let block = `#### 📚 **Round ${r.round}/${maxRounds}**\n${r.thoughts}`;
                    if (r.toolAction) {
                        block += `\n\n> 🛠️ **Action**: \`${r.toolAction}\``;
                        if (r.toolObservation) {
                            block += `\n>\n> *Observation*:\n\`\`\`\n${r.toolObservation}\n\`\`\``;
                        }
                    }
                    return block;
                }).join('\n\n---\n\n') + '\n\n---\n\n';
            }

            if (liveRoundIndex !== undefined && liveStreamContent !== undefined) {
                const cleanedLive = cleanActionTagsFromText(liveStreamContent);
                md += `#### 📚 **Round ${liveRoundIndex}/${maxRounds} (Evaluating live)**\n${cleanedLive || liveStreamContent || '*(Analyzing...)*'}`;
            }

            return md;
        };

        const compactCatalog = this.buildCompactCatalog(fileCandidates, options.currentMuted);
        const existingStructure = await this.getStructureGuide();

        let projectTreePreview = "";
        try {
            projectTreePreview = await contextManager.generateProjectTree(signal);
        } catch {}

        const totalCandidateTokens = fileCandidates.reduce((sum, c) => sum + c.tokens, 0);
        const currentUnmutedTokens = fileCandidates.filter(c => !options.currentMuted.some(m => this.pathsMatch(m, c.path))).reduce((sum, c) => sum + c.tokens, 0);

        const systemPrompt = `You are the **Lead Sovereign Librarian**.
Your mission is to be the intelligent eyes, memory, and architectural scout for the AI worker. The worker cannot add/remove files or run grep/SPARQL directly—it relies exclusively on you to scout the codebase, verify dependencies, balance the token budget, and provide the exact files or reference summaries needed.
Capacity limit: ${maxTokens.toLocaleString()} tokens.
Maximum Allowed Negotiation Rounds: Up to ${maxRounds}.

### ⚡ FAST-PATH MANDATE (CONCLUDE IN ROUND 1 WHENEVER POSSIBLE):
- If the user prompt mentions specific files (e.g. "load main.py, core.py..."), or if the relevant files are obvious, you MUST output your <librarian_decision> IMMEDIATELY in Round 1.
- DO NOT execute <grep>, <peek_files>, or <read_full_file> unless you genuinely lack the information needed to categorize the files.
- Speed and low latency are top priorities: avoid taking extra rounds when the requested files are already known.

### 🏛️ CONTINUOUS FINDINGS EVOLUTION & PATCHING (.lollms/structure.md):
The previous findings in .lollms/structure.md are provided in your prompt.
The codebase changes over time, so previous findings may contain STALE, CHANGED, or MISSING information.
- **Inspect & Compare**: As you inspect files via <read_full_file>, <peek_files>, or <grep>, compare the actual code on disk with the previous findings.
- **Patch Stale Findings**: If any function, class, endpoint, route, or schema changed or was removed:
  You MUST patch .lollms/structure.md using an Aider Search/Replace block:
  <structure action="patch">

### 📊 REAL-TIME TOKEN AUDIT & BUDGET OBJECTIVE:
- **Total Candidates Pool Tokens (Muted + Unmuted)**: ~${totalCandidateTokens.toLocaleString()} tokens (${fileCandidates.length} files)
- **Current Unmuted Files Tokens ([C] Active)**: ~${currentUnmutedTokens.toLocaleString()} tokens
- **Maximum Window Capacity**: ${maxTokens.toLocaleString()} tokens
- **Target Objective Threshold (${objectiveThresholdPercent}%)**: ~${objectiveThreshold.toLocaleString()} tokens
- **Goal**: Ensure the unmuted files token count fits within the target budget.

### ⚖️ TRI-TIER CLASSIFICATION & PATCH-FOCUSED CONTEXT MANDATE:
You MUST categorize all candidate files into three distinct categories:
1. **EDIT FILES (Mandatory for Patching)**: Files that MUST be modified, written, or created to fulfill the user's task. ONLY these files will be loaded with full content ([C]) for the worker.
2. **CONTEXT FILES (Reference Only)**: Files needed ONLY as references to understand function signatures, contracts, schemas, or callers (files that will NOT be changed). You MUST inspect these files with <read_full_file> or <peek_files>, compress their essential interfaces, types, and contracts into <librarian_report>, and MUTE them ([M], 0 tokens) so they do not consume context budget.
3. **UNNEEDED FILES**: Files unrelated to the user's task (must be muted [M]).

### 🚦 THREE-TIER FITTING LOGIC:
- **TIER A (fit_edits_only - PRIMARY)**:
  * Unmute EDIT FILES (they must be loaded with full content [C] for the worker to patch).
  * Mute CONTEXT FILES (0 tokens [M] in tree).
  * Extract relevant function signatures, types, and interfaces from context files into <librarian_report>...</librarian_report>.
- **TIER B (fit_all - OVERVIEW ONLY)**: Only if there are ZERO files to edit (e.g. an architectural explanation or system audit question) and all reference files fit within target budget.
- **TIER C (split_multi_part)**: If even tokens(edit_files) exceeds the budget alone:
  * Partition edit files into sequential parts: Part 1, Part 2, etc., so each part fits.
  * Formulate clear multi-phase instructions in <librarian_report>.

### 🛠️ ACTIVE INVESTIGATION TOOLS:
1. **Full File Read**: <read_full_file path="path/to/file.ext" />
   Reads the complete file content for this round so you can inspect all its classes/functions and extract contracts into your report.
2. **Peek File Slice**: <peek_files path="path/to/file.ext" lines="30" from="top|bottom" />
3. **Grep Search**: <grep pattern="searchTerm" path="optional/subdir" />
4. **SPARQL Architecture Query**: <sparql query="SELECT ?x WHERE { ?x s:type s:Class }" />
5. **Add Tree Files to Context**: <add_files_to_context>\npath/to/file.ext\n</add_files_to_context>
6. **Update Structure Guide**: <structure># Architecture Guide\n...</structure> (.lollms/structure.md)

### 📋 FINAL ARBITRATION TAG:
When ready to conclude, output your final decision using:
<librarian_decision status="fit_edits_only|fit_all|split_multi_part">
<edit_files>
path/to/file_to_modify.ext
</edit_files>
<context_files>
path/to/reference_file.ext
</context_files>
<librarian_analysis>
MANDATORY: Write a comprehensive analysis paragraph to the worker explaining:
1. What you discovered about the codebase workings, call graphs, or architecture.
2. Why the selected edit files were chosen and how they relate.
3. Summary of key contracts and types from reference files.
</librarian_analysis>
<librarian_report>
### 🏛️ ARCHITECTURAL CONTRACTS & REFERENCE FINDINGS
- Specific functions, contracts, types, or multi-phase instructions from reference files...
</librarian_report>
</librarian_decision>

🛑 ZERO-ECHO MANDATE (NEVER LIST UNNEEDED FILES):
- You are **STRICTLY FORBIDDEN from listing, reciting, or outputting unneeded files**.
- DO NOT output an \`<unneeded_files>\` tag. Any file not listed in \`<edit_files>\` or \`<context_files>\` is AUTOMATICALLY muted by the system at 0 tokens.
- Never recite file paths in your thoughts. Focus exclusively on the files you need to inspect or modify.`;

        const safeUserPromptText = (userPromptText || '')
            .replace(/data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=]{50,}/g, '[Attached Image]')
            .trim();

        // Extract files explicitly mentioned or requested in the prompt
        const promptLower = safeUserPromptText.toLowerCase();
        const requestedCandidates = fileCandidates.filter(c => {
            const cleanP = c.path.toLowerCase().replace(/\\/g, '/');
            const baseName = path.basename(cleanP);
            return promptLower.includes(cleanP) || promptLower.includes(baseName);
        });

        const requestedSection = requestedCandidates.length > 0 ? `
### 🎯 EXPLICITLY REQUESTED FILES IN PROMPT (${requestedCandidates.length} files):
${requestedCandidates.map(c => `- \`${c.path}\` (~${c.tokens} tok)`).join('\n')}

**DIRECT FAST-PATH INSTRUCTION**:
The user/worker explicitly named these files.
1. If you need to verify code before deciding, use \`<read_full_file path="...">\` on the relevant file now.
2. Otherwise, assign them to \`<edit_files>\` (for patching) or \`<context_files>\` (for reference) and output \`<librarian_decision>\` in Round 1.
3. DO NOT evaluate, recite, or list other files. All other files are automatically muted.
` : '';

        const initialUserPrompt = `### 🎯 USER OBJECTIVE:
"${safeUserPromptText}"
${requestedSection}

### 📊 REAL-TIME TOKEN AUDIT & BUDGET OBJECTIVE:
- Total Candidates Pool (Muted + Unmuted): ~${totalCandidateTokens.toLocaleString()} tokens (${fileCandidates.length} files)
- Current Unmuted Files Load: ~${currentUnmutedTokens.toLocaleString()} tokens
- Target Budget Threshold: ~${objectiveThreshold.toLocaleString()} tokens (${objectiveThresholdPercent}% of ${maxTokens.toLocaleString()})

${existingStructure ? `### 🏛️ CURRENT CODEBASE STRUCTURE GUIDE (.lollms/structure.md):\n${existingStructure}\n` : '*(No .lollms/structure.md yet. You will create the initial structure guide using <structure action="write">...)*\n'}
### 🌳 PROJECT STRUCTURE TREE:
${projectTreePreview ? projectTreePreview.substring(0, 3000) : '(No tree available)'}

${governorDirectives && governorDirectives.length > 0 ? `### ⚖️ DIRECT USER DIRECTIVES:\n${governorDirectives.map(d => `- ${d}`).join('\n')}\n\n` : ''}### 📄 CANDIDATE FILES CATALOG:
${compactCatalog}

Analyze the requirements. If you lack information on contracts or implementations, execute discovery tools (<read_full_file>, <peek_files>, <grep>, <sparql>). When ready, output your <librarian_decision>.`;

        const conversation: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: initialUserPrompt }
        ];

        while (currentRound < maxRounds) {
            if (signal.aborted) break;
            currentRound++;
            if (onRoundUsed) onRoundUsed(currentRound);

            const roundMessageId = `lib_round_${currentRound}_${Date.now()}`;
            const statusText = `Librarian: Round ${currentRound}/${maxRounds} (Active: ~${currentUnmutedTokens.toLocaleString()}/${objectiveThreshold.toLocaleString()} tok)...`;
            if (onStatusUpdate) onStatusUpdate(statusText);
            if (onRoundProgress) {
                onRoundProgress({
                    round: currentRound,
                    maxRounds,
                    status: statusText,
                    discoverySteps: [...discoverySteps]
                });
            }

            let turnStreamBuffer = "";
            let cleanResponse = "";
            let lastUiStreamTime = 0;

            try {
                const response = await lollmsAPI.sendChat(
                    conversation,
                    (chunk) => {
                        if (signal.aborted) return;
                        turnStreamBuffer += chunk;
                        const now = Date.now();
                        if (onStreamChunk) {
                            onStreamChunk({
                                round: currentRound,
                                maxRounds,
                                chunk,
                                fullText: turnStreamBuffer,
                                messageId: roundMessageId
                            });
                        }
                        if (options.optionsUpdateMessage && options.pruneMsgId && (now - lastUiStreamTime > 150)) {
                            lastUiStreamTime = now;
                            options.optionsUpdateMessage(options.pruneMsgId, formatAccumulatedRoundsMarkdown(currentRound, turnStreamBuffer)).catch(() => {});
                        }
                    },
                    signal,
                    targetModel,
                    { thinking: false, reasoningEffort: 'none' }
                );

                cleanResponse = stripThinkingTags(response).trim();
            } catch (err: any) {
                Logger.error(`[Librarian] LLM query failed in round ${currentRound}: ${err.message}`);
                throw new Error(`Librarian could not communicate with LLM: ${err.message}`);
            }

            const currentThoughts = cleanActionTagsFromText(cleanResponse) || cleanResponse;

            const structMatch = cleanResponse.match(/<structure\b([^>]*?)>([\s\S]*?)<\/structure>/i);
            if (structMatch && structMatch[2] !== undefined) {
                const attrStr = structMatch[1] || "";
                const inner = structMatch[2].trim();
                const isPatch = attrStr.includes('action="patch"') || attrStr.includes("action='patch'") || inner.includes('<<<<<<< SEARCH');
                const action = isPatch ? 'patch' : 'write';

                await this.updateStructureGuide(inner, action);
                const step = { 
                    type: 'structure', 
                    label: isPatch ? 'Patched Structure Guide' : 'Updated Structure Guide', 
                    detail: isPatch ? 'Replaced stale findings in .lollms/structure.md' : '.lollms/structure.md' 
                };
                discoverySteps.push(step);
                if (onDiscoveryAction) onDiscoveryAction(step);

                completedRounds.push({
                    round: currentRound,
                    thoughts: currentThoughts,
                    toolAction: isPatch ? 'Patched Codebase Architecture Guide (.lollms/structure.md)' : 'Updated Codebase Architecture Guide (.lollms/structure.md)',
                    toolObservation: isPatch ? 'Applied patch to remove stale info and synchronize findings with disk.' : 'Architecture and component contracts recorded to persistent storage.'
                });

                if (options.optionsUpdateMessage && options.pruneMsgId) {
                    options.optionsUpdateMessage(options.pruneMsgId, formatAccumulatedRoundsMarkdown()).catch(() => {});
                }
            }

            const readFullMatch = cleanResponse.match(/<read_full_file\b[^>]*path=["']([^"']+)["'][^>]*\/>/i) ||
                                  cleanResponse.match(/<read_file\b[^>]*path=["']([^"']+)["'][^>]*\/>/i);
            if (readFullMatch) {
                const reqPath = readFullMatch[1].trim();
                const res = await contextManager.resolveWorkspaceFromPath(reqPath);
                let contentText = "(File could not be resolved)";
                if (res) {
                    try {
                        const bytes = await vscode.workspace.fs.readFile(res.uri);
                        contentText = Buffer.from(bytes).toString('utf8');
                        if (contentText.length > 120000) {
                            contentText = contentText.substring(0, 120000) + "\n... [Truncated at 120k chars for single-round inspection]";
                        }
                    } catch (e: any) {
                        contentText = `(Error reading file: ${e.message})`;
                    }
                }

                const step = { type: 'read', label: `Read Full File: ${path.basename(reqPath)}`, detail: `${Math.ceil(contentText.length / 3.5)} tok inspected` };
                discoverySteps.push(step);
                if (onDiscoveryAction) onDiscoveryAction(step);

                completedRounds.push({
                    round: currentRound,
                    thoughts: currentThoughts,
                    toolAction: `Read Full File: ${reqPath}`,
                    toolObservation: contentText.length > 350 ? contentText.substring(0, 350) + '\n... [truncated for log]' : contentText
                });

                if (options.optionsUpdateMessage && options.pruneMsgId) {
                    options.optionsUpdateMessage(options.pruneMsgId, formatAccumulatedRoundsMarkdown()).catch(() => {});
                }

                const remaining = maxRounds - currentRound;
                conversation.push({ role: 'assistant', content: cleanResponse });
                conversation.push({
                    role: 'user',
                    content: `### 📄 FULL FILE INSPECTION: \`${reqPath}\`\n\`\`\`\n${contentText}\n\`\`\`\n\n⏳ **BUDGET NOTICE**: You have ${remaining} round${remaining === 1 ? '' : 's'} remaining. Use as few rounds as possible. If you have enough information, finalize immediately with <librarian_decision>.`
                });
                continue;
            }

            const peekMatch = cleanResponse.match(/<peek_files\b([^>]*?)>([\s\S]*?)<\/peek_files>/i) ||
                              cleanResponse.match(/<peek_files\s+([^>]*?)\/>/i);
            if (peekMatch) {
                const attrPart = peekMatch[1] || "";
                const inner = (peekMatch[2] || "").trim();
                const pathFromAttr = attrPart.match(/path=["']([^"']+)["']/i)?.[1] || "";
                const linesFromAttr = parseInt(attrPart.match(/lines=["']?(\d+)["']?/i)?.[1] || "30", 10);
                const fromDir = (attrPart.match(/from=["']?(top|bottom)["']?/i)?.[1] || "top") as 'top' | 'bottom';
                const targetPath = pathFromAttr || inner.split(/\s+/)[0] || "";

                if (targetPath) {
                    const peekRes = await contextManager.peekFiles([{ path: targetPath, lines: linesFromAttr, from: fromDir }]);
                    const snippet = peekRes.map(r => r.error ? `Error: ${r.error}` : r.content).join('\n') || 'File empty.';
                    const step = { type: 'peek', label: `Peek: "${path.basename(targetPath)}"`, detail: `${linesFromAttr} lines` };
                    discoverySteps.push(step);
                    if (onDiscoveryAction) onDiscoveryAction(step);

                    completedRounds.push({
                        round: currentRound,
                        thoughts: currentThoughts,
                        toolAction: `Peek Slice: ${targetPath} (${linesFromAttr} lines from ${fromDir})`,
                        toolObservation: snippet.length > 350 ? snippet.substring(0, 350) + '\n... [truncated for log]' : snippet
                    });

                    if (options.optionsUpdateMessage && options.pruneMsgId) {
                        options.optionsUpdateMessage(options.pruneMsgId, formatAccumulatedRoundsMarkdown()).catch(() => {});
                    }

                    const remaining = maxRounds - currentRound;
                    conversation.push({ role: 'assistant', content: cleanResponse });
                    conversation.push({
                        role: 'user',
                        content: `### 📄 PEEK SLICE FOR "${targetPath}":\n\`\`\`\n${snippet}\n\`\`\`\n\n⏳ **BUDGET NOTICE**: You have ${remaining} round${remaining === 1 ? '' : 's'} remaining. Use as few rounds as possible. Conclude with <librarian_decision> if ready.`
                    });
                    continue;
                }
            }

            const grepMatch = cleanResponse.match(/<grep\b([^>]*?)(?:\/>|>([\s\S]*?)<\/grep>)/i);
            if (grepMatch) {
                const attrStr = grepMatch[1] || "";
                const pMatch = attrStr.match(/(?:pattern|query)=["']([^"']+)["']/i);
                const pattern = (pMatch ? pMatch[1] : (grepMatch[2]?.trim() || "")).trim();
                const pathMatch = attrStr.match(/(?:path|include)=["']([^"']+)["']/i);
                const subPath = pathMatch ? pathMatch[1].trim() : undefined;

                if (pattern) {
                    const searchRes = await contextManager.searchWorkspaceContent(pattern, { matchCase: false, wholeWord: false, include: subPath, bypassGate: true }, signal);
                    const snippet = searchRes.slice(0, 8).map(r => `${r.path}:${r.line} - ${r.snippet}`).join('\n') || 'No matches found.';
                    const step = { type: 'grep', label: `Grep: "${pattern}"`, detail: `${searchRes.length} hits` };
                    discoverySteps.push(step);
                    if (onDiscoveryAction) onDiscoveryAction(step);

                    completedRounds.push({
                        round: currentRound,
                        thoughts: currentThoughts,
                        toolAction: `Grep Pattern: "${pattern}"${subPath ? ` in ${subPath}` : ''}`,
                        toolObservation: snippet.length > 350 ? snippet.substring(0, 350) + '\n... [truncated for log]' : snippet
                    });

                    if (options.optionsUpdateMessage && options.pruneMsgId) {
                        options.optionsUpdateMessage(options.pruneMsgId, formatAccumulatedRoundsMarkdown()).catch(() => {});
                    }

                    const remaining = maxRounds - currentRound;
                    conversation.push({ role: 'assistant', content: cleanResponse });
                    conversation.push({
                        role: 'user',
                        content: `### 🔍 GREP RESULTS FOR "${pattern}":\n${snippet}\n\n⏳ **BUDGET NOTICE**: You have ${remaining} round${remaining === 1 ? '' : 's'} remaining. Strive to finalize with <librarian_decision>.`
                    });
                    continue;
                }
            }

            const sparqlMatch = cleanResponse.match(/<sparql\b[^>]*query=["']([\s\S]*?)["'][^>]*\/>/i) ||
                                cleanResponse.match(/<sparql\b[^>]*>([\s\S]*?)<\/sparql>/i);
            if (sparqlMatch) {
                const query = (sparqlMatch[1] || "").trim();
                const graphManager = (contextManager as any).codeGraphManager;
                if (query && graphManager) {
                    const sparqlRes = await graphManager.executeSparql(query);
                    const step = { type: 'sparql', label: `SPARQL Query`, detail: `Graph evaluated` };
                    discoverySteps.push(step);
                    if (onDiscoveryAction) onDiscoveryAction(step);

                    completedRounds.push({
                        round: currentRound,
                        thoughts: currentThoughts,
                        toolAction: `SPARQL Query: ${query.split('\n')[0]}`,
                        toolObservation: sparqlRes.length > 350 ? sparqlRes.substring(0, 350) + '\n... [truncated for log]' : sparqlRes
                    });

                    if (options.optionsUpdateMessage && options.pruneMsgId) {
                        options.optionsUpdateMessage(options.pruneMsgId, formatAccumulatedRoundsMarkdown()).catch(() => {});
                    }

                    conversation.push({ role: 'assistant', content: cleanResponse });
                    conversation.push({
                        role: 'user',
                        content: `### 📊 SPARQL RESULTS:\n${sparqlRes}\n\nContinue scouting or output your <librarian_decision>.`
                    });
                    continue;
                }
            }

            const addFilesMatch = cleanResponse.match(/<add_files_to_context\b[^>]*>([\s\S]*?)<\/add_files_to_context>/i);
            if (addFilesMatch) {
                const requestedPaths = addFilesMatch[1].split(/[\r\n,]+/).map(p => p.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
                for (const reqPath of requestedPaths) {
                    const resolution = await contextManager.resolveWorkspaceFromPath(reqPath);
                    if (resolution) {
                        try {
                            const fileBytes = await vscode.workspace.fs.readFile(resolution.uri);
                            const text = Buffer.from(fileBytes).toString('utf8');
                            const bytesCount = fileBytes.length;
                            const tokens = Math.max(1, Math.ceil(bytesCount / 3.5));

                            if (!fileCandidates.some(c => this.pathsMatch(c.path, reqPath))) {
                                const formatted = text.endsWith('\n') ? text : text + '\n';
                                const candidate = this.buildCandidate(`<file path="${reqPath}">\n${formatted}</file>

\n\n`, reqPath, text, tokens, new Set([reqPath.toLowerCase()]), options.keywords, contextManager);
                                candidate.bytes = bytesCount;
                                candidate.linesCount = text.split('\n').length;
                                candidate.isNewlyAdded = true;
                                fileCandidates.push(candidate);
                                newlyAddedFiles.push(reqPath);
                            }
                            discoverySteps.push({ type: 'add_file', label: `Added: ${path.basename(reqPath)}`, detail: `~${tokens} tok` });
                        } catch {}
                    }
                }

                completedRounds.push({
                    round: currentRound,
                    thoughts: currentThoughts,
                    toolAction: `Added files from workspace tree: ${requestedPaths.join(', ')}`,
                    toolObservation: `Added ${requestedPaths.length} file(s) into candidate pool.`
                });

                if (options.optionsUpdateMessage && options.pruneMsgId) {
                    options.optionsUpdateMessage(options.pruneMsgId, formatAccumulatedRoundsMarkdown()).catch(() => {});
                }

                conversation.push({ role: 'assistant', content: cleanResponse });
                conversation.push({
                    role: 'user',
                    content: `Added files to candidate pool. Now evaluate them and output your <librarian_decision>.`
                });
                continue;
            }

            const decisionTagMatch = cleanResponse.match(/<(?:librarian_decision|governor_decision)\b[^>]*status=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:librarian_decision|governor_decision)>/i) ||
                                     cleanResponse.match(/<(?:librarian_decision|governor_decision)>([\s\S]*?)<\/(?:librarian_decision|governor_decision)>/i);

            const analysisTagMatch = cleanResponse.match(/<(?:librarian_analysis|analysis)\b[^>]*>([\s\S]*?)<\/(?:librarian_analysis|analysis)>/i);
            const reportTagMatch = cleanResponse.match(/<(?:librarian_report|governor_report)\b[^>]*>([\s\S]*?)<\/librarian_report>/i);
            const rationaleTagMatch = cleanResponse.match(/<rationale\b[^>]*>([\s\S]*?)<\/rationale>/i);
            const adviceTagMatch = cleanResponse.match(/<worker\b[^>]*>([\s\S]*?)<\/worker>/i);
            const sigTagMatch = cleanResponse.match(/<signatures\b[^>]*>([\s\S]*?)<\/signatures>/i);

            if (analysisTagMatch) extractedAdvice = analysisTagMatch[1].trim();
            if (reportTagMatch) extractedReport = reportTagMatch[1].trim();
            if (rationaleTagMatch && !extractedAdvice) extractedAdvice = rationaleTagMatch[1].trim();
            if (adviceTagMatch && !extractedAdvice) extractedAdvice = adviceTagMatch[1].trim();
            if (sigTagMatch) extractedSignatures = sigTagMatch[1].trim();

            let decisionStatus = 'fit_all';
            let editPaths: string[] = [];
            let contextPaths: string[] = [];
            let unneededPaths: string[] = [];

            if (decisionTagMatch) {
                const statusAttr = cleanResponse.match(/<(?:librarian_decision|governor_decision)\b[^>]*status=["']([^"']+)["']/i);
                if (statusAttr) decisionStatus = statusAttr[1].toLowerCase();

                const inner = decisionTagMatch[2] || decisionTagMatch[1] || "";
                const editMatch = inner.match(/<edit_files>([\s\S]*?)<\/edit_files>/i);
                const ctxMatch = inner.match(/<context_files>([\s\S]*?)<\/context_files>/i);
                const unneededMatch = inner.match(/<unneeded_files>([\s\S]*?)<\/unneeded_files>/i);

                if (editMatch) editPaths = editMatch[1].split(/[\r\n,]+/).map(p => p.trim()).filter(Boolean);
                if (ctxMatch) contextPaths = ctxMatch[1].split(/[\r\n,]+/).map(p => p.trim()).filter(Boolean);
                if (unneededMatch) unneededPaths = unneededMatch[1].split(/[\r\n,]+/).map(p => p.trim()).filter(Boolean);
            } else {
                const revealMatch = cleanResponse.match(/<reveal_only\b[^>]*>([\s\S]*?)<\/reveal_only>/i) ||
                                     cleanResponse.match(/<keep\b[^>]*>([\s\S]*?)<\/keep>/i);
                const muteMatch = cleanResponse.match(/<mute_only\b[^>]*>([\s\S]*?)<\/mute_only>/i) ||
                                  cleanResponse.match(/<mute\b[^>]*>([\s\S]*?)<\/mute>/i);

                if (revealMatch) {
                    editPaths = revealMatch[1].split(/[\r\n,]+/).map(p => p.trim()).filter(Boolean);
                }
                if (muteMatch) {
                    unneededPaths = muteMatch[1].split(/[\r\n,]+/).map(p => p.trim()).filter(Boolean);
                }
            }

            fileCandidates.forEach(c => {
                if (editPaths.some(ep => this.pathsMatch(ep, c.path))) {
                    c.role = 'edit';
                    c.keep = true;
                } else if (contextPaths.some(cp => this.pathsMatch(cp, c.path))) {
                    c.role = 'context';
                    c.keep = false;
                } else {
                    // Any unmentioned file is automatically unneeded and muted
                    c.role = 'unneeded';
                    c.keep = false;
                }
            });

            const editTokens = fileCandidates.filter(c => c.role === 'edit').reduce((sum, c) => sum + c.tokens, 0);
            const contextTokens = fileCandidates.filter(c => c.role === 'context').reduce((sum, c) => sum + c.tokens, 0);
            const availableBudget = objectiveThreshold;

            let multiPartPlan: MultiPartPlan | undefined = undefined;

            if (editTokens > 0 && editTokens <= availableBudget) {
                decisionStatus = 'fit_edits_only';
                fileCandidates.forEach(c => {
                    c.keep = (c.role === 'edit');
                });
            } else if (editTokens === 0 && contextTokens <= availableBudget) {
                decisionStatus = 'fit_all';
                fileCandidates.forEach(c => {
                    c.keep = (c.role === 'context');
                });
            } else if (editTokens <= availableBudget) {
                decisionStatus = 'fit_edits_only';
                fileCandidates.forEach(c => {
                    c.keep = (c.role === 'edit');
                });
            } else {
                decisionStatus = 'split_multi_part';
                multiPartPlan = this.partitionEditFilesIntoPhases(
                    fileCandidates.filter(c => c.role === 'edit'),
                    availableBudget,
                    userPromptText
                );
            }

            lastDecision = {
                status: decisionStatus,
                rationale: extractedAdvice || `Librarian arbitrated context: status ${decisionStatus}.`,
                editFiles: fileCandidates.filter(c => c.role === 'edit').map(c => c.path),
                contextFiles: fileCandidates.filter(c => c.role === 'context').map(c => c.path),
                unneededFiles: fileCandidates.filter(c => c.role === 'unneeded').map(c => c.path)
            };

            return {
                decision: lastDecision,
                workerAdvice: extractedAdvice,
                signatures: extractedSignatures,
                governorReport: extractedReport || extractedSignatures,
                discoverySteps,
                addedFiles: newlyAddedFiles,
                multiPartPlan,
                roundsUsed: currentRound
            };
        }

        if (currentThoughts && !completedRounds.some(r => r.round === currentRound)) {
            completedRounds.push({
                round: currentRound,
                thoughts: currentThoughts
            });
        }

        const fallbackDecision = this.buildDeterministicFallback(fileCandidates, options.overflow, options.canAvoidEvictingCurrentPrompt, objectiveThresholdPercent, objectiveThreshold, options.currentMuted);
        return {
            decision: fallbackDecision,
            workerAdvice: extractedAdvice,
            signatures: extractedSignatures,
            governorReport: extractedReport || extractedSignatures,
            discoverySteps,
            addedFiles: newlyAddedFiles,
            roundsUsed: currentRound
        };
    }

    private static partitionEditFilesIntoPhases(
        editCandidates: ParsedFileCandidate[],
        budget: number,
        originalPrompt: string
    ): MultiPartPlan {
        const phases: MultiPartPhase[] = [];
        const targetBudgetPerPhase = Math.max(1000, budget - 4000);

        let currentPhaseFiles: string[] = [];
        let currentPhaseTokens = 0;

        for (const candidate of editCandidates) {
            if (currentPhaseFiles.length > 0 && (currentPhaseTokens + candidate.tokens > targetBudgetPerPhase)) {
                phases.push({
                    partIndex: phases.length,
                    totalParts: 0,
                    editFiles: [...currentPhaseFiles],
                    partInstruction: ""
                });
                currentPhaseFiles = [candidate.path];
                currentPhaseTokens = candidate.tokens;
            } else {
                currentPhaseFiles.push(candidate.path);
                currentPhaseTokens += candidate.tokens;
            }
        }

        if (currentPhaseFiles.length > 0) {
            phases.push({
                partIndex: phases.length,
                totalParts: 0,
                editFiles: [...currentPhaseFiles],
                partInstruction: ""
            });
        }

        const totalParts = Math.max(2, phases.length);

        phases.forEach((p, idx) => {
            p.partIndex = idx;
            p.totalParts = totalParts;
            if (idx === 0) {
                p.partInstruction = `### ⚠️ MULTI-PHASE EXECUTION (Phase 1 of ${totalParts})
Files to modify in this phase: ${p.editFiles.map(f => `\`${f}\``).join(', ')}.
Apply changes ONLY to Phase 1 files. Subsequent phase files will be loaded once these edits complete.`;
            } else {
                p.partInstruction = `### ⚠️ MULTI-PHASE CONTINUATION (Phase ${idx + 1} of ${totalParts})
Phase ${idx} files have been updated and muted to free memory.
Now proceed to update the files for Phase ${idx + 1}:
${p.editFiles.map(f => `- \`${f}\``).join('\n')}

Original Objective: "${originalPrompt.substring(0, 300)}"
Apply the required modifications for this phase.`;
            }
        });

        return {
            totalParts,
            currentPartIndex: 0,
            parts: phases
        };
    }

    private static buildDeterministicFallback(
        candidates: ParsedFileCandidate[],
        overflow: number,
        canAvoidEvictingCurrentPrompt: boolean,
        targetThresholdPercent: number,
        triggerThreshold: number,
        currentMuted: string[] = []
    ): any {
        const evictList: any[] = [];
        let liberated = 0;
        const analysisParagraph = "The Librarian evaluated the codebase candidates against the objective budget. Priority files were kept active with full content, while supplementary files were set to reference mode.";

        const isAlreadyMuted = (p: string) => currentMuted.some(m => this.pathsMatch(m, p));

        for (const candidate of candidates) {
            if (isAlreadyMuted(candidate.path)) {
                candidate.role = 'unneeded';
                candidate.keep = false;
                evictList.push({ path: candidate.path, reason: "Remained muted from prior configuration." });
            }
        }

        const activeCandidates = candidates.filter(b => !isAlreadyMuted(b.path));
        const sorted = [...activeCandidates].sort((a, b) => a.relevanceScore - b.relevanceScore || b.tokens - a.tokens);

        for (const candidate of sorted) {
            if (liberated >= overflow) break;
            candidate.role = 'context';
            candidate.keep = false;
            evictList.push({ path: candidate.path, reason: `Muted as reference to save ${candidate.tokens.toLocaleString()} tokens.` });
            liberated += candidate.tokens;
        }

        return {
            status: 'fit_edits_only',
            rationale: analysisParagraph,
            keep: candidates.filter(b => b.keep).map(b => ({ path: b.path, justification: "Active file." })),
            evict: evictList
        };
    }

    private static buildCompactCatalog(candidates: ParsedFileCandidate[], currentMuted: string[] = []): string {
        const formatSize = (b: number) => {
            if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
            if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
            return `${b} B`;
        };

        if (candidates.length <= 35) {
            return candidates.map(c => {
                const isMuted = currentMuted.some(m => this.pathsMatch(m, c.path));
                const statusTag = isMuted ? ' [MUTED]' : ' [ACTIVE]';
                const sizeStr = `${formatSize(c.bytes)} (~${c.tokens.toLocaleString()} tok)`;
                return `- File: \`${c.path}\`${statusTag} (${sizeStr})`;
            }).join('\n');
        }

        // Bounded Catalog for large projects: show relevant candidates + directory scopes
        const highRelevance = candidates.filter(c => c.relevanceScore > 0 || c.isCurrentPromptFile).slice(0, 25);
        const dirs = new Map<string, number>();
        candidates.forEach(c => {
            const d = c.dirName || './';
            dirs.set(d, (dirs.get(d) || 0) + 1);
        });

        const dirSummary = Array.from(dirs.entries()).map(([d, cnt]) => `  - Directory \`${d}/\`: ${cnt} file(s)`).join('\n');

        return `Top Candidate Files:\n` + highRelevance.map(c => `- File: \`${c.path}\` (${formatSize(c.bytes)}, ~${c.tokens} tok)`).join('\n') +
               `\n\nOther Candidate Directories in Pool (${candidates.length} total files):\n` + dirSummary;
    }

    private static buildCandidate(
        fullMatch: string,
        filePath: string,
        body: string,
        tokens: number,
        currentPromptAddedFiles: Set<string>,
        keywords: string[],
        contextManager: ContextManager
    ): ParsedFileCandidate {
        const cleanPath = filePath.replace(/\\/g, '/').toLowerCase().trim();
        const baseName = path.basename(cleanPath);

        let isCurrentPromptFile = false;
        for (const pf of currentPromptAddedFiles) {
            const cleanPf = pf.replace(/\\/g, '/').toLowerCase().trim();
            if (cleanPath === cleanPf || cleanPath.endsWith('/' + cleanPf) || cleanPf.endsWith('/' + cleanPath) || baseName === path.basename(cleanPf)) {
                isCurrentPromptFile = true;
                break;
            }
        }
        if (!isCurrentPromptFile && contextManager.isRecentlyAdded(filePath, 30 * 60 * 1000)) {
            isCurrentPromptFile = true;
        }

        const isCoreOrInterface = cleanPath.includes('core') || cleanPath.includes('types') ||
                                  cleanPath.includes('interface') || cleanPath.includes('schema') ||
                                  cleanPath.includes('api') || cleanPath.includes('app.') ||
                                  cleanPath.includes('main.') || cleanPath.includes('index.');

        let score = 0;
        if (isCurrentPromptFile) score += 10000;
        if (isCoreOrInterface) score += 200;

        for (const kw of keywords) {
            if (cleanPath.includes(kw)) score += 150;
            else if (body.toLowerCase().includes(kw)) score += 30;
        }

        return {
            fullMatch,
            path: filePath,
            tokens,
            bytes: body.length,
            linesCount: body.split('\n').length,
            isCurrentPromptFile,
            isCoreOrInterface,
            relevanceScore: score,
            matchedKeywords: [],
            extractedSymbols: [],
            keep: true,
            role: isCurrentPromptFile ? 'edit' : 'context'
        };
    }

    private static extractQueryKeywords(userPromptText: string, history: ChatMessage[]): string[] {
        const recentHistoryText = history.slice(-2).map(m => typeof m.content === 'string' ? m.content : '').join(' ');
        const combined = `${userPromptText} ${recentHistoryText}`.toLowerCase();

        const words = combined
            .replace(/[^a-z0-9_$\-\/.]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 2 && !this.STOP_WORDS.has(w));

        const freq = new Map<string, number>();
        words.forEach(w => freq.set(w, (freq.get(w) || 0) + 1));

        return Array.from(freq.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 12)
            .map(([w]) => w);
    }

    private static async cropAndSummarizeHistory(
        history: ChatMessage[],
        lollmsAPI: LollmsAPI,
        targetModel: string,
        signal: AbortSignal,
        currentDiscussion: Discussion,
        discussionManager: DiscussionManager
    ): Promise<{ newHistory: ChatMessage[]; liberatedTokens: number; newHistoryTokens: number; croppedCount: number } | null> {
        const keepRecentCount = history.length > 4 ? 2 : 1;
        const olderHistory = history.slice(0, history.length - keepRecentCount);
        const recentHistory = history.slice(history.length - keepRecentCount);

        if (olderHistory.length === 0) return null;

        const getCleanHistoryText = (msgs: ChatMessage[]) => msgs
            .filter(m => !m.skipInPrompt)
            .map(m => {
                const c = m.content;
                if (typeof c === 'string') return stripThinkingTags(c);
                if (Array.isArray(c)) return c.filter((p: any) => p && p.type === 'text').map((p: any) => stripThinkingTags(p.text)).join('\n');
                return '';
            }).filter(t => t.trim().length > 0).join('\n');

        const olderTokens = Math.ceil(getCleanHistoryText(olderHistory).length / 3.5);

        const transcript = olderHistory.map(m => {
            const role = m.role.toUpperCase();
            const c = m.content;
            let txt = typeof c === 'string' ? stripThinkingTags(c) : (Array.isArray(c) ? c.filter((p: any) => p && p.type === 'text').map((p: any) => stripThinkingTags(p.text)).join('\n') : JSON.stringify(c));
            if (txt.length > 1500) {
                txt = txt.substring(0, 750) + '\n... [truncated] ...\n' + txt.substring(txt.length - 750);
            }
            return `[${role}]: ${txt}`;
        }).join('\n\n');

        const summaryPrompt = `You are the Sovereign Context Librarian.
The conversation history has grown large and must be cropped to fit the token budget.
Analyze the following earlier discussion transcript and synthesize a concise, high-density summary focusing on:
1. **Accomplished**: Key decisions made, files created or modified, and problems resolved.
2. **Important Stuff to Do (Pending Objectives)**: Outstanding requirements, pending tasks, constraints, and specific next steps that still need to be completed.

STRICT INSTRUCTIONS:
- Keep the summary under 200 words.
- Format with clear bullet points.
- Output ONLY the summary text. No conversational preamble.

TRANSCRIPT:
${transcript}`;

        let summaryText = "";
        try {
            const summaryRes = await lollmsAPI.sendChat([
                { role: 'system', content: "You are a concise technical summarizer. Output only the structured summary." },
                { role: 'user', content: summaryPrompt }
            ], null, signal, targetModel, { thinking: false, reasoningEffort: 'none' });

            summaryText = stripThinkingTags(summaryRes).trim();
        } catch (err: any) {
            Logger.warn(`[Librarian] LLM history summarization failed: ${err.message}`);
        }

        if (!summaryText) {
            const userObjectives = olderHistory
                .filter(m => m.role === 'user')
                .map(m => typeof m.content === 'string' ? m.content.trim().slice(0, 100) : '')
                .filter(Boolean)
                .map(t => `- ${t}`)
                .join('\n');
            summaryText = `**Accomplished:** Processed earlier turns.\n\n**Important Stuff to Do:**\n${userObjectives || '- Continue fulfilling active requests.'}`;
        }

        const summaryMessage: ChatMessage = {
            id: 'history_summary_' + Date.now(),
            role: 'system',
            content: `### 📋 CROPPED HISTORY SUMMARY & IMPORTANT STUFF TO DO\n*Earlier conversation history was cropped by the Context Librarian to free token budget.*\n\n${summaryText}`
        };

        olderHistory.forEach(oldMsg => {
            const found = currentDiscussion.messages.find(m => m.id === oldMsg.id);
            if (found) found.skipInPrompt = true;
        });

        const newHistory = [summaryMessage, ...recentHistory];
        const newHistoryTokens = Math.ceil(getCleanHistoryText(newHistory).length / 3.5);
        const liberatedTokens = Math.max(0, olderTokens - Math.ceil(summaryMessage.content.length / 3.5));

        if (!currentDiscussion.id.startsWith('temp-')) {
            await discussionManager.saveDiscussion(currentDiscussion);
        }

        return {
            newHistory,
            liberatedTokens,
            newHistoryTokens,
            croppedCount: olderHistory.length
        };
    }

    private static updateTreeWithKeptFiles(tree: string, keptPaths: string[], mutedPaths: string[] = []): string {
        if (!tree) return tree;
        const keptSet = new Set(keptPaths.map(p => path.basename(p.replace(/\\/g, '/')).toLowerCase()));
        const mutedSet = new Set(mutedPaths.map(p => path.basename(p.replace(/\\/g, '/')).toLowerCase()));

        let updated = tree.replace(/([^\s,\[\]\(\)\/]+)\s*\[(?:C|M|D)\]/g, '$1');

        return updated.replace(/([a-zA-Z0-9_\-\.]+\.[a-zA-Z0-9]+)(?=[,\s\]])/g, (match, fileName) => {
            const lower = fileName.toLowerCase();
            if (keptSet.has(lower)) {
                return `${fileName} [C]`;
            } else if (mutedSet.has(lower)) {
                return `${fileName} [M]`;
            }
            return fileName;
        });
    }

    private static pathsMatch(p1: string, p2: string): boolean {
        if (!p1 || !p2) return false;
        const c1 = p1.replace(/\\/g, '/').toLowerCase().trim().replace(/^\.?\/+/, '');
        const c2 = p2.replace(/\\/g, '/').toLowerCase().trim().replace(/^\.?\/+/, '');
        if (c1 === c2) return true;
        if (c1.endsWith('/' + c2) || c2.endsWith('/' + c1)) return true;

        const base1 = c1.split('/').pop() || '';
        const base2 = c2.split('/').pop() || '';
        return base1.length > 0 && base1 === base2;
    }

    private static updateDiscussionMetrics(
        currentDiscussion: Discussion,
        discussionManager: DiscussionManager,
        totalTokens: number,
        maxTokens: number,
        systemTokens: number,
        briefingTokens: number,
        treeTokens: number,
        skillsTokens: number,
        filesTokens: number,
        historyTokens: number
    ): void {
        if (!currentDiscussion) return;
        currentDiscussion.lastTokenMetrics = {
            total: totalTokens,
            contextSize: maxTokens,
            segments: {
                system: systemTokens,
                briefing: briefingTokens,
                tree: treeTokens,
                skills: skillsTokens,
                memory: 0,
                diagrams: 0,
                files: filesTokens,
                history: historyTokens,
                images: 0
            }
        };
        if (!currentDiscussion.id.startsWith('temp-')) {
            discussionManager.saveDiscussion(currentDiscussion).catch(() => {});
        }
    }

    private static buildPassingResult(
        contextData: ContextResult,
        baseInstructions: string,
        history: ChatMessage[],
        currentPromptMessage: ChatMessage | undefined,
        totalTokens: number,
        maxTokens: number,
        systemTokens: number,
        briefingTokens: number,
        treeTokens: number,
        skillsTokens: number,
        capabilities: DiscussionCapabilities,
        briefingContent?: string,
        fallbackPromptText?: string,
        governorReport?: string,
        overrideSelectedFilesContent?: string
    ): GovernorArbitrationResult {
        const briefingText = briefingContent !== undefined ? briefingContent : "";
        const finalTree = (contextData.projectTree && contextData.projectTree.trim()) 
            ? contextData.projectTree 
            : "```text\n./: [Workspace root]\n```";

        const filesContent = overrideSelectedFilesContent !== undefined 
            ? overrideSelectedFilesContent 
            : (contextData.selectedFilesContent || "");

        const projectStateText = `
### 📂 ATTACHED PROJECT CONTEXT
I am providing you with the current, ground-truth state of my project files and the technical briefing.

${briefingText && !briefingText.includes("Librarian is analyzing") ? `#### 📋 TEAM TECHNICAL BRIEFING\n${briefingText}\n` : ""}
#### 🌳 PROJECT STRUCTURE
${finalTree}

${filesContent ? `#### 📄 FILE CONTENTS\n${filesContent}` : "*(No files currently selected)*"}
--------------------------------------------------`.trim();

        const { ensureStrictAlternatingRoles, mergeMessageContents } = require('./utils');

        const promptText = (currentPromptMessage && currentPromptMessage.content)
            ? currentPromptMessage.content
            : (fallbackPromptText || "");

        // The Worker and Librarian communicate solely through the findings file in the system prompt (.lollms/structure.md).
        // The user's prompt text must remain clean without librarian report blocks or decision text.
        let singleUserContent: any = projectStateText;
        if (promptText) {
            singleUserContent = mergeMessageContents(projectStateText, promptText);
        }

        if (capabilities.enableImages !== false && contextData.images && contextData.images.length > 0) {
            if (typeof singleUserContent === 'string') {
                singleUserContent = [
                    { type: 'text', text: singleUserContent },
                    ...contextData.images.map(img => ({ type: 'image_url', image_url: { url: img.data } }))
                ];
            } else if (Array.isArray(singleUserContent)) {
                contextData.images.forEach(img => {
                    singleUserContent.push({ type: 'image_url', image_url: { url: img.data } });
                });
            }
        }

        const singleUserMessage: ChatMessage = {
            role: 'user',
            content: singleUserContent
        };

        const rawMessages: ChatMessage[] = [
            { role: 'system', content: baseInstructions },
            ...history.filter(m => !m.skipInPrompt),
            singleUserMessage
        ];

        const messagesToSend = ensureStrictAlternatingRoles(rawMessages);

        return {
            selectedFilesContent: filesContent,
            messagesToSend,
            totalTokens,
            contextSize: maxTokens,
            history,
            governorReport
        };
    }
}

export { ContextLibrarian as ContextGovernor };
export { ContextLibrarian as Librarian };
export default ContextLibrarian;