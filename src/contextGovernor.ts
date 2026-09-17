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

        // 3. Extract and Parse File Blocks
        const extractedBlocks = extractFileBlocks(contextData.selectedFilesContent);
        const fileCandidates: ParsedFileCandidate[] = [];

        // Extract keywords from user prompt and recent conversation for relevance matching
        const keywords = this.extractQueryKeywords(userPromptText, history);

        if (extractedBlocks.length > 0) {
            for (const fb of extractedBlocks) {
                const attrs = parseFileTagAttributes(fb.attrStr, fb.rawContent);
                const filePath = attrs?.path || "";
                if (!filePath || filePath.includes('<<<<<<< SEARCH')) continue;

                const tokens = Math.max(1, Math.ceil(fb.rawContent.length / 3.5));
                const candidate = this.buildCandidate(fb.fullMatch, filePath, fb.rawContent, tokens, currentPromptAddedFiles, keywords, contextManager);
                fileCandidates.push(candidate);
            }
        } else {
            // Regex fallback for legacy fenced code blocks constructed with string concatenation
            const fileOpenTag = '<' + 'file';
            const fileCloseTag = '<' + '/file>';
            const blockRegex = new RegExp(fileOpenTag + '\\s+([^>]*?)>([\\s\\S]*?)' + fileCloseTag + '|```(?:\\w+)?[:]?([^\\n]+)[\\r\\n]([\\s\\S]*?)[\\r\\n]```', 'gi');
            let fileMatch: RegExpExecArray | null;
            while ((fileMatch = blockRegex.exec(contextData.selectedFilesContent)) !== null) {
                let filePath = "";
                let fileBody = "";
                if (fileMatch[1] !== undefined) {
                    const attrs = parseFileTagAttributes(fileMatch[1], fileMatch[2]);
                    filePath = attrs?.path || "";
                    fileBody = fileMatch[2] || "";
                } else {
                    filePath = (fileMatch[3] || '').trim();
                    fileBody = fileMatch[4] || '';
                }
                if (!filePath || filePath.includes('<<<<<<< SEARCH')) continue;

                const tokens = Math.max(1, Math.ceil(fileBody.length / 3.5));
                const candidate = this.buildCandidate(fileMatch[0], filePath, fileBody, tokens, currentPromptAddedFiles, keywords, contextManager);
                fileCandidates.push(candidate);
            }
        }

        const filesLoad = fileCandidates.reduce((sum, b) => sum + b.tokens, 0);
        const totalEstimated = fixedLoad + filesLoad;
        const initialUsagePercent = Math.round((totalEstimated / maxTokens) * 100);

        // If Governor is disabled: enforce only the 120% hard-cap
        if (capabilities.contextGovernorEnabled === false) {
            if (totalEstimated > hardCap120) {
                if (onAddMessage) {
                    await onAddMessage({
                        role: 'system',
                        content: `🛑 **Context Limit Exceeded (>120%)**\nPayload (~${totalEstimated.toLocaleString()} tokens, **${initialUsagePercent}%**) exceeds 120% of model capacity (**${maxTokens.toLocaleString()}** tokens).\n\n**To continue:** Enable Context Governor in Discussion Settings to auto-prune files, remove files from context, or start a new discussion.`
                    });
                }
                return null;
            }
            return this.buildPassingResult(contextData, baseInstructions, history, currentPromptMessage, totalEstimated, maxTokens, systemTokens, briefingTokens, treeTokens, skillsTokens, capabilities);
        }

        // If context is comfortably within trigger threshold, pass through immediately
        if (totalEstimated <= triggerThreshold) {
            return this.buildPassingResult(contextData, baseInstructions, history, currentPromptMessage, totalEstimated, maxTokens, systemTokens, briefingTokens, treeTokens, skillsTokens, capabilities);
        }

        // 4. Overload Detected (up to 1000%+): Engage Context Governor toward Objective Threshold
        if (onStatusUpdate) {
            onStatusUpdate(`⚖️ Governor: Context at ${initialUsagePercent}% (Trigger: ${triggerThresholdPercent}%, Objective: ${objectiveThresholdPercent}%). Optimizing...`);
        }

        // The overflow to eliminate is based on the Objective Target Threshold
        let overflow = Math.max(0, totalEstimated - objectiveThreshold);
        const pruneMsgId = 'system_prune_' + Date.now();

        if (onAddMessage) {
            await onAddMessage({
                id: pruneMsgId,
                role: 'system',
                content: `⚖️ **Context Governor: Overload Optimization Engaged**
Initial Load: **${initialUsagePercent}%** (${totalEstimated.toLocaleString()} / ${maxTokens.toLocaleString()} tokens).
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
        // Shield files added during the current user prompt
        const olderCandidates = fileCandidates.filter(b => !b.isCurrentPromptFile);
        const tokensAvailableFromOlder = olderCandidates.reduce((sum, b) => sum + b.tokens, 0);

        const canAvoidEvictingCurrentPrompt = tokensAvailableFromOlder >= overflow;

        // Stage 3: Multi-Round Governor Negotiation with Objective Verification Loop
        let governorDecision: any = null;
        let roundsUsed = 0;
        let chunkingNotice: string | undefined = undefined;

        if (overflow > 0 && fileCandidates.length > 0) {
            governorDecision = await this.runGovernorNegotiation({
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
                keywords,
                maxRounds: maxNegotiationRounds,
                onStatusUpdate,
                onRoundUsed: (r) => { roundsUsed = r; }
            });
        } else {
            fileCandidates.forEach(b => {
                b.keep = true;
                b.justification = "Preserved: Context already meets objective threshold.";
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

        // If Governor failed or produced insufficient reduction, engage deterministic ranking fallback to guarantee objective
        if (!governorDecision || (candidateEvictList.length === 0 && candidateKeepList.length === 0 && overflow > 0)) {
            governorDecision = this.buildDeterministicFallback(fileCandidates, overflow, canAvoidEvictingCurrentPrompt, objectiveThresholdPercent, objectiveThreshold);
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

            let shouldEvict = Boolean(evictMatch);
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
                liberatedTokens += b.tokens;
                evictedPaths.push(b.path);
                const reason = (evictMatch && typeof evictMatch === 'object' && evictMatch.reason)
                    ? evictMatch.reason
                    : (b.isCurrentPromptFile
                        ? "Evicted out of strict capacity saturation to fit model window."
                        : "Pruned to satisfy target context threshold.");
                b.evictionReason = reason;
                evictedReport.push(`- ✂️ \`${b.path}\` (~${b.tokens.toLocaleString()} tok) — *${reason}*`);
            } else {
                b.keep = true;
                const just = (keepMatch && typeof keepMatch === 'object' && keepMatch.justification)
                    ? keepMatch.justification
                    : (b.isCurrentPromptFile
                        ? "Active file added for the current prompt mission."
                        : "High-relevance dependency for current task.");
                b.justification = just;
                if (b.isCurrentPromptFile) {
                    keptList.push(`- 🛡️ \`${b.path}\` (~${b.tokens.toLocaleString()} tok) [CURRENT PROMPT] — *${just}*`);
                } else {
                    keptList.push(`- ✅ \`${b.path}\` (~${b.tokens.toLocaleString()} tok) — *${just}*`);
                }
            }
        }

        // Check if context is saturated (even after eviction, remaining kept files still exceed target or 120%)
        let newTotal = Math.max(0, totalEstimated - liberatedTokens - liberatedHistoryTokens);

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

        // Reconstruct selected files content
        const keptBlocks = fileCandidates.filter(b => b.keep);
        const newSelectedFilesContent = keptBlocks.map(b => b.fullMatch).join('\n\n');

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

        const addFilesTagStr = '<' + 'add_files_to_context>';
        const reportMarkdown = `⚖️ **Context Governor: Context Optimization Complete**
Optimization reduced payload from **${initialUsagePercent}%** to **${newUsagePercent}%** (${newTotal.toLocaleString()} / ${maxTokens.toLocaleString()} tokens, Trigger: ${triggerThresholdPercent}%, Objective: ${objectiveThresholdPercent}%). Total liberated: **${totalLiberated.toLocaleString()}** tokens.
*(Negotiation & Verification: ${roundsUsed} round${roundsUsed === 1 ? '' : 's'} / max ${maxNegotiationRounds})*

🧠 **ARCHITECTURAL STRATEGY & RATIONALE**:
${rationale}

${historyCropReport ? `📜 **CONVERSATION HISTORY OPTIMIZATION**:\n${historyCropReport}\n\n` : ''}📦 **PRESERVED FILES (Active for Mission)**:
${keptList.join('\n') || '- (None)'}

🗑️ **EVICTED FILES (Pruned from Active Context)**:
${evictedReport.join('\n') || '- (None)'}

*Evicted files remain in the Project Tree. Use \`${addFilesTagStr}\` if needed in subsequent turns.*
${chunkingNotice ? `\n---\n${chunkingNotice}\n` : ''}`;

        if (onUpdateMessage) {
            await onUpdateMessage(pruneMsgId, reportMarkdown);
        }

        const updatedBriefing = contextManager.renderBriefing(currentDiscussion);
        const chunkingDirectiveText = chunkingNotice ? `\n\n${chunkingNotice}\n` : '';

        const projectStateText = `
### 📂 ATTACHED PROJECT CONTEXT
I am providing you with the current, ground-truth state of my project files and the technical briefing.

${updatedBriefing && !updatedBriefing.includes("Librarian is analyzing") ? `#### 📋 TEAM TECHNICAL BRIEFING\n${updatedBriefing}\n` : ""}
${contextData.projectTree ? `#### 🌳 PROJECT STRUCTURE\n${contextData.projectTree}\n` : ""}
${newSelectedFilesContent ? `#### 📄 FILE CONTENTS\n${newSelectedFilesContent}` : "*(No files currently selected)*"}
--------------------------------------------------
${chunkingDirectiveText}`.trim();

        let projectContextContent: any = projectStateText;
        if (capabilities.enableImages !== false && contextData.images && contextData.images.length > 0) {
            projectContextContent = [
                { type: 'text', text: projectStateText }
            ];
            contextData.images.forEach(img => {
                projectContextContent.push({
                    type: 'image_url',
                    image_url: { url: img.data }
                });
            });
        }

        const projectContextUserMessage: ChatMessage = {
            role: 'user',
            content: projectContextContent
        };

        const messagesToSend: ChatMessage[] = [
            { role: 'system', content: baseInstructions },
            ...history,
            projectContextUserMessage
        ];

        if (currentPromptMessage) {
            messagesToSend.push(currentPromptMessage);
        }

        const segments = {
            system: systemTokens,
            briefing: briefingTokens,
            tree: treeTokens,
            skills: skillsTokens,
            memory: 0,
            diagrams: 0,
            files: Math.max(0, Math.ceil(newSelectedFilesContent.length / 3.5)),
            history: historyTokens,
            images: 0
        };

        if (currentDiscussion) {
            currentDiscussion.lastTokenMetrics = {
                total: newTotal,
                contextSize: maxTokens,
                segments
            };
            if (!currentDiscussion.id.startsWith('temp-')) {
                await discussionManager.saveDiscussion(currentDiscussion);
            }
        }

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
        totalEstimated: number;
        maxTokens: number;
        triggerThresholdPercent: number;
        objectiveThresholdPercent: number;
        objectiveThreshold: number;
        overflow: number;
        canAvoidEvictingCurrentPrompt: boolean;
        keywords: string[];
        maxRounds: number;
        onStatusUpdate?: (status: string) => void;
        onRoundUsed?: (rounds: number) => void;
    }): Promise<any> {
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
            onStatusUpdate,
            onRoundUsed
        } = options;

        let currentRound = 0;
        let lastCandidateDecision: any = null;

        const compactCatalog = this.buildCompactCatalog(fileCandidates);

        const systemPrompt = `You are the **Sovereign Context Governor**.
