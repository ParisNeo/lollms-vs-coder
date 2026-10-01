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
    signatures?: string;
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
    bytes: number;
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
        candidateFiles?: string[];
        currentMutedFiles?: string[];
        history?: any[];
        onStatusUpdate?: (status: string) => void;
    }): Promise<{
        keptFiles: string[];
        mutedFiles: string[];
        rationale: string;
        advice?: string;
        signatures?: string;
        discoverySteps?: { type: string; label: string; detail?: string }[];
        totalTokens: number;
        liberatedTokens: number;
    }> {
        const { lollmsAPI, contextManager, targetModel, prompt, signal, candidateFiles, onStatusUpdate } = options;

        const provider = contextManager.getContextStateProvider();
        let rawIncluded: { path: string; state?: any; bytes?: number; tokens?: number }[] = [];
        if (candidateFiles !== undefined) {
            rawIncluded = candidateFiles.map(p => ({ path: p, state: 'included' as any }));
        } else {
            rawIncluded = provider ? provider.getIncludedFiles().filter(f => f && f.path) : [];
        }

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
            candidate.bytes = bytesCount || Math.round(tokens * 3.5);
            fileCandidates.push(candidate);
        }

        const maxTokensRes = await lollmsAPI.getContextSize(targetModel).catch(() => null);
        const maxTokens = (maxTokensRes && maxTokensRes.context_size > 0)
            ? maxTokensRes.context_size
            : (options.currentDiscussion?.lastTokenMetrics?.contextSize || 128000);

        const targetPercent = options.currentDiscussion?.capabilities?.contextGovernorTargetThreshold || 70;
        const targetBudget = Math.round(maxTokens * (targetPercent / 100));

        if (onStatusUpdate) onStatusUpdate(`Governor: Evaluating ${fileCandidates.length} files against ${targetPercent}% budget...`);

        let projectTreePreview = "";
        try {
            projectTreePreview = await contextManager.generateProjectTree(signal);
        } catch {}

        const systemPrompt = `You are the **Sovereign Context Governor**.
Your mission is to explore project files, discover dependencies, and select which candidate files to keep in active context ([C] full content loaded) vs mute ([M] 0 content tokens, kept in tree).
Target Budget: ~${targetBudget.toLocaleString()} tokens (${targetPercent}% of ${maxTokens.toLocaleString()}).

### 🛠️ AVAILABLE EXPLORATION TOOLS (MULTI-ROUND DISCOVERY):
Before finalizing your selection, you may inspect the codebase in intermediate rounds:
1. **Grep Search**: \`<grep pattern="searchTerm" path="optional/subdir" />\`
2. **SPARQL Architecture Query**: \`<sparql query="SELECT ?x WHERE { ?x s:type s:Class }" />\`
3. **Peek File Slice**: \`<peek_files path="path/to/file.ext" lines="30" from="top" />\` (or \`<peek_files>path</peek_files>

\`)
When you output any of these tools, it will be executed on disk and the results provided to you in the next round so you can learn and make an informed decision.

### 📋 SELECTION FUNCTIONS (CHOOSE ONE APPROACH):
1. **Reveal Only (Keep essential files active)**:
<reveal_only>
path/to/file_to_keep1.ext
path/to/file_to_keep2.ext
</reveal_only>
*(Keeps ONLY the listed files active with full content [C]. ALL other files will be muted in tree at 0 tokens [M]. Use this to keep clear only the files that should inevitably be modified!)*

2. **Mute Only (Mute specific files)**:
<mute_only>
path/to/file_to_mute1.ext
path/to/file_to_mute2.ext
</mute_only>
*(Mutes ONLY the listed files at 0 tokens [M]. ALL other files remain active [C].)*

### 📝 ARCHITECTURE & MUTED SIGNATURES EXPLAINER:
To give the worker model enough context about muted files without bloating the context window, you can write an architectural summary or Mermaid diagram:
<signatures>
### 🔍 MUTED FILES FUNCTION SIGNATURES & ARCHITECTURE
\`\`\`mermaid
classDiagram
  ...
\`\`\`
- \`file_a.ext\`: \`def method_name(arg: type) -> ret\`: summary of function
- \`file_b.ext\`: \`class ServiceName\`: summary of responsibilities
</signatures>

### 💬 ADVICE & RATIONALE:
<rationale>
Why these files were kept active or muted...
</rationale>

<worker>
Specific findings, guidelines, or advice to forward to the developer and AI worker.
</worker>`;

        const discoverySteps: { type: string; label: string; detail?: string }[] = [];
        let workerAdvice = "";
        let rationaleText = "";
        let signaturesText = "";
        let finalKeptPaths: string[] | null = null;

        const candidateCatalog = this.buildCompactCatalog(fileCandidates, options.currentDiscussion?.mutedFiles || []);

        const initialUserPrompt = `### 🎯 USER FOCUS OBJECTIVE:
"${prompt}"

### 🌳 PROJECT WORLD STATE (FILE TREE):
${projectTreePreview ? projectTreePreview.substring(0, 3500) : '(No tree available)'}

### 📄 CANDIDATE FILES CATALOG (${fileCandidates.length} files):
${candidateCatalog}

Begin by running discovery queries (<grep>, <sparql>, or <peek_files>) to inspect code, or output your selection (<reveal_only> or <mute_only>), <signatures>, <rationale>, and <worker>.`;

        const chatMessages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            ...(options.history || []).map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
            { role: 'user', content: initialUserPrompt }
        ];

        let rounds = 0;
        const maxRounds = 6;

        while (rounds < maxRounds) {
            if (signal.aborted) break;
            rounds++;

            if (onStatusUpdate) onStatusUpdate(`Governor: Reasoning & scouting (step ${rounds}/${maxRounds})...`);

            let cleanResponse = "";
            try {
                const response = await lollmsAPI.sendChat(chatMessages, null, signal, targetModel, { thinking: false });
                cleanResponse = stripThinkingTags(response).trim();
            } catch (err: any) {
                Logger.warn(`[Governor] LLM query failed in round ${rounds}: ${err.message}`);
                break;
            }

            // 1. Check for Grep tool call
            const grepMatch = cleanResponse.match(/<grep\b[^>]*pattern=["']([^"']+)["'][^>]*\/>/i) ||
                              cleanResponse.match(/<grep\b[^>]*query=["']([^"']+)["'][^>]*\/>/i) ||
                              cleanResponse.match(/<grep\b[^>]*>([\s\S]*?)<\/grep>/i);
            if (grepMatch) {
                const pattern = (grepMatch[1] || "").trim();
                if (pattern) {
                    if (onStatusUpdate) onStatusUpdate(`Governor: Searching disk for "${pattern}"...`);
                    const searchRes = await contextManager.searchWorkspaceContent(pattern, { matchCase: false, wholeWord: false });
                    const snippet = searchRes.slice(0, 8).map(r => `${r.path}:${r.line} - ${r.snippet}`).join('\n') || 'No matches found.';
                    discoverySteps.push({ type: 'grep', label: `Grep: "${pattern}"`, detail: `Found ${searchRes.length} hits across files` });

                    chatMessages.push({ role: 'assistant', content: cleanResponse });
                    chatMessages.push({
                        role: 'user',
                        content: `### 🔍 GREP RESULTS FOR "${pattern}":\n${snippet}\n\nReview this result. You may make another tool call (<grep>, <sparql>, <peek_files>) to explore further, or finalize your selection (<reveal_only> or <mute_only>).`
                    });
                    continue;
                }
            }

            // 2. Check for SPARQL query tool call
            const sparqlMatch = cleanResponse.match(/<sparql\b[^>]*query=["']([\s\S]*?)["'][^>]*\/>/i) ||
                                cleanResponse.match(/<sparql\b[^>]*>([\s\S]*?)<\/sparql>/i);
            if (sparqlMatch) {
                const sparqlQuery = (sparqlMatch[1] || "").trim();
                if (sparqlQuery && (contextManager as any).codeGraphManager) {
                    if (onStatusUpdate) onStatusUpdate(`Governor: Querying architecture graph...`);
                    const sparqlRes = await (contextManager as any).codeGraphManager.executeSparql(sparqlQuery);
                    discoverySteps.push({ type: 'sparql', label: `SPARQL Query`, detail: `Graph pattern evaluated` });

                    chatMessages.push({ role: 'assistant', content: cleanResponse });
                    chatMessages.push({
                        role: 'user',
                        content: `### 📊 SPARQL RESULTS:\n${sparqlRes}\n\nReview this result. You may make another tool call or output your selection.`
                    });
                    continue;
                }
            }

            // 3. Check for Peek Files tool call
            const peekMatch = cleanResponse.match(/<peek_files\b([^>]*?)>([\s\S]*?)<\/peek_files>/i) ||
                              cleanResponse.match(/<peek\b([^>]*?)\/>/i);
            if (peekMatch) {
                const attrPart = peekMatch[1] || "";
                const inner = (peekMatch[2] || "").trim();
                const pathFromAttr = attrPart.match(/path=["']([^"']+)["']/i)?.[1] || "";
                const linesFromAttr = parseInt(attrPart.match(/lines=["']?(\d+)["']?/i)?.[1] || "30", 10);
                const fromDir = (attrPart.match(/from=["']?(top|bottom)["']?/i)?.[1] || "top") as 'top' | 'bottom';
                const targetPath = pathFromAttr || inner.split(/\s+/)[0] || "";

                if (targetPath) {
                    if (onStatusUpdate) onStatusUpdate(`Governor: Peeking at ${path.basename(targetPath)}...`);
                    const peekRes = await contextManager.peekFiles([{ path: targetPath, lines: linesFromAttr, from: fromDir }]);
                    const snippet = peekRes.map(r => r.error ? `Error: ${r.error}` : r.content).join('\n') || 'File empty or unavailable.';
                    discoverySteps.push({ type: 'peek', label: `Peek: "${path.basename(targetPath)}"`, detail: `${linesFromAttr} lines (${fromDir})` });

                    chatMessages.push({ role: 'assistant', content: cleanResponse });
                    chatMessages.push({
                        role: 'user',
                        content: `### 📄 PEEK SLICE FOR "${targetPath}":\n\`\`\`\n${snippet}\n\`\`\`\n\nReview this file content. You may continue scouting or output your selection.`
                    });
                    continue;
                }
            }

            // 4. Check for tags: <reveal_only>, <mute_only>, <mute>, <signatures>, <rationale>, <worker>
            const revealOnlyMatch = cleanResponse.match(/<reveal_only\b[^>]*>([\s\S]*?)<\/reveal_only>/i);
            const muteOnlyMatch = cleanResponse.match(/<mute_only\b[^>]*>([\s\S]*?)<\/mute_only>/i) || cleanResponse.match(/<mute\b[^>]*>([\s\S]*?)<\/mute>/i);
            const sigMatch = cleanResponse.match(/<signatures\b[^>]*>([\s\S]*?)<\/signatures>/i);
            const rationaleMatch = cleanResponse.match(/<rationale\b[^>]*>([\s\S]*?)<\/rationale>/i);
            const workerMatch = cleanResponse.match(/<worker\b[^>]*>([\s\S]*?)<\/worker>/i);

            if (sigMatch) signaturesText = sigMatch[1].trim();
            if (rationaleMatch) rationaleText = rationaleMatch[1].trim();
            if (workerMatch) workerAdvice = workerMatch[1].trim();

            let proposedKept: string[] | null = null;

            if (revealOnlyMatch) {
                const revealPaths = revealOnlyMatch[1]
                    .split(/[\r\n,]+/)
                    .map(l => l.trim().replace(/^['"]|['"]$/g, ''))
                    .filter(l => l.length > 0 && !l.startsWith('<'));
                proposedKept = fileCandidates
                    .filter(c => revealPaths.some(rp => this.pathsMatch(rp, c.path)))
                    .map(c => c.path);
            } else if (muteOnlyMatch) {
                const mutePaths = muteOnlyMatch[1]
                    .split(/[\r\n,]+/)
                    .map(l => l.trim().replace(/^['"]|['"]$/g, ''))
                    .filter(l => l.length > 0 && !l.startsWith('<'));
                proposedKept = fileCandidates
                    .filter(c => !mutePaths.some(mp => this.pathsMatch(mp, c.path)))
                    .map(c => c.path);
            }

            // 5. Preselection Budget Verification: Check if proposed active files fit into target budget
            if (proposedKept !== null) {
                let candidateTokens = 0;
                fileCandidates.forEach(c => {
                    if (proposedKept!.includes(c.path)) {
                        candidateTokens += c.tokens;
                    }
                });

                if (candidateTokens > targetBudget && rounds < maxRounds) {
                    if (onStatusUpdate) onStatusUpdate(`Governor: Selection exceeds budget (~${candidateTokens.toLocaleString()} > ~${targetBudget.toLocaleString()} tok). Reprompting...`);

                    const keptListDetailed = fileCandidates
                        .filter(c => proposedKept!.includes(c.path))
                        .sort((a, b) => b.tokens - a.tokens)
                        .map(c => `- \`${c.path}\`: ~${c.tokens.toLocaleString()} tokens (${c.bytes ? (c.bytes > 1024 ? Math.round(c.bytes / 1024) + ' KB' : c.bytes + ' B') : 'unknown size'})`)
                        .join('\n');

                    chatMessages.push({ role: 'assistant', content: cleanResponse });
                    chatMessages.push({
                        role: 'user',
                        content: `⚠️ PRESELECTION EXCEEDS TOKEN BUDGET (Round ${rounds} of ${maxRounds}):
Your proposed active selection totals ~${candidateTokens.toLocaleString()} tokens (${Math.round((candidateTokens / maxTokens) * 100)}%), which exceeds the target budget of ~${targetBudget.toLocaleString()} tokens (${targetPercent}%).
Excess to eliminate: ~${(candidateTokens - targetBudget).toLocaleString()} tokens.

Here are the files currently kept active and their sizes:
${keptListDetailed}

Please tighten your selection:
- Use <reveal_only> to keep ONLY the essential files that must inevitably be modified.
- Or use <mute_only> to mute more files.
- Put function and method signatures for newly muted files inside <signatures>...</signatures> so the worker still understands their API contracts without loading full code.`
                    });
                    continue;
                }

                finalKeptPaths = proposedKept;
                break;
            }

            // Fallback for JSON decisions
            const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const parsed = JSON.parse(jsonMatch[0]);
                    if (Array.isArray(parsed.reveal_only)) {
                        finalKeptPaths = fileCandidates.filter(c => parsed.reveal_only.some((rp: string) => this.pathsMatch(rp, c.path))).map(c => c.path);
                    } else if (Array.isArray(parsed.mute) || Array.isArray(parsed.mute_only)) {
                        const mList = parsed.mute_only || parsed.mute;
                        finalKeptPaths = fileCandidates.filter(c => !mList.some((mp: string) => this.pathsMatch(mp, c.path))).map(c => c.path);
                    }
                    if (parsed.signatures) signaturesText = String(parsed.signatures).trim();
                    if (parsed.rationale) rationaleText = String(parsed.rationale).trim();
                    if (parsed.worker || parsed.advice) workerAdvice = String(parsed.worker || parsed.advice).trim();
                } catch {}
            }

            break;
        }

        const keptFiles: string[] = [];
        const mutedFiles: string[] = [];
        let totalTokens = 0;
        let liberatedTokens = 0;

        for (const candidate of fileCandidates) {
            let keep = true;
            if (finalKeptPaths !== null) {
                keep = finalKeptPaths.includes(candidate.path);
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

        const rationale = rationaleText || workerAdvice ||
            `Filtered context for "${prompt}": Kept ${keptFiles.length} active file(s) and muted ${mutedFiles.length} file(s).`;

        return {
            keptFiles,
            mutedFiles,
            rationale,
            advice: workerAdvice,
            signatures: signaturesText,
            discoverySteps,
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
            onAddMessage
        } = options;

        let history = [...options.history];

        // 1. Resolve Context Size Capacity and Thresholds
        const ctxSizeRes = await lollmsAPI.getContextSize(targetModel).catch(() => null);
        const authoritativeMaxTokens = (ctxSizeRes && ctxSizeRes.context_size > 0)
            ? ctxSizeRes.context_size
            : (currentDiscussion?.lastTokenMetrics?.contextSize || 128000);

        const maxTokens = authoritativeMaxTokens;

        const triggerThresholdPercent = capabilities.contextGovernorThreshold !== undefined
            ? capabilities.contextGovernorThreshold
            : 95;
        const triggerThreshold = Math.round(maxTokens * (triggerThresholdPercent / 100));

        const objectiveThresholdPercent = capabilities.contextGovernorTargetThreshold !== undefined
            ? capabilities.contextGovernorTargetThreshold
            : Math.min(triggerThresholdPercent, 70);
        const objectiveThreshold = Math.round(maxTokens * (objectiveThresholdPercent / 100));

        const maxNegotiationRounds = capabilities.contextGovernorMaxRounds !== undefined
            ? capabilities.contextGovernorMaxRounds
            : 5;

        const hardCap120 = Math.round(maxTokens * 1.2);

        // 2. Calculate Base Non-File Fixed Loads
        const getCleanHistoryText = (msgs: ChatMessage[]) => msgs
            .filter(m => !m.skipInPrompt)
            .map(m => {
                const c = m.content;
                if (typeof c === 'string') return stripThinkingTags(c);
                if (Array.isArray(c)) return c.filter((p: any) => p && p.type === 'text').map((p: any) => stripThinkingTags(p.text)).join('\n');
                return '';
            }).filter(t => t.trim().length > 0).join('\n');

        const systemTokens = Math.ceil((baseInstructions || '').length / 3.5);
        let historyTokens = Math.ceil(getCleanHistoryText(history).length / 3.5);
        const treeTokens = Math.ceil((contextData.projectTree || '').length / 3.5);
        const skillsTokens = Math.ceil((contextData.skillsContent || '').length / 3.5);
        const briefingContent = contextManager.renderBriefing(currentDiscussion);
        const briefingTokens = Math.ceil((briefingContent || '').length / 3.5);
        const promptTokens = Math.ceil((userPromptText || '').length / 3.5);

        let fixedLoad = systemTokens + historyTokens + treeTokens + skillsTokens + briefingTokens + promptTokens;

        // 3. Extract and Parse File Blocks across ALL candidate files in context
        const extractedBlocks = extractFileBlocks(contextData.selectedFilesContent);
        const fileCandidates: ParsedFileCandidate[] = [];

        const { extractGovernorDirectives } = require('./utils');
        const extractedFromPrompt = extractGovernorDirectives(userPromptText);
        const allGovernorDirectives: string[] = [
            ...(options.governorDirectives || []),
            ...extractedFromPrompt.governorDirectives
        ];
        const hasGovernorDirective = allGovernorDirectives.length > 0;

        const combinedKeywordsSource = `${userPromptText} ${allGovernorDirectives.join(' ')}`;
        const keywords = this.extractQueryKeywords(combinedKeywordsSource, history);

        const provider = contextManager.getContextStateProvider();
        const allIncludedFiles = provider ? provider.getIncludedFiles().filter(f => f && f.path) : [];

        const candidateSourceList = allIncludedFiles.length > 0 ? allIncludedFiles : extractedBlocks.map(eb => {
            const attrs = parseFileTagAttributes(eb.attrStr, eb.rawContent);
            return { path: attrs?.path || '', state: 'included' as any };
        }).filter(f => f.path);

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
            let bytesCount = (f as any).bytes || 0;

            const isMuted = isCandidateMuted(f.path);

            if (!isMuted) {
                const cached = (contextManager as any)._fileContentCache?.get(f.path);
                if (cached?.content) {
                    fileBody = cached.content;
                    bytesCount = cached.size || cached.content.length;
                } else {
                    const res = await contextManager.resolveWorkspaceFromPath(f.path);
                    if (res) {
                        try {
                            const bytes = await vscode.workspace.fs.readFile(res.uri);
                            fileBody = Buffer.from(bytes).toString('utf8');
                            bytesCount = bytes.length;
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
                        bytesCount = cached.size || cached.content.length;
                    }
                }
                fullMatch = `### 📄 \`${f.path}\` [M] [MUTED IN CONTEXT]\n> Content is currently muted to save context tokens (0 tokens). If you need to inspect or edit this file's code, output:\n> <unmute_files>\n> ${f.path}\n> </unmute_files>\n\n`;
            }

            const candidate = this.buildCandidate(fullMatch, f.path, fileBody, tokens, currentPromptAddedFiles, keywords, contextManager);
            candidate.bytes = bytesCount || Math.round(tokens * 3.5);

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

        const actualFilesTokens = Math.max(0, Math.ceil((contextData.selectedFilesContent || '').length / 3.5));
        const activeContextLoad = fixedLoad + actualFilesTokens;
        const activeUsagePercent = maxTokens > 0 ? Math.round((activeContextLoad / maxTokens) * 100) : 0;

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

        if (!hasGovernorDirective && activeContextLoad <= triggerThreshold) {
            this.updateDiscussionMetrics(currentDiscussion, discussionManager, activeContextLoad, maxTokens, systemTokens, briefingTokens, treeTokens, skillsTokens, actualFilesTokens, historyTokens);

            return this.buildPassingResult(contextData, baseInstructions, history, currentPromptMessage, activeContextLoad, maxTokens, systemTokens, briefingTokens, treeTokens, skillsTokens, capabilities, briefingContent, userPromptText);
        }

        // 4. Overload Detected: Engage Context Governor
        if (onStatusUpdate) {
            onStatusUpdate(`⚖️ Governor: Context at ${activeUsagePercent}% (Trigger: ${triggerThresholdPercent}%, Objective: ${objectiveThresholdPercent}%). Optimizing...`);
        }

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
        const olderActiveCandidates = fileCandidates.filter(b => !b.isCurrentPromptFile && !isCandidateMuted(b.path));
        const tokensAvailableFromOlder = olderActiveCandidates.reduce((sum, b) => sum + b.tokens, 0);
        const canAvoidEvictingCurrentPrompt = tokensAvailableFromOlder >= overflow;

        // Stage 3: Multi-Round Governor Negotiation
        let governorDecision: any = null;
        let roundsUsed = 0;
        let chunkingNotice: string | undefined = undefined;
        let workerAdvice: string = "";
        let mutedSignatures: string = "";

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
            mutedSignatures = negotiationResult.signatures || "";
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

        let candidateEvictList = Array.isArray(governorDecision?.evict) ? governorDecision.evict : [];
        let candidateKeepList = Array.isArray(governorDecision?.keep) ? governorDecision.keep : [];

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

        for (const b of fileCandidates) {
            const evictMatch = candidateEvictList.find((e: any) => this.pathsMatch(e.path || e, b.path));
            const keepMatch = candidateKeepList.find((k: any) => this.pathsMatch(k.path || k, b.path));
            const wasMuted = isCandidateMuted(b.path);

            let shouldEvict = Boolean(evictMatch);
            if (!shouldEvict && wasMuted && !keepMatch) {
                shouldEvict = true;
            }
            if (!shouldEvict && candidateKeepList.length > 0 && !keepMatch && (liberatedTokens < overflow)) {
                shouldEvict = true;
            }

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

        let newTotal = Math.max(0, activeContextLoad - liberatedTokens - liberatedHistoryTokens);

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

        currentDiscussion.mutedFiles = fileCandidates.filter(b => !b.keep).map(b => b.path);
        if (!currentDiscussion.id.startsWith('temp-')) {
            await discussionManager.saveDiscussion(currentDiscussion);
        }

        const keptBlocks = fileCandidates.filter(b => b.keep);
        const mutedBlocks = fileCandidates.filter(b => !b.keep);
        const newSelectedFilesContent = keptBlocks.map(b => b.fullMatch).join('\n\n');
        const updatedProjectTree = this.updateTreeWithKeptFiles(
            contextData.projectTree, 
            keptBlocks.map(b => b.path),
            mutedBlocks.map(b => b.path)
        );
        contextData.projectTree = updatedProjectTree;

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

        if (onAddMessage && (hasGovernorDirective || overflow > 0)) {
            const directiveSummary = allGovernorDirectives.length > 0 ? `\n- **Directive**: \`${allGovernorDirectives.join('; ')}\`` : '';
            const governorCardMarkdown = `### ⚖️ Context Governor Decision
${directiveSummary}
- **Rounds Taken**: ${roundsUsed} round${roundsUsed === 1 ? '' : 's'} (max ${maxNegotiationRounds})
- **New Context Load**: ${newTotal.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (**${newUsagePercent}%**)
- **Tokens Liberated**: ${totalLiberated.toLocaleString()} tokens

🧠 **Thoughts & Rationale**:
${rationale}

${workerAdvice ? `💬 **Advice Forwarded to Worker**:\n${workerAdvice}\n\n` : ''}${mutedSignatures ? `🔍 **Muted Files Architecture & Signatures**:\n${mutedSignatures}\n\n` : ''}📁 **File Decisions**:
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
        const signaturesSection = mutedSignatures ? `\n#### 🔍 MUTED FILES ARCHITECTURE & FUNCTION SIGNATURES (Context Governor)\n${mutedSignatures}\n` : '';

        const projectStateText = `
### 📂 ATTACHED PROJECT CONTEXT
I am providing you with the current, ground-truth state of my project files and the technical briefing.

${updatedBriefing && !updatedBriefing.includes("Librarian is analyzing") ? `#### 📋 TEAM TECHNICAL BRIEFING\n${updatedBriefing}\n` : ""}${governorAdviceSection}${signaturesSection}
${updatedProjectTree ? `#### 🌳 PROJECT STRUCTURE\n${updatedProjectTree}\n` : ""}
${newSelectedFilesContent ? `#### 📄 FILE CONTENTS\n${newSelectedFilesContent}` : "*(No files currently selected)*"}
--------------------------------------------------
${chunkingDirectiveText}`.trim();

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
            chunkingNotice,
            signatures: mutedSignatures
        };
    }

    /**
     * Executes up to `maxRounds` rounds of negotiation and verification with the LLM Governor.
     * Supports intermediate exploration tools (grep, sparql, peek_files), multiple selection
     * approaches (<reveal_only>, <mute_only>), and signature extraction.
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
    }): Promise<{ decision: any; workerAdvice?: string; signatures?: string }> {
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
        let extractedSignatures = "";

        const compactCatalog = this.buildCompactCatalog(fileCandidates, options.currentMuted);

        const systemPrompt = `You are the **Sovereign Context Governor**.
Your goal is to optimize active prompt context to strictly satisfy the objective target (${objectiveThresholdPercent}%, max ${objectiveThreshold.toLocaleString()} tokens).
Capacity limit: ${maxTokens.toLocaleString()} tokens. Current full load: ${totalEstimated.toLocaleString()} tokens. Required reduction: ~${overflow.toLocaleString()} tokens.

### 🛠️ AVAILABLE EXPLORATION TOOLS (MULTI-ROUND DISCOVERY):
Before finalizing your decision, you may inspect the codebase across multiple rounds:
1. **Grep Search**: \`<grep pattern="searchTerm" path="optional/subdir" />\`
2. **SPARQL Architecture Query**: \`<sparql query="SELECT ?x WHERE { ?x s:type s:Class }" />\`
3. **Peek File Slice**: \`<peek_files path="path/to/file.ext" lines="30" from="top" />\` (or \`<peek_files>path</peek_files>

\`)
Outputting any tool executes it immediately on disk and provides the observation in the next round so you can learn and make an informed decision.

### 📋 SELECTION FUNCTIONS (CHOOSE ONE APPROACH):
1. **Reveal Only (Keep essential files active)**:
<reveal_only>
path/to/file_to_keep1.ext
path/to/file_to_keep2.ext
</reveal_only>
*(Keeps ONLY the listed files active with full content [C]. ALL other files will be muted in tree at 0 tokens [M]. Use this to keep clear only the files that should inevitably be modified!)*

2. **Mute Only (Mute specific files)**:
<mute_only>
path/to/file_to_mute1.ext
path/to/file_to_mute2.ext
</mute_only>
*(Mutes ONLY the listed files at 0 tokens [M]. ALL other files remain active [C]. Also accepts <mute>.)*

### 📝 ARCHITECTURE & MUTED SIGNATURES EXPLAINER:
To give the worker model enough context about muted files without bloating the context window, you can write an architectural summary or Mermaid diagram:
<signatures>
### 🔍 MUTED FILES FUNCTION SIGNATURES & ARCHITECTURE
\`\`\`mermaid
classDiagram
  ...
\`\`\`
- \`file_a.ext\`: \`def method_name(arg: type) -> ret\`: summary of function
- \`file_b.ext\`: \`class ServiceName\`: summary of responsibilities
</signatures>

### 💬 ADVICE & RATIONALE:
<rationale>
Why these choices were made...
</rationale>

<worker>
Specific findings, guidelines, or advice to forward to the worker model.
</worker>`;

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

Make your decision to reach the objective threshold of ${objectiveThresholdPercent}% (${objectiveThreshold.toLocaleString()} tokens). Output your discovery queries (<grep>, <sparql>, <peek_files>) or your selection decision (<reveal_only> or <mute_only>), <signatures>, and <worker>.`;

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

                // Check for Grep tool call
                const grepMatch = cleanResponse.match(/<grep\b[^>]*pattern=["']([^"']+)["'][^>]*\/>/i) ||
                                  cleanResponse.match(/<grep\b[^>]*query=["']([^"']+)["'][^>]*\/>/i) ||
                                  cleanResponse.match(/<grep\b[^>]*>([\s\S]*?)<\/grep>/i);
                if (grepMatch) {
                    const pattern = (grepMatch[1] || "").trim();
                    if (pattern) {
                        if (onStatusUpdate) onStatusUpdate(`⚖️ Governor: Grep exploration for "${pattern}"...`);
                        const searchResults = await contextManager.searchWorkspaceContent(pattern, { matchCase: false, wholeWord: false });
                        const searchSnippet = searchResults.slice(0, 8).map(r => `${r.path}:${r.line} - ${r.snippet}`).join('\n') || 'No matches found.';

                        conversation.push({ role: 'assistant', content: cleanResponse });
                        conversation.push({
                            role: 'user',
                            content: `### 🔍 GREP RESULTS FOR "${pattern}":\n${searchSnippet}\n\nContinue scouting or finalize your decision (<reveal_only> or <mute_only>) to meet the ${objectiveThresholdPercent}% objective.`
                        });
                        continue;
                    }
                }

                // Check for SPARQL query tool call
                const sparqlMatch = cleanResponse.match(/<sparql\b[^>]*query=["']([\s\S]*?)["'][^>]*\/>/i) ||
                                    cleanResponse.match(/<sparql\b[^>]*>([\s\S]*?)<\/sparql>/i);
                if (sparqlMatch) {
                    const sparqlQuery = (sparqlMatch[1] || "").trim();
                    if (sparqlQuery && (contextManager as any).codeGraphManager) {
                        if (onStatusUpdate) onStatusUpdate(`⚖️ Governor: Querying architecture graph...`);
                        const sparqlRes = await (contextManager as any).codeGraphManager.executeSparql(sparqlQuery);

                        conversation.push({ role: 'assistant', content: cleanResponse });
                        conversation.push({
                            role: 'user',
                            content: `### 📊 SPARQL RESULTS:\n${sparqlRes}\n\nContinue scouting or output your selection (<reveal_only> or <mute_only>).`
                        });
                        continue;
                    }
                }

                // Check for Peek Files tool call
                const peekMatch = cleanResponse.match(/<peek_files\b([^>]*?)>([\s\S]*?)<\/peek_files>/i) ||
                                  cleanResponse.match(/<peek\b([^>]*?)\/>/i);
                if (peekMatch) {
                    const attrPart = peekMatch[1] || "";
                    const inner = (peekMatch[2] || "").trim();
                    const pathFromAttr = attrPart.match(/path=["']([^"']+)["']/i)?.[1] || "";
                    const linesFromAttr = parseInt(attrPart.match(/lines=["']?(\d+)["']?/i)?.[1] || "30", 10);
                    const fromDir = (attrPart.match(/from=["']?(top|bottom)["']?/i)?.[1] || "top") as 'top' | 'bottom';
                    const targetPath = pathFromAttr || inner.split(/\s+/)[0] || "";

                    if (targetPath) {
                        if (onStatusUpdate) onStatusUpdate(`⚖️ Governor: Peeking at ${path.basename(targetPath)}...`);
                        const peekRes = await contextManager.peekFiles([{ path: targetPath, lines: linesFromAttr, from: fromDir }]);
                        const snippet = peekRes.map(r => r.error ? `Error: ${r.error}` : r.content).join('\n') || 'File empty.';

                        conversation.push({ role: 'assistant', content: cleanResponse });
                        conversation.push({
                            role: 'user',
                            content: `### 📄 PEEK SLICE FOR "${targetPath}":\n\`\`\`\n${snippet}\n\`\`\`\n\nContinue scouting or output your selection (<reveal_only> or <mute_only>).`
                        });
                        continue;
                    }
                }

                // Check for tags
                const revealOnlyMatch = cleanResponse.match(/<reveal_only\b[^>]*>([\s\S]*?)<\/reveal_only>/i);
                const muteOnlyMatch = cleanResponse.match(/<mute_only\b[^>]*>([\s\S]*?)<\/mute_only>/i) || cleanResponse.match(/<mute\b[^>]*>([\s\S]*?)<\/mute>/i);
                const sigMatch = cleanResponse.match(/<signatures\b[^>]*>([\s\S]*?)<\/signatures>/i);
                const workerMatch = cleanResponse.match(/<worker\b[^>]*>([\s\S]*?)<\/worker>/i);
                const rationaleMatch = cleanResponse.match(/<rationale\b[^>]*>([\s\S]*?)<\/rationale>/i);

                if (sigMatch) extractedSignatures = sigMatch[1].trim();
                if (workerMatch) extractedWorkerAdvice = workerMatch[1].trim();
                if (rationaleMatch) extractedWorkerAdvice = extractedWorkerAdvice || rationaleMatch[1].trim();

                let proposedKept: string[] | null = null;
                let proposedEvict: any[] = [];
                let proposedKeep: any[] = [];

                if (revealOnlyMatch) {
                    const pathsToReveal = revealOnlyMatch[1]
                        .split(/[\r\n,]+/)
                        .map(l => l.trim().replace(/^['"]|['"]$/g, ''))
                        .filter(l => l.length > 0 && !l.startsWith('<'));

                    proposedKeep = fileCandidates.filter(c => pathsToReveal.some(rp => this.pathsMatch(rp, c.path))).map(c => ({ path: c.path, justification: "Selected in <reveal_only>" }));
                    proposedEvict = fileCandidates.filter(c => !pathsToReveal.some(rp => this.pathsMatch(rp, c.path))).map(c => ({ path: c.path, reason: "Muted by <reveal_only>" }));
                    proposedKept = proposedKeep.map(k => k.path);
                } else if (muteOnlyMatch) {
                    const pathsToMute = muteOnlyMatch[1]
                        .split(/[\r\n,]+/)
                        .map(l => l.trim().replace(/^['"]|['"]$/g, ''))
                        .filter(l => l.length > 0 && !l.startsWith('<'));

                    proposedEvict = fileCandidates.filter(c => pathsToMute.some(mp => this.pathsMatch(mp, c.path))).map(c => ({ path: c.path, reason: "Muted in <mute_only>" }));
                    proposedKeep = fileCandidates.filter(c => !pathsToMute.some(mp => this.pathsMatch(mp, c.path))).map(c => ({ path: c.path, justification: "Active (not in mute list)" }));
                    proposedKept = proposedKeep.map(k => k.path);
                } else {
                    const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        try {
                            const parsed = JSON.parse(jsonMatch[0]);
                            if (parsed.signatures) extractedSignatures = String(parsed.signatures).trim();
                            if (parsed.worker || parsed.worker_advice) extractedWorkerAdvice = String(parsed.worker || parsed.worker_advice).trim();
                            if (Array.isArray(parsed.reveal_only)) {
                                proposedKeep = fileCandidates.filter(c => parsed.reveal_only.some((rp: string) => this.pathsMatch(rp, c.path))).map(c => ({ path: c.path, justification: "Selected in reveal_only" }));
                                proposedEvict = fileCandidates.filter(c => !parsed.reveal_only.some((rp: string) => this.pathsMatch(rp, c.path))).map(c => ({ path: c.path, reason: "Muted by reveal_only" }));
                                proposedKept = proposedKeep.map(k => k.path);
                            } else if (Array.isArray(parsed.mute_only) || Array.isArray(parsed.mute)) {
                                const mList = parsed.mute_only || parsed.mute;
                                proposedEvict = fileCandidates.filter(c => mList.some((mp: string) => this.pathsMatch(mp, c.path))).map(c => ({ path: c.path, reason: "Muted in mute list" }));
                                proposedKeep = fileCandidates.filter(c => !mList.some((mp: string) => this.pathsMatch(mp, c.path))).map(c => ({ path: c.path, justification: "Active" }));
                                proposedKept = proposedKeep.map(k => k.path);
                            } else if (Array.isArray(parsed.evict) || Array.isArray(parsed.keep)) {
                                proposedEvict = parsed.evict || [];
                                proposedKeep = parsed.keep || [];
                                proposedKept = fileCandidates.filter(c => !proposedEvict.some((e: any) => this.pathsMatch(e.path || e, c.path))).map(c => c.path);
                            }
                        } catch {}
                    }
                }

                if (proposedKept !== null) {
                    let proposedActiveTokens = 0;
                    fileCandidates.forEach(c => {
                        if (proposedKept!.includes(c.path)) {
                            proposedActiveTokens += c.tokens;
                        }
                    });

                    lastCandidateDecision = {
                        action: 'decide',
                        rationale: extractedWorkerAdvice || "Governor optimized context selection.",
                        keep: proposedKeep,
                        evict: proposedEvict
                    };

                    if (proposedActiveTokens <= objectiveThreshold) {
                        Logger.info(`[Governor] Objective threshold verified in round ${currentRound}: ${proposedActiveTokens.toLocaleString()} <= ${objectiveThreshold.toLocaleString()} tokens.`);
                        return { decision: lastCandidateDecision, workerAdvice: extractedWorkerAdvice, signatures: extractedSignatures };
                    }

                    if (currentRound < maxRounds) {
                        const keptListDetailed = fileCandidates
                            .filter(c => proposedKept!.includes(c.path))
                            .sort((a, b) => b.tokens - a.tokens)
                            .map(c => `- \`${c.path}\`: ~${c.tokens.toLocaleString()} tokens (${c.bytes ? (c.bytes > 1024 ? Math.round(c.bytes / 1024) + ' KB' : c.bytes + ' B') : 'unknown size'})`)
                            .join('\n');

                        conversation.push({ role: 'assistant', content: cleanResponse });
                        conversation.push({
                            role: 'user',
                            content: `⚠️ OBJECTIVE THRESHOLD NOT REACHED (Round ${currentRound} of ${maxRounds}):
Your proposed selection leaves active context at ~${proposedActiveTokens.toLocaleString()} tokens (${Math.round((proposedActiveTokens / maxTokens) * 100)}%), which exceeds the objective target of ${objectiveThresholdPercent}% (~${objectiveThreshold.toLocaleString()} tokens).
Excess to eliminate: ~${(proposedActiveTokens - objectiveThreshold).toLocaleString()} tokens.

Here are the files currently kept active and their sizes:
${keptListDetailed}

Please tighten your selection using <reveal_only> (keeping only files that should inevitably be modified) or <mute_only>.
Remember you can summarize the muted files' function signatures and architecture in <signatures> so the worker still has enough context.`
                        });
                        continue;
                    }

                    return { decision: lastCandidateDecision, workerAdvice: extractedWorkerAdvice, signatures: extractedSignatures };
                }

                break;
            } catch (err: any) {
                Logger.warn(`[Governor] LLM negotiation round ${currentRound} error: ${err.message}`);
                break;
            }
        }

        return { decision: lastCandidateDecision, workerAdvice: extractedWorkerAdvice, signatures: extractedSignatures };
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
                evictList.push({
                    path: candidate.path,
                    reason: "Remained muted from prior configuration."
                });
            }
        }

        const activeCandidates = candidates.filter(b => !isAlreadyMuted(b.path));
        const olderActive = activeCandidates.filter(b => !b.isCurrentPromptFile);
        const currentPromptActive = activeCandidates.filter(b => b.isCurrentPromptFile);

        const sortedOlder = [...olderActive].sort((a, b) => a.relevanceScore - b.relevanceScore || b.tokens - a.tokens);

        for (const candidate of sortedOlder) {
            if (liberated >= overflow) break;
            evictList.push({
                path: candidate.path,
                reason: `Older module pruned to liberate ${candidate.tokens.toLocaleString()} tokens.`
            });
            liberated += candidate.tokens;
        }

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

        const isCoreOrInterface = cleanPath.includes('core') || cleanPath.includes('types') || cleanPath.includes('interface') || cleanPath.includes('schema');

        const extractedSymbols: string[] = [];
        const symbolRegex = /(?:class|interface|type|function|def)\s+([a-zA-Z0-9_]+)/g;
        let sMatch: RegExpExecArray | null;
        while ((sMatch = symbolRegex.exec(body)) !== null && extractedSymbols.length < 8) {
            extractedSymbols.push(sMatch[1]);
        }

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
            bytes: body.length,
            isCurrentPromptFile,
            isCoreOrInterface,
            relevanceScore: score,
            matchedKeywords,
            extractedSymbols,
            keep: true
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
        fallbackPromptText?: string
    ): GovernorArbitrationResult {
        const briefingText = briefingContent !== undefined ? briefingContent : "";
        const finalTree = (contextData.projectTree && contextData.projectTree.trim()) 
            ? contextData.projectTree 
            : "```text\n./: [Workspace root]\n```";

        const projectStateText = `
### 📂 ATTACHED PROJECT CONTEXT
I am providing you with the current, ground-truth state of my project files and the technical briefing.

${briefingText && !briefingText.includes("Librarian is analyzing") ? `#### 📋 TEAM TECHNICAL BRIEFING\n${briefingText}\n` : ""}
#### 🌳 PROJECT STRUCTURE
${finalTree}

${contextData.selectedFilesContent ? `#### 📄 FILE CONTENTS\n${contextData.selectedFilesContent}` : "*(No files currently selected)*"}
--------------------------------------------------`.trim();

        const { ensureStrictAlternatingRoles, mergeMessageContents } = require('./utils');

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