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
    linesCount: number;
    isCurrentPromptFile: boolean;
    isCoreOrInterface: boolean;
    relevanceScore: number;
    matchedKeywords: string[];
    extractedSymbols: string[];
    keep: boolean;
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

    private static async getStructureGuide(): Promise<string> {
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

    private static async saveStructureGuide(content: string): Promise<boolean> {
        const folders = vscode.workspace.workspaceFolders || [];
        if (folders.length === 0 || !content.trim()) return false;
        try {
            const lollmsDir = vscode.Uri.joinPath(folders[0].uri, '.lollms');
            await vscode.workspace.fs.createDirectory(lollmsDir);
            const structUri = vscode.Uri.joinPath(lollmsDir, 'structure.md');
            await vscode.workspace.fs.writeFile(structUri, Buffer.from(content.trim(), 'utf8'));
            return true;
        } catch (err: any) {
            Logger.warn("Failed to write .lollms/structure.md", err);
            return false;
        }
    }

    /**
     * Automatically filters files in context based on a user focus prompt.
     * Full token budget transparency, file adding, and reference vs edit segregation.
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
        discoverySteps?: { type: string; label: string; detail?: string }[];
        totalTokens: number;
        liberatedTokens: number;
        roundsUsed: number;
        maxRounds: number;
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
        const maxTokens = (maxTokensRes && maxTokensRes.context_size > 0)
            ? maxTokensRes.context_size
            : (options.currentDiscussion?.lastTokenMetrics?.contextSize || 128000);

        const targetPercent = options.currentDiscussion?.capabilities?.contextGovernorTargetThreshold || 70;
        const targetBudget = Math.round(maxTokens * (targetPercent / 100));

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const configuredRounds = options.currentDiscussion?.capabilities?.contextGovernorMaxRounds;
        const fallbackConfigRounds = config.get<number>('contextGovernorMaxRounds');
        const effectiveRounds = (configuredRounds && configuredRounds >= 10) ? configuredRounds : (fallbackConfigRounds || 20);
        const maxRounds = Math.max(15, effectiveRounds);

        let totalCandidateTokens = fileCandidates.reduce((sum, c) => sum + c.tokens, 0);
        let totalCandidateBytes = fileCandidates.reduce((sum, c) => sum + c.bytes, 0);

        let projectTreePreview = "";
        try {
            projectTreePreview = await contextManager.generateProjectTree(signal);
        } catch {}

        const existingStructure = await this.getStructureGuide();

        const formatSize = (b: number) => {
            if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
            if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
            return `${b} B`;
        };

        const systemPrompt = `You are the **Sovereign Context Governor**.
Your mission is to maintain context hygiene, discover dependencies across the workspace, and enforce the **Dual-Tier Context Strategy** to keep active token usage strictly within the target budget.

### 📊 100% TRANSPARENT TOKEN BUDGET:
- **Maximum Model Window Capacity**: ${maxTokens.toLocaleString()} tokens
- **Target Budget Threshold (${targetPercent}%)**: ~${targetBudget.toLocaleString()} tokens
- **Current Total of Candidate Files**: ~${totalCandidateTokens.toLocaleString()} tokens (${formatSize(totalCandidateBytes)})
- **Governor Exploration Rounds**: Up to ${maxRounds} rounds

### ⚖️ CRITICAL DUAL-TIER CONTEXT STRATEGY (EDIT VS REFERENCE):
You must divide all relevant files into two distinct categories:

1. **FILES TO MODIFY (ACTIVE CONTEXT [C])**:
   - Files where code, bugfixes, or features will be actively edited or created.
   - Put ONLY these files in \`<reveal_only>\`.
   - Full file content will be loaded into active context for exact search/replace matching.

2. **REFERENCE-ONLY FILES (STRUCTURE REPORT [.lollms/structure.md] + MUTED [M])**:
   - Files needed ONLY as references to understand the architecture, data models, interfaces, utility functions, or callers (files that will NOT be modified).
   - **DO NOT load these files with full content into active context!** That wastes context tokens.
   - Instead, inspect their structure (using \`<peek_files>\` or AST inspection) and write their architecture, types, and function signatures into the **Governor's Codebase Report** using \`<structure>...</structure>\`.
   - Put these files in \`<mute_only>\` (or omit from \`<reveal_only>\`). They remain tracked in tree at 0 tokens [M].
   - The worker LLM will read the Governor's Report from \`.lollms/structure.md\` in the HUD/briefing and will have 100% of the type contracts without burning active tokens on full code!

### 🛠️ AVAILABLE TOOLS & COMMANDS:
1. **Add Workspace Files to Context**:
   If a file exists in the Project Structure Tree that is not currently in your candidate list, output:
   \`<add_files_to_context>\\npath/to/workspace_file.ext\\n</add_files_to_context>

\`
   This loads the file into candidate memory and gives you its size and tokens!
2. **Peek File Slice**: \`<peek_files path="path/to/file.ext" lines="30" from="top" />\`
3. **Grep Search**: \`<grep pattern="searchTerm" path="optional/subdir" />\`
4. **SPARQL Architecture Query**: \`<sparql query="SELECT ?x WHERE { ?x s:type s:Class }" />\`
5. **Update Codebase Structure Guide**: Output \`<structure># Architecture & Reference Guide\\n...</structure>\` to document module responsibilities into persistent \`.lollms/structure.md\`.
6. **Selection Output**:
   - \`<reveal_only>\\npath/to/file_to_edit.ext\\n</reveal_only>\`
   - \`<mute_only>\\npath/to/reference_file.ext\\n</mute_only>\`
   - \`<signatures>\\n- file.ext: def func(): ...\\n</signatures>\`
   - \`<rationale>...</rationale>\` and \`<worker>...</worker>\``;

        const discoverySteps: { type: string; label: string; detail?: string }[] = [];
        let workerAdvice = "";
        let rationaleText = "";
        let signaturesText = "";
        let finalKeptPaths: string[] | null = null;

        const candidateCatalog = this.buildCompactCatalog(fileCandidates, options.currentMutedFiles || []);

        const initialUserPrompt = `### 🎯 USER FOCUS OBJECTIVE:
"${prompt}"

### 📊 CAPACITY & BUDGET AUDIT:
- Target Budget: ${targetBudget.toLocaleString()} tokens (${targetPercent}% limit)
- Current Files Weight: ~${totalCandidateTokens.toLocaleString()} tokens (${formatSize(totalCandidateBytes)})
- Status: ${totalCandidateTokens <= targetBudget ? '✅ All current candidates fit comfortably within budget!' : '⚠️ Candidates exceed budget — prune non-edit files to structure report.'}

${isStructural ? `💡 NOTICE: The user is asking for an architectural or structural overview. Keep primary application source code files active, extract reference architectures into <structure>, and mute only cosmetic stylesheets (*.css) and minified files.\n` : ''}
${existingStructure ? `### 🏛️ CURRENT CODEBASE STRUCTURE GUIDE (.lollms/structure.md):\n${existingStructure.substring(0, 2500)}\n` : ''}
### 🌳 PROJECT WORLD STATE (FILE TREE):
${projectTreePreview ? projectTreePreview.substring(0, 3500) : '(No tree available)'}

### 📄 CANDIDATE FILES CATALOG (${fileCandidates.length} files):
${candidateCatalog}

Investigate the codebase using discovery queries (<peek_files>, <grep>, <add_files_to_context>, <sparql>), update the structure guide with <structure>, or output your selection.`;

        const chatMessages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            ...(options.history || []).map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
            { role: 'user', content: initialUserPrompt }
        ];

        let rounds = 0;
        const isTrivialDirective = /^(mute\s+all|unmute\s+all|activate\s+all|all\s+on|all\s+off)$/i.test(prompt.trim());
        const minExplorationRounds = (!isTrivialDirective && fileCandidates.length > 3) ? 2 : 1;

        while (rounds < maxRounds) {
            if (signal.aborted) break;
            rounds++;

            const roundMessageId = `gov_round_${rounds}_${Date.now()}`;
            const statusText = `Governor: Round ${rounds}/${maxRounds} (Budget: ~${totalCandidateTokens.toLocaleString()}/${targetBudget.toLocaleString()} tok)...`;
            if (onStatusUpdate) onStatusUpdate(statusText);
            if (onRoundProgress) {
                onRoundProgress({
                    round: rounds,
                    maxRounds,
                    status: statusText,
                    discoverySteps: [...discoverySteps]
                });
            }

            let turnStreamBuffer = "";
            let cleanResponse = "";

            try {
                const response = await lollmsAPI.sendChat(
                    chatMessages,
                    (chunk) => {
                        if (signal.aborted) return;
                        turnStreamBuffer += chunk;
                        if (onStreamChunk) {
                            onStreamChunk({
                                round: rounds,
                                maxRounds,
                                chunk,
                                fullText: turnStreamBuffer,
                                messageId: roundMessageId
                            });
                        }
                    },
                    signal,
                    targetModel,
                    { thinking: true }
                );

                cleanResponse = stripThinkingTags(response).trim();
                if (!cleanResponse) {
                    throw new Error("LLM server returned an empty response.");
                }
            } catch (err: any) {
                Logger.error(`[Governor] LLM query failed in round ${rounds}: ${err.message}`);
                throw new Error(`Governor could not communicate with LLM model '${targetModel}': ${err.message || 'Connection failed'}. Ensure your LLM server is running.`);
            }

            // Save structure guide update immediately
            const structMatch = cleanResponse.match(/<structure\b[^>]*>([\s\S]*?)<\/structure>/i);
            if (structMatch && structMatch[1].trim()) {
                const structContent = structMatch[1].trim();
                await this.saveStructureGuide(structContent);
                const step = { type: 'structure', label: 'Updated Structure Guide', detail: '.lollms/structure.md saved' };
                discoverySteps.push(step);
                if (onDiscoveryAction) onDiscoveryAction(step);
            }

            // Check if Governor is adding new files from the workspace tree to context
            const addFilesMatch = cleanResponse.match(/<add_files_to_context\b[^>]*>([\s\S]*?)<\/add_files_to_context>/i);
            if (addFilesMatch) {
                const requestedPaths = addFilesMatch[1].split(/[\r\n,]+/).map(p => p.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
                const addedReports: string[] = [];

                for (const reqPath of requestedPaths) {
                    const resolution = await contextManager.resolveWorkspaceFromPath(reqPath);
                    if (resolution) {
                        try {
                            const fileBytes = await vscode.workspace.fs.readFile(resolution.uri);
                            const text = Buffer.from(fileBytes).toString('utf8');
                            const bytesCount = fileBytes.length;
                            const tokens = Math.max(1, Math.ceil(bytesCount / 3.5));

                            const existingIdx = fileCandidates.findIndex(c => this.pathsMatch(c.path, reqPath));
                            if (existingIdx === -1) {
                                const formatted = text.endsWith('\n') ? text : text + '\n';
                                const candidate = this.buildCandidate(`<file path="${reqPath}">\n${formatted}</file>

\n\n`, reqPath, text, tokens, new Set([reqPath.toLowerCase()]), keywords, contextManager);
                                candidate.bytes = bytesCount;
                                candidate.linesCount = text.split('\n').length;
                                candidate.isNewlyAdded = true;
                                fileCandidates.push(candidate);
                                newlyAddedFiles.push(reqPath);
                            }

                            addedReports.push(`- \`${reqPath}\`: ~${tokens.toLocaleString()} tokens (${formatSize(bytesCount)})`);
                            const step = { type: 'add_file', label: `Added to Context: ${path.basename(reqPath)}`, detail: `~${tokens} tok` };
                            discoverySteps.push(step);
                            if (onDiscoveryAction) onDiscoveryAction(step);
                        } catch {}
                    }
                }

                totalCandidateTokens = fileCandidates.reduce((sum, c) => sum + c.tokens, 0);
                totalCandidateBytes = fileCandidates.reduce((sum, c) => sum + c.bytes, 0);

                chatMessages.push({ role: 'assistant', content: cleanResponse });
                chatMessages.push({
                    role: 'user',
                    content: `### ✅ ADDED FILES TO CONTEXT CANDIDATES:
${addedReports.join('\n') || '(Could not resolve requested paths on disk)'}

Updated Candidate Total: ${fileCandidates.length} files (~${totalCandidateTokens.toLocaleString()} tokens / ${formatSize(totalCandidateBytes)}).
Target Budget: ~${targetBudget.toLocaleString()} tokens.
Continue scouting or finalize your selection.`
                });
                continue;
            }

            // Grep search tool call
            const grepMatch = cleanResponse.match(/<grep\b[^>]*pattern=["']([^"']+)["'][^>]*\/>/i) ||
                              cleanResponse.match(/<grep\b[^>]*query=["']([^"']+)["'][^>]*\/>/i) ||
                              cleanResponse.match(/<grep\b[^>]*>([\s\S]*?)<\/grep>/i);
            if (grepMatch) {
                const pattern = (grepMatch[1] || "").trim();
                if (pattern) {
                    if (onStatusUpdate) onStatusUpdate(`Governor: Searching disk for "${pattern}"...`);
                    const searchRes = await contextManager.searchWorkspaceContent(pattern, { matchCase: false, wholeWord: false });
                    const snippet = searchRes.slice(0, 8).map(r => `${r.path}:${r.line} - ${r.snippet}`).join('\n') || 'No matches found.';
                    const step = { type: 'grep', label: `Grep: "${pattern}"`, detail: `Found ${searchRes.length} hits` };
                    discoverySteps.push(step);
                    if (onDiscoveryAction) onDiscoveryAction(step);

                    chatMessages.push({ role: 'assistant', content: cleanResponse });
                    chatMessages.push({
                        role: 'user',
                        content: `### 🔍 GREP RESULTS FOR "${pattern}":\n${snippet}\n\nReview this result. You may make another discovery call or finalize your selection.`
                    });
                    continue;
                }
            }

            // SPARQL query tool call
            const sparqlMatch = cleanResponse.match(/<sparql\b[^>]*query=["']([\s\S]*?)["'][^>]*\/>/i) ||
                                cleanResponse.match(/<sparql\b[^>]*>([\s\S]*?)<\/sparql>/i);
            if (sparqlMatch) {
                const sparqlQuery = (sparqlMatch[1] || "").trim();
                if (sparqlQuery && (contextManager as any).codeGraphManager) {
                    if (onStatusUpdate) onStatusUpdate(`Governor: Querying architecture graph...`);
                    const sparqlRes = await (contextManager as any).codeGraphManager.executeSparql(sparqlQuery);
                    const step = { type: 'sparql', label: `SPARQL Query`, detail: `Graph evaluated` };
                    discoverySteps.push(step);
                    if (onDiscoveryAction) onDiscoveryAction(step);

                    chatMessages.push({ role: 'assistant', content: cleanResponse });
                    chatMessages.push({
                        role: 'user',
                        content: `### 📊 SPARQL RESULTS:\n${sparqlRes}\n\nReview this result. You may continue scouting or output your selection.`
                    });
                    continue;
                }
            }

            // Peek Files tool call
            const peekMatch = cleanResponse.match(/<peek_files\b([^>]*?)>([\s\S]*?)<\/peek_files>/i) ||
                              cleanResponse.match(/<peek\b([^>]*?)\/>/i) ||
                              cleanResponse.match(/<peek_files\s+([^>]*?)\/>/i);
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
                    const step = { type: 'peek', label: `Peek: "${path.basename(targetPath)}"`, detail: `${linesFromAttr} lines` };
                    discoverySteps.push(step);
                    if (onDiscoveryAction) onDiscoveryAction(step);

                    chatMessages.push({ role: 'assistant', content: cleanResponse });
                    chatMessages.push({
                        role: 'user',
                        content: `### 📄 PEEK SLICE FOR "${targetPath}":\n\`\`\`\n${snippet}\n\`\`\`\n\nRemember: If this file is only needed for reference/structure, document its signatures in <structure> and leave it muted. If it must be modified, add it to <reveal_only>.`
                    });
                    continue;
                }
            }

            // Check for selection tags
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

            // Anti-lazy-exit guard: Mandate discovery before locking in decision on non-trivial prompts
            if (proposedKept !== null && rounds < minExplorationRounds && discoverySteps.length === 0) {
                if (onStatusUpdate) onStatusUpdate(`Governor: Mandating discovery round ${rounds + 1}...`);
                const keyCandidates = fileCandidates.filter(c => !this.isClutterOrCosmeticFile(c.path)).slice(0, 3).map(c => c.path);

                chatMessages.push({ role: 'assistant', content: cleanResponse });
                chatMessages.push({
                    role: 'user',
                    content: `⚠️ MULTI-ROUND EXPLORATION MANDATE (Round ${rounds} of ${maxRounds}):
You made an initial guess without inspecting candidate files on disk.
To ensure you do not mute files that need edits or load unneeded reference files:
1. Use \`<peek_files path="..." lines="30" />\` on key files: ${keyCandidates.map(p => `\`${p}\``).join(', ')}.
2. If files are only needed for reference, extract their signatures into \`<structure>\` and mute them.
3. If new files from the workspace tree need to be added, use \`<add_files_to_context>\`.
Perform at least one discovery step now before finalizing.`
                });
                continue;
            }

            // Preselection Budget Verification & Sanity Check
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
                        .map(c => `- \`${c.path}\`: ~${c.tokens.toLocaleString()} tokens (${formatSize(c.bytes)})`)
                        .join('\n');

                    chatMessages.push({ role: 'assistant', content: cleanResponse });
                    chatMessages.push({
                        role: 'user',
                        content: `⚠️ PRESELECTION EXCEEDS TOKEN BUDGET (Round ${rounds} of ${maxRounds}):
Proposed selection: ~${candidateTokens.toLocaleString()} tokens (${Math.round((candidateTokens / maxTokens) * 100)}%), exceeding target budget of ~${targetBudget.toLocaleString()} tokens (${targetPercent}%).
Excess to eliminate: ~${(candidateTokens - targetBudget).toLocaleString()} tokens.

Active files in your selection:
${keptListDetailed}

Apply the Dual-Tier Strategy:
- Are any of these files needed ONLY for reference/types? Extract their signatures into <structure> and mute them!
- Keep ONLY files that must be modified in <reveal_only>.`
                    });
                    continue;
                }

                // Sanity check for structural queries
                if (isStructural && fitsComfortablyInBudget) {
                    const mutedCode = fileCandidates.filter(c => !proposedKept!.includes(c.path) && !this.isClutterOrCosmeticFile(c.path));
                    if (mutedCode.length > 0 && rounds < 3) {
                        chatMessages.push({ role: 'assistant', content: cleanResponse });
                        chatMessages.push({
                            role: 'user',
                            content: `⚠️ STRUCTURAL QUERY CORRECTION (Round ${rounds} of ${maxRounds}):
The user asked to explain the project structure, but your selection muted primary source code files: [${mutedCode.map(c => c.path).join(', ')}].
All candidate files total ~${totalCandidateTokens.toLocaleString()} tokens, which fits within the budget (~${targetBudget.toLocaleString()} tokens).
Keep all primary code files active in <reveal_only> and mute only cosmetic stylesheets (*.css) and minified files.`
                        });
                        continue;
                    }
                }

                finalKeptPaths = proposedKept;
                break;
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
            } else if (isStructural && fitsComfortablyInBudget) {
                keep = !this.isClutterOrCosmeticFile(candidate.path);
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
            addedFiles: newlyAddedFiles,
            rationale,
            advice: workerAdvice,
            signatures: signaturesText,
            discoverySteps,
            totalTokens,
            liberatedTokens,
            roundsUsed: rounds,
            maxRounds
        };
    }

    /**
     * Executes the Context Governor arbitration algorithm.
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

        const systemTokens = Math.ceil((baseInstructions || '').length / 3.5);
        let historyTokens = Math.ceil(getCleanHistoryText(history).length / 3.5);
        const treeTokens = Math.ceil((contextData.projectTree || '').length / 3.5);
        const skillsTokens = Math.ceil((contextData.skillsContent || '').length / 3.5);
        const briefingContent = contextManager.renderBriefing(currentDiscussion);
        const briefingTokens = Math.ceil((briefingContent || '').length / 3.5);
        const promptTokens = Math.ceil((userPromptText || '').length / 3.5);

        let fixedLoad = systemTokens + historyTokens + treeTokens + skillsTokens + briefingTokens + promptTokens;

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

        const isStructural = this.isBroadOrStructuralQuery(userPromptText);

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
            candidate.linesCount = fileBody.split('\n').length;

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

        const olderActiveCandidates = fileCandidates.filter(b => !b.isCurrentPromptFile && !isCandidateMuted(b.path));
        const tokensAvailableFromOlder = olderActiveCandidates.reduce((sum, b) => sum + b.tokens, 0);
        const canAvoidEvictingCurrentPrompt = tokensAvailableFromOlder >= overflow;

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
                pruneMsgId,
                onStatusUpdate,
                onAddMessage,
                optionsUpdateMessage: options.onUpdateMessage,
                onRoundUsed: (r) => { roundsUsed = r; }
            });
            governorDecision = negotiationResult.decision;
            workerAdvice = negotiationResult.workerAdvice || "";
            mutedSignatures = negotiationResult.signatures || "";
            if (negotiationResult.addedFiles && negotiationResult.addedFiles.length > 0) {
                try {
                    await contextManager.getContextStateProvider()?.addFilesToContext(negotiationResult.addedFiles);
                } catch {}
            }
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
            const steps = (governorDecision as any)?.discoverySteps || [];
            let stepsHtml = '';
            if (steps.length > 0) {
                const chips = steps.map((s: any) => `
                    <div class="gov-discovery-chip ${s.type || 'thought'}">
                        <i class="codicon ${s.type === 'grep' ? 'codicon-search' : (s.type === 'sparql' ? 'codicon-graph' : (s.type === 'peek' ? 'codicon-eye' : (s.type === 'add_file' ? 'codicon-diff-added' : (s.type === 'structure' ? 'codicon-book' : 'codicon-symbol-misc'))))}"></i>
                        <span>${s.label || 'Step'}</span>
                        ${s.detail ? `<span style="opacity:0.6;">(${s.detail})</span>` : ''}
                    </div>
                `).join('');

                stepsHtml = `
<div style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; padding: 6px 10px; background: rgba(0,0,0,0.18); border-radius: 6px; border: 1px dashed var(--vscode-widget-border);">
    <div style="font-size: 9px; font-weight: 800; text-transform: uppercase; color: var(--vscode-charts-orange); opacity: 0.9; display: flex; align-items: center; gap: 4px;">
        <i class="codicon codicon-sparkle"></i> Autonomous Discovery Steps Taken
    </div>
    <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px;">${chips}</div>
</div>\n\n`;
            }

            const signaturesHtml = mutedSignatures ? `
<div style="padding: 8px 12px; background: rgba(155, 89, 182, 0.08); border-left: 3px solid var(--vscode-charts-purple); border-radius: 4px; margin: 8px 0;">
    <strong style="color: var(--vscode-charts-purple); font-size: 11px; display: flex; align-items: center; gap: 6px;">
        <i class="codicon codicon-graph"></i> Muted Files Architecture & Signatures
    </strong>
    <div class="markdown-body" style="font-size: 11px; opacity: 0.9; margin-top: 4px; max-height: 250px; overflow-y: auto; line-height: 1.45;">
        ${mutedSignatures}
    </div>
</div>\n\n` : '';

            const adviceHtml = workerAdvice ? `
<div style="padding: 6px 10px; background: rgba(0, 122, 204, 0.08); border-left: 3px solid var(--vscode-charts-blue); border-radius: 4px; margin: 6px 0;">
    <strong style="color: var(--vscode-charts-blue); font-size: 11px;">Advice for Worker:</strong>
    <div style="font-size: 11px; opacity: 0.9; margin-top: 2px;">${workerAdvice}</div>
</div>\n\n` : '';

            const governorCardMarkdown = `${stepsHtml}${rationale}\n\n${signaturesHtml}${adviceHtml}*${keptBlocks.length} file(s) will be loaded with content [C], ${mutedBlocks.length} kept in tree at 0 tokens [M].*\n*(Completed in ${roundsUsed} round${roundsUsed === 1 ? '' : 's'} &middot; Context Load: ${newUsagePercent}% &middot; Liberated: ~${totalLiberated.toLocaleString()} tok)*${chunkingNotice ? `\n\n---\n${chunkingNotice}` : ''}`;

            if (options.onUpdateMessage) {
                await options.onUpdateMessage(pruneMsgId, governorCardMarkdown);
            } else {
                await onAddMessage({
                    id: 'governor_run_' + Date.now(),
                    role: 'system',
                    personalityName: '⚖️ Context Governor',
                    content: governorCardMarkdown,
                    skipInPrompt: true
                });
            }
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
        onAddMessage?: (message: ChatMessage) => Promise<void>;
        optionsUpdateMessage?: (messageId: string, content: string) => Promise<void>;
        onRoundUsed?: (rounds: number) => void;
    }): Promise<{ decision: any; workerAdvice?: string; signatures?: string; discoverySteps?: any[]; addedFiles?: string[] }> {
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
        const newlyAddedFiles: string[] = [];
        const discoverySteps: { type: string; label: string; detail?: string }[] = [];
        const isStructural = this.isBroadOrStructuralQuery(userPromptText);
        let totalCandidateTokens = fileCandidates.reduce((sum, c) => sum + c.tokens, 0);
        let totalCandidateBytes = fileCandidates.reduce((sum, c) => sum + c.bytes, 0);
        const fitsComfortablyInBudget = totalCandidateTokens <= objectiveThreshold;

        const compactCatalog = this.buildCompactCatalog(fileCandidates, options.currentMuted);
        const existingStructure = await this.getStructureGuide();

        const formatSize = (b: number) => {
            if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
            if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
            return `${b} B`;
        };

        const systemPrompt = `You are the **Sovereign Context Governor**.
Your goal is to optimize active prompt context to strictly satisfy the objective target (${objectiveThresholdPercent}%, max ${objectiveThreshold.toLocaleString()} tokens).
Capacity limit: ${maxTokens.toLocaleString()} tokens. Current full load: ${totalEstimated.toLocaleString()} tokens. Required reduction: ~${overflow.toLocaleString()} tokens.
Allowed Negotiation Rounds: Up to ${maxRounds}.

### 📊 100% TRANSPARENT TOKEN BUDGET:
- **Maximum Model Window Capacity**: ${maxTokens.toLocaleString()} tokens
- **Target Budget Threshold (${objectiveThresholdPercent}%)**: ~${objectiveThreshold.toLocaleString()} tokens
- **Total Weight of All Candidate Files**: ~${totalCandidateTokens.toLocaleString()} tokens (${formatSize(totalCandidateBytes)})

### ⚖️ CRITICAL DUAL-TIER CONTEXT STRATEGY (EDIT VS REFERENCE):
1. **FILES TO MODIFY (ACTIVE CONTEXT [C])**:
   - Files where code, bugfixes, or features will be actively edited or created.
   - Put ONLY these files in \`<reveal_only>\`.
2. **REFERENCE-ONLY FILES (STRUCTURE REPORT [.lollms/structure.md] + MUTED [M])**:
   - Files needed ONLY as references to understand the architecture, data models, interfaces, utility functions, or callers (files that will NOT be modified).
   - **DO NOT load these files with full content into active context!**
   - Instead, inspect their structure (using \`<peek_files>\`) and write their architecture, types, and function signatures into the **Governor's Codebase Report** using \`<structure>...</structure>\`.
   - Put these files in \`<mute_only>\` (or omit from \`<reveal_only>\`). They remain tracked in tree at 0 tokens [M].

### 🛠️ AVAILABLE EXPLORATION TOOLS (MULTI-ROUND DISCOVERY):
1. **Grep Search**: \`<grep pattern="searchTerm" path="optional/subdir" />\`
2. **SPARQL Architecture Query**: \`<sparql query="SELECT ?x WHERE { ?x s:type s:Class }" />\`
3. **Peek File Slice**: \`<peek_files path="path/to/file.ext" lines="30" from="top" />\`
4. **Codebase Structure Guide**: Output \`<structure># Architecture Guide\\n...</structure>\` to document module responsibilities into persistent \`.lollms/structure.md\`.
5. **Selection Output**: \`<reveal_only>\` or \`<mute_only>\``;

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

${isStructural ? `⚠️ NOTICE: The user is asking for an architectural or structural overview of the project. Do NOT mute primary source code files like api.js, app.js, or controllers! Only mute cosmetic stylesheets (*.css), minified files (*.min.*), and static assets.\n` : ''}
${fitsComfortablyInBudget ? `💡 BUDGET NOTE: All candidate files total ~${totalCandidateTokens.toLocaleString()} tokens, which fits comfortably within the target budget (~${objectiveThreshold.toLocaleString()} tokens). Do not gut the codebase.\n` : ''}
${existingStructure ? `### 🏛️ PERSISTENT CODEBASE STRUCTURE GUIDE (.lollms/structure.md):\n${existingStructure.substring(0, 2000)}\n` : ''}
${governorDirectives && governorDirectives.length > 0 ? `### ⚖️ DIRECT USER DIRECTIVES FOR GOVERNOR (MANDATORY PRIORITY):\n${governorDirectives.map(d => `- ${d}`).join('\n')}\n(Follow these user instructions above all else when selecting files to keep or evict!)\n\n` : ''}### 📄 LOADED FILES COMPACT CATALOG (${fileCandidates.length} files)
${compactCatalog}

Make your decision to reach the objective threshold of ${objectiveThresholdPercent}% (${objectiveThreshold.toLocaleString()} tokens). Output your discovery queries (<peek_files>, <grep>, <sparql>, <structure>) or your selection decision.`;

        const conversation: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: initialUserPrompt }
        ];

        let discoveryCount = 0;
        const minExplorationRounds = (!isStructural && fileCandidates.length > 3) ? 2 : 1;

        while (currentRound < maxRounds) {
            if (signal.aborted) break;
            currentRound++;
            if (onRoundUsed) onRoundUsed(currentRound);

            if (onStatusUpdate) {
                onStatusUpdate(`⚖️ Governor: Round ${currentRound}/${maxRounds} (Evaluating & verifying)...`);
            }

            let streamBuffer = "";
            try {
                const response = await lollmsAPI.sendChat(conversation, (chunk) => {
                    if (signal.aborted) return;
                    streamBuffer += chunk;
                    if (options.optionsUpdateMessage && options.pruneMsgId) {
                        const statusBadge = `⚖️ **Context Governor: Round ${currentRound}/${maxRounds} (Scouting & Evaluating)**\n\n`;
                        options.optionsUpdateMessage(options.pruneMsgId, statusBadge + streamBuffer).catch(() => {});
                    }
                }, signal, targetModel, { thinking: true });
                const cleanResponse = stripThinkingTags(response).trim();
                if (!cleanResponse) {
                    throw new Error("LLM server returned an empty response.");
                }

                // Structure guide update check
                const structMatch = cleanResponse.match(/<structure\b[^>]*>([\s\S]*?)<\/structure>/i);
                if (structMatch && structMatch[1].trim()) {
                    await this.saveStructureGuide(structMatch[1].trim());
                    discoverySteps.push({ type: 'structure', label: 'Updated Structure Guide', detail: '.lollms/structure.md' });
                    discoveryCount++;
                }

                // Check for <add_files_to_context> to add files from tree
                const addFilesMatch = cleanResponse.match(/<add_files_to_context\b[^>]*>([\s\S]*?)<\/add_files_to_context>/i);
                if (addFilesMatch) {
                    const requestedPaths = addFilesMatch[1].split(/[\r\n,]+/).map(p => p.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
                    const addedReports: string[] = [];

                    for (const reqPath of requestedPaths) {
                        const resolution = await contextManager.resolveWorkspaceFromPath(reqPath);
                        if (resolution) {
                            try {
                                const fileBytes = await vscode.workspace.fs.readFile(resolution.uri);
                                const text = Buffer.from(fileBytes).toString('utf8');
                                const bytesCount = fileBytes.length;
                                const tokens = Math.max(1, Math.ceil(bytesCount / 3.5));

                                const existingIdx = fileCandidates.findIndex(c => this.pathsMatch(c.path, reqPath));
                                if (existingIdx === -1) {
                                    const formatted = text.endsWith('\n') ? text : text + '\n';
                                    const candidate = this.buildCandidate(`<file path="${reqPath}">\n${formatted}</file>

\n\n`, reqPath, text, tokens, new Set([reqPath.toLowerCase()]), keywords, contextManager);
                                    candidate.bytes = bytesCount;
                                    candidate.linesCount = text.split('\n').length;
                                    candidate.isNewlyAdded = true;
                                    fileCandidates.push(candidate);
                                    newlyAddedFiles.push(reqPath);
                                }

                                addedReports.push(`- \`${reqPath}\`: ~${tokens.toLocaleString()} tokens (${formatSize(bytesCount)})`);
                                discoverySteps.push({ type: 'add_file', label: `Added to Context: ${path.basename(reqPath)}`, detail: `~${tokens} tok` });
                                discoveryCount++;
                            } catch {}
                        }
                    }

                    totalCandidateTokens = fileCandidates.reduce((sum, c) => sum + c.tokens, 0);
                    totalCandidateBytes = fileCandidates.reduce((sum, c) => sum + c.bytes, 0);

                    conversation.push({ role: 'assistant', content: cleanResponse });
                    conversation.push({
                        role: 'user',
                        content: `### ✅ ADDED FILES TO CONTEXT CANDIDATES:
${addedReports.join('\n') || '(Could not resolve requested paths on disk)'}

Updated Candidate Total: ${fileCandidates.length} files (~${totalCandidateTokens.toLocaleString()} tokens / ${formatSize(totalCandidateBytes)}).
Target Budget: ~${objectiveThreshold.toLocaleString()} tokens.
Continue scouting or finalize your selection.`
                    });
                    continue;
                }

                // Check for Grep tool call
                const grepMatch = cleanResponse.match(/<grep\b[^>]*pattern=["']([^"']+)["'][^>]*\/>/i) ||
                                  cleanResponse.match(/<grep\b[^>]*query=["']([^"']+)["'][^>]*\/>/i) ||
                                  cleanResponse.match(/<grep\b[^>]*>([\s\S]*?)<\/grep>/i);
                if (grepMatch) {
                    const pattern = (grepMatch[1] || "").trim();
                    if (pattern) {
                        discoveryCount++;
                        if (onStatusUpdate) onStatusUpdate(`⚖️ Governor: Grep exploration for "${pattern}"...`);
                        const searchResults = await contextManager.searchWorkspaceContent(pattern, { matchCase: false, wholeWord: false });
                        const searchSnippet = searchResults.slice(0, 8).map(r => `${r.path}:${r.line} - ${r.snippet}`).join('\n') || 'No matches found.';
                        discoverySteps.push({ type: 'grep', label: `Grep: "${pattern}"`, detail: `Found ${searchResults.length} hits` });

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
                        discoveryCount++;
                        if (onStatusUpdate) onStatusUpdate(`⚖️ Governor: Querying architecture graph...`);
                        const sparqlRes = await (contextManager as any).codeGraphManager.executeSparql(sparqlQuery);
                        discoverySteps.push({ type: 'sparql', label: `SPARQL Query`, detail: `Graph evaluated` });

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
                              cleanResponse.match(/<peek\b([^>]*?)\/>/i) ||
                              cleanResponse.match(/<peek_files\s+([^>]*?)\/>/i);
                if (peekMatch) {
                    const attrPart = peekMatch[1] || "";
                    const inner = (peekMatch[2] || "").trim();
                    const pathFromAttr = attrPart.match(/path=["']([^"']+)["']/i)?.[1] || "";
                    const linesFromAttr = parseInt(attrPart.match(/lines=["']?(\d+)["']?/i)?.[1] || "30", 10);
                    const fromDir = (attrPart.match(/from=["']?(top|bottom)["']?/i)?.[1] || "top") as 'top' | 'bottom';
                    const targetPath = pathFromAttr || inner.split(/\s+/)[0] || "";

                    if (targetPath) {
                        discoveryCount++;
                        if (onStatusUpdate) onStatusUpdate(`⚖️ Governor: Peeking at ${path.basename(targetPath)}...`);
                        const peekRes = await contextManager.peekFiles([{ path: targetPath, lines: linesFromAttr, from: fromDir }]);
                        const snippet = peekRes.map(r => r.error ? `Error: ${r.error}` : r.content).join('\n') || 'File empty.';
                        discoverySteps.push({ type: 'peek', label: `Peek: "${path.basename(targetPath)}"`, detail: `${linesFromAttr} lines` });

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
                }

                // Exploration enforcement: do not let it make a blind guess on Round 1 without discovery
                if (proposedKept !== null && currentRound < minExplorationRounds && discoveryCount === 0) {
                    conversation.push({ role: 'assistant', content: cleanResponse });
                    conversation.push({
                        role: 'user',
                        content: `⚠️ DISCOVERY ROUND MANDATORY (Round ${currentRound} of ${maxRounds}):
You made a preliminary selection without peeking at any file content or running discovery.
Take an exploration round now using \`<peek_files path="..." lines="30" />\` or \`<grep pattern="..." />\` to verify file roles before finalizing.`
                    });
                    continue;
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
                        discoverySteps,
                        keep: proposedKeep,
                        evict: proposedEvict
                    };

                    if (proposedActiveTokens <= objectiveThreshold) {
                        Logger.info(`[Governor] Objective threshold verified in round ${currentRound}: ${proposedActiveTokens.toLocaleString()} <= ${objectiveThreshold.toLocaleString()} tokens.`);
                        return { decision: lastCandidateDecision, workerAdvice: extractedWorkerAdvice, signatures: extractedSignatures, discoverySteps, addedFiles: newlyAddedFiles };
                    }

                    if (currentRound < maxRounds) {
                        const keptListDetailed = fileCandidates
                            .filter(c => proposedKept!.includes(c.path))
                            .sort((a, b) => b.tokens - a.tokens)
                            .map(c => `- \`${c.path}\`: ~${c.tokens.toLocaleString()} tokens (${formatSize(c.bytes)})`)
                            .join('\n');

                        conversation.push({ role: 'assistant', content: cleanResponse });
                        conversation.push({
                            role: 'user',
                            content: `⚠️ OBJECTIVE THRESHOLD NOT REACHED (Round ${currentRound} of ${maxRounds}):
Your proposed selection leaves active context at ~${proposedActiveTokens.toLocaleString()} tokens (${Math.round((proposedActiveTokens / maxTokens) * 100)}%), which exceeds the objective target of ${objectiveThresholdPercent}% (~${objectiveThreshold.toLocaleString()} tokens).
Excess to eliminate: ~${(proposedActiveTokens - objectiveThreshold).toLocaleString()} tokens.

Here are the files currently kept active and their sizes:
${keptListDetailed}

Please tighten your selection using <reveal_only> or <mute_only>.`
                        });
                        continue;
                    }

                    return { decision: lastCandidateDecision, workerAdvice: extractedWorkerAdvice, signatures: extractedSignatures };
                }

                break;
            } catch (err: any) {
                Logger.error(`[Governor] LLM negotiation round ${currentRound} error: ${err.message}`);
                throw new Error(`Governor could not communicate with LLM model '${targetModel}': ${err.message || 'Connection failed'}. Ensure your LLM server is running.`);
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
            const newTag = c.isNewlyAdded ? ' [NEWLY ADDED FROM DISK]' : '';
            const sizeStr = `${formatSize(c.bytes)} (~${c.tokens.toLocaleString()} tok${c.linesCount > 0 ? `, ${c.linesCount} lines` : ''})`;
            const symbolsStr = c.extractedSymbols.length > 0 ? `\n  Symbols: ${c.extractedSymbols.slice(0, 5).join(', ')}` : '';
            const keywordsStr = c.matchedKeywords.length > 0 ? `\n  Matches: ${c.matchedKeywords.slice(0, 5).join(', ')}` : '';

            return `- File: \`${c.path}\`${statusTag}${newTag} (${sizeStr})${shieldTag}${coreTag}${symbolsStr}${keywordsStr}`;
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
            linesCount: body.split('\n').length,
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