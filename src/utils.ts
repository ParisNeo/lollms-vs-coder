

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { MemoryManager } from './memoryManager';
import { execSync } from 'child_process';

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
    codeGenType: 'full' | 'diff' | 'none';
    allowedFormats: {
        fullFile: boolean;
        insert: boolean;
        replace: boolean;
        delete: boolean;
    };
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
 * Parses and applies a unified diff patch to a file using context matching.
 * Robust against LLMs providing incorrect line numbers or malformed hunk headers.
 */
export async function applyDiff(diffContent: string) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) throw new Error('No workspace folder open.');
    const workspaceRoot = workspaceFolders[0].uri;

    // 1. Extract file path from header (--- a/path or +++ b/path)
    const fileMatch = diffContent.match(/^(?:--- a\/|\+\+\+ b\/|---\s|\+\+\+\s)(.*)$/m);
    if (!fileMatch) throw new Error('Invalid diff header. Could not find file path.');
    const relativePath = fileMatch[1].trim();
    const fileUri = vscode.Uri.joinPath(workspaceRoot, relativePath);

    const document = await vscode.workspace.openTextDocument(fileUri);
    const docLines = document.getText().split(/\r?\n/);
    
    // 2. Parse diff into hunks
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

    if (hunks.length === 0) throw new Error('No valid diff hunks found.');

    // 3. Apply hunks to file content in memory
    let finalLines = [...docLines];
    
    for (const hunk of hunks) {
        if (hunk.searchLines.length === 0) {
            // Addition-only hunk at the end/start? 
            // If the LLM didn't provide context for a '+', we can't safely know where to put it.
            continue; 
        }

        const matchIndex = findHunkMatch(finalLines, hunk.searchLines);
        if (matchIndex === -1) {
            throw new Error(`Could not locate the code block to patch in '${relativePath}'.\nTarget block starting with: "${hunk.searchLines[0].substring(0, 40)}..."`);
        }

        // Perform the replacement
        finalLines.splice(matchIndex, hunk.searchLines.length, ...hunk.replaceLines);
    }

    // 4. Update the document
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        document.lineAt(document.lineCount - 1).range.end
    );
    edit.replace(fileUri, fullRange, finalLines.join(document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'));
    
    const success = await vscode.workspace.applyEdit(edit);
    if (!success) throw new Error('Failed to apply edits to the VS Code editor.');
}

/**
 * Searches for a block of lines in the document lines.
 * Uses trimmed matching to be resilient to indentation changes made by the LLM.
 */
function findHunkMatch(docLines: string[], searchLines: string[]): number {
    if (searchLines.length === 0) return -1;

    for (let i = 0; i <= docLines.length - searchLines.length; i++) {
        let match = true;
        for (let j = 0; j < searchLines.length; j++) {
            // Trim both to ignore indentation drift, which is common in LLM diffs
            if (docLines[i + j].trim() !== searchLines[j].trim()) {
                match = false;
                break;
            }
        }
        if (match) return i;
    }
    return -1;
}

function getIpAddresses(): string {
    const interfaces = os.networkInterfaces();
    const addresses: string[] = [];
    for (const k in interfaces) {
        for (const k2 in interfaces[k]!) {
            const address = interfaces[k]![k2];
            if (address.family === 'IPv4' && !address.internal) {
                addresses.push(`${k}: ${address.address}`);
            }
        }
    }
    return addresses.join(', ') || 'None found';
}

function getAvailableShells(): string {
    const shells: string[] = [];
    const isWin = process.platform === 'win32';
    if (isWin) {
        shells.push('powershell', 'cmd');
        try { execSync('where bash', { stdio: 'ignore' }); shells.push('bash'); } catch {}
    } else {
        const common = ['/bin/bash', '/bin/zsh', '/bin/sh'];
        common.forEach(s => { if (require('fs').existsSync(s)) shells.push(s); });
    }
    return shells.join(', ') || 'Unknown';
}

export async function getProcessedSystemPrompt(
    promptType: 'chat' | 'agent' | 'inspector' | 'commit', 
    capabilities?: DiscussionCapabilities,
    customPersonaContent?: string,
    memoryManager?: MemoryManager
): Promise<string> {
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    const thinkingMode = capabilities?.thinkingMode || config.get<string>('thinkingMode') || 'none';
    const outputFormat = config.get<string>('outputFormat') || 'legacy';
    
    const userName = config.get<string>('userInfo.name') || 'Developer';
    const userEmail = config.get<string>('userInfo.email') || '';
    const userLicense = config.get<string>('userInfo.license') || 'MIT';
    const userStyle = config.get<string>('userInfo.codingStyle') || '';

    let memoryContent = memoryManager ? await memoryManager.getMemory() : "";
    let thinkingInstructions = '';

    if (thinkingMode !== 'none' && thinkingMode !== 'no_think') {
        const thinkingStrategies: Record<string, string> = {
            'chain_of_thought': 'Break down requirements into logical steps.',
            'chain_of_verification': 'Verify assumptions against provided file content.',
            'plan_and_solve': 'Construct a plan, then execute it.',
            'self_critique': 'Critique your logic for security and efficiency before responding.',
            'custom': config.get<string>('thinkingModeCustomPrompt') || ''
        };
        thinkingInstructions = `<reasoning_protocol>\nUse <thinking> tags for reasoning. Strategy: ${thinkingStrategies[thinkingMode]}\n</reasoning_protocol>\n\n`;
    }

    let personaContent = customPersonaContent || config.get<string>(
        promptType === 'chat' ? 'chatPersona' :
        promptType === 'agent' ? 'agentPersona' :
        promptType === 'inspector' ? 'codeInspectorPersona' :
        'commitMessagePersona'
    ) || "You are a Senior VSCode Engineering Assistant.";

    if (capabilities?.funMode) personaContent += "\n\n**FUN MODE**: Be quirky and use emojis!";

    let formatInstructions = '';
    if (promptType === 'chat' || promptType === 'agent') {
        const allowed = capabilities?.allowedFormats || config.get<any>('allowedFileFormats') || { fullFile: true };
        if (outputFormat === 'xml') {
            formatInstructions = `Use <file path="path">content</file> for file updates.`;
        } else if (outputFormat === 'aider') {
            formatInstructions = `Use SEARCH/REPLACE blocks for partial updates.`;
        } else {
            formatInstructions = `Use \`\`\`language:path/to/file\`\`\` for full file content.`;
        }
    }

    const basePrompt = `# Role\n${personaContent}\n\n${thinkingInstructions}# Formatting Rules\n${formatInstructions}`;

    const contextSections: string[] = [
        `### User Context\n- Name: ${userName}\n- Email: ${userEmail}\n- Coding Style: ${userStyle}\n- License: ${userLicense}`,
        `### Environment Info\n- OS: ${os.type()} ${os.release()} (${os.platform()})\n- Arch: ${os.arch()}\n- Available Shells: ${getAvailableShells()}\n- IP: ${getIpAddresses()}\n- Additional: ${config.get('systemEnv.customInfo', '')}`,
        memoryContent.trim() ? `### Long-Term Memory\n${memoryContent}` : ''
    ].filter(Boolean);

    const contextBlock = '\n\n# System Context\n\n' + contextSections.join('\n\n');
    let finalPrompt = `${basePrompt}${contextBlock}`.trim();
    
    finalPrompt = finalPrompt
        .replace(/{{date}}/g, new Date().toISOString().split('T')[0])
        .replace(/{{os}}/g, os.platform())
        .replace(/{{developer_name}}/g, userName);

    if (thinkingMode === 'no_think') finalPrompt = `/no_think\n${finalPrompt}`;
    return finalPrompt + '\n\n';
}

export function stripThinkingTags(responseText: string): string {
    return responseText.replace(/<(think|thinking|analysis)>[\s\S]*?<\/\1>/g, '').trim();
}

export function extractAndStripMemory(responseText: string): { content: string, memory: string | null } {
    const match = responseText.match(/<memory>([\s\S]*?)<\/memory>/);
    return match ? { content: responseText.replace(match[0], '').trim(), memory: match[1].trim() } : { content: responseText, memory: null };
}