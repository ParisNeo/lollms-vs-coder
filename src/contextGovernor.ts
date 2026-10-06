import * as vscode from 'vscode';
import * as path from 'path';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { ContextManager, ContextResult } from './contextManager';
import { DiscussionManager, Discussion } from './discussionManager';
import { DiscussionCapabilities, stripThinkingTags, extractFileBlocks, parseFileTagAttributes } from './utils';
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

export class ContextGovernor {
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
            if (lower.match(/^#+\s*(?:muted\s+files|active\s+files|files\s+kept|files\s+to\s+edit|priority\s+edit\s+files|evicted\s+files|token\s+budget|governor\s+selection|session\s+events)/i)) {
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
            const structUri = vscode.Uri.joinPath(lollmsDir, 'structure.md');
            await vscode.workspace.fs.writeFile(structUri, Buffer.from(cleaned, 'utf8'));
            return true;
        } catch (err: any) {
            Logger.warn("Failed to write .lollms/structure.md", err);
            return false;
        }
    }

    /**
     * Interactive Studio filtering routine supporting peeks, full-file reads, and tri-tier classification.
     */
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
        onStatusUpdate?: (status: string) => void;
        onRoundProgress?: (progress: { round: number; maxRounds: number; status: string; discoverySteps?: any[] }) => void;
        onStreamChunk?: (data: { round: number; maxRounds: number; chunk: string; fullText: string; messageId: string }) => void;
        onDiscoveryAction?: (data: { type: string; label: string; detail?: string; output?: string }) => void;
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

        if (onStatusUpdate) onStatusUpdate("Governor: Initializing token budget & reading files...");

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
        const effectiveRounds = (configuredRounds && configuredRounds >= 10) ? configuredRounds : (fallbackConfigRounds || 20);
        const maxRounds = Math.max(15, effectiveRounds);

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

