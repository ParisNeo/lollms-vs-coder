import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { MemoryManager } from './memoryManager';
import { execSync } from 'child_process';
import { PromptTemplates } from './promptTemplates';

export interface HerdParticipant {
    model: string;
    personality: string;
    name?: string;
    systemPrompt?: string;
    allowExecution?: boolean;
}

export interface DynamicModelEntry {
    model: string;
    description: string;
}

export interface ResponseProfile {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
    prefix?: string;
    isCustom?: boolean; // Flag to allow user overrides
}

/**
 * 🚀 THE SOURCE OF TRUTH (Deactivates Cache)
 * These prompts are defined in code. Even if settings.json has old versions,
 * the extension logic will use these unless the user explicitly creates a custom profile.
 */
export const SYSTEM_RESPONSE_PROFILES: ResponseProfile[] = [
    {
        id: "balanced",
        name: "Balanced (Default)",
        description: "Natural technical flow: Brief explanation followed by implementation.",
        systemPrompt: "### RESPONSE STYLE: BALANCED\n- **Logic**: Briefly explain the technical approach or reasoning behind your solution.\n- **Implementation**: Provide the code or tags (e.g., <project_memory>) immediately after the explanation.\n- **Constraint**: Do not wrap your entire response in a code block. Use standard markdown for text and only use code blocks for actual source code.\n- **Tone**: Professional, helpful, and direct.",
        prefix: ""
    },
    {
        id: "structured",
        name: "Structured (Analytical)",
        description: "Formal Discover/Explain/Think/Act breakdown.",
        systemPrompt: "### RESPONSE STYLE: STRUCTURED\n- **MANDATORY LAYOUT**: You MUST follow this four-part structure for every response:\n  1. **Discover**: Identify what is being asked or what issue was found.\n  2. **Explain**: Break down the underlying mechanics or context of the issue.\n  3. **Think**: Describe the technical path chosen to resolve it and why.\n  4. **Act**: Provide the actual implementation, code, or tool call.\n\n- **STRICT FORMATTING**: Use standard Markdown (bolding, lists) for these sections. Do NOT wrap these text sections in triple backticks.\n- **AUTONOMOUS ACTIONS**: If you need to use a tool or save a memory, do so at the END of your 'Act' section. Tags like <project_memory> are mandatory for persistence.",
        prefix: ""
    },
    {
        id: "minimalist",
        name: "Minimalist",
        description: "Just the answer/code. Zero fluff.",
        systemPrompt: "### RESPONSE STYLE: MINIMALIST\n- **Directness**: Do not include introductions, conclusions, or 'Here is your code'.\n- **Content**: Provide only the requested code block or the direct answer to the question.\n- **Brevity**: Extreme conciseness.",
        prefix: ""
    }
];

export interface DiscussionCapabilities {
    generationFormats: {
        fullFile: boolean;
        partialFormat: 'aider' | 'diff';
    };
    autoApply: boolean;
    autoFix: boolean;
    autoBranch: boolean;
    maxFixRetries: number;
    thinkingMode: boolean;
    thinkingBudget?: number;
    forceFullCode: boolean;
    allowedFormats: {
        fullFile: boolean;
        insert: boolean;
        replace: boolean;
        delete: boolean;
    };
    responseProfileId: string;
    language: string;
    voice: string;
    explainCode: boolean;
    addPedagogicalInstruction: boolean;
    forceFullCodePath: boolean;
    fileRename: boolean;
    fileDelete: boolean;
    fileSelect: boolean;
    fileReset: boolean;
    imageGen: boolean;
    enableImages: boolean;
    enableTTS: boolean;
    enableSTT: boolean;
    useImageModeForDocs: boolean;
    webSearch: boolean;
    distillWebResults: boolean;
    antiPromptInjection: boolean;
    searchInCacheFirst: boolean;
    clipboardInsertRole: 'user' | 'assistant';
    searchSources: {
        google: boolean;
        arxiv: boolean;
        wikipedia: boolean;
        stackoverflow: boolean;
        youtube: boolean;
        github: boolean;
    };
    gitWorkflow: boolean;
    gitCommit?: boolean;
    
    // --- UPDATED HERD CONFIG ---
    herdMode: boolean;
    herdParallelGeneration: boolean;
    herdPreAnswerCount: number;
    herdPostAnswerCount: number;
    herdOrchestratorModel?: string;      // The leader/planner model
    herdParticipantModels?: string[];    // List of model names participating
    herdCriticEnabled?: boolean;         // Optional critique step
    // ---------------------------

