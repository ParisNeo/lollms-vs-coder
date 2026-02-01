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

export interface DiscussionCapabilities {
    generationFormats: {
        fullFile: boolean;
        diff: boolean;
        aider: boolean; 
    };
    allowedFormats: {
        fullFile: boolean;
        insert: boolean;
        replace: boolean;
        delete: boolean;
    };
    responseMode: 'silent' | 'balanced' | 'pedagogical';
    explainCode: boolean; 
    fileRename: boolean;
    fileDelete: boolean;
    fileSelect: boolean;
    fileReset: boolean;
    imageGen: boolean;
    webSearch: boolean;
    arxivSearch: boolean;
    funMode: boolean;
    thinkingMode: 'none' | 'chain_of_thought' | 'chain_of_verification' | 'plan_and_solve' | 'self_critique' | 'no_think';
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
    };
}

/**
 * Detects available shells on the current system (Windows, Linux, macOS).
 */
export async function getAvailableShells(): Promise<string[]> {
    const shells: string[] = [];
    const platform = os.platform();

    if (platform === 'win32') {
        shells.push('powershell', 'cmd');
        try { execSync('pwsh --version', { stdio: 'ignore' }); shells.push('pwsh'); } catch {}
        try { execSync('bash --version', { stdio: 'ignore' }); shells.push('bash'); } catch {}
        try { execSync('wsl --list', { stdio: 'ignore' }); shells.push('wsl'); } catch {}
    } else {
        // Unix-like (Linux, macOS/Darwin)
        shells.push('sh');
        try { execSync('bash --version', { stdio: 'ignore' }); shells.push('bash'); } catch {}
        try { execSync('zsh --version', { stdio: 'ignore' }); shells.push('zsh'); } catch {}
        try { execSync('fish --version', { stdio: 'ignore' }); shells.push('fish'); } catch {}
        try { execSync('pwsh --version', { stdio: 'ignore' }); shells.push('pwsh'); } catch {}
    }

    return shells;
}

/**
 * Parses and applies a unified diff patch to a file using context matching.
 * Robust against LLMs providing incorrect line numbers or malformed hunk headers.
 */
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
    const docLines = document.getText().split(/\r?\n/);
    
    const diffLines = diffContent.split(/\r?\n/);
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
            } else if (line.startsWith(' ')) {
                const content = line.substring(1);
                currentHunk.searchLines.push(content);
                currentHunk.replaceLines.push(content);
            }
        }
    }
    if (currentHunk) hunks.push(currentHunk);

    if (hunks.length === 0) throw new Error('No valid diff hunks found in content.');

    let finalLines = [...docLines];
    
    for (const hunk of hunks) {
        if (hunk.searchLines.length === 0) continue; 

        const matchIndex = findHunkMatch(finalLines, hunk.searchLines);
        if (matchIndex === -1) {
            throw new Error(`Could not locate the code block to patch in '${relativePath}'. Match failed for block starting with: "${hunk.searchLines[0].substring(0, 40)}..."`);
        }

        finalLines.splice(matchIndex, hunk.searchLines.length, ...hunk.replaceLines);
    }

    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        document.lineAt(document.lineCount - 1).range.end
    );
    edit.replace(fileUri, fullRange, finalLines.join(document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'));
    
    await vscode.workspace.applyEdit(edit);
}

function findHunkMatch(docLines: string[], searchLines: string[]): number {
    if (searchLines.length === 0) return -1;
    for (let i = 0; i <= docLines.length - searchLines.length; i++) {
        let match = true;
        for (let j = 0; j < searchLines.length; j++) {
            if (docLines[i + j].trim() !== searchLines[j].trim()) {
                match = false;
                break;
            }
        }
        if (match) return i;
    }
    return -1;
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