        for (const candidate of fileCandidates) {
            const keep = candidate.role === 'edit' || (candidate.role === 'context' && decision?.status === 'fit_all');
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

    /**
     * Executes the Context Governor arbitration algorithm before worker generation.
     */
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
        const effectiveRounds = (configuredRounds && configuredRounds >= 10) ? configuredRounds : (fallbackConfigRounds || 20);
        const maxNegotiationRounds = Math.max(15, effectiveRounds);
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
        const briefingContent = contextManager.renderBriefing(currentDiscussion);
        const briefingTokens = Math.ceil((briefingContent || '').length / 3.5);
        const promptTokens = Math.ceil(cleanUserPromptText.length / 3.5);

        // Account for images as fixed multimodal vision tokens (~600 tok/img), NOT base64 character text
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

        // Continuation Fast-Path: Bypass re-splitting if continuing multi-part sequence
        if (isMultiPartContinuation) {
            const passingTotal = fixedLoad + Math.ceil((contextData.selectedFilesContent || '').length / 3.5);
            return this.buildPassingResult(
                contextData, baseInstructions, history, currentPromptMessage, passingTotal, maxTokens,
                systemTokens, briefingTokens, treeTokens, skillsTokens, capabilities, briefingContent, userPromptText
            );
        }

        const provider = contextManager.getContextStateProvider();
        const allIncludedFiles = provider ? provider.getIncludedFiles().filter(f => f && f.path) : [];

        // If context governor is explicitly disabled via discussion settings
        if (capabilities.contextGovernorEnabled === false) {
            const activeFilesTokens = Math.ceil((contextData.selectedFilesContent || '').length / 3.5);
            const totalLoad = fixedLoad + activeFilesTokens;
            if (totalLoad > maxTokens) {
                if (onAddMessage) {
                    await onAddMessage({
                        role: 'system',
                        content: `🛑 **Context Limit Exceeded (>100%)**\nActive context load (~${totalLoad.toLocaleString()} tokens) exceeds model capacity (**${maxTokens.toLocaleString()}** tokens).\n\nEnable Context Governor in settings or mute unneeded files.`
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

        // --- SMART THRESHOLD GATING (AVOID WASTEFUL PER-TURN RUNS) ---
        // Most of the time inside a discussion, once the right files are selected we keep using them.
        // If active load is within the trigger threshold and no explicit governor directive was given, pass through cleanly!
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

        const activeUsagePercent = maxTokens > 0 ? Math.round((activeContextLoad / maxTokens) * 100) : 0;
        if (onStatusUpdate) {
            onStatusUpdate(`⚖️ Governor: Active load at ${activeUsagePercent}%. Arbitrating context...`);
        }

        const pruneMsgId = 'gov_stream_' + Date.now();
        if (onAddMessage) {
            await onAddMessage({
                id: pruneMsgId,
                role: 'system',
                personalityName: '⚖️ Context Governor',
                content: `⚖️ **Context Governor: Engaged**\nAnalyzing ${fileCandidates.length} files (Pool: ~${totalCandidateTokens.toLocaleString()} tok, Unmuted: ~${currentUnmutedTokens.toLocaleString()} tok)...\nTarget budget: ~${objectiveThreshold.toLocaleString()} tok (${objectiveThresholdPercent}% of ${maxTokens.toLocaleString()}).`,
                skipInPrompt: true
            });
        }

        const negotiationResult = await this.runGovernorNegotiation({
            lollmsAPI,
            contextManager,
            targetModel,
            signal,
            userPromptText,
            fileCandidates,
            currentMuted,
            totalEstimated: activeContextLoad,
            maxTokens,
            triggerThresholdPercent,
            objectiveThresholdPercent,
            objectiveThreshold,
            overflow: Math.max(0, activeContextLoad - objectiveThreshold),
            canAvoidEvictingCurrentPrompt: true,
            keywords,
            maxRounds: maxNegotiationRounds,
            governorDirectives: allGovernorDirectives,
            pruneMsgId,
            onStatusUpdate,
            onAddMessage,
            optionsUpdateMessage: options.onUpdateMessage
        });

        const { decision, workerAdvice, signatures, governorReport, multiPartPlan } = negotiationResult;

        // Apply classification to candidates
        const editCandidates = fileCandidates.filter(c => c.role === 'edit');
        const contextCandidates = fileCandidates.filter(c => c.role === 'context');
        const unneededCandidates = fileCandidates.filter(c => c.role === 'unneeded');

        let keptBlocks: ParsedFileCandidate[] = [];
        let mutedBlocks: ParsedFileCandidate[] = [];

        if (decision.status === 'fit_all') {
            keptBlocks = [...editCandidates, ...contextCandidates];
            mutedBlocks = unneededCandidates;
        } else if (decision.status === 'fit_edits_only') {
            keptBlocks = editCandidates;
            mutedBlocks = [...contextCandidates, ...unneededCandidates];
        } else {
            // multiPartPlan: Phase 1 files unmuted
            const phase1Files = multiPartPlan?.parts[0]?.editFiles || [];
            keptBlocks = fileCandidates.filter(c => phase1Files.some(pf => this.pathsMatch(pf, c.path)));
            mutedBlocks = fileCandidates.filter(c => !phase1Files.some(pf => this.pathsMatch(pf, c.path)));
        }

        currentDiscussion.mutedFiles = mutedBlocks.map(b => b.path);
        if (!currentDiscussion.id.startsWith('temp-')) {
            await discussionManager.saveDiscussion(currentDiscussion);
        }

        // If Governor identified missing files from tree that should be in context, add them
        if (negotiationResult.addedFiles && negotiationResult.addedFiles.length > 0) {
            try {
                await contextManager.getContextStateProvider()?.addFilesToContext(negotiationResult.addedFiles);
            } catch {}
        }

        const newSelectedFilesContent = keptBlocks.map(b => {
            const formatted = (b as any).body ? ((b as any).body.endsWith('\n') ? (b as any).body : (b as any).body + '\n') : '';
            return formatted ? `<file path="${b.path}">\n${formatted}</file>

\n\n` : b.fullMatch;
        }).join('\n\n');

        const updatedProjectTree = this.updateTreeWithKeptFiles(
            contextData.projectTree,
            keptBlocks.map(b => b.path),
            mutedBlocks.map(b => b.path)
        );
        contextData.projectTree = updatedProjectTree;

        const newActiveFilesTokens = keptBlocks.reduce((sum, b) => sum + b.tokens, 0);
        const newTotal = fixedLoad + newActiveFilesTokens;

        if (newTotal > hardCap120) {
            if (onAddMessage) {
                await onAddMessage({
                    role: 'system',
                    content: `🛑 **Context Limit Exceeded (>120%)**\nPayload (~${newTotal.toLocaleString()} tokens) exceeds 120% of model capacity. Clear history or prune files.`
                });
            }
            return null;
        }

        let finalReportWithHistory = "";
        const steps = (negotiationResult as any)?.discoverySteps || [];

        if (steps.length > 0 || (negotiationResult as any).roundsUsed > 1) {
            finalReportWithHistory += `### ⚖️ **Context Governor: Multi-Round Investigation History**\n\n`;
            finalReportWithHistory += `<details open style="margin-bottom: 12px; border: 1px solid var(--vscode-widget-border); border-radius: 6px; padding: 8px 12px; background: rgba(0,0,0,0.1);">\n`;
            finalReportWithHistory += `<summary style="font-size: 11px; font-weight: bold; cursor: pointer; color: var(--vscode-charts-orange);"><i class="codicon codicon-history"></i> Investigation Rounds (${(negotiationResult as any).roundsUsed || 1} rounds evaluated)</summary>\n\n`;

            if (steps.length > 0) {
                finalReportWithHistory += `**Discovery Actions Taken**:\n` + steps.map((s: any) => `- \`${s.label}\` (${s.detail || s.type})`).join('\n') + '\n\n';
            }

            finalReportWithHistory += `</details>\n\n---\n\n`;
        }

        finalReportWithHistory += `### ⚖️ **Context Governor: Arbitration Complete**
- **Decision Status**: \`${decision.status.toUpperCase()}\`
- **Active Files to Modify [C]**: ${keptBlocks.length} (${keptBlocks.map(k => `\`${k.path}\``).join(', ') || 'None'})
- **Muted Reference Files [M]**: ${mutedBlocks.length} (Key interfaces preserved in Governor's Report in prompt)
- **Active Context Load**: ${Math.round((newTotal / maxTokens) * 100)}% (~${newTotal.toLocaleString()} / ${maxTokens.toLocaleString()} tokens)
${multiPartPlan ? `\n⚠️ **Task Partitioned**: Split into **${multiPartPlan.totalParts} sequential phases** to guarantee context window capacity.` : ''}`;

        if (options.onUpdateMessage) {
            await options.onUpdateMessage(pruneMsgId, finalReportWithHistory);
        } else if (onAddMessage) {
            await onAddMessage({
                id: 'gov_result_' + Date.now(),
                role: 'system',
                personalityName: '⚖️ Context Governor',
                content: finalReportWithHistory,
                skipInPrompt: true
            });
        }

        const finalPassingResult = this.buildPassingResult(
            contextData, baseInstructions, history, currentPromptMessage, newTotal, maxTokens,
            systemTokens, briefingTokens, treeTokens, skillsTokens, capabilities, briefingContent, userPromptText,
            governorReport, newSelectedFilesContent
        );

        finalPassingResult.multiPartPlan = multiPartPlan;
        finalPassingResult.governorReport = governorReport;
        finalPassingResult.signatures = signatures;

        return finalPassingResult;
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
            return text
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
                .replace(/<governor_decision\b[^>]*>[\s\S]*?<\/governor_decision>/gi, '')
                .replace(/<reveal_only\b[^>]*>[\s\S]*?<\/reveal_only>/gi, '')
                .replace(/<mute_only\b[^>]*>[\s\S]*?<\/mute_only>/gi, '')
                .trim();
        };

        const formatAccumulatedRoundsMarkdown = (liveRoundIndex?: number, liveStreamContent?: string) => {
            let md = `### ⚖️ **Context Governor Investigation**\n`;
            md += `*Pool: ~${totalCandidateTokens.toLocaleString()} tok &middot; Unmuted: ~${currentUnmutedTokens.toLocaleString()} tok &middot; Target: ~${objectiveThreshold.toLocaleString()} tok (${objectiveThresholdPercent}%)*\n\n`;

            if (completedRounds.length > 0) {
                md += completedRounds.map(r => {
                    let block = `#### ⚖️ **Round ${r.round}/${maxRounds}**\n${r.thoughts}`;
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
                md += `#### ⚖️ **Round ${liveRoundIndex}/${maxRounds} (Evaluating live)**\n${cleanedLive || liveStreamContent || '*(Analyzing...)*'}`;
            }

            return md;
        };

        const compactCatalog = this.buildCompactCatalog(fileCandidates, options.currentMuted);
        const existingStructure = await this.getStructureGuide();

        let projectTreePreview = "";
        try {
            projectTreePreview = await contextManager.generateProjectTree(signal);
        } catch {}

        const formatSize = (b: number) => {
            if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
            if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
            return `${b} B`;
        };

        const totalCandidateTokens = fileCandidates.reduce((sum, c) => sum + c.tokens, 0);
        const currentUnmutedTokens = fileCandidates.filter(c => !options.currentMuted.some(m => this.pathsMatch(m, c.path))).reduce((sum, c) => sum + c.tokens, 0);

        const systemPrompt = `You are the **Sovereign Context Governor**.
Your mission is to manage active context, explore the project to understand the user's task, and arbitrate files to bring the active unmuted files count below the objective budget (${objectiveThresholdPercent}%, max ${objectiveThreshold.toLocaleString()} tokens).
Capacity limit: ${maxTokens.toLocaleString()} tokens.
Allowed Negotiation Rounds: Up to ${maxRounds}.

### 📊 REAL-TIME TOKEN AUDIT & BUDGET OBJECTIVE:
- **Total Candidates Pool Tokens (Muted + Unmuted)**: ~${totalCandidateTokens.toLocaleString()} tokens (${fileCandidates.length} files)
- **Current Unmuted Files Tokens ([C] Active)**: ~${currentUnmutedTokens.toLocaleString()} tokens
- **Maximum Window Capacity**: ${maxTokens.toLocaleString()} tokens
- **Target Objective Threshold (${objectiveThresholdPercent}%)**: ~${objectiveThreshold.toLocaleString()} tokens
- **Goal**: Ensure the unmuted files token count fits within the target budget.

### ⚖️ TRI-TIER CLASSIFICATION ARBITRATION (EDIT VS REFERENCE):
You MUST categorize all files into three distinct categories:
1. **EDIT FILES (Mandatory)**: Files that MUST be modified or created to fulfill the user's task.
2. **CONTEXT FILES (Reference)**: Files needed ONLY as references to understand function signatures, contracts, schemas, or callers (files that will NOT be changed).
3. **UNNEEDED FILES**: Files completely unrelated to the user's task.

### 🚦 THREE-TIER FITTING LOGIC:
- **TIER A (fit_all)**: If tokens(edit_files) + tokens(context_files) <= targetBudget, unmute both!
- **TIER B (fit_edits_only)**: If tokens(edit_files) fits within budget, but full context files would exceed it:
  * Unmute EDIT FILES (they must be loaded with full content [C]).
  * Mute CONTEXT FILES (0 tokens [M] in tree).
  * Extract relevant function signatures, types, and interfaces from context files into <governor_report>...</governor_report>.
- **TIER C (split_multi_part)**: If even tokens(edit_files) exceeds the budget alone:
  * Partition edit files into sequential parts: Part 1, Part 2, etc., so each part fits.
  * Formulate clear multi-phase instructions in <governor_report>.

### 🛠️ ACTIVE INVESTIGATION TOOLS:
1. **Full File Read**: <read_full_file path="path/to/file.ext" />
   Reads the complete file content for this round so you can inspect all its classes/functions and extract contracts into your report.
2. **Peek File Slice**: <peek_files path="path/to/file.ext" lines="30" from="top|bottom" />
3. **Grep Search**: <grep pattern="searchTerm" path="optional/subdir" />
4. **SPARQL Architecture Query**: <sparql query="SELECT ?x WHERE { ?x s:type s:Class }" />
5. **Add Tree Files to Context**: <add_files_to_context>\\npath/to/file.ext\\n</add_files_to_context>
6. **Update Structure Guide**: <structure># Architecture Guide\\n...</structure> (.lollms/structure.md)

### 📋 FINAL ARBITRATION TAG:
When ready to conclude, output your final decision using:
<governor_decision status="fit_all|fit_edits_only|split_multi_part">
<edit_files>
path/to/file_to_edit.ext
</edit_files>
<context_files>
path/to/reference_file.ext
</context_files>
<unneeded_files>
path/to/unneeded_file.ext
</unneeded_files>
<governor_report>
### 🏛️ ARCHITECTURAL CONTRACTS & REFERENCE FINDINGS
- Specific functions, contracts, types, or multi-phase instructions from reference files ...
</governor_report>
<rationale>
Why these files were chosen.
</rationale>
</governor_decision>`;

        const safeUserPromptText = (userPromptText || '')
            .replace(/data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=]{50,}/g, '[Attached Image]')
            .trim();

        const initialUserPrompt = `### 🎯 USER OBJECTIVE:
"${safeUserPromptText}"

### 📊 REAL-TIME TOKEN AUDIT & BUDGET OBJECTIVE:
- Total Candidates Pool (Muted + Unmuted): ~${totalCandidateTokens.toLocaleString()} tokens (${fileCandidates.length} files)
- Current Unmuted Files Load: ~${currentUnmutedTokens.toLocaleString()} tokens
- Target Budget Threshold: ~${objectiveThreshold.toLocaleString()} tokens (${objectiveThresholdPercent}% of ${maxTokens.toLocaleString()})

${existingStructure ? `### 🏛️ CODEBASE STRUCTURE GUIDE (.lollms/structure.md):\n${existingStructure.substring(0, 2000)}\n` : '*(No .lollms/structure.md yet. Make an educated guess from the tree below, then verify with <peek_files> or <read_full_file>)*\n'}
### 🌳 PROJECT STRUCTURE TREE:
${projectTreePreview ? projectTreePreview.substring(0, 3000) : '(No tree available)'}

${governorDirectives && governorDirectives.length > 0 ? `### ⚖️ DIRECT USER DIRECTIVES:\n${governorDirectives.map(d => `- ${d}`).join('\n')}\n\n` : ''}### 📄 CANDIDATE FILES CATALOG:
${compactCatalog}

Analyze the requirements. If you lack information on contracts or implementations, execute discovery tools (<read_full_file>, <peek_files>, <grep>, <sparql>). When ready, output your <governor_decision>.`;

        const conversation: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: initialUserPrompt }
        ];

        while (currentRound < maxRounds) {
            if (signal.aborted) break;
            currentRound++;
            if (onRoundUsed) onRoundUsed(currentRound);

            const roundMessageId = `gov_round_${currentRound}_${Date.now()}`;
            const statusText = `Governor: Round ${currentRound}/${maxRounds} (Active: ~${currentUnmutedTokens.toLocaleString()}/${objectiveThreshold.toLocaleString()} tok)...`;
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
                Logger.error(`[Governor] LLM query failed in round ${currentRound}: ${err.message}`);
                throw new Error(`Governor could not communicate with LLM: ${err.message}`);
            }

            const currentThoughts = cleanActionTagsFromText(cleanResponse) || cleanResponse;

            // 1. Structure guide update
            const structMatch = cleanResponse.match(/<structure\b[^>]*>([\s\S]*?)<\/structure>/i);
            if (structMatch && structMatch[1].trim()) {
                await this.saveStructureGuide(structMatch[1].trim());
                const step = { type: 'structure', label: 'Updated Structure Guide', detail: '.lollms/structure.md' };
                discoverySteps.push(step);
                if (onDiscoveryAction) onDiscoveryAction(step);

                completedRounds.push({
                    round: currentRound,
                    thoughts: currentThoughts,
                    toolAction: 'Updated Codebase Architecture Guide (.lollms/structure.md)',
                    toolObservation: 'Architecture and component contracts recorded to persistent storage.'
                });

                if (options.optionsUpdateMessage && options.pruneMsgId) {
                    options.optionsUpdateMessage(options.pruneMsgId, formatAccumulatedRoundsMarkdown()).catch(() => {});
                }
            }

            // 2. Full File Read Tool
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

                conversation.push({ role: 'assistant', content: cleanResponse });
                conversation.push({
                    role: 'user',
                    content: `### 📄 FULL FILE INSPECTION: \`${reqPath}\`\n\`\`\`\n${contentText}\n\`\`\`\n\nYou have now read this file for this round. Extract any key contracts/signatures into your scratchpad or <structure>, categorize it as edit or context, or proceed with other files.`
                });
                continue;
            }

            // 3. Peek File Tool
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

                    conversation.push({ role: 'assistant', content: cleanResponse });
                    conversation.push({
                        role: 'user',
                        content: `### 📄 PEEK SLICE FOR "${targetPath}":\n\`\`\`\n${snippet}\n\`\`\`\n\nContinue scouting or output your <governor_decision>.`
                    });
                    continue;
                }
            }

            // 4. Grep Tool
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

                    conversation.push({ role: 'assistant', content: cleanResponse });
                    conversation.push({
                        role: 'user',
                        content: `### 🔍 GREP RESULTS FOR "${pattern}":\n${snippet}\n\nContinue scouting or output your <governor_decision>.`
                    });
                    continue;
                }
            }

            // 5. SPARQL Tool
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
                        content: `### 📊 SPARQL RESULTS:\n${sparqlRes}\n\nContinue scouting or output your <governor_decision>.`
                    });
                    continue;
                }
            }

            // 6. Add Files to Context Tool
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
                    content: `Added files to candidate pool. Now evaluate them and output your <governor_decision>.`
                });
                continue;
            }

            // 7. Parse Arbitration Decision Tag
            const decisionTagMatch = cleanResponse.match(/<governor_decision\b[^>]*status=["']([^"']+)["'][^>]*>([\s\S]*?)<\/governor_decision>/i) ||
                                     cleanResponse.match(/<governor_decision>([\s\S]*?)<\/governor_decision>/i);

            const reportTagMatch = cleanResponse.match(/<governor_report\b[^>]*>([\s\S]*?)<\/governor_report>/i);
            const rationaleTagMatch = cleanResponse.match(/<rationale\b[^>]*>([\s\S]*?)<\/rationale>/i);
            const adviceTagMatch = cleanResponse.match(/<worker\b[^>]*>([\s\S]*?)<\/worker>/i);
            const sigTagMatch = cleanResponse.match(/<signatures\b[^>]*>([\s\S]*?)<\/signatures>/i);

            if (reportTagMatch) extractedReport = reportTagMatch[1].trim();
            if (rationaleTagMatch) extractedAdvice = rationaleTagMatch[1].trim();
            if (adviceTagMatch) extractedAdvice = extractedAdvice || adviceTagMatch[1].trim();
            if (sigTagMatch) extractedSignatures = sigTagMatch[1].trim();

            let decisionStatus = 'fit_all';
            let editPaths: string[] = [];
            let contextPaths: string[] = [];
            let unneededPaths: string[] = [];

            if (decisionTagMatch) {
                const statusAttr = cleanResponse.match(/<governor_decision\b[^>]*status=["']([^"']+)["']/i);
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

            // Assign roles to candidates
            fileCandidates.forEach(c => {
                if (editPaths.some(ep => this.pathsMatch(ep, c.path))) {
                    c.role = 'edit';
                    c.keep = true;
                } else if (contextPaths.some(cp => this.pathsMatch(cp, c.path))) {
                    c.role = 'context';
                    c.keep = false;
                } else if (unneededPaths.some(up => this.pathsMatch(up, c.path))) {
                    c.role = 'unneeded';
                    c.keep = false;
                } else {
                    c.role = c.isCurrentPromptFile ? 'edit' : 'context';
                    c.keep = false;
                }
            });

            // Perform budget verification
            const editTokens = fileCandidates.filter(c => c.role === 'edit').reduce((sum, c) => sum + c.tokens, 0);
            const contextTokens = fileCandidates.filter(c => c.role === 'context').reduce((sum, c) => sum + c.tokens, 0);
            const availableBudget = objectiveThreshold;

            let multiPartPlan: MultiPartPlan | undefined = undefined;

            if (editTokens + contextTokens <= availableBudget) {
                decisionStatus = 'fit_all';
                fileCandidates.forEach(c => {
                    if (c.role === 'edit' || c.role === 'context') c.keep = true;
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
                rationale: extractedAdvice || `Governor arbitrated context: status ${decisionStatus}.`,
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

        // Record final round if thoughts were generated
        if (currentThoughts && !completedRounds.some(r => r.round === currentRound)) {
            completedRounds.push({
                round: currentRound,
                thoughts: currentThoughts
            });
        }

        // Fallback if negotiation ended without explicit decision
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
        const targetBudgetPerPhase = Math.max(1000, budget - 4000); // 4k buffer for instructions/report

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
            rationale: "Deterministic fallback applied to satisfy context budget.",
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

        return candidates.map(c => {
            const isMuted = currentMuted.some(m => this.pathsMatch(m, c.path));
            const statusTag = isMuted ? ' [MUTED]' : ' [ACTIVE]';
            const shieldTag = c.isCurrentPromptFile ? ' [CURRENT PROMPT]' : '';
            const coreTag = c.isCoreOrInterface ? ' [CORE / INTERFACE]' : '';
            const sizeStr = `${formatSize(c.bytes)} (~${c.tokens.toLocaleString()} tok${c.linesCount > 0 ? `, ${c.linesCount} lines` : ''})`;
            return `- File: \`${c.path}\`${statusTag} (${sizeStr})${shieldTag}${coreTag}`;
        }).join('\n');
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

        const summaryPrompt = `You are the Sovereign Context Governor.
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
            Logger.warn(`[Governor] LLM history summarization failed: ${err.message}`);
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
            content: `### 📋 CROPPED HISTORY SUMMARY & IMPORTANT STUFF TO DO\n*Earlier conversation history was cropped by the Context Governor to free token budget.*\n\n${summaryText}`
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

        // INJECT <governor_report> DIRECTLY INTO THE USER PROMPT TURN
        let enrichedPrompt = promptText;
        if (governorReport && governorReport.trim().length > 0) {
            const reportBlock = `<governor_report>\n${governorReport.trim()}\n</governor_report>\n\n`;
            if (typeof enrichedPrompt === 'string') {
                enrichedPrompt = reportBlock + enrichedPrompt;
            } else if (Array.isArray(enrichedPrompt)) {
                enrichedPrompt = [
                    { type: 'text', text: reportBlock },
                    ...enrichedPrompt
                ];
            }
        }

        let singleUserContent: any = projectStateText;
        if (enrichedPrompt) {
            singleUserContent = mergeMessageContents(projectStateText, enrichedPrompt);
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

export default ContextGovernor;