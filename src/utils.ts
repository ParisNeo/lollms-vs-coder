import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { MemoryManager } from './memoryManager';
import { execSync } from 'child_process';
import { PromptTemplates } from './promptTemplates';
import * as crypto from 'crypto';


/**
 * HARDEN WORKSPACE PROTOCOL
 * Programmatically forces VS Code tools (isort, pylance, search) to ignore .lollms internal data.
 * This prevents the 'isort crash' loop during rapid file operations.
 */
export async function hardenWorkspace(folder: vscode.WorkspaceFolder): Promise<void> {
    const config = vscode.workspace.getConfiguration(undefined, folder.uri);

    // 1. Files & Search Exclusion
    const filesToExclude = config.get<Record<string, boolean>>('files.exclude') || {};
    const searchToExclude = config.get<Record<string, boolean>>('search.exclude') || {};

    // Aggressively append all build, environmental, and hidden directory patterns to VS Code's indexers
    const targetExcludes = [
        '**/.lollms/**',
        '**/.git/**',
        '**/.vscode/**',
        '**/node_modules/**',
        '**/venv/**',
        '**/.venv/**',
        '**/env/**',
        '**/.env/**',
        '**/dist/**',
        '**/build/**',
        '**/bin/**',
        '**/obj/**',
        '**/target/**',
        '**/.*/**' // Blocks all hidden dot-folders/files completely
    ];

    targetExcludes.forEach(pattern => {
        filesToExclude[pattern] = true;
        searchToExclude[pattern] = true;
    });

    // 2. Python Language Server Hardening
    const pythonExclude = ['**/.lollms/**', '**/venv/**', '**/node_modules/**', '**/.*/**'];

    try {
        await Promise.all([
            config.update('files.exclude', filesToExclude, vscode.ConfigurationTarget.WorkspaceFolder),
            config.update('search.exclude', searchToExclude, vscode.ConfigurationTarget.WorkspaceFolder),
            config.update('python.analysis.exclude', pythonExclude, vscode.ConfigurationTarget.WorkspaceFolder),
            config.update('python.analysis.ignore', pythonExclude, vscode.ConfigurationTarget.WorkspaceFolder),
            // BLOCK ISORT & PYLANCE FROM CRASHING
            config.update('isort.check', false, vscode.ConfigurationTarget.WorkspaceFolder),
            config.update('isort.importStrategy', 'useBundled', vscode.ConfigurationTarget.WorkspaceFolder),
            config.update('black-formatter.importStrategy', 'useBundled', vscode.ConfigurationTarget.WorkspaceFolder),
            config.update('flake8.importStrategy', 'useBundled', vscode.ConfigurationTarget.WorkspaceFolder),
            config.update('python.analysis.indexing', false, vscode.ConfigurationTarget.WorkspaceFolder),
            // Disable 'Organize Imports' on save which causes deadlocks during AI file writes
            config.update('editor.codeActionsOnSave', { "source.organizeImports": "never" }, vscode.ConfigurationTarget.WorkspaceFolder),
            // Mute linting and indexing for internal scripts to prevent host overhead
            config.update('python.linting.ignorePatterns', ['**/.lollms/**/*.py'], vscode.ConfigurationTarget.WorkspaceFolder)
        ]);
        console.log(`[Sovereign] Workspace ${folder.name} hardened against isort/analysis crashes.`);
    } catch (e) {
        console.error("[Sovereign] Failed to apply hardening:", e);
    }
}