    agentMode: boolean;
    debugMode: boolean;
    verifierMode: boolean;
    testMode: boolean;
    documentationMode: boolean;
    gitAutoWorkflow: boolean;
    maxDebugSteps: number;
    autoContextMode: boolean;
    autoSkillMode: boolean;
    contextAggression: 'respect' | 'none' | 'minimal' | 'signatures';
    disableProjectContext: boolean;
    projectMemoryEnabled: boolean;
    temperature: number;
    ttftTimeout: number;
    interTokenTimeout: number;
    guiState?: {
        agentBadge: boolean;
        autoContextBadge: boolean;
        herdBadge: boolean;
        webSearchBadge?: boolean;
        autoSkillBadge?: boolean;
        testBadge?: boolean;
        docsBadge?: boolean;
    };
}

export async function getAvailableShells(): Promise<string[]> {
    const shells: string[] = [];
    const platform = os.platform();

    if (platform === 'win32') {
        shells.push('powershell', 'cmd');
        try { execSync('pwsh --version', { stdio: 'ignore' }); shells.push('pwsh'); } catch {}
        try { execSync('bash --version', { stdio: 'ignore' }); shells.push('bash'); } catch {}
        try { execSync('wsl --list', { stdio: 'ignore' }); shells.push('wsl'); } catch {}
    } else {
        shells.push('sh');
        try { execSync('bash --version', { stdio: 'ignore' }); shells.push('bash'); } catch {}
        try { execSync('zsh --version', { stdio: 'ignore' }); shells.push('zsh'); } catch {}
        try { execSync('fish --version', { stdio: 'ignore' }); shells.push('fish'); } catch {}
        try { execSync('pwsh --version', { stdio: 'ignore' }); shells.push('pwsh'); } catch {}
    }

    return shells;
}

function levenshtein(a: string, b: string): number {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix = [];

    // increment along the first column of each row
    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }

    // increment each column in the first row
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }

    // Fill in the rest of the matrix
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) == a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, // substitution
                    Math.min(matrix[i][j - 1] + 1, // insertion
                        matrix[i - 1][j] + 1)); // deletion
            }
        }
    }

    return matrix[b.length][a.length];
}

function calculateLineSimilarity(line1: string, line2: string): number {
    const l1 = line1.trim();
    const l2 = line2.trim();
    if (l1 === l2) return 1.0;
    if (l1 === "" && l2 === "") return 1.0;
    if (l1 === "" || l2 === "") return 0.0; // One empty, one not
    
    // Quick length check optimization
    if (Math.abs(l1.length - l2.length) / Math.max(l1.length, l2.length) > 0.5) return 0.2; 
    
    const dist = levenshtein(l1, l2);
    const maxLen = Math.max(l1.length, l2.length);
    return 1.0 - (dist / maxLen);
}

/**
 * Applies a Search/Replace (Aider-style) block to content.
 * Includes indentation detection and automatic correction.
 */
