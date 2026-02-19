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
        systemPrompt: "### RESPONSE STYLE: BALANCED\n- **Logic**: Briefly explain the technical approach or reasoning behind your solution.\n- **Implementation**: Provide the code or perform the actions immediately after the explanation.\n- **Tone**: Professional, helpful, and direct. Avoid rigid headers like 'Problem' or 'Hypothesis' unless explicitly asked.",
        prefix: ""
    },
    {
        id: "structured",
        name: "Structured (Analytical)",
        description: "Formal Problem/Hypothesis/Fix breakdown.",
        systemPrompt: "### RESPONSE STYLE: STRUCTURED\n- **MANDATORY LAYOUT**: You MUST follow this three-part structure for every response:\n  1. **Problem**: Identify what is being asked or what issue was found.\n  2. **Hypothesis**: Describe the technical path chosen and why.\n  3. **Fix**: Provide the actual implementation or code.",
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
    forceFullCode: boolean;
    allowedFormats: {
        fullFile: boolean;
        insert: boolean;
        replace: boolean;
        delete: boolean;
    };
    responseProfileId: string;
    explainCode: boolean;
    addPedagogicalInstruction: boolean;
    forceFullCodePath: boolean;
    fileRename: boolean;
    fileDelete: boolean;
    fileDelete: boolean;
    fileSelect: boolean;
    fileReset: boolean;
    imageGen: boolean;
    webSearch: boolean;
    distillWebResults: boolean;
    antiPromptInjection: boolean;
    searchInCacheFirst: boolean;
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
    herdMode: boolean;
    herdDynamicMode: boolean;
    herdParticipants: HerdParticipant[];
    herdPreAnswerParticipants: HerdParticipant[];
    herdPostAnswerParticipants: HerdParticipant[];
    herdRounds: number;
    agentMode: boolean;
    autoContextMode: boolean;
    autoSkillMode: boolean;
    contextAggression: 'respect' | 'none' | 'minimal' | 'signatures';
    disableProjectContext: boolean;
    guiState?: {
        agentBadge: boolean;
        autoContextBadge: boolean;
        herdBadge: boolean;
        webSearchBadge?: boolean;
        autoSkillBadge?: boolean;
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
    // Normalize line endings to \n for internal processing
    const normalizedContent = content.replace(/\r\n/g, '\n');
    // Also trim leading/trailing empty lines from the blocks which sometimes happens during LLM output
    let normalizedSearch = searchBlock.replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '');
    let normalizedReplace = replaceBlock.replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '');

    // 1. Direct match attempt
    if (normalizedContent.includes(normalizedSearch)) {
        return { success: true, result: normalizedContent.replace(normalizedSearch, normalizedReplace) };
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
                    // We found the block location at lines [startContentIdx ... startContentIdx + searchLines.length]
                    // Now we need to construct the replacement.
                    // We must apply the indentation delta to the replace block.
                    
                    // Calculate indentation delta based on the first non-empty line
                    const contentIndent = contentLines[i].match(/^\s*/)?.[0] || "";
                    const searchIndent = searchLine.match(/^\s*/)?.[0] || "";
                    
                    const adjustedReplaceLines = replaceLines.map(line => {
                        if (line.trim().length === 0) return ""; // Normalize empty lines
                        
                        const lineIndent = line.match(/^\s*/)?.[0] || "";
                        
                        // If the replace line starts with the same base indent as the search block had,
                        // we can safely swap it for the content's base indent.
                        if (lineIndent.startsWith(searchIndent)) {
                            return contentIndent + line.substring(searchIndent.length);
                        } 
                        
                        // If searchIndent was shorter or different? 
                        // E.g. searchIndent was 2 spaces, contentIndent is 4 spaces.
                        // Replace line has 2 spaces. We want 4 spaces.
                        // Delta is +2 spaces (or +1 tab etc).
                        // Hard to do robustly with mixed tabs/spaces, but let's try simple prefix replacement
                        // if contentIndent starts with searchIndent (unlikely if lengths differ)
                        
                        // Simple robust approach: If contentIndent is longer, prepend difference.
                        if (contentIndent.length > searchIndent.length && contentIndent.startsWith(searchIndent)) {
                             return contentIndent.substring(searchIndent.length) + line;
                        }
                        
                        // If contentIndent is shorter (dedented), try to remove prefix
                        if (searchIndent.length > contentIndent.length && searchIndent.startsWith(contentIndent)) {
                             if (line.startsWith(searchIndent.substring(contentIndent.length))) {
                                 return line.substring(searchIndent.length - contentIndent.length);
                             }
                        }

                        // Fallback: just return line if we can't calculate shift
                        return line;
                    });
                    
                    // Reconstruct
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
    const THRESHOLD = 0.85; 

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

    return { 
        success: false, 
        result: content, 
        error: `Could not find match for SEARCH block (Best similarity: ${(bestScore*100).toFixed(1)}%). Check indentation and content.` 
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

    if (hunks.length === 0) return { success: false, result: originalContent, error: "No valid diff hunks found." };

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
    await vscode.workspace.applyEdit(edit);
}

export async function getProcessedSystemPrompt(
    promptType: 'chat' | 'agent' | 'inspector' | 'commit', 
    capabilities?: DiscussionCapabilities,
    customPersonaContent?: string,
    memoryManager?: MemoryManager,
    forceFullCode?: boolean,
    context?: { tree: string, files: string, skills: string }
): Promise<string> {
    const memory = memoryManager ? await memoryManager.getMemory() : "";
    return PromptTemplates.getSystemPrompt(promptType, capabilities, customPersonaContent, memory, forceFullCode, context);
}

export function stripAnsiCodes(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/[\u001b\u009b][[()#;?]*(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~]*)*)?\u0007?/g, '');
}

export function stripThinkingTags(responseText: string): string {
    return responseText.replace(/<(think|thinking|analysis)>[\s\S]*?<\/\1>/gi, '').trim();
}

export function extractAndStripMemory(responseText: string): { content: string, memory: string | null } {
    const match = responseText.match(/<memory>([\s\S]*?)<\/memory>/);
    return match ? { content: responseText.replace(match[0], '').trim(), memory: match[1].trim() } : { content: responseText, memory: null };
}