export function getLollmsStorageUri(context: vscode.ExtensionContext, folder?: vscode.WorkspaceFolder): vscode.Uri {
    const workspaceFile = vscode.workspace.workspaceFile;

    if (workspaceFile) {
        // --- CENTRALIZED WORKSPACE MODE ---
        // Use a hash of the .code-workspace path to create a unique, persistent folder in user home
        const wsHash = crypto.createHash('md5').update(workspaceFile.toString()).digest('hex').substring(0, 12);
        const homeDir = vscode.Uri.file(os.homedir());
        const storageUri = vscode.Uri.joinPath(homeDir, '.lollms', 'workspaces', wsHash);

        // BACKGROUND: Update metadata so we can manage this workspace later
        const infoPath = vscode.Uri.joinPath(storageUri, 'workspace_info.json');
        const info = {
            id: wsHash,
            name: path.basename(workspaceFile.fsPath, '.code-workspace'),
            originalPath: workspaceFile.fsPath,
            lastUsed: Date.now()
        };

        // Fire and forget (don't block the UI thread)
        vscode.workspace.fs.createDirectory(storageUri).then(() => {
            vscode.workspace.fs.writeFile(infoPath, Buffer.from(JSON.stringify(info, null, 2)));
        });

        return storageUri;
        }

    // --- LOCAL PROJECT MODE ---
    // Fallback to the local .lollms folder of the requested or first folder
    const targetFolder = folder || (vscode.workspace.workspaceFolders?.[0]);
    if (targetFolder) {
        return vscode.Uri.joinPath(targetFolder.uri, '.lollms');
    }

    // --- GLOBAL FALLBACK ---
    return context.globalStorageUri;
}

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
export { 
    ResponseProfile, 
    SYSTEM_RESPONSE_PROFILES, 
    UserPreferenceProfile, 
    DEFAULT_USER_PREFERENCE_PROFILES, 
    getUserPreferenceProfiles, 
    saveUserPreferenceProfile 
} from './registries/profiles';

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

    includeGitInfo?: boolean;
    agentMode: boolean;
    dynamicMode?: boolean; // Added for live in-chat multi-turn tools loop
    debugMode: boolean;
    verifierMode: boolean;
    testMode: boolean;
    documentationMode: boolean;
    gitAutoWorkflow: boolean;
    maxDebugSteps: number;
    toolPolicies?: Record<string, 'disabled' | 'manual' | 'autonomous'>;
    selectedFolders?: string[];
    contextAggression: 'respect' | 'none' | 'minimal' | 'signatures';
    tokenEconomyMode: boolean;
    projectMemoryEnabled: boolean;
    enableTemperature?: boolean; // Added to enable/disable temperature control override
    temperature?: number; // Optional temperature value
    enableMaxTokens?: boolean; // Added to enable/disable maximum generation tokens override
    maxTokens?: number; // Optional maximum tokens to generate
    ttftTimeout: number;
    interTokenTimeout: number;
    contextGovernorThreshold: number; // Trigger threshold percentage (0-100)
    contextGovernorTargetThreshold?: number; // Objective threshold percentage to reach (0-100)
    contextGovernorMaxRounds?: number; // Maximum negotiation rounds (default 5)
    contextGovernorEnabled?: boolean; // New key
    contextGovernorPermanentPruning?: boolean; // New key
    enableSymbolMode?: boolean; // New key
    userPreferences?: string; // Custom user preferences and coding guidelines injected into system prompt
    userPreferenceProfileId?: string; // Selected user preference profile ID
    isExport?: boolean; // True when exporting context & prompt for external clipboard use
    guiState?: {
        agentBadge: boolean;
        dynamicBadge?: boolean;
        herdBadge: boolean;
        webSearchBadge?: boolean;
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

export function sanitizeAiderMarkers(text: string): string {
    if (!text) return '';
    return text
        .split('\n')
        .filter(line => {
            const trimmed = line.trim();
            if (/^<{7}\s*SEARCH$/.test(trimmed)) return false;
            if (/^={5,}$/.test(trimmed)) return false;
            if (/^>{7}\s*REPLACE$/.test(trimmed)) return false;
            return true;
        })
        .join('\n');
}

/**
 * Normalizes Aider Search/Replace block content.
 * Handles:
 * 1. Standard Aider: <<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE
 * 2. Indented Aider markers: "  <<<<<<< SEARCH" -> "<<<<<<< SEARCH"
 * 3. AI emitting ONLY the "=======" separator without outer <<<<<<< SEARCH and >>>>>>> REPLACE markers.
 */
export function normalizeAiderContent(rawBlock: string): string {
    if (!rawBlock || typeof rawBlock !== 'string') return '';

    let text = rawBlock.replace(/\r\n/g, '\n');

    // 1. If it already has <<<<<<< SEARCH and >>>>>>> REPLACE, normalize markers to line start
    if (text.includes('<<<<<<< SEARCH') && text.includes('>>>>>>> REPLACE')) {
        return text.replace(/^[ \t]*(<<<<<<< SEARCH|={5,}|>>>>>>> REPLACE)[ \t]*/gm, (match, marker) => {
            if (marker.startsWith('<')) return '<<<<<<< SEARCH';
            if (marker.startsWith('=')) return '=======';
            if (marker.startsWith('>')) return '>>>>>>> REPLACE';
            return match;
        });
    }

    // 2. If it has <<<<<<< SEARCH and ======= but missing closing >>>>>>> REPLACE
    if (text.includes('<<<<<<< SEARCH') && text.includes('=======')) {
        let normalized = text.replace(/^[ \t]*(<<<<<<< SEARCH|={5,})[ \t]*/gm, (match, marker) => {
            if (marker.startsWith('<')) return '<<<<<<< SEARCH';
            if (marker.startsWith('=')) return '=======';
            return match;
        });
        if (!normalized.includes('>>>>>>> REPLACE')) {
            normalized = normalized.trimEnd() + '\n>>>>>>> REPLACE';
        }
        return normalized;
    }

    // 3. If the AI emitted ONLY the ======= separator without outer markers
    const separatorRegex = /^[ \t]*={5,}[ \t]*$/m;
    if (separatorRegex.test(text)) {
        const cleanText = text.replace(/^[ \t]*>{7}\s*REPLACE[ \t]*$/gm, '').replace(/^[ \t]*<{7}\s*SEARCH[ \t]*$/gm, '');
        const parts = cleanText.split(separatorRegex);
        if (parts.length === 2) {
            const searchPart = parts[0];
            const replacePart = parts[1];
            return `<<<<<<< SEARCH\n${searchPart.trimEnd()}\n=======\n${replacePart.trimStart()}\n>>>>>>> REPLACE`;
        } else if (parts.length > 2) {
            let result = '';
            for (let i = 0; i < parts.length - 1; i += 2) {
                const s = parts[i];
                const r = parts[i + 1] || '';
                result += `<<<<<<< SEARCH\n${s.trimEnd()}\n=======\n${r.trimStart()}\n>>>>>>> REPLACE\n\n`;
            }
            return result.trim();
        }
    }

    return text;
}

/**
 * Applies a Search/Replace (Aider-style) block to content.
 * Includes indentation detection and automatic correction.
 */
export function applySearchReplace(content: string, searchBlock: string, replaceBlock: string): { success: boolean, result: string, error?: string } {
    const isCrlf = content.includes('\r\n');
    const normalizedContent = content.replace(/\r\n/g, '\n');

    let normalizedSearch = sanitizeAiderMarkers((searchBlock || "").replace(/\r\n/g, '\n'));
    let normalizedReplace = sanitizeAiderMarkers((replaceBlock || "").replace(/\r\n/g, '\n'));

    // 1. Handle Empty Search (Prepend/Append logic)
    if (normalizedSearch.trim() === "") {
        const result = normalizedContent.endsWith('\n') ? normalizedContent + normalizedReplace : normalizedContent + '\n' + normalizedReplace;
        return { success: true, result: isCrlf ? result.replace(/\n/g, '\r\n') : result };
    }

    const contentLines = normalizedContent.split('\n');
    const searchLines = normalizedSearch.split('\n');
    const replaceLines = normalizedReplace === "" ? [] : normalizedReplace.split('\n');

    
    // 2. Find Match using an optimized and bounds-safe sliding window
    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
        let match = true;

        for (let j = 0; j < searchLines.length; j++) {
            const cLine = contentLines[i + j];
            const sLine = searchLines[j];

            if (cLine === undefined || sLine === undefined) {
                match = false;
                break;
            }

            const cTrim = cLine.trim();
            const sTrim = sLine.trim();

            // Direct comparison or soft white-space check
            if (cTrim !== sTrim && !(cTrim === "" && sTrim === "")) {
                match = false;
                break;
            }
        }

        if (match) {
            // Find first non-empty line inside the match window to evaluate indentation delta
            let matchedFileIndent = "";
            let matchedAiIndent = "";
            for (let j = 0; j < searchLines.length; j++) {
                if (searchLines[j].trim().length > 0) {
                    matchedFileIndent = contentLines[i + j].match(/^\s*/)?.[0] || "";
                    matchedAiIndent = searchLines[j].match(/^\s*/)?.[0] || "";
                    break;
                }
            }

            const indentDelta = matchedFileIndent.length - matchedAiIndent.length;

            const adjustedReplace = replaceLines.map(line => {
                if (line.trim().length === 0) return "";
                const currentLineIndent = line.match(/^\s*/)?.[0] || "";
                const newIndentLength = Math.max(0, currentLineIndent.length + indentDelta);
                return " ".repeat(newIndentLength) + line.trimStart();
            });

            const before = contentLines.slice(0, i);
            const after = contentLines.slice(i + searchLines.length);
            const finalResult = normalizedReplace === ""
                ? [...before, ...after].join('\n')
                : [...before, ...adjustedReplace, ...after].join('\n');
            
            return { 
                success: true, 
                result: isCrlf ? finalResult.replace(/\n/g, '\r\n') : finalResult 
            };
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

/**
 * Generates a standardized Environment Awareness block for all agent prompts.
 */
export async function getEnvironmentAwarenessBlock(isExport: boolean = false): Promise<string> {
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    const userName = config.get<string>('userInfo.name') || os.userInfo().username || 'Developer';
    const shells = await getAvailableShells();

    const toolRule = isExport
        ? `- **Sovereign Rule**: This is a MULTILINGUAL environment. Verify the availability of tools or provide cross-platform solutions.`
        : `- **Sovereign Rule**: This is a MULTILINGUAL environment. DO NOT assume Python, Node.js, or any compiler is installed. You MUST use 'get_environment_details' or 'execute_command' to verify the availability of tools before proposing scripts.`;

    return `
    ### 💻 ENVIRONMENT AWARENESS
    - **User**: ${userName}
    - **Operating System**: ${os.platform()} (${os.type()} ${os.release()})
    - **Primary Shell**: ${os.platform() === 'win32' ? 'cmd / powershell' : 'bash / zsh'}
    - **Available Shells**: ${shells.join(', ')}
    ${toolRule}
    - **Current Date**: ${new Date().toLocaleDateString()}
    - **Current Time**: ${new Date().toLocaleTimeString()}
    - **Timezone**: ${Intl.DateTimeFormat().resolvedOptions().timeZone}
    - **Workspace Root**: The execution context is the WORKSPACE ROOT. Use relative paths.
    `.trim();
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
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');

    if (promptType === 'commit') {
        const finalPersona = config.get<string>('commitMessagePersona') || "You are an expert AI assistant that writes conventional git commit messages.";
        return PromptTemplates.build('commit', finalPersona, "", [], undefined, false, undefined);
    }

    const memory = memoryManager ? await memoryManager.getMemory() : "";
    let finalPersona = customPersonaContent || "";

    if (!finalPersona) {
        const key = promptType === 'chat' ? 'chatPersona' :
                    promptType === 'agent' ? 'agentPersona' :
                    promptType === 'inspector' ? 'codeInspectorPersona' : 'commitMessagePersona';
        finalPersona = config.get<string>(key) || "You are an expert software engineer.";
    }

    if (workingMemory) {
        finalPersona = `### 🧠 LIBRARIAN'S CONTEXT ANALYSIS\n${workingMemory}\n\n${finalPersona}`;
    }

    const isExport = (capabilities as any)?.isExport === true;
    const shells = await getAvailableShells();
    const envAwareness = await getEnvironmentAwarenessBlock(isExport);

    const fileMutationProtocol = `
### 📁 FILE MUTATION PROTOCOL (XML SPECIFICATION)
You are STRICTLY FORBIDDEN from using colon-delimited markdown backticks (like \`\`\`language:path/to/file) to edit or write files.
- Use standard markdown code fences (\`\`\`python ... \`\`\`) ONLY for explanations, illustrations, and command examples (they have no file writing authority).
- When you need to CREATE, OVERWRITE, PATCH, or MODIFY a file on disk, you MUST wrap the code in a top-level <file> XML tag starting on a brand-new line.

#### 1. FULL FILE CREATION / REWRITE:
<file path="path/to/file.ext" action="write">
[Complete file content from line 1 to the end with no placeholders]
</file>

#### 2. SURGICAL SEARCH/REPLACE (AIDER PATCH):
<file path="path/to/file.ext" action="patch">
<<<<<<< SEARCH
[Exact lines currently in the file]
=======
[New lines to replace them with]
>>>>>>> REPLACE
</file>

#### 3. TARGETED SYMBOL REPLACEMENT:
<file path="path/to/file.ext" action="update_symbol" symbol="ClassName:methodName">
[New complete implementation of this class, function, or method]
</file>

**STRICT RULES & ATTRIBUTE ENFORCEMENT**:
- **MANDATORY ATTRIBUTE NAME**: You MUST use \`path="..."\` (e.g. \`<file path="src/main.py" action="write">\`). You are STRICTLY FORBIDDEN from using \`file="..."\`, \`name="..."\`, or \`filename="..."\`.
- Always specify the relative workspace path in \`path="..."\`.
- Always specify the \`action="..."\` attribute (\`write\`, \`patch\`, or \`update_symbol\`).
- The closing </file> tag MUST be placed on its own line after the code content.
- Do NOT nest <file> tags inside markdown code fences.
`;

    // CALL THE TEMPLATE BUILDER
    const basePrompt = PromptTemplates.build(
        promptType, 
        finalPersona, 
        memory, 
        shells, 
        capabilities, 
        forceFullCode, 
        context
    ) + "\n" + fileMutationProtocol;

    // --- CONDITIONAL SPARQL DEACTIVATION ---
    let finalizedBasePrompt = basePrompt;
    if (capabilities?.sparqlEnabled === false) {
        finalizedBasePrompt = finalizedBasePrompt
            .replace(/### 🧊 SOVEREIGN DUAL-ONTOLOGY GRAPH[\s\S]*?before making decisions!/gi, "")
            .replace(/### 📊 SOVEREIGN CODE GRAPH & PATTERNS[\s\S]*?protects your attention map\./gi, "")
            .replace(/### 📊 GRAPH-BASED ARCHITECTURE AWARENESS[\s\S]*?or circular imports\./gi, "")
            .replace(/<query_architecture>[\s\S]*?<\/query_architecture>/gi, "")
            .split('\n')
            .filter(line => {
                const lower = line.toLowerCase();
                return !lower.includes('sparql') && 
                       !lower.includes('ontology') && 
                       !lower.includes('read_code_graph') && 
                       !lower.includes('query_architecture') &&
                       !lower.includes('s:class') &&
                       !lower.includes('s:file');
            })
            .join('\n');
    }

    // --- CONDITIONAL WEB SEARCH DEACTIVATION ---
    if (capabilities?.webSearch === false) {
        finalizedBasePrompt = finalizedBasePrompt
            .replace(/### 🛡️ PROACTIVE RESEARCH PROTOCOL[\s\S]*?until both the patch and the validation test suite are generated\./gi, "")
            .replace(/### 🛡️ PROACTIVE RESEARCH PROTOCOL[\s\S]*?until you have verified the API via research\./gi, "")
            .replace(/<search_web>[\s\S]*?<\/search_web>/gi, "");
    }

    // --- WORKFLOW PROFILE DIRECTIVES (THE DESTINY DECISION) ---
    let destinyDirectives = "";
    if (capabilities?.profileType === 'vibe') {
        destinyDirectives = `
### 🤠 VIBE CODING PROFILE: ACTIVE (SOFTWARE 3.0 SPONTANEITY)
- **Velocity Over Rigor**: Your primary goal is rapid, intuition-led prototyping.
- **Fluid Iteration**: You are authorized to write spontaneous code blocks. Focus on getting the visual design and "game feel" right!
- **Constraint**: Maintain clean conversational turn-economy but do not force heavy formal test-driven architectures unless explicitly requested.
`;
    } else if (capabilities?.profileType === 'agentic' || promptType === 'agent') {
        destinyDirectives = `
### 🧠 AGENTIC ENGINEERING PROFILE: ACTIVE (SOFTWARE 3.0 RIGOR)
You are operating under strict **Agentic Engineering** constraints to prevent Theresa Torres's "Doom Loop" desynchronizations and visual-only "Context Bleed" saturations.

**STRICT COMPLIANCE DIRECTIVES:**
1. **PRODUCT REQUIREMENTS DOCUMENT (PRD) LOCK**: 
   - Never write code before the architecture is locked. Every edit must trace directly to a spec inside the 'Mission Briefing' (Our locked PRD).
   - If the user asks for a feature that breaks the MVC/Database models defined in the PRD, request a PRD amendment first.
2. **YOLO MODE / TEST-DRIVEN DEVELOPMENT (TDD) ON STEROIDS**:
   - You are STRICTLY FORBIDDEN from writing function logic blindly.
   - You MUST write a strict automated test (using \`pytest\`, \`unittest\`, \`jest\`, or \`vitest\`) FIRST, run it to verify it fails, and only then write/edit the code to make it pass.
   - Iterate autonomously (YOLO Mode) in a fast run-test-fix loop until all tests are green.
3. **KASPERSKY 45% SECURITY SHIELD (CRITICAL)**:
   - Nearly half of AI-generated code contains security vulnerabilities. You must actively defend the project.
   - **No Custom Auth**: Never roll your own login or session system. Only use validated solutions (NextAuth, Clerk, Supabase Auth).
   - **Sanitize Every Input**: Treat all user-facing forms, inputs, and search bars as malicious injection boundaries. Scrub all strings.
   - **Generic Exception Handling**: Wrap code in try/except blocks. Display generic "Oops" messages to users while logging specific diagnostics internally. Prevent verbose stack dumps.
4. **THE DIFF REVIEW MANDATE**: Keep your SEARCH blocks minimal (1-5 lines) and review changes line-by-line to prevent accidental code deletion.
`;
    }

    // 🛡️ PROTOCOL GATE: Mode-Specific Operational Constraints
    const isAutonomous = !isExport && (capabilities?.agentMode === true || promptType === 'agent');
    const isBuilder = !isExport && capabilities?.workerType === 'builder';
    const isDynamic = !isExport && capabilities?.dynamicMode === true;

    let operationalMandate = "";

    if (isExport) {
        operationalMandate = `
    ### 🛡️ EXTERNAL LLM OPERATIONAL PROTOCOL (TAGS EXCLUSIVE - NO TOOLS)
    You are an external assistant. Tool calling is completely deactivated. You do NOT have access to tools or \`<lollms_tool>\`.
    You MUST EXCLUSIVELY use top-level XML tags starting on a new line to interact with the project:
    - \`<add_files_to_context>\npath/to/file.ext\n</add_files_to_context>\`: Request that a file from the project tree be loaded into your context.
    - \`<remove_files_from_context>\npath/to/file.ext\n</remove_files_from_context>\`: Eject files from context.
    - \`<delete_files>\npath/to/file.ext\n</delete_files>\`: Delete files.
    `;
    } else if (promptType === 'surgical_agent') {
        operationalMandate = "\n### 🚫 STRICT OPERATIONAL RULE\nYou are a single-file refactoring engine. You are FORBIDDEN from using, referencing, or outputting any JSON tool calls, XML tags, or external commands. Your only authorized action is to output the SEARCH/REPLACE block modifying the code.\n";
    } else if (isAutonomous || isBuilder) {
        operationalMandate = "\n### 🦾 OPERATIONAL AUTHORITY: ACTIVE\nYou have permission to use JSON tool calls to interact with the filesystem, terminal, and vision systems directly.\n";
    } else if (isDynamic) {
        const allTools = (context as any)?.toolManager?.getAllTools() || [];
        const isSparqlActive = capabilities?.sparqlEnabled !== false;
        const isSymbolModeActive = capabilities?.enableSymbolMode !== false;
        const isWebSearchActive = capabilities?.webSearch !== false;

const sparqlDynamicRule = isSparqlActive ? `
    ### 🧱 LIGHTWEIGHT ARCHITECTURAL EXPLORATION (MANDATORY ORDER OF OPERATIONS)
    - **SPARQL FIRST**: When asked to locate classes, verify imports, check method signatures, or find where a function is called, you **MUST** use the \`<query_architecture>\` tag to perform a fast, token-efficient SPARQL-lite query on the codebase map first.
    - **NO PREMATURE CONTEXT BLOAT**: Do **NOT** use \`<add_files_to_context>\` to search for definitions. Adding files with full contents uses your token budget. Use SPARQL queries to inspect the ontology nodes first, and only add files via \`<add_files_to_context>\` when you are 100% sure you need to edit or review their detailed inner logic.
` : "";

        const authorizedXmlTags = [
            `<add_files_to_context>\npath/to/file\n</add_files_to_context>`,
            `<remove_files_from_context>\npath/to/file\n</remove_files_from_context>`,
            `<unpack_directory>\npath/to/folder\n</unpack_directory>`,
            `<peek_files>\npath/to/file.ext\n</peek_files>`,
            isSparqlActive ? `<query_architecture>\nSELECT ?x WHERE { ?x s:type s:Class }\n</query_architecture>` : null,
            `<lollms_tool>\n{\n  "name": "tool_name",\n  "arguments": {\n    "param1": "val1"\n  }\n}\n</lollms_tool>`
        ].filter(Boolean).map(tag => `- \`${tag}\``).join('\n    ');

        const availableToolsList = allTools.filter((t: any) => {
            if (t.name === 'execute_command' || t.name === 'edit_code') return false;
            // In non-agent mode, read_file, read_files, and peek_at_context must NEVER be accessible or shown
            if (t.name === 'read_file' || t.name === 'read_files' || t.name === 'peek_at_context') return false;
            if (!isSymbolModeActive && t.name === 'update_function') return false;
            if (!isSparqlActive && (t.name === 'query_architecture' || t.name === 'read_code_graph')) return false;
            if (!isWebSearchActive && (t.name === 'search_web' || t.name === 'search_wikipedia' || t.name === 'scrape_website')) return false;
            return true;
        }).map((t: any) => `- \`${t.name}\`: ${t.description.split('.')[0]}`).join('\n    ');

        operationalMandate = `
    ### 🧠 CO-ENGINEER DYNAMIC MODE (MULTI-TURN INTERACTIVE LOOP)
    You are operating under **Co-Engineer Mode (Dynamic Multi-Turn Loop)**.
    You have direct authority to call tools, query the architecture ontology, and load files *inside this single turn*.
${sparqlDynamicRule}
    **⚡ THE ACTION-FIRST MANDATE & STEP-BY-STEP REASONING:**
    1. **ACT IMMEDIATELY**: If you need files from the project, output \`<add_files_to_context>\` or \`<peek_files>\` starting on **LINE 1**.
    2. **COOPERATIVE STEP-BY-STEP HYDRATION (TOKEN PRESERVATION)**:
       - If you need to inspect multiple large files, do NOT load them all at once.
       - Load File A, note what you need into your thoughts/scratchpad, and use \`<remove_files_from_context>\` to mute/evict File A before loading File B.
    3. **NO INTERMEDIATE CODE PATCHING (STRICT INVARIANT)**:
       - In Co-Engineer mode, you **NEVER apply patches to disk during intermediate exploration steps** unless \`autoApply\` is explicitly active.
       - You must keep all code mutations exclusively in your **final synthesized message** after all research and inspections are complete.
    4. **EXCLUSIVE FILE DISCOVERY VIA <add_files_to_context> & <peek_files>**: To inspect files without bloating context, use \`<peek_files lines="30" from="top">path</peek_files>\`.
    5. **TOKEN BUDGET LIMIT**: If active context exceeds **85%**, prune using \`<remove_files_from_context>\` before requesting more.
    6. **USER VALIDATION IN ASSISTANT MODE**: In Assistant Mode, every action is presented to the user for step-by-step confirmation. In Co-Engineer mode, you execute inspections autonomously within the turn.

    **CORRECT BEHAVIOR FORMAT (ONLY USE REAL PATHS FROM THE MANIFEST):**
    <add_files_to_context>
    exact/path/from/project/manifest/file1.ext
    exact/path/from/project/manifest/file2.ext
    </add_files_to_context>

    **🛑 ZERO CONTEXT WASTE MANDATE (NO REDUNDANT REQUESTS):**
    - Inspect 'ACTIVE CONTEXT INVENTORY' and files marked '[C]'. If a file is ALREADY loaded, calling <add_files_to_context> for it is FORBIDDEN.
    - Only request files that are visible in the manifest WITHOUT a [C] marker.
    - DO NOT hallucinate paths: concatenate the 4-space nested directory scopes and filename directly.

    **AUTHORIZED TOOLS (OUTPUT XML TAGS VERBATIM):**
    ${authorizedXmlTags}

    *Available Tools for the <lollms_tool> JSON name parameter:*
    ${availableToolsList}
    `;
    } else {
        // --- DISCUSSION MODE: SCOPE-AWARE FILTERING ---
        const allTools = (context as any)?.toolManager?.getEnabledTools() || [];
        const isMemoryActive = capabilities?.projectMemoryEnabled !== false;
        const isVisionActive = capabilities?.enableImages !== false;

        const HUD_SAFE_LIST = [
            isVisionActive ? 'generate_image' : null,
            isVisionActive ? 'edit_image_asset' : null,
            'add_files_to_context',
            'record_milestone',
            'record_discovery'
        ].filter(Boolean);

        const activeTools = allTools.filter((t: any) => HUD_SAFE_LIST.includes(t.name));

        const authorizedTags = [
            `- \`<add_files_to_context>\`: Add files from project workspace.`,
            isMemoryActive ? `- \`<project_memory>\`: Save an architectural fact or coding standard.` : null,
            `- \`<lollms_tool name="tool_name" params='{...}' />\`: Request execution of other specialized tools.`
        ].filter(Boolean).join('\n    ');

        operationalMandate = `
    ### 🛡️ DISCUSSION MODE: ACTIONS
    You are currently in 'Discussion Mode'. You cannot execute code or shell commands autonomously.
    You can request user execution of certain tools by using XML tags on a new line:
    ${authorizedTags}

    **AUTHORIZED TAGS:**
    ${activeTools.map((t: any) => `- **${t.name}**: \`<lollms_tool name="${t.name}" params='{...}' />\``).join('\n    ')}
    `;
    }

    return finalizedBasePrompt + destinyDirectives + "\n" + operationalMandate + "\n" + envAwareness;
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
    'gemma': 128000, // Explicitly add gemma to prevent safe fallback to lower values
    'gpt-4o': 128000,
    'gpt-4o-mini': 128000,
    'gpt-4-turbo': 128000,
    'gpt-3.5-turbo': 128000,
    'claude-3-7': 200000,
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
    'lollms': 200000, // Modern large-context standard
    'phi3': 128000,
    'command-r': 128000,
    'kimi': 128000,
    'moonshot': 128000
    };

/**
 * Heuristic to detect context size based on model ID string.
 */
export function getContextLimitForModel(modelName: string): number {
    const lower = modelName.toLowerCase();

    // Iterate through known limits in our local map
    for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
        if (lower.includes(key)) return limit;
    }

    // Default fallback for unknown cloud model families
    if (lower.startsWith('gpt-')) return 128000;
    if (lower.startsWith('claude-')) return 200000;
    if (lower.startsWith('gemini-')) return 1000000;

    return 128000; // General safe default
}

/**
 * Estimates the token cost of an image based on model-specific vision protocols.
 * Heuristic based on April 2026 provider documentation.
 */
export function isModelVisionCapable(modelName: string, config?: vscode.WorkspaceConfiguration): boolean {
    if (!modelName) return false;
    const model = modelName.toLowerCase().trim();
    const cfg = config || vscode.workspace.getConfiguration('lollmsVsCoder');

    // 1. Explicit Vision keywords & architectures - always allow
    const visionKeywords = [
        'vision', '-vl', '_vl', '-v', '_v', '4v', '5v', 'visual', 'multimodal', 
        'llava', 'bakllava', 'minicpm', 'mplug', 'internvl', 'cogvlm', 'pixtral',
        'gpt-4o', 'gpt-4-turbo', 'gpt-4-vision', 'claude-3', 'gemini', 'omni'
    ];
    if (visionKeywords.some(k => model.includes(k))) {
        return true;
    }

    // 2. Check user-configured non-vision model list
    const nonVisionPatterns: string[] = cfg.get<string[]>('nonVisionModels') || [
        'deepseek-chat', 'deepseek-v', 'codellama', 'mistral-nemo', 'qwen-coder', 'command-r', 'llama-3-8b', 'llama-3-70b'
    ];
    for (const pattern of nonVisionPatterns) {
        if (pattern && model.includes(pattern.toLowerCase().trim())) {
            return false;
        }
    }

    // 3. Fallback to token estimation heuristic
    return estimateImageTokens(modelName) > 0;
}

export function estimateImageTokens(modelName: string, width?: number, height?: number): number {
    if (!modelName) return 0;
    const model = modelName.toLowerCase();

    // Fallback dimensions if not provided (standard HD)
    const w = width || 1024;
    const h = height || 1024;

    // 1. OpenAI GPT-4o / GPT-4 Vision
    // Formula: 85 base + (tiles of 512x512 * 170)
    if (model.includes('gpt-4o') || model.includes('gpt-4-vision')) {
        const tilesX = Math.ceil(w / 512);
        const tilesY = Math.ceil(h / 512);
        return (tilesX * tilesY * 170) + 85;
    }

    // 2. Anthropic Claude 3 / 3.5 / 3.7
    // Formula: (width * height) / 750
    if (model.includes('claude-3')) {
        return Math.ceil((w * h) / 750);
    }

    // 3. Google Gemini 1.5 / 2.0
    // Fixed base for standard images
    if (model.includes('gemini')) {
        return 258; 
    }

    // Local Models (Ollama / Llava / Llama-Vision)
    // Most use a fixed CLIP/SigLIP vit-h-14 encoder or similar
    if (model.includes('llava') || model.includes('vision') || model.includes('minicpm')) {
        return 620; // Safe average for local vision encoders
    }

    // --- MULTIMODAL DETECTION ---
    // Keywords indicating vision capability in local/open-source models
    const visionKeywords = ['vision', '-vl', 'multimodal', 'llava', 'minicpm', 'mplug'];
    const isExplicitVision = visionKeywords.some(k => model.includes(k));

    // Known multimodal-first families
    if (model.includes('gpt-4') || model.includes('claude-3') || model.includes('gemini')) {
        return 800; // Default if specific tile math above didn't catch it
    }

    // --- NON-VISUAL MODEL GUARD ---
    // Narrower list of strictly text-only specialized models
    const strictlyTextPatterns = ['codellama', 'qwen-coder', 'deepseek-v', 'mistral-nemo', 'phi-3-mini'];
    if (strictlyTextPatterns.some(p => model.includes(p)) && !isExplicitVision) {
        return 0;
    }

    // If it's a family like Gemma or Llama 3.2 which is hybrid, 
    // only charge if name contains a vision indicator.
    const hybridFamilies = ['gemma', 'llama-3.2', 'qwen', 'phi-3.5'];
    if (hybridFamilies.some(f => model.includes(f)) && !isExplicitVision) {
        return 0;
    }

    // Default safe fallback for unidentified multimodal models (1 tile)
    return 600;
    }

export function stripThinkingTags(responseText: string): string {
    if (typeof responseText !== 'string') return '';

    // Fence-aware thinking tag stripper:
    // Only strip tags if they are NOT inside a backtick code fence.
    const fenceRegex = /(`{1,3})[\s\S]*?\1/g;
    const matches: {start: number, end: number}[] = [];
    let m;
    while ((m = fenceRegex.exec(responseText)) !== null) {
        matches.push({ start: m.index, end: m.index + m[0].length });
    }

    let working = responseText;

    // --- HEURISTIC: DANGLING CLOSURE STRIPPER ---
    const closeTags = ['</think>', '</thinking>', '</analysis>', '</reasoning>'];
    for (const closeTag of closeTags) {
        const closeIdx = working.indexOf(closeTag);
        if (closeIdx !== -1) {
            const isProtected = matches.some(range => closeIdx >= range.start && closeIdx < range.end);
            if (!isProtected) {
                const beforeClose = working.substring(0, closeIdx);
                const openTag = closeTag.replace('/', '');
                if (!beforeClose.includes(openTag)) {
                    working = working.substring(closeIdx + closeTag.length);
                    break;
                }
            }
        }
    }

    // --- 🛡️ UNCLOSED THINKING SAFEGUARD ---
    // If a thinking tag is opened but NEVER closed, and there are backtick code blocks
    // further down in the text, we must NOT let the regex eat the entire remaining response!
    // Instead, we truncate the match right before the first code fence.
    const openTags = ['<think>', '<thinking>', '<analysis>', '<reasoning>'];
    for (const openTag of openTags) {
        const openIdx = working.indexOf(openTag);
        if (openIdx !== -1) {
            const closeTag = openTag.replace('<', '</');
            const closeIdx = working.indexOf(closeTag, openIdx);
            
            if (closeIdx === -1) {
                // Unclosed thinking block detected. Check if there are code fences downstream.
                const nextCodeFence = working.indexOf('```', openIdx);
                if (nextCodeFence !== -1) {
                    // Truncate the thinking block right before the code fence starts.
                    const thinkingContent = working.substring(openIdx + openTag.length, nextCodeFence);
                    const before = working.substring(0, openIdx);
                    const after = working.substring(nextCodeFence);
                    working = before + after;
                }
            }
        }
    }

    const thinkRegex = /<(think|thinking|analysis|reasoning)>([\s\S]*?)<\/\1>/gi;
    return working.replace(thinkRegex, (match, tag, inner, offset) => {
        const isProtected = matches.some(range => offset >= range.start && offset < range.end);
        return isProtected ? match : "";
    }).trim();
}

/**
 * Detects if a specific index in a string falls within any of the provided ranges.
 */
export function isIndexInRange(index: number, ranges: { start: number, end: number }[]): boolean {
    return ranges.some(r => index >= r.start && index < r.end);
}

export interface AiderHunk {
    fullMatch: string;
    searchPart: string;
    replacePart: string;
    startIndex: number;
    endIndex: number;
}

/**
 * Balanced Aider hunk parser that tracks nested <<<<<<< SEARCH / >>>>>>> REPLACE markers.
 */
export function parseAiderHunks(rawBlock: string): AiderHunk[] {
    const hunks: AiderHunk[] = [];
    if (!rawBlock || typeof rawBlock !== 'string') return hunks;

    const lines = rawBlock.replace(/\r\n/g, '\n').split('\n');
    let i = 0;

    const isSearchMarker = (l: string) => /^<{7}\s*search\b/i.test(l.trim());
    const isReplaceMarker = (l: string) => /^>{7}\s*replace\b/i.test(l.trim());
    const isSeparatorMarker = (l: string) => /^={5,}$/.test(l.trim());

    while (i < lines.length) {
        const line = lines[i];
        if (isSearchMarker(line)) {
            const startLineIdx = i;
            const searchLines: string[] = [];
            const replaceLines: string[] = [];
            let inReplace = false;
            let depth = 1;
            let isClosed = false;

            i++;
            while (i < lines.length) {
                const curLine = lines[i];
                const trimmed = curLine.trim();

                if (!inReplace) {
                    if (isSearchMarker(curLine)) {
                        depth++;
                        searchLines.push(curLine);
                    } else if (isReplaceMarker(curLine)) {
                        if (depth > 1) {
                            depth--;
                            searchLines.push(curLine);
                        } else {
                            isClosed = true;
                            break;
                        }
                    } else if (isSeparatorMarker(curLine) && depth === 1) {
                        inReplace = true;
                        depth = 0;
                    } else {
                        searchLines.push(curLine);
                    }
                } else {
                    if (isSearchMarker(curLine)) {
                        if (depth === 0) {
                            isClosed = true;
                            i--;
                            break;
                        } else {
                            depth++;
                            replaceLines.push(curLine);
                        }
                    } else if (isReplaceMarker(curLine)) {
                        if (depth > 0) {
                            depth--;
                            replaceLines.push(curLine);
                        } else {
                            isClosed = true;
                            break;
                        }
                    } else if (isSeparatorMarker(curLine) && depth === 0) {
                        // Skip duplicate separator line to avoid leaking ======= into replace output
                        i++;
                        continue;
                    } else {
                        replaceLines.push(curLine);
                    }
                }
                i++;
            }

            if (isClosed || inReplace) {
                const searchPart = sanitizeAiderMarkers(searchLines.join('\n'));
                const replacePart = sanitizeAiderMarkers(replaceLines.join('\n'));
                const fullMatch = lines.slice(startLineIdx, i + 1).join('\n');
                hunks.push({
                    fullMatch,
                    searchPart,
                    replacePart,
                    startIndex: startLineIdx,
                    endIndex: i
                });
            }
        }
        i++;
    }

    return hunks;
}

export function extractAndStripMemory(responseText: string): { content: string, memory: string | null } {
    const match = responseText.match(/<memory>([\s\S]*?)<\/memory>/);
    return match ? { content: responseText.replace(match[0], '').trim(), memory: match[1].trim() } : { content: responseText, memory: null };
}

export interface ExtractedFileBlock {
    attrStr: string;
    rawContent: string;
    fullMatch: string;
    start: number;
    end: number;
    isClosed: boolean;
}

export interface ExtractedFileBlock {
    attrStr: string;
    rawContent: string;
    fullMatch: string;
    start: number;
    end: number;
    isClosed: boolean;
}

export interface FileTagAttributes {
    path: string;
    action: 'write' | 'patch' | 'update_symbol';
    symbol?: string;
}

/**
 * Robustly parses attributes from <file ...> tags.
 * Tolerates edge cases where LLMs hallucinate attribute names like file="...",
 * filepath="...", target="...", name="...", unquoted values, or missing actions.
 */
export function parseFileTagAttributes(attrStr: string, rawContent?: string): FileTagAttributes | null {
    if (!attrStr && !rawContent) return null;
    const cleanAttr = (attrStr || "").trim();

    // 1. Extract path using common synonyms (path, file_path, filepath, file, target, name, filename)
    // Supports double quotes, single quotes, or unquoted values
    const pathRegex = /(?:^|\s+)(?:path|file_path|filepath|file|target|name|filename)\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/i;
    const pathMatch = cleanAttr.match(pathRegex);
    let filePath = pathMatch ? (pathMatch[1] || pathMatch[2] || "").trim() : "";

    // Fallback: Check if attribute string starts with an unkeyed path e.g. <file "main.py"> or <file main.py>
    if (!filePath) {
        const unkeyedMatch = cleanAttr.match(/^(?:["']([^"']+)["']|([^\s=>"']+\.[a-zA-Z0-9_\-]+))/);
        if (unkeyedMatch) {
            filePath = (unkeyedMatch[1] || unkeyedMatch[2] || "").trim();
        }
    }

    if (!filePath) return null;

    // Clean any leading/trailing quotes
    filePath = filePath.replace(/^['"]|['"]$/g, '').trim();

    // 2. Extract action with synonyms (action, type, mode)
    const actionRegex = /(?:^|\s+)(?:action|type|mode)\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/i;
    const actionMatch = cleanAttr.match(actionRegex);
    const actionRaw = actionMatch ? (actionMatch[1] || actionMatch[2] || "").toLowerCase().trim() : "";

    // 3. Extract symbol with synonyms (symbol, function, method, class)
    const symbolRegex = /(?:^|\s+)(?:symbol|function|method|class)\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/i;
    const symbolMatch = cleanAttr.match(symbolRegex);
    let symbol = symbolMatch ? (symbolMatch[1] || symbolMatch[2] || "").trim() : "";

    // Handle embedded symbol in path (e.g. path="src/main.ts:myMethod")
    if (!symbol && filePath.includes(':') && !/^[a-zA-Z]:[\\/]/.test(filePath)) {
        const parts = filePath.split(':');
        filePath = parts[0].trim();
        symbol = parts.slice(1).join(':').trim();
    }

    let action: 'write' | 'patch' | 'update_symbol' = 'write';
    if (actionRaw === 'patch' || (rawContent && rawContent.includes('<<<<<<< SEARCH'))) {
        action = 'patch';
    } else if (actionRaw === 'update_symbol' || (symbol && actionRaw !== 'write')) {
        action = 'update_symbol';
    } else if (actionRaw === 'write' || actionRaw === 'create' || actionRaw === 'overwrite' || actionRaw === 'new') {
        action = 'write';
    }

    return { path: filePath, action, symbol: symbol || undefined };
}

/**
 * Depth-aware extractor for <file> mutation blocks.
 * Correctly handles nested <file>...</file> tags inside code strings or templates.
 */
export function extractFileBlocks(text: string): ExtractedFileBlock[] {
    const blocks: ExtractedFileBlock[] = [];
    if (!text || typeof text !== 'string') return blocks;

    const openTagRegex = /^[ \t]*<file\s+([^>]*?)>/gim;
    let match: RegExpExecArray | null;

    while ((match = openTagRegex.exec(text)) !== null) {
        let start = match.index;
        const attrStr = match[1] || "";
        const bodyStart = match.index + match[0].length;

        let depth = 1;
        let isClosed = false;
        let end = text.length;
        let bodyEnd = text.length;

        const tagFinder = /<file\b([^>]*?)>|<\/file>/gi;
        tagFinder.lastIndex = bodyStart;

        let innerMatch: RegExpExecArray | null;
        while ((innerMatch = tagFinder.exec(text)) !== null) {
            const tag = innerMatch[0];
            if (tag.toLowerCase() === '</file>') {
                depth--;
                if (depth === 0) {
                    isClosed = true;
                    bodyEnd = innerMatch.index;
                    end = innerMatch.index + tag.length;
                    break;
                }
            } else {
                const innerAttr = innerMatch[1] || "";
                if (!innerAttr.trim().endsWith('/')) {
                    depth++;
                }
            }
        }

        // Check if <file> was wrapped inside outer markdown fences (```python ... ```)
        const textBefore = text.substring(0, start);
        const fenceBeforeMatch = textBefore.match(/(?:^|\n)[ \t]*(`{3,}|~{3,})(?:[a-zA-Z0-9_\-]+)?[ \t]*\r?\n[ \t]*$/);

        let fenceLen = 0;
        let fenceChar = '';
        if (fenceBeforeMatch) {
            fenceChar = fenceBeforeMatch[1][0];
            fenceLen = fenceBeforeMatch[1].length;
            const matchOffsetInBefore = textBefore.length - fenceBeforeMatch[0].length;
            const newlineIndex = fenceBeforeMatch[0].indexOf('\n');
            start = newlineIndex !== -1 ? matchOffsetInBefore + newlineIndex + 1 : matchOffsetInBefore;
        }

        if (fenceLen > 0 && isClosed) {
            const textAfter = text.substring(end);
            const fenceAfterRegex = new RegExp(`^[ \\t]*(?:\\r?\\n)[ \\t]*${fenceChar}{${fenceLen},}[ \\t]*(?=\\r?\\n|$)`);
            const fenceAfterMatch = textAfter.match(fenceAfterRegex);
            if (fenceAfterMatch) {
                end += fenceAfterMatch[0].length;
            }
        }

        let rawContent = text.substring(bodyStart, bodyEnd);
        if (/^```(?:\w+)?\r?\n([\s\S]*?)\r?\n```$/s.test(rawContent.trim())) {
            rawContent = rawContent.trim().replace(/^```(?:\w+)?\r?\n([\s\S]*?)\r?\n```$/s, '$1');
        }

        const fullMatch = text.substring(start, end);

        blocks.push({
            attrStr,
            rawContent,
            fullMatch,
            start,
            end,
            isClosed
        });

        openTagRegex.lastIndex = end;
    }

    return blocks;
}