export function applySearchReplace(content: string, searchBlock: string, replaceBlock: string): { success: boolean, result: string, error?: string } {
    // Detect original line endings
    const isCrlf = content.includes('\r\n');
    const eol = isCrlf ? '\r\n' : '\n';

    // Normalize line endings to \n for internal processing
    const normalizedContent = content.replace(/\r\n/g, '\n');
    
    // Normalize blocks but avoid stripping significant empty lines if they were intended for context
    let normalizedSearch = searchBlock.replace(/\r\n/g, '\n');
    let normalizedReplace = replaceBlock.replace(/\r\n/g, '\n');

    // Clean up markers if they accidentally include the search/replace keywords themselves (Safety fallback)
    normalizedSearch = normalizedSearch.replace(/^<<<<<<< SEARCH\n?/, '').replace(/\n?>>>>>>> REPLACE$/, '');

    // 1. Special Case: Empty Search Block (Append to end)
    if (normalizedSearch.trim() === "") {
        const result = (normalizedContent.length === 0 || normalizedContent.endsWith('\n')) 
            ? normalizedContent + normalizedReplace.trimStart()
            : normalizedContent + '\n' + normalizedReplace.trimStart();
        
        return { success: true, result: isCrlf ? result.replace(/\n/g, '\r\n') : result };
    }

    // 2. Idempotency Check: If the replacement is already there, we win.
    if (normalizedContent.includes(normalizedReplace.trim())) {
        return { success: true, result: normalizedContent };
    }

    // 3. Direct match attempt (Fast Path)
    if (normalizedContent.includes(normalizedSearch)) {
        const parts = normalizedContent.split(normalizedSearch);
        return { success: true, result: parts.join(normalizedReplace) };
    }

    // 4. Handle trailing whitespace issues in SEARCH block
    // AI often adds trailing spaces that are not in the source code
    const linesSearch = normalizedSearch.split('\n');
    const linesSearchNoTrailing = linesSearch.map(l => l.trimEnd()).join('\n');
    if (normalizedContent.includes(linesSearchNoTrailing)) {
        const parts = normalizedContent.split(linesSearchNoTrailing);
        return { success: true, result: parts.join(normalizedReplace) };
    }

    // 1b. Direct match with trimmed search (Handles AI adding/removing trailing newlines)
    const trimmedSearch = normalizedSearch.trim();
    if (trimmedSearch.length > 10 && normalizedContent.includes(trimmedSearch)) {
        const parts = normalizedContent.split(trimmedSearch);
        return { success: true, result: parts.join(normalizedReplace.trim()) };
    }

    // 2. Indentation Fixer & Fuzzy Indent Matching
    // Detect if the model added or removed consistent leading whitespace OR if we can find the block by trimmed lines.
    const contentLines = normalizedContent.split('\n');
    const searchLines = normalizedSearch.split('\n');
    const replaceLines = normalizedReplace.split('\n');

    const firstNonEmptySearchIdx = searchLines.findIndex(l => l.trim().length > 0);
    
    if (firstNonEmptySearchIdx !== -1) {
        const searchLine = searchLines[firstNonEmptySearchIdx];
        const trimmedSearch = searchLine.trim();
        
        // Scan through content to find a line that matches the first non-empty search line (trimmed)
        for (let i = 0; i < contentLines.length; i++) {
            // Robust match: ignore leading/trailing whitespace when finding the anchor line
            if (contentLines[i].trim() === trimmedSearch) {
                // Found a potential start anchor.
                // Verify the rest of the search block matches (trimmed)
                let matchFound = true;
                
                // We need to account for the empty lines before the first non-empty line in searchLines
                const startContentIdx = i - firstNonEmptySearchIdx;
                if (startContentIdx < 0) continue; 

                // Check all search lines
                for (let j = 0; j < searchLines.length; j++) {
                    if (startContentIdx + j >= contentLines.length) {
                        matchFound = false;
                        break;
                    }
                    // Crucial: compare trimmed lines to be resilient to indentation shifts
                    if (searchLines[j].trim() !== contentLines[startContentIdx + j].trim()) {
                        matchFound = false;
                        break;
                    }
                }

                if (matchFound) {
                    // We found the block location
                    const contentIndent = contentLines[i].match(/^\s*/)?.[0] || "";
                    const searchIndent = searchLine.match(/^\s*/)?.[0] || "";
                    
                    let adjustedReplaceLines: string[] = [];
                    
                    if (normalizedReplace === "") {
                        // Total removal
                        adjustedReplaceLines = [];
                    } else {
                        adjustedReplaceLines = replaceLines.map(line => {
                            if (line.trim().length === 0) return "";
                            const lineIndent = line.match(/^\s*/)?.[0] || "";
                            if (lineIndent.startsWith(searchIndent)) {
                                return contentIndent + line.substring(searchIndent.length);
                            } 
                            if (contentIndent.length > searchIndent.length && contentIndent.startsWith(searchIndent)) {
                                return contentIndent.substring(searchIndent.length) + line;
                            }
                            if (searchIndent.length > contentIndent.length && searchIndent.startsWith(contentIndent)) {
                                if (line.startsWith(searchIndent.substring(contentIndent.length))) {
                                    return line.substring(searchIndent.length - contentIndent.length);
                                }
                            }
                            return line;
                        });
                    }
                    
                    const before = contentLines.slice(0, startContentIdx);
                    const after = contentLines.slice(startContentIdx + searchLines.length);
                    
                    return { success: true, result: [...before, ...adjustedReplaceLines, ...after].join('\n') };
                }
            }
        }
    }

    // 3. Fuzzy matching fallback for minor typos or non-consistent whitespace
    let bestScore = 0;
    let bestMatchIndex = -1;
    const THRESHOLD = 0.85; // 85% similarity required to apply the change anyway

    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
        let currentBlockScore = 0;
        let possible = true;

        if (calculateLineSimilarity(contentLines[i], searchLines[0]) < 0.5) continue; 

        for (let j = 0; j < searchLines.length; j++) {
            const score = calculateLineSimilarity(contentLines[i + j], searchLines[j]);
            if (score < 0.4) { 
                possible = false;
                break; 
            }
            currentBlockScore += score;
        }

        if (possible) {
            const averageScore = currentBlockScore / searchLines.length;
            if (averageScore > bestScore) {
                bestScore = averageScore;
                bestMatchIndex = i;
            }
        }
    }

    if (bestScore >= THRESHOLD && bestMatchIndex !== -1) {
        const resultLines = [...contentLines];
        resultLines.splice(bestMatchIndex, searchLines.length, normalizedReplace);
        return { success: true, result: resultLines.join('\n') };
    }

    // --- CHECK IF ALREADY APPLIED (Repetition Guard) ---
    const trimR = normalizedReplace.trim();
    if (trimR.length > 0) {
        if (normalizedContent.includes(normalizedReplace) || normalizedContent.includes(trimR)) {
            return { success: true, result: normalizedContent };
        }
    }

    // 4. Final Fallback: All matching strategies failed.
    return { 
        success: false, 
        result: content, 
        error: "The SEARCH block was not found in the file. Ensure the code you are trying to match is identical to the file content, including indentation and blank lines." 
    };
}

