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
}

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
    fileRename: boolean;
    fileDelete: boolean;
    fileSelect: boolean;
    fileReset: boolean;
    imageGen: boolean;
    webSearch: boolean;
    wikipediaSearch: boolean; 
    stackoverflowSearch: boolean; 
    arxivSearch: boolean;
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
    guiState?: {
        agentBadge: boolean;
        autoContextBadge: boolean;
        herdBadge: boolean;
        webSearchBadge?: boolean;
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
    const normalizedContent = content.replace(/\r\n/g, '\n');
    let normalizedSearch = searchBlock.replace(/\r\n/g, '\n');
    let normalizedReplace = replaceBlock.replace(/\r\n/g, '\n');

    // 1. Direct match attempt
    if (normalizedContent.includes(normalizedSearch)) {
        return { success: true, result: normalizedContent.replace(normalizedSearch, normalizedReplace) };
    }

    // 2. Indentation Fixer: Detect if the model added or removed consistent leading whitespace
    const contentLines = normalizedContent.split('\n');
    const searchLines = normalizedSearch.split('\n');
    const replaceLines = normalizedReplace.split('\n');

    // Detect indentation shift on the first non-empty line of search block vs content
    const firstNonEmptySearchIdx = searchLines.findIndex(l => l.trim().length > 0);
    if (firstNonEmptySearchIdx !== -1) {
        const searchLine = searchLines[firstNonEmptySearchIdx];
        const trimmedSearch = searchLine.trim();
        
        for (let i = 0; i < contentLines.length; i++) {
            if (contentLines[i].trim() === trimmedSearch) {
                // Potential match at line i. Check indentation diff.
                const contentIndent = contentLines[i].match(/^\s*/)?.[0] || "";
                const searchIndent = searchLine.match(/^\s*/)?.[0] || "";
                
                if (contentIndent !== searchIndent) {
                    // Try to re-indent the search block to match the content's current indentation
                    const reindentedSearchLines = searchLines.map(line => {
                        if (line.trim().length === 0) return line;
                        const lineIndent = line.match(/^\s*/)?.[0] || "";
                        if (lineIndent.startsWith(searchIndent)) {
                            return contentIndent + line.substring(searchIndent.length);
                        }
                        return line;
                    });
                    
                    const reindentedSearch = reindentedSearchLines.join('\n');
                    
                    if (normalizedContent.includes(reindentedSearch)) {
                        // Success! Apply the same shift to the replace block
                        const reindentedReplaceLines = replaceLines.map(line => {
                            if (line.trim().length === 0) return line;
                            const lineIndent = line.match(/^\s*/)?.[0] || "";
                            if (lineIndent.startsWith(searchIndent)) {
                                return contentIndent + line.substring(searchIndent.length);
                            }
                            return line;
                        });
                        return { success: true, result: normalizedContent.replace(reindentedSearch, reindentedReplaceLines.join('\n')) };
                    }
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
        if (line.startsWith('@@')) {
            if (currentHunk) hunks.push(currentHunk);
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
        }
    }
    if (currentHunk) hunks.push(currentHunk);

    if (hunks.length === 0) return { success: false, result: originalContent, error: "No valid diff hunks found." };

    let workingLines = [...docLines];
    
    for (const hunk of hunks) {
        if (hunk.searchLines.length === 0) continue; 

        // Find hunk match
        let matchIndex = -1;
        for (let i = 0; i <= workingLines.length - hunk.searchLines.length; i++) {
            let match = true;
            for (let j = 0; j < hunk.searchLines.length; j++) {
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
            return { success: false, result: originalContent, error: `Match failed for hunk starting with: "${hunk.searchLines[0]}"` };
        }

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

export function stripThinkingTags(responseText: string): string {
    return responseText.replace(/<(think|thinking|analysis)>[\s\S]*?<\/\1>/gi, '').trim();
}

export function extractAndStripMemory(responseText: string): { content: string, memory: string | null } {
    const match = responseText.match(/<memory>([\s\S]*?)<\/memory>/);
    return match ? { content: responseText.replace(match[0], '').trim(), memory: match[1].trim() } : { content: responseText, memory: null };
}