Your goal is to optimize the active prompt context to strictly meet the Objective Target Threshold (${objectiveThresholdPercent}%, max ${objectiveThreshold.toLocaleString()} tokens).
Capacity limit: ${maxTokens.toLocaleString()} tokens. Initial estimated load: ${totalEstimated.toLocaleString()} tokens.

### GOVERNOR OBJECTIVE & VERIFICATION RULES:
1. **OBJECTIVE REQUIREMENT**: You MUST evict enough file tokens so that total tokens fall below the objective threshold (~${objectiveThreshold.toLocaleString()} tokens). Required reduction: ~${overflow.toLocaleString()} tokens.
2. **VERIFICATION LOOP**: Your decision will be mathematically audited. If your proposed eviction does not reach the objective threshold, you will be recalled for another round (up to ${maxRounds} rounds).
3. **STRICT SHIELD**: Files marked [ADDED FOR CURRENT PROMPT] must be kept unless older files alone cannot satisfy the reduction.
4. **DECISION FORMAT**:
\`\`\`json
{
  "action": "decide",
  "rationale": "Summary of decision and why evicted files can be safely removed or read sequentially",
  "hydration_steps": [
    "Step 1: Inspect File A for imports and interface definitions.",
    "Step 2: Mute File A and load File B to execute the modification."
  ],
  "keep": [
    { "path": "path/to/file.ts", "justification": "Why this file is necessary right now" }
  ],
  "evict": [
    { "path": "path/to/file.py", "reason": "Why this file should be muted or evicted for this turn" }
  ]
}
\`\`\``;

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