/**
 * Parses and applies a unified diff patch to a string.
 * Supports standard and simplified (missing line numbers) formats.
 */
export function applyDiffToString(originalContent: string, diffContent: string): { success: boolean, result: string, error?: string } {
    const docLines = originalContent.replace(/\r\n/g, '\n').split('\n');
    const diffLines = diffContent.replace(/\r\n/g, '\n').split('\n');
    
    interface Hunk {
        searchLines: string[];
        replaceLines: string[];
    }
    const hunks: Hunk[] = [];
    let currentHunk: Hunk | null = null;

    for (const line of diffLines) {
        // Skip unified diff headers
        if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ') || line.startsWith('Index:')) {
            continue;
        }

        // Any line starting with @@ marks the start of a new hunk, 
        // regardless of whether it has numbers.
        if (line.startsWith('@@')) {
            if (currentHunk && (currentHunk.searchLines.length > 0 || currentHunk.replaceLines.length > 0)) {
                hunks.push(currentHunk);
            }
            currentHunk = { searchLines: [], replaceLines: [] };
        } else if (currentHunk) {
            if (line.startsWith('-')) {
                currentHunk.searchLines.push(line.substring(1));
            } else if (line.startsWith('+')) {
                currentHunk.replaceLines.push(line.substring(1));
            } else if (line.startsWith(' ') || line === "") {
                const content = line.startsWith(' ') ? line.substring(1) : line;
                currentHunk.searchLines.push(content);
                currentHunk.replaceLines.push(content);
            }
        } else {
            // If we find +/- before the first @@, assume the first hunk starts implicitly
            if (line.startsWith('-') || line.startsWith('+')) {
                currentHunk = { searchLines: [], replaceLines: [] };
                if (line.startsWith('-')) currentHunk.searchLines.push(line.substring(1));
                else currentHunk.replaceLines.push(line.substring(1));
            }
        }
    }

    if (currentHunk && (currentHunk.searchLines.length > 0 || currentHunk.replaceLines.length > 0)) {
        hunks.push(currentHunk);
    }

    if (hunks.length === 0) {
        return { success: false, result: originalContent, error: "No valid diff hunks found. Ensure the diff follows the unified format (---/+++/@@)." };
    }

    let workingLines = [...docLines];
    
    for (const hunk of hunks) {
        if (hunk.searchLines.length === 0) {
            continue; 
        }

        // Find hunk match in the document
        let matchIndex = -1;
        for (let i = 0; i <= workingLines.length - hunk.searchLines.length; i++) {
            let match = true;
            for (let j = 0; j < hunk.searchLines.length; j++) {
                // Use trimmed comparison for robustness against minor indentation shifts
                if (workingLines[i + j].trim() !== hunk.searchLines[j].trim()) {
                    match = false;
                    break;
                }
            }
            if (match) {
                matchIndex = i;
                break;
            }
        }

        if (matchIndex === -1) {
            const preview = hunk.searchLines.length > 0 ? hunk.searchLines[0].substring(0, 40) : "empty hunk";
            return { success: false, result: originalContent, error: `Match failed for hunk starting with: "${preview}..."` };
        }

        // Apply replacement: remove search lines, insert replace lines
        workingLines.splice(matchIndex, hunk.searchLines.length, ...hunk.replaceLines);
    }

    return { success: true, result: workingLines.join('\n') };
}

