import * as vscode from 'vscode';
import * as path from 'path';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { ContextManager, ContextResult } from './contextManager';
import { DiscussionManager, Discussion } from './discussionManager';
import { DiscussionCapabilities, stripThinkingTags, extractFileBlocks, parseFileTagAttributes } from './utils';
import { Logger } from './logger';

export interface GovernorArbitrationResult {
    selectedFilesContent: string;
    messagesToSend: ChatMessage[];
    totalTokens: number;
    contextSize: number;
    history: ChatMessage[];
    chunkingNotice?: string;
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
    onStatusUpdate?: (status: string) => void;
    onAddMessage?: (message: ChatMessage) => Promise<void>;
    onUpdateMessage?: (messageId: string, content: string) => Promise<void>;
}

interface ParsedFileCandidate {
    fullMatch: string;
    path: string;
    tokens: number;
    isCurrentPromptFile: boolean;
    isCoreOrInterface: boolean;
    relevanceScore: number;
    matchedKeywords: string[];
    extractedSymbols: string[];
    keep: boolean;
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

    /**
     * Automatically filters files in context based on a user focus prompt.
     * Selects files to keep active (content loaded) and files to mute (0 tokens, kept in tree).
     */
    public static async filterFilesByPrompt(options: {
        lollmsAPI: LollmsAPI;
        contextManager: ContextManager;
        discussionManager: DiscussionManager;
        currentDiscussion: Discussion;
        targetModel: string;
        prompt: string;
        signal: AbortSignal;
        onStatusUpdate?: (status: string) => void;
    }): Promise<{
        keptFiles: string[];
        mutedFiles: string[];
        rationale: string;
        totalTokens: number;
        liberatedTokens: number;
    }> {
        const { lollmsAPI, contextManager, targetModel, prompt, signal, onStatusUpdate } = options;

        const provider = contextManager.getContextStateProvider();
        const rawIncluded = provider ? provider.getIncludedFiles().filter(f => f && f.path) : [];

        if (rawIncluded.length === 0) {
            return {
                keptFiles: [],
                mutedFiles: [],
                rationale: "No files are currently included in the context explorer.",
                totalTokens: 0,
                liberatedTokens: 0
            };
        }

        if (onStatusUpdate) onStatusUpdate("Governor: Reading candidate files & metadata...");

        const keywords = this.extractQueryKeywords(prompt, []);
        const fileCandidates: ParsedFileCandidate[] = [];

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
            fileCandidates.push(candidate);
        }

        if (onStatusUpdate) onStatusUpdate(`Governor: Asking AI to evaluate ${fileCandidates.length} files...`);

        const compactCatalog = this.buildCompactCatalog(fileCandidates, options.currentDiscussion?.mutedFiles || []);

        const systemPrompt = `You are the **Sovereign Context Governor**.
Your task is to analyze the user's focus objective and decide which files to keep in active context (content loaded) vs which files to mute (0 tokens, kept in tree tagged [M]).

### CANDIDATE FILES (FULL CATALOG):
Files marked [C] have full content loaded. Files marked [M] are currently muted.
${compactCatalog}

### MANDATORY OUTPUT FORMAT (USE THESE EXACT TAGS):
<mute>
path/to/file_to_mute.ext
</mute>

<worker>
Specific advice, findings, or guidance to forward to the worker model answering the user's request.
</worker>

RULES:
1. Put every file that should be MUTED inside <mute>...</mute>, exactly one path per line.
2. Any file NOT listed inside <mute> will be KEPT ACTIVE with full content loaded ([C]).
3. If all files should be active, output <mute></mute> empty.
4. Put concise advice or guidance for the worker model inside <worker>...</worker>.`;

        const userMsg = `### USER FOCUS OBJECTIVE:
"${prompt}"

Select which files to mute and which to keep active. Output <mute> and <worker> tags.`;

        let rawResponse = "";
        let mutedFromTags: string[] | null = null;
        let workerAdvice = "";

        try {
            rawResponse = await lollmsAPI.sendChat([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMsg }
            ], null, signal, targetModel, { thinking: false });

            const cleanResponse = stripThinkingTags(rawResponse).trim();

            const muteMatch = cleanResponse.match(/<mute\b[^>]*>([\s\S]*?)<\/mute>/i);
            if (muteMatch) {
                mutedFromTags = muteMatch[1]
                    .split(/[\r\n,]+/)
                    .map(l => l.trim().replace(/^['"]|['"]$/g, ''))
                    .filter(l => l.length > 0 && !l.startsWith('<'));
            }

            const workerMatch = cleanResponse.match(/<worker\b[^>]*>([\s\S]*?)<\/worker>/i);
            if (workerMatch) {
                workerAdvice = workerMatch[1].trim();
            }

            // JSON fallback if model used JSON
            if (mutedFromTags === null) {
                const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    if (Array.isArray(parsed.evict)) {
                        mutedFromTags = parsed.evict.map((e: any) => typeof e === 'string' ? e : e.path).filter(Boolean);
                    } else if (Array.isArray(parsed.mute)) {
                        mutedFromTags = parsed.mute.map((e: any) => typeof e === 'string' ? e : e.path).filter(Boolean);
                    }
                    if (parsed.worker || parsed.worker_advice) {
                        workerAdvice = String(parsed.worker || parsed.worker_advice).trim();
                    }
                }
            }
        } catch (llmErr: any) {
            Logger.warn(`[Governor] LLM prompt filter failed: ${llmErr.message}, using heuristic fallback.`);
        }

        const keptFiles: string[] = [];
        const mutedFiles: string[] = [];
        let totalTokens = 0;
        let liberatedTokens = 0;

        for (const candidate of fileCandidates) {
            let keep = true;
            if (mutedFromTags !== null) {
                const shouldMute = mutedFromTags.some(m => this.pathsMatch(m, candidate.path));
                keep = !shouldMute;
            } else {
                keep = candidate.relevanceScore > 0;
            }

            if (keep) {
                keptFiles.push(candidate.path);
                totalTokens += candidate.tokens;
            } else {
                mutedFiles.push(candidate.path);
                liberatedTokens += candidate.tokens;
            }
        }

        if (keptFiles.length === 0 && fileCandidates.length > 0) {
            const highestScoring = [...fileCandidates].sort((a, b) => b.relevanceScore - a.relevanceScore)[0];
            const idx = mutedFiles.indexOf(highestScoring.path);
            if (idx !== -1) mutedFiles.splice(idx, 1);
            keptFiles.push(highestScoring.path);
            totalTokens += highestScoring.tokens;
            liberatedTokens -= highestScoring.tokens;
        }

        const rationale = workerAdvice ||
            `Filtered context for "${prompt}": Kept ${keptFiles.length} active file(s) and muted ${mutedFiles.length} file(s).`;

        return {
            keptFiles,
            mutedFiles,
            rationale,
            totalTokens,
            liberatedTokens
        };
    }