### 📄 LOADED FILES COMPACT CATALOG (${fileCandidates.length} files)
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

                // Case: Candidate Decision proposed
                if (parsed.action === 'decide' || (Array.isArray(parsed.keep) && Array.isArray(parsed.evict))) {
                    lastCandidateDecision = parsed;

                    // Audit token reduction mathematically
                    const proposedEvict = Array.isArray(parsed.evict) ? parsed.evict : [];
                    let proposedLiberatedTokens = 0;

                    for (const candidate of fileCandidates) {
                        const isEvicted = proposedEvict.some((e: any) => this.pathsMatch(e.path || e, candidate.path));
                        if (isEvicted) {
                            proposedLiberatedTokens += candidate.tokens;
                        }
                    }

                    const resultingLoad = Math.max(0, totalEstimated - proposedLiberatedTokens);

                    // VERIFICATION CHECK: Did the decision satisfy the objective threshold?
                    if (resultingLoad <= objectiveThreshold) {
                        Logger.info(`[Governor] Objective threshold verified in round ${currentRound}: ${resultingLoad.toLocaleString()} <= ${objectiveThreshold.toLocaleString()} tokens.`);
                        return parsed;
                    }

                    // Target NOT met: If more rounds available, challenge the Governor to reduce further
                    if (currentRound < maxRounds) {
                        const shortfall = resultingLoad - objectiveThreshold;
                        const remainingPercent = Math.round((resultingLoad / maxTokens) * 100);

                        Logger.warn(`[Governor] Round ${currentRound}: Proposed eviction fell short by ${shortfall.toLocaleString()} tokens (${remainingPercent}% > ${objectiveThresholdPercent}%). Recalling...`);

                        conversation.push({ role: 'assistant', content: cleanResponse });
                        conversation.push({
                            role: 'user',
                            content: `⚠️ **OBJECTIVE THRESHOLD NOT REACHED (Round ${currentRound} of ${maxRounds})**
Your proposed eviction only liberated ~${proposedLiberatedTokens.toLocaleString()} tokens, leaving the context at ~${resultingLoad.toLocaleString()} tokens (**${remainingPercent}%**).
The Objective Threshold is **${objectiveThresholdPercent}%** (~${objectiveThreshold.toLocaleString()} tokens).
You are still **${shortfall.toLocaleString()} tokens short** of the target.
You MUST evict more files from the catalog to reach the ${objectiveThresholdPercent}% objective. Provide your updated decision.`
                        });
                        continue;
                    }

                    // Max rounds reached: accept the best attempt (deterministic fallback will close remaining gap)
                    return parsed;
                }

                break;
            } catch (err: any) {
                Logger.warn(`[Governor] LLM negotiation round ${currentRound} error: ${err.message}`);
                break;
            }
        }

        return lastCandidateDecision;
    }

    /**
     * Builds a deterministic fallback decision based on pre-calculated relevance scores and shields.
     */
    private static buildDeterministicFallback(
        candidates: ParsedFileCandidate[],
        overflow: number,
        canAvoidEvictingCurrentPrompt: boolean,
        targetThresholdPercent: number,
        triggerThreshold: number
    ): any {
        const evictList: any[] = [];
        let liberated = 0;

        const olderCandidates = candidates.filter(b => !b.isCurrentPromptFile);
        const currentPromptCandidates = candidates.filter(b => b.isCurrentPromptFile);

        // Phase 1: Evict older, lower-relevance candidates first
        const sortedOlder = [...olderCandidates].sort((a, b) => a.relevanceScore - b.relevanceScore || b.tokens - a.tokens);

        for (const candidate of sortedOlder) {
            evictList.push({
                path: candidate.path,
                reason: `Older module pruned to liberate ${candidate.tokens.toLocaleString()} tokens.`
            });
            liberated += candidate.tokens;
            if (liberated >= overflow) break;
        }

        // Phase 2: If and ONLY if budget cannot be met with older files alone, touch current prompt files
        if (liberated < overflow) {
            const sortedCurrent = [...currentPromptCandidates].sort((a, b) => a.relevanceScore - b.relevanceScore || b.tokens - a.tokens);
            for (const candidate of sortedCurrent) {
                evictList.push({
                    path: candidate.path,
                    reason: `Evicted out of strict necessity: Impossible to meet token budget (${targetThresholdPercent}%, ${triggerThreshold.toLocaleString()} tok) even after evicting all older files.`
                });
                liberated += candidate.tokens;
                if (liberated >= overflow) break;
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
    private static buildCompactCatalog(candidates: ParsedFileCandidate[]): string {
        return candidates.map(c => {
            const shieldTag = c.isCurrentPromptFile ? ' [ADDED FOR CURRENT PROMPT - SHIELDED]' : '';
            const coreTag = c.isCoreOrInterface ? ' [INTERFACE/SCHEMA]' : '';
            const symbolsStr = c.extractedSymbols.length > 0 ? `\n  Symbols: ${c.extractedSymbols.slice(0, 4).join(', ')}` : '';
            const keywordsStr = c.matchedKeywords.length > 0 ? `\n  Matches: ${c.matchedKeywords.slice(0, 5).join(', ')}` : '';

            return `- File: \`${c.path}\` (~${c.tokens.toLocaleString()} tok)${shieldTag}${coreTag}${symbolsStr}${keywordsStr}`;
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

        const olderTokens = Math.ceil(olderHistory.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n').length / 3.5);

        const transcript = olderHistory.map(m => {
            const role = m.role.toUpperCase();
            let txt = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
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

    private static pathsMatch(p1: string, p2: string): boolean {
        if (!p1 || !p2) return false;
        const c1 = p1.replace(/\\/g, '/').toLowerCase().trim();
        const c2 = p2.replace(/\\/g, '/').toLowerCase().trim();
        return c1 === c2 || c1.endsWith('/' + c2) || c2.endsWith('/' + c1) || path.basename(c1) === path.basename(c2);
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
        capabilities: DiscussionCapabilities
    ): GovernorArbitrationResult {
        const projectStateText = `
### 📂 ATTACHED PROJECT CONTEXT
I am providing you with the current, ground-truth state of my project files and the technical briefing.

${contextData.projectTree ? `#### 🌳 PROJECT STRUCTURE\n${contextData.projectTree}\n` : ""}
${contextData.selectedFilesContent ? `#### 📄 FILE CONTENTS\n${contextData.selectedFilesContent}` : "*(No files currently selected)*"}
--------------------------------------------------`.trim();

        let projectContextContent: any = projectStateText;
        if (capabilities.enableImages !== false && contextData.images && contextData.images.length > 0) {
            projectContextContent = [
                { type: 'text', text: projectStateText }
            ];
            contextData.images.forEach(img => {
                projectContextContent.push({
                    type: 'image_url',
                    image_url: { url: img.data }
                });
            });
        }

        const projectContextUserMessage: ChatMessage = {
            role: 'user',
            content: projectContextContent
        };

        const messagesToSend: ChatMessage[] = [
            { role: 'system', content: baseInstructions },
            ...history,
            projectContextUserMessage
        ];

        if (currentPromptMessage) {
            messagesToSend.push(currentPromptMessage);
        }

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