export async function applyDiff(diffContent: string, targetFilePath?: string) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) throw new Error('No workspace folder open.');
    const workspaceRoot = workspaceFolders[0].uri;

    let relativePath = targetFilePath || "";
    if (!relativePath) {
        const fileMatch = diffContent.match(/^(?:--- a\/|\+\+\+ b\/|---\s|\+\+\+\s)(.*)$/m);
        if (fileMatch) {
            relativePath = fileMatch[1].trim();
            // Strip a/ or b/ if present
            if (relativePath.startsWith('a/') || relativePath.startsWith('b/')) {
                relativePath = relativePath.substring(2);
            }
        }
    }

    if (!relativePath) {
        throw new Error('Invalid diff: Could not determine target file path.');
    }

    const fileUri = vscode.Uri.joinPath(workspaceRoot, relativePath);
    const document = await vscode.workspace.openTextDocument(fileUri);
    const originalText = document.getText();
    
    const patchResult = applyDiffToString(originalText, diffContent);
    if (!patchResult.success) {
        throw new Error(patchResult.error);
    }

    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        document.lineAt(document.lineCount - 1).range.end
    );
    edit.replace(fileUri, fullRange, patchResult.result);
    const applied = await vscode.workspace.applyEdit(edit);
    if (applied) {
        await document.save();
    }
}

export async function getProcessedSystemPrompt(
    promptType: 'chat' | 'agent' | 'inspector' | 'commit' | 'surgical_agent', 
    capabilities?: DiscussionCapabilities,
    customPersonaContent?: string,
    memoryManager?: MemoryManager,
    forceFullCode?: boolean,
    context?: { tree: string, files: string, skills: string, memory?: string, projectName?: string },
    workingMemory?: string
): Promise<string> {
    const memory = memoryManager ? await memoryManager.getMemory() : "";
    let finalPersona = customPersonaContent || "";
    
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    
    // Fallback if no custom persona
    if (!finalPersona) {
        const key = promptType === 'chat' ? 'chatPersona' :
                    promptType === 'agent' ? 'agentPersona' :
                    promptType === 'inspector' ? 'codeInspectorPersona' : 'commitMessagePersona';
        finalPersona = config.get<string>(key) || "You are an expert software engineer.";
    }

    if (workingMemory) {
        finalPersona = `### 🧠 LIBRARIAN'S CONTEXT ANALYSIS\n${workingMemory}\n\n${finalPersona}`;
    }

    // Logic moved to dynamic system message for 'chat' and 'agent' types

    const shells = await getAvailableShells();

    // CALL THE TEMPLATE BUILDER
    return PromptTemplates.build(
        promptType, 
        finalPersona, 
        memory, 
        shells, 
        capabilities, 
        forceFullCode, 
        context
    );
}

export function stripAnsiCodes(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/[\u001b\u009b][[()#;?]*(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~]*)*)?\u0007?/g, '');
}

/**
 * Known context window sizes for major LLM providers.
 * Updated as of early 2025.
 */
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
    'gpt-4o': 128000,
    'gpt-4-turbo': 128000,
    'gpt-3.5-turbo': 16385,
    'claude-3-5': 200000,
    'claude-3-opus': 200000,
    'claude-3-haiku': 200000,
    'gemini-1.5-pro': 2000000,
    'gemini-1.5-flash': 1000000,
    'gemini-pro': 32768,
    'sonar': 128000, // Perplexity standard
    'llama3': 8192,
    'llama-3.1': 128000,
    'llama-3.2': 128000,
    'mistral-large': 128000,
    'mixtral-8x7b': 32768,
    'deepseek-v3': 64000,
    'deepseek-r1': 64000,
    'phi3': 128000,
    'command-r': 128000
};

/**
 * Heuristic to detect context size based on model ID string.
 */
export function getContextLimitForModel(modelName: string): number {
    const lower = modelName.toLowerCase();
    for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
        if (lower.includes(key)) return limit;
    }
    // Default fallback for unknown cloud models
    if (lower.startsWith('gpt-')) return 128000;
    if (lower.startsWith('claude-')) return 200000;
    if (lower.startsWith('gemini-')) return 1000000;
    
    return 128000; // General safe default
}

export function stripThinkingTags(responseText: string): string {
    return responseText.replace(/<(think|thinking|analysis)>[\s\S]*?<\/\1>/gi, '').trim();
}

export function extractAndStripMemory(responseText: string): { content: string, memory: string | null } {
    const match = responseText.match(/<memory>([\s\S]*?)<\/memory>/);
    return match ? { content: responseText.replace(match[0], '').trim(), memory: match[1].trim() } : { content: responseText, memory: null };
}