    /**
     * Executes the Context Governor arbitration algorithm.
     * Can reduce contexts loaded up to 1000%+ down to the target model threshold safely.
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
            onStatusUpdate,
            onAddMessage,
            onUpdateMessage
        } = options;

        let history = [...options.history];

        // 1. Resolve Context Size Capacity and Thresholds
        const ctxSizeRes = await lollmsAPI.getContextSize(targetModel).catch(() => null);
        const authoritativeMaxTokens = (ctxSizeRes && ctxSizeRes.context_size > 0)
            ? ctxSizeRes.context_size
            : (currentDiscussion?.lastTokenMetrics?.contextSize || 128000);

        const maxTokens = authoritativeMaxTokens;

        // Trigger threshold: Percentage that triggers Governor into action
        const triggerThresholdPercent = capabilities.contextGovernorThreshold !== undefined
            ? capabilities.contextGovernorThreshold
            : 95;
        const triggerThreshold = Math.round(maxTokens * (triggerThresholdPercent / 100));

        // Objective threshold: Target percentage to reduce down to once triggered
        const objectiveThresholdPercent = capabilities.contextGovernorTargetThreshold !== undefined
            ? capabilities.contextGovernorTargetThreshold
            : Math.min(triggerThresholdPercent, 70);
        const objectiveThreshold = Math.round(maxTokens * (objectiveThresholdPercent / 100));

        const maxNegotiationRounds = capabilities.contextGovernorMaxRounds !== undefined
            ? capabilities.contextGovernorMaxRounds
            : 5;

        const hardCap120 = Math.round(maxTokens * 1.2);

        // 2. Calculate Base Non-File Fixed Loads
        const systemTokens = Math.ceil((baseInstructions || '').length / 3.5);
        let historyTokens = Math.ceil(history.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n').length / 3.5);
        const treeTokens = Math.ceil((contextData.projectTree || '').length / 3.5);
        const skillsTokens = Math.ceil((contextData.skillsContent || '').length / 3.5);
        const briefingContent = contextManager.renderBriefing(currentDiscussion);
        const briefingTokens = Math.ceil((briefingContent || '').length / 3.5);
        const promptTokens = Math.ceil((userPromptText || '').length / 3.5);

        let fixedLoad = systemTokens + historyTokens + treeTokens + skillsTokens + briefingTokens + promptTokens;

        // 3. Extract and Parse File Blocks across ALL candidate files in context
        const extractedBlocks = extractFileBlocks(contextData.selectedFilesContent);
        const fileCandidates: ParsedFileCandidate[] = [];

        // Extract and combine user governor directives
        const { extractGovernorDirectives } = require('./utils');
        const extractedFromPrompt = extractGovernorDirectives(userPromptText);
        const allGovernorDirectives: string[] = [
            ...(options.governorDirectives || []),
            ...extractedFromPrompt.governorDirectives
        ];
        const hasGovernorDirective = allGovernorDirectives.length > 0;

        // Extract keywords from user prompt, history, and governor directives for relevance matching
        const combinedKeywordsSource = `${userPromptText} ${allGovernorDirectives.join(' ')}`;
        const keywords = this.extractQueryKeywords(combinedKeywordsSource, history);

        // Always start from the original full list of files included in context
        const provider = contextManager.getContextStateProvider();
        const allIncludedFiles = provider ? provider.getIncludedFiles().filter(f => f && f.path) : [];

        const candidateSourceList = allIncludedFiles.length > 0 ? allIncludedFiles : extractedBlocks.map(eb => {
            const attrs = parseFileTagAttributes(eb.attrStr, eb.rawContent);
            return { path: attrs?.path || '', state: 'included' as any };
        }).filter(f => f.path);

        // Aggregate all muted files across discussion state and capabilities
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
        addMuted(currentDiscussion?.capabilities?.mutedFiles);
        const currentMuted = Array.from(currentMutedSet);

        const isCandidateMuted = (candidatePath: string): boolean => {
            if (currentMuted.some(m => this.pathsMatch(m, candidatePath))) return true;
            // Also check if contextData explicitly marked this file as muted
            const cleanPath = candidatePath.replace(/\\/g, '/').trim();
            const cleanBase = cleanPath.split('/').pop() || '';
            if (contextData.selectedFilesContent && (
                contextData.selectedFilesContent.includes(`\`${cleanPath}\` [MUTED FOR THIS DISCUSSION]`) ||
                contextData.selectedFilesContent.includes(`\`${cleanBase}\` [MUTED FOR THIS DISCUSSION]`)
            )) {
                return true;
            }
            return false;
        };

        for (const f of candidateSourceList) {
            let fullMatch = "";
            let fileBody = "";
            let tokens = (f as any).tokens || 0;

            const isMuted = isCandidateMuted(f.path);

            if (!isMuted) {
                const cached = (contextManager as any)._fileContentCache?.get(f.path);
                if (cached?.content) {
                    fileBody = cached.content;
                } else {
                    const res = await contextManager.resolveWorkspaceFromPath(f.path);
                    if (res) {
                        try {
                            const bytes = await vscode.workspace.fs.readFile(res.uri);
                            fileBody = Buffer.from(bytes).toString('utf8');
                        } catch {}
                    }
                }
                tokens = tokens || Math.max(1, Math.ceil(fileBody.length / 3.5));
                const formatted = fileBody.endsWith('\n') ? fileBody : fileBody + '\n';
                fullMatch = `<file path="${f.path}">\n${formatted}</file>

\n\n`;
            } else {
                tokens = (f as any).tokens || 0;
                if (tokens === 0) {
                    const cached = (contextManager as any)._fileContentCache?.get(f.path);
                    if (cached?.content) {
                        tokens = Math.max(1, Math.ceil(cached.content.length / 3.5));
                    }
                }
                fullMatch = `### 📄 \`${f.path}\` [MUTED FOR THIS DISCUSSION]\n> Content deactivated for this discussion by manual governor. Reactivate from HUD when needed.\n\n`;
            }

            const candidate = this.buildCandidate(fullMatch, f.path, fileBody, tokens, currentPromptAddedFiles, keywords, contextManager);

            if (hasGovernorDirective) {
                const normP = f.path.toLowerCase().replace(/\\/g, '/');
                const baseP = normP.split('/').pop() || '';
                const directiveText = allGovernorDirectives.join(' ').toLowerCase();
                if (directiveText.includes(normP) || directiveText.includes(baseP)) {
                    candidate.relevanceScore += 5000;
                }
            }
            fileCandidates.push(candidate);
        }

        // Ground truth: Active files tokens derived directly from contextData.selectedFilesContent
        const actualFilesTokens = Math.max(0, Math.ceil((contextData.selectedFilesContent || '').length / 3.5));

        // Active context load strictly accounts for muted files (0 content tokens for muted files)
        const activeContextLoad = fixedLoad + actualFilesTokens;
        const activeUsagePercent = maxTokens > 0 ? Math.round((activeContextLoad / maxTokens) * 100) : 0;

        // Rule 1: If Governor is disabled and NO explicit governor directive was issued:
        // If the user muted files enough so that active context is under 100% (activeContextLoad <= maxTokens),
        // call the LLM safely with that selection as-is.
        if (capabilities.contextGovernorEnabled === false && !hasGovernorDirective) {
            if (activeContextLoad > maxTokens) {
                if (onAddMessage) {
                    await onAddMessage({
                        role: 'system',
                        content: `🛑 **Context Limit Exceeded (>100%)**\nActive context load (~${activeContextLoad.toLocaleString()} tokens, **${activeUsagePercent}%**) exceeds model capacity (**${maxTokens.toLocaleString()}** tokens).\n\n**To continue:** Mute more files in the Context Explorer, enable Context Governor in Discussion Settings to auto-prune files, remove files from context, or start a new discussion.`
                    });
                }
                return null;
            }

            this.updateDiscussionMetrics(currentDiscussion, discussionManager, activeContextLoad, maxTokens, systemTokens, briefingTokens, treeTokens, skillsTokens, actualFilesTokens, historyTokens);

            return this.buildPassingResult(contextData, baseInstructions, history, currentPromptMessage, activeContextLoad, maxTokens, systemTokens, briefingTokens, treeTokens, skillsTokens, capabilities, briefingContent, userPromptText);
        }

        // Rule 2: If NO explicit governor directive was sent, only run the governor if the active context
        // (unmuted files + history + tree + system prompt) exceeds the trigger threshold.
        // Even if the total of all files exceeds the threshold, if activeContextLoad <= triggerThreshold,
        // use the selection as is without calling the governor.
        if (!hasGovernorDirective && activeContextLoad <= triggerThreshold) {
            this.updateDiscussionMetrics(currentDiscussion, discussionManager, activeContextLoad, maxTokens, systemTokens, briefingTokens, treeTokens, skillsTokens, actualFilesTokens, historyTokens);

            return this.buildPassingResult(contextData, baseInstructions, history, currentPromptMessage, activeContextLoad, maxTokens, systemTokens, briefingTokens, treeTokens, skillsTokens, capabilities, briefingContent, userPromptText);
        }
        
        // 4. Overload Detected: Engage Context Governor toward Objective Threshold
        if (onStatusUpdate) {
            onStatusUpdate(`⚖️ Governor: Context at ${activeUsagePercent}% (Trigger: ${triggerThresholdPercent}%, Objective: ${objectiveThresholdPercent}%). Optimizing...`);
        }

        // The overflow to eliminate is based on the active context load and the Objective Target Threshold
        let overflow = Math.max(0, activeContextLoad - objectiveThreshold);
        const pruneMsgId = 'system_prune_' + Date.now();

        if (onAddMessage) {
            await onAddMessage({
                id: pruneMsgId,
                role: 'system',
                content: `⚖️ **Context Governor: Overload Optimization Engaged**
Initial Active Load: **${activeUsagePercent}%** (${activeContextLoad.toLocaleString()} / ${maxTokens.toLocaleString()} tokens).
Trigger Threshold: **${triggerThresholdPercent}%** &middot; Objective Target: **${objectiveThresholdPercent}%** (~${objectiveThreshold.toLocaleString()} tokens) &middot; Max Verification Rounds: **${maxNegotiationRounds}**.
*Analyzing candidate relevance, verifying reduction targets, and executing multi-round optimization...*`,
                skipInPrompt: true
            });
        }

        let historyCropReport = "";
        let liberatedHistoryTokens = 0;

        // Stage 1: Crop and Summarize Bloated History
        const isCropHistoryEnabled = capabilities.contextGovernorCropHistory !== false;
        if (isCropHistoryEnabled && history.length > 2 && historyTokens > 1000) {
            const isHistoryBloated = historyTokens > (maxTokens * 0.15) || (historyTokens > 2000 && overflow > 0) || fileCandidates.length === 0;
            if (isHistoryBloated) {
                if (onStatusUpdate) onStatusUpdate("⚖️ Governor: Condensing earlier conversation history...");
                const cropResult = await this.cropAndSummarizeHistory(history, lollmsAPI, targetModel, signal, currentDiscussion, discussionManager);
                if (cropResult) {
                    history = cropResult.newHistory;
                    liberatedHistoryTokens = cropResult.liberatedTokens;
                    historyTokens = cropResult.newHistoryTokens;
                    overflow = Math.max(0, overflow - liberatedHistoryTokens);
                    historyCropReport = `- 📜 **Conversation History**: Cropped ${cropResult.croppedCount} earlier turn(s) (~${liberatedHistoryTokens.toLocaleString()} tokens liberated). Retained active mission summary.`;
                }
            }
        }

        // Stage 2: Evaluate Protection and Available Tokens
        // Shield files added during the current user prompt among active (unmuted) files
        const olderActiveCandidates = fileCandidates.filter(b => !b.isCurrentPromptFile && !isCandidateMuted(b.path));
        const tokensAvailableFromOlder = olderActiveCandidates.reduce((sum, b) => sum + b.tokens, 0);

        const canAvoidEvictingCurrentPrompt = tokensAvailableFromOlder >= overflow;

        // Stage 3: Multi-Round Governor Negotiation with Objective Verification Loop
        let governorDecision: any = null;
        let roundsUsed = 0;
        let chunkingNotice: string | undefined = undefined;
        let workerAdvice: string = "";

        const combinedDirectiveText = allGovernorDirectives.join(' ').toLowerCase().trim();
        const isActivateAll = /\b(activate\s+all|unmute\s+all|enable\s+all|show\s+all|all\s+on|reveal\s+all|keep\s+all)\b/i.test(combinedDirectiveText);
        const isMuteAll = /\b(mute\s+all|deactivate\s+all|hide\s+all|all\s+off)\b/i.test(combinedDirectiveText);

        if (isActivateAll) {
            if (onStatusUpdate) onStatusUpdate("⚖️ Governor: Executing 'activate all' directive...");
            fileCandidates.forEach(b => {
                b.keep = true;
                b.justification = "Activated by user directive.";
            });
            workerAdvice = `User directive executed: All ${fileCandidates.length} files in context have been activated with full content loaded.`;
            governorDecision = {
                rationale: workerAdvice,
                keep: fileCandidates.map(b => ({ path: b.path, justification: b.justification })),
                evict: []
            };
        } else if (isMuteAll) {
            if (onStatusUpdate) onStatusUpdate("⚖️ Governor: Executing 'mute all' directive...");
            fileCandidates.forEach(b => {
                b.keep = false;
                b.evictionReason = "Muted by user directive.";
            });
            workerAdvice = `User directive executed: All ${fileCandidates.length} files in context have been muted (0 tokens).`;
            governorDecision = {
                rationale: workerAdvice,
                keep: [],
                evict: fileCandidates.map(b => ({ path: b.path, reason: b.evictionReason }))
            };
        } else if (overflow > 0 || hasGovernorDirective) {
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
                overflow: Math.max(0, overflow),
                canAvoidEvictingCurrentPrompt,
                keywords,
                maxRounds: maxNegotiationRounds,
                governorDirectives: allGovernorDirectives,
                onStatusUpdate,
                onRoundUsed: (r) => { roundsUsed = r; }
            });
            governorDecision = negotiationResult.decision;
            workerAdvice = negotiationResult.workerAdvice || "";
        } else {
            fileCandidates.forEach(b => {
                b.keep = true;
                b.justification = "Preserved: Context meets objective threshold.";
            });
            governorDecision = {
                rationale: "Token budget satisfied. All files preserved.",
                keep: fileCandidates.map(b => ({ path: b.path, justification: b.justification })),
                evict: []
            };
        }

        // Stage 4: Apply Eviction Decisions with Strict Deterministic Safeguards
        let candidateEvictList = Array.isArray(governorDecision?.evict) ? governorDecision.evict : [];
        let candidateKeepList = Array.isArray(governorDecision?.keep) ? governorDecision.keep : [];

        // If Governor failed or produced insufficient reduction, engage deterministic ranking fallback
        if (!governorDecision || (candidateEvictList.length === 0 && candidateKeepList.length === 0 && overflow > 0)) {
            governorDecision = this.buildDeterministicFallback(fileCandidates, overflow, canAvoidEvictingCurrentPrompt, objectiveThresholdPercent, objectiveThreshold, currentMuted);
            candidateEvictList = Array.isArray(governorDecision?.evict) ? governorDecision.evict : [];
            candidateKeepList = Array.isArray(governorDecision?.keep) ? governorDecision.keep : [];
        }

        let liberatedTokens = 0;
        const keptList: string[] = [];
        const evictedReport: string[] = [];
        const evictedPaths: string[] = [];
        const rationale = governorDecision?.rationale || "Balanced attention-map optimization prioritizing current mission files.";

        // Apply keep / evict classifications
        for (const b of fileCandidates) {
            const evictMatch = candidateEvictList.find((e: any) => this.pathsMatch(e.path || e, b.path));
            const keepMatch = candidateKeepList.find((k: any) => this.pathsMatch(k.path || k, b.path));
            const wasMuted = isCandidateMuted(b.path);

            let shouldEvict = Boolean(evictMatch);
            // If the file was already muted and not explicitly restored to keep list:
            if (!shouldEvict && wasMuted && !keepMatch) {
                shouldEvict = true;
            }
            if (!shouldEvict && candidateKeepList.length > 0 && !keepMatch && (liberatedTokens < overflow)) {
                shouldEvict = true;
            }

            // Strict shield veto: Never evict current prompt files if budget can be met with older files
            if (shouldEvict && b.isCurrentPromptFile && canAvoidEvictingCurrentPrompt) {
                Logger.info(`[Governor] Vetoed eviction of current-prompt file: ${b.path}`);
                shouldEvict = false;
            }

            if (shouldEvict) {
                b.keep = false;
                if (!wasMuted) {
                    liberatedTokens += b.tokens;
                }
                evictedPaths.push(b.path);
                const reason = (evictMatch && typeof evictMatch === 'object' && evictMatch.reason)
                    ? evictMatch.reason
                    : (b.isCurrentPromptFile
                        ? "Evicted out of strict capacity saturation to fit model window."
                        : (wasMuted ? "Remained muted in tree." : "Pruned to satisfy target context threshold."));
                b.evictionReason = reason;
                evictedReport.push(`- \`${b.path}\` [M] (~${b.tokens.toLocaleString()} tok) — *${reason}*`);
            } else {
                b.keep = true;
                const just = (keepMatch && typeof keepMatch === 'object' && keepMatch.justification)
                    ? keepMatch.justification
                    : (b.isCurrentPromptFile
                        ? "Active file added for the current prompt mission."
                        : "High-relevance dependency for current task.");
                b.justification = just;
                if (b.isCurrentPromptFile) {
                    keptList.push(`- \`${b.path}\` [C] (~${b.tokens.toLocaleString()} tok) [CURRENT PROMPT] — *${just}*`);
                } else {
                    keptList.push(`- \`${b.path}\` [C] (~${b.tokens.toLocaleString()} tok) — *${just}*`);
                }
            }
        }

        // Check if context is saturated (even after eviction, remaining kept files still exceed target or 120%)
        let newTotal = Math.max(0, activeContextLoad - liberatedTokens - liberatedHistoryTokens);

        // Emergency prune if remaining files still exceed objectiveThreshold (e.g. from 1000% load)
        if (newTotal > objectiveThreshold) {
            const sortedKept = fileCandidates
                .filter(b => b.keep)
                .sort((a, b) => {
                    if (a.isCurrentPromptFile !== b.isCurrentPromptFile) {
                        return a.isCurrentPromptFile ? -1 : 1;
                    }
                    return b.relevanceScore - a.relevanceScore;
                });

            for (let idx = sortedKept.length - 1; idx >= 0; idx--) {
                if (newTotal <= objectiveThreshold) break;
                const candidateToDrop = sortedKept[idx];
                candidateToDrop.keep = false;
                liberatedTokens += candidateToDrop.tokens;
                newTotal -= candidateToDrop.tokens;
                evictedPaths.push(candidateToDrop.path);
                evictedReport.push(`- ✂️ \`${candidateToDrop.path}\` (~${candidateToDrop.tokens.toLocaleString()} tok) — *Emergency reduction to guarantee ${objectiveThresholdPercent}% objective.*`);
            }

            // If context saturation occurred, generate the chunking directive
            const removeFilesTag = '<' + 'remove_files_from_context>';
            chunkingNotice = `
### ⚠️ CONTEXT CAPACITY SATURATION: BIT-BY-BIT CHUNKING DIRECTIVE
The codebase context required for this request is extremely large. It is mathematically impossible to load all requested files into memory simultaneously.
**MANDATORY OPERATIONAL DIRECTIVE FOR ASSISTANT/AGENT**:
1. Do NOT attempt to load all remaining files at once.
2. Process the task **bit by bit**: inspect 1 or 2 files at a time.
3. Use your **scratchpad / working memory** to record critical facts, function signatures, and interface contracts.
4. Use \`${removeFilesTag}\` to evict files you have finished reading/editing to free space for the next files.
5. Proceed incrementally until the task is accomplished.`.trim();
        }

        if (newTotal > hardCap120) {
            if (onAddMessage) {
                await onAddMessage({
                    role: 'system',
                    content: `🛑 **Context Limit Exceeded (>120%)**\nEven after pruning all files, the payload (~${newTotal.toLocaleString()} tokens) exceeds 120% of model capacity (**${maxTokens.toLocaleString()}** tokens).\n\n**To continue:** Delete older messages or start a new discussion.`
                });
            }
            return null;
        }

        // Synchronize muted files list with discussion state
        currentDiscussion.mutedFiles = fileCandidates.filter(b => !b.keep).map(b => b.path);
        if (!currentDiscussion.id.startsWith('temp-')) {
            await discussionManager.saveDiscussion(currentDiscussion);
        }

        // Reconstruct selected files content and synchronize tree markers with [C] and [M]
        const keptBlocks = fileCandidates.filter(b => b.keep);
        const mutedBlocks = fileCandidates.filter(b => !b.keep);
        const newSelectedFilesContent = keptBlocks.map(b => b.fullMatch).join('\n\n');
        const updatedProjectTree = this.updateTreeWithKeptFiles(
            contextData.projectTree, 
            keptBlocks.map(b => b.path),
            mutedBlocks.map(b => b.path)
        );
        contextData.projectTree = updatedProjectTree;

        // Permanent eviction to workspace state if enabled
        if (capabilities.contextGovernorPermanentPruning && evictedPaths.length > 0) {
            const urisToEvict: vscode.Uri[] = [];
            for (const p of evictedPaths) {
                const res = await contextManager.resolveWorkspaceFromPath(p);
                if (res) urisToEvict.push(res.uri);
            }
            if (urisToEvict.length > 0) {
                await contextManager.getContextStateProvider()?.setStateForUris(urisToEvict, 'tree-only');
            }
        }

        const newUsagePercent = maxTokens > 0 ? Math.round((newTotal / maxTokens) * 100) : 0;
        const totalLiberated = liberatedTokens + liberatedHistoryTokens;

        // Emit dedicated Governor chat card with skipInPrompt: true (visible to user, never sent to worker LLM)
        if (onAddMessage && (hasGovernorDirective || overflow > 0)) {
            const directiveSummary = allGovernorDirectives.length > 0 ? `\n- **Directive**: \`${allGovernorDirectives.join('; ')}\`` : '';
            const governorCardMarkdown = `### ⚖️ Context Governor Decision
${directiveSummary}
- **Rounds Taken**: ${roundsUsed} round${roundsUsed === 1 ? '' : 's'} (max ${maxNegotiationRounds})
- **New Context Load**: ${newTotal.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (**${newUsagePercent}%**)
- **Tokens Liberated**: ${totalLiberated.toLocaleString()} tokens

🧠 **Thoughts & Rationale**:
${rationale}

${workerAdvice ? `💬 **Advice Forwarded to Worker**:\n${workerAdvice}\n\n` : ''}📁 **File Decisions**:
- **✅ Kept Active (${keptBlocks.length} files with content loaded [C])**:
${keptList.join('\n') || '  - (None)'}

- **✂️ Muted in Tree (${mutedBlocks.length} files at 0 tokens [M])**:
${evictedReport.join('\n') || '  - (None)'}
${chunkingNotice ? `\n---\n${chunkingNotice}\n` : ''}`;

            await onAddMessage({
                id: 'governor_run_' + Date.now(),
                role: 'system',
                personalityName: '⚖️ Context Governor',
                content: governorCardMarkdown,
                skipInPrompt: true
            });
        }

        const updatedBriefing = contextManager.renderBriefing(currentDiscussion);
        const chunkingDirectiveText = chunkingNotice ? `\n\n${chunkingNotice}\n` : '';
        const governorAdviceSection = workerAdvice ? `\n#### ⚖️ CONTEXT GOVERNOR ADVICE & FINDINGS\n${workerAdvice}\n` : '';

        const projectStateText = `
### 📂 ATTACHED PROJECT CONTEXT
I am providing you with the current, ground-truth state of my project files and the technical briefing.

${updatedBriefing && !updatedBriefing.includes("Librarian is analyzing") ? `#### 📋 TEAM TECHNICAL BRIEFING\n${updatedBriefing}\n` : ""}${governorAdviceSection}
${updatedProjectTree ? `#### 🌳 PROJECT STRUCTURE\n${updatedProjectTree}\n` : ""}
${newSelectedFilesContent ? `#### 📄 FILE CONTENTS\n${newSelectedFilesContent}` : "*(No files currently selected)*"}
--------------------------------------------------
${chunkingDirectiveText}`.trim();

        // Enforce strict alternating user/assistant structure:
        // Combine project context and current user request into a single user message
        const { ensureStrictAlternatingRoles, mergeMessageContents } = require('./utils');

        let singleUserContent: any = projectStateText;
        if (currentPromptMessage && currentPromptMessage.content) {
            singleUserContent = mergeMessageContents(projectStateText, currentPromptMessage.content);
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

        await this.updateDiscussionMetrics(
            currentDiscussion,
            discussionManager,
            newTotal,
            maxTokens,
            systemTokens,
            briefingTokens,
            treeTokens,
            skillsTokens,
            Math.max(0, Math.ceil(newSelectedFilesContent.length / 3.5)),
            historyTokens
        );

        return {
            selectedFilesContent: newSelectedFilesContent,
            messagesToSend,
            totalTokens: newTotal,
            contextSize: maxTokens,
            history,
            chunkingNotice
        };
    }

    /**
     * Executes up to `maxRounds` rounds of negotiation and verification with the LLM Governor.
     * In each round, recalculates token load to rigorously verify that the objective threshold is reached.
     */
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
        onStatusUpdate?: (status: string) => void;
        onRoundUsed?: (rounds: number) => void;
    }): Promise<{ decision: any; workerAdvice?: string }> {
        const {
            lollmsAPI,
            contextManager,
            targetModel,
            signal,
            userPromptText,
            fileCandidates,
            totalEstimated,
            maxTokens,
            triggerThresholdPercent,
            objectiveThresholdPercent,
            objectiveThreshold,
            overflow,
            canAvoidEvictingCurrentPrompt,
            maxRounds,
            governorDirectives,
            onStatusUpdate,
            onRoundUsed
        } = options;

        let currentRound = 0;
        let lastCandidateDecision: any = null;
        let extractedWorkerAdvice = "";

        const compactCatalog = this.buildCompactCatalog(fileCandidates, options.currentMuted);

        const systemPrompt = `You are the **Sovereign Context Governor**.
Your goal is to optimize active prompt context to strictly satisfy the objective target (${objectiveThresholdPercent}%, max ${objectiveThreshold.toLocaleString()} tokens).
Capacity limit: ${maxTokens.toLocaleString()} tokens. Current full load: ${totalEstimated.toLocaleString()} tokens.

### MANDATORY TAG PROTOCOL:
You MUST specify which files to mute using the <mute> tag, and what guidance to forward to the worker model using the <worker> tag.
1. Use <mute>...</mute> to list all files that should be MUTED (0 content tokens). Put one path per line:
<mute>
path/to/file1.ext
path/to/file2.ext
</mute>
2. Any file from the catalog NOT listed inside <mute> will be KEPT ACTIVE with full content loaded ([C]).
3. Use <worker>...</worker> to provide concise advice, key findings, or architectural guidance to forward to the worker model:
<worker>
Specific findings, guidelines, or advice to forward to the worker model.
</worker>
4. You may also output a JSON decision object: {"action": "decide", "evict": [{"path": "..."}], "keep": [{"path": "..."}], "worker_advice": "..."}`;

        const promptSummary = userPromptText.length > 500 ? userPromptText.substring(0, 500) + '...' : userPromptText;

        const initialUserPrompt = `### 📊 CONTEXT & CAPACITY AUDIT
- Total Initial Load: ${totalEstimated.toLocaleString()} tokens
- Model Window Capacity: ${maxTokens.toLocaleString()} tokens
- Trigger Threshold (${triggerThresholdPercent}%): ${Math.round(maxTokens * (triggerThresholdPercent / 100)).toLocaleString()} tokens
- Objective Threshold (${objectiveThresholdPercent}%): ${objectiveThreshold.toLocaleString()} tokens
- Required Reduction (Overflow): ~${overflow.toLocaleString()} tokens
- Shield Policy: ${canAvoidEvictingCurrentPrompt ? 'Older files contain enough tokens to meet budget: DO NOT evict files marked [ADDED FOR CURRENT PROMPT].' : 'Older files alone cannot meet the budget: evict older files first, then only the minimum necessary recent files.'}

### 🎯 USER OBJECTIVE
"${promptSummary}"

${governorDirectives && governorDirectives.length > 0 ? `### ⚖️ DIRECT USER DIRECTIVES FOR GOVERNOR (MANDATORY PRIORITY):\n${governorDirectives.map(d => `- ${d}`).join('\n')}\n(Follow these user instructions above all else when selecting files to keep or evict!)\n\n` : ''}### 📄 LOADED FILES COMPACT CATALOG (${fileCandidates.length} files)
${compactCatalog}

Make your decision to reach the objective threshold of ${objectiveThresholdPercent}% (${objectiveThreshold.toLocaleString()} tokens). Output JSON only.`;

        const conversation: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: initialUserPrompt }
        ];

        while (currentRound < maxRounds) {
            if (signal.aborted) break;
            currentRound++;
            if (onRoundUsed) onRoundUsed(currentRound);

            if (onStatusUpdate) {
                onStatusUpdate(`⚖️ Governor: Verifying Objective (${currentRound}/${maxRounds})...`);
            }

            try {
                const response = await lollmsAPI.sendChat(conversation, null, signal, targetModel, { thinking: false });
                const cleanResponse = stripThinkingTags(response);

                const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/);
                if (!jsonMatch) break;

                const parsed = JSON.parse(jsonMatch[0]);

                // Case: Grep exploration request
                if (parsed.action === 'grep' && parsed.query) {
                    if (onStatusUpdate) onStatusUpdate(`⚖️ Governor: Grep exploration for "${parsed.query}"...`);
                    const searchResults = await contextManager.searchWorkspaceContent(parsed.query, { matchCase: false, wholeWord: false });
                    const searchSnippet = searchResults.slice(0, 8).map(r => `${r.path}:${r.line} - ${r.snippet}`).join('\n') || 'No matches found.';

                    conversation.push({ role: 'assistant', content: cleanResponse });
                    conversation.push({
                        role: 'user',
                        content: `### 🔍 GREP RESULTS FOR "${parsed.query}"\n${searchSnippet}\n\nNow finalize your keep/evict decision with {"action": "decide", ...} to meet the ${objectiveThresholdPercent}% objective.`
                    });
                    continue;
                }

                // Case: Check for XML <mute> and <worker> tags in response
                const muteTagMatch = cleanResponse.match(/<mute\b[^>]*>([\s\S]*?)<\/mute>/i);
                const workerTagMatch = cleanResponse.match(/<worker\b[^>]*>([\s\S]*?)<\/worker>/i);

                if (workerTagMatch) {
                    extractedWorkerAdvice = workerTagMatch[1].trim();
                } else if (parsed.worker || parsed.worker_advice) {
                    extractedWorkerAdvice = String(parsed.worker || parsed.worker_advice).trim();
                }

                if (muteTagMatch) {
                    const pathsToMute = muteTagMatch[1]
                        .split(/[\r\n,]+/)
                        .map(l => l.trim().replace(/^['"]|['"]$/g, ''))
                        .filter(l => l.length > 0 && !l.startsWith('<'));

                    lastCandidateDecision = {
                        action: 'decide',
                        rationale: extractedWorkerAdvice || "Governor optimized context using <mute> tag selection.",
                        evict: pathsToMute.map(p => ({ path: p, reason: "Muted by Governor" })),
                        keep: fileCandidates.filter(c => !pathsToMute.some(mp => this.pathsMatch(mp, c.path))).map(c => ({ path: c.path, justification: "Active in context" }))
                    };
                    return { decision: lastCandidateDecision, workerAdvice: extractedWorkerAdvice };
                }

                // Case: Candidate Decision proposed via JSON
                if (parsed.action === 'decide' || (Array.isArray(parsed.keep) && Array.isArray(parsed.evict))) {
                    lastCandidateDecision = parsed;

                    // Audit token reduction mathematically
                    const proposedEvict = Array.isArray(parsed.evict) ? parsed.evict : [];
                    let proposedLiberatedTokens = 0;

                    for (const candidate of fileCandidates) {
                        const isEvicted = proposedEvict.some((e: any) => this.pathsMatch(e.path || e, candidate.path));
                        const wasAlreadyMuted = options.currentMuted.some(m => this.pathsMatch(m, candidate.path));
                        if (isEvicted && !wasAlreadyMuted) {
                            proposedLiberatedTokens += candidate.tokens;
                        }
                    }

                    const resultingLoad = Math.max(0, totalEstimated - proposedLiberatedTokens);

                    // VERIFICATION CHECK: Did the decision satisfy the objective threshold?
                    if (resultingLoad <= objectiveThreshold) {
                        Logger.info(`[Governor] Objective threshold verified in round ${currentRound}: ${resultingLoad.toLocaleString()} <= ${objectiveThreshold.toLocaleString()} tokens.`);
                        return { decision: parsed, workerAdvice: extractedWorkerAdvice };
                    }

                    if (currentRound < maxRounds) {
                        const shortfall = resultingLoad - objectiveThreshold;
                        const remainingPercent = Math.round((resultingLoad / maxTokens) * 100);

                        conversation.push({ role: 'assistant', content: cleanResponse });
                        conversation.push({
                            role: 'user',
                            content: `⚠️ **OBJECTIVE THRESHOLD NOT REACHED (Round ${currentRound} of ${maxRounds})**
Your proposed eviction only liberated ~${proposedLiberatedTokens.toLocaleString()} tokens, leaving context at ~${resultingLoad.toLocaleString()} tokens (**${remainingPercent}%**).
The Objective Threshold is **${objectiveThresholdPercent}%** (~${objectiveThreshold.toLocaleString()} tokens).
You MUST evict more files via <mute>...</mute> to reach the objective.`
                        });
                        continue;
                    }

                    return { decision: parsed, workerAdvice: extractedWorkerAdvice };
                }

                break;
            } catch (err: any) {
                Logger.warn(`[Governor] LLM negotiation round ${currentRound} error: ${err.message}`);
                break;
            }
        }

        return { decision: lastCandidateDecision, workerAdvice: extractedWorkerAdvice };
    }

    /**
     * Builds a deterministic fallback decision based on pre-calculated relevance scores and shields.
     */
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

        // Preserve already muted files in evict list so they remain muted
        for (const candidate of candidates) {
            if (isAlreadyMuted(candidate.path)) {
                evictList.push({
                    path: candidate.path,
                    reason: "Remained muted from prior configuration."
                });
            }
        }

        // Only active (unmuted) files can liberate tokens
        const activeCandidates = candidates.filter(b => !isAlreadyMuted(b.path));
        const olderActive = activeCandidates.filter(b => !b.isCurrentPromptFile);
        const currentPromptActive = activeCandidates.filter(b => b.isCurrentPromptFile);

        // Phase 1: Evict older, lower-relevance active candidates first
        const sortedOlder = [...olderActive].sort((a, b) => a.relevanceScore - b.relevanceScore || b.tokens - a.tokens);

        for (const candidate of sortedOlder) {
            if (liberated >= overflow) break;
            evictList.push({
                path: candidate.path,
                reason: `Older module pruned to liberate ${candidate.tokens.toLocaleString()} tokens.`
            });
            liberated += candidate.tokens;
        }

        // Phase 2: If and ONLY if budget cannot be met with older active files alone, touch current prompt files
        if (liberated < overflow) {
            const sortedCurrent = [...currentPromptActive].sort((a, b) => a.relevanceScore - b.relevanceScore || b.tokens - a.tokens);
            for (const candidate of sortedCurrent) {
                if (liberated >= overflow) break;
                evictList.push({
                    path: candidate.path,
                    reason: `Evicted out of strict necessity: Impossible to meet token budget (${targetThresholdPercent}%, ${triggerThreshold.toLocaleString()} tok) even after evicting all older files.`
                });
                liberated += candidate.tokens;
            }
        }

        const evictPaths = new Set(evictList.map(e => e.path));

        return {
            rationale: canAvoidEvictingCurrentPrompt
                ? "Budget satisfied deterministically by evicting older context files while strictly preserving all files added for the current prompt."
                : "Emergency eviction: Budget could not be met with older files alone, requiring selective pruning of lowest-relevance modules.",
            keep: candidates.filter(b => !evictPaths.has(b.path)).map(b => ({
                path: b.path,
                justification: b.isCurrentPromptFile
                    ? "Preserved: File added for the current prompt mission execution."
                    : "Preserved: Core module or dependency required for task execution."
            })),
            evict: evictList
        };
    }

    /**
     * Builds a compact, high-density catalog of file candidates without code bodies.
     */
    private static buildCompactCatalog(candidates: ParsedFileCandidate[], currentMuted: string[] = []): string {
        return candidates.map(c => {
            const isMuted = currentMuted.some(m => this.pathsMatch(m, c.path));
            const statusTag = isMuted ? ' [M]' : ' [C]';
            const shieldTag = c.isCurrentPromptFile ? ' [ADDED FOR CURRENT PROMPT]' : '';
            const coreTag = c.isCoreOrInterface ? ' [INTERFACE/SCHEMA]' : '';
            const symbolsStr = c.extractedSymbols.length > 0 ? `\n  Symbols: ${c.extractedSymbols.slice(0, 4).join(', ')}` : '';
            const keywordsStr = c.matchedKeywords.length > 0 ? `\n  Matches: ${c.matchedKeywords.slice(0, 5).join(', ')}` : '';

            return `- File: \`${c.path}\`${statusTag} (~${c.tokens.toLocaleString()} tok)${shieldTag}${coreTag}${symbolsStr}${keywordsStr}`;
        }).join('\n');
    }

    /**
     * Constructs a parsed file candidate with relevance metrics.
     */
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

        // Protection check: Was this file added during the current user prompt?
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

        const isCoreOrInterface = cleanPath.includes('core') || cleanPath.includes('types') || cleanPath.includes('interface') || cleanPath.includes('schema');

        // Extract key symbol names
        const extractedSymbols: string[] = [];
        const symbolRegex = /(?:class|interface|type|function|def)\s+([a-zA-Z0-9_]+)/g;
        let sMatch: RegExpExecArray | null;
        while ((sMatch = symbolRegex.exec(body)) !== null && extractedSymbols.length < 8) {
            extractedSymbols.push(sMatch[1]);
        }

        // Calculate keyword matches and relevance score
        const lowerBody = body.substring(0, 5000).toLowerCase();
        const matchedKeywords: string[] = [];
        let score = 0;

        if (isCurrentPromptFile) score += 10000;
        if (isCoreOrInterface) score += 200;

        for (const kw of keywords) {
            if (cleanPath.includes(kw)) {
                score += 150;
                matchedKeywords.push(kw);
            } else if (lowerBody.includes(kw)) {
                score += 30;
                matchedKeywords.push(kw);
            }
        }

        return {
            fullMatch,
            path: filePath,
            tokens,
            isCurrentPromptFile,
            isCoreOrInterface,
            relevanceScore: score,
            matchedKeywords,
            extractedSymbols,
            keep: true
        };
    }

    /**
     * Extracts keyword tokens from query text and history.
     */
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

    /**
     * Summarizes older history and retains pending tasks.
     */
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

        const olderTokens = Math.ceil(olderHistory.map(m => typeof m.content === 'string' ? stripThinkingTags(m.content) : JSON.stringify(m.content)).join('\n').length / 3.5);

        const transcript = olderHistory.map(m => {
            const role = m.role.toUpperCase();
            let txt = typeof m.content === 'string' ? stripThinkingTags(m.content) : JSON.stringify(m.content);
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
            ], null, signal, targetModel, { thinking: false });

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
        const newHistoryTokens = Math.ceil(newHistory.map(m => typeof m.content === 'string' ? m.content : '').join('\n').length / 3.5);
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

    /**
     * Strips [C] from project tree for any file not in keptPaths.
     */
    private static updateTreeWithKeptFiles(tree: string, keptPaths: string[], mutedPaths: string[] = []): string {
        if (!tree) return tree;
        const keptSet = new Set(keptPaths.map(p => path.basename(p.replace(/\\/g, '/')).toLowerCase()));
        const mutedSet = new Set(mutedPaths.map(p => path.basename(p.replace(/\\/g, '/')).toLowerCase()));

        // 1. Strip existing [C], [M], [D] tags
        let updated = tree.replace(/([^\s,\[\]\(\)\/]+)\s*\[(?:C|M|D)\]/g, '$1');

        // 2. Re-apply [C] for kept files and [M] for muted files
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
        fallbackPromptText?: string
    ): GovernorArbitrationResult {
        const briefingText = briefingContent !== undefined ? briefingContent : "";
        const projectStateText = `
### 📂 ATTACHED PROJECT CONTEXT
I am providing you with the current, ground-truth state of my project files and the technical briefing.

${briefingText && !briefingText.includes("Librarian is analyzing") ? `#### 📋 TEAM TECHNICAL BRIEFING\n${briefingText}\n` : ""}
${contextData.projectTree ? `#### 🌳 PROJECT STRUCTURE\n${contextData.projectTree}\n` : ""}
${contextData.selectedFilesContent ? `#### 📄 FILE CONTENTS\n${contextData.selectedFilesContent}` : "*(No files currently selected)*"}
--------------------------------------------------`.trim();

        const { ensureStrictAlternatingRoles, mergeMessageContents } = require('./utils');

        // Ensure user prompt content is preserved under all conditions (including regeneration)
        const promptContent = (currentPromptMessage && currentPromptMessage.content)
            ? currentPromptMessage.content
            : (fallbackPromptText || "");

        let singleUserContent: any = projectStateText;
        if (promptContent) {
            singleUserContent = mergeMessageContents(projectStateText, promptContent);
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
            selectedFilesContent: contextData.selectedFilesContent,
            messagesToSend,
            totalTokens,
            contextSize: maxTokens,
            history
        };
    }
}

export default ContextGovernor;