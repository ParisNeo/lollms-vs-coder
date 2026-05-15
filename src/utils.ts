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

    filesToExclude['**/.lollms/**'] = true;
    searchToExclude['**/.lollms/**'] = true;

    // 2. Python Language Server Hardening
    const pythonExclude = ['**/.lollms/**', '**/venv/**', '**/node_modules/**'];

    try {
        await Promise.all([
            config.update('files.exclude', filesToExclude, vscode.ConfigurationTarget.WorkspaceFolder),
            config.update('search.exclude', searchToExclude, vscode.ConfigurationTarget.WorkspaceFolder),
            config.update('python.analysis.exclude', pythonExclude, vscode.ConfigurationTarget.WorkspaceFolder),
            config.update('python.analysis.ignore', pythonExclude, vscode.ConfigurationTarget.WorkspaceFolder),
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
        description: "Formal Observe/Think/Act breakdown.",
        systemPrompt: "### RESPONSE STYLE: STRUCTURED\n- **MANDATORY LAYOUT**: You MUST follow this three-part structure for every response:\n  1. **Observe**: Identify what is being asked or what issue was found in the context.\n  2. **Think**: Describe the technical path chosen to resolve it and why.\n  3. **Act**: Provide the actual implementation, code, or tool call.\n\n- **STRICT FORMATTING**: Use standard Markdown (bolding, lists) for these sections. Do NOT wrap these text sections in triple backticks.\n- **ACT SECTION**: The Act section MUST contain the functional XML tags (like <edit_image_asset>) or JSON tool calls. Do NOT just output text description of the action in the Act section.\n- **AUTONOMOUS ACTIONS**: If you need to use a tool or save a memory, do so at the END of your 'Act' section. Tags like <project_memory> are mandatory for persistence.",
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

    workerType: 'discussion' | 'builder';
    agentMode: boolean;
    debugMode: boolean;
    verifierMode: boolean;
    testMode: boolean;
    documentationMode: boolean;
    gitAutoWorkflow: boolean;
    maxDebugSteps: number;
    autoContextMode: boolean;
    toolPolicies?: Record<string, 'disabled' | 'manual' | 'autonomous'>;
    selectedFolders?: string[];
    folderSettings?: Record<string, { tree: boolean, content: boolean }>;
    autoSkillMode: boolean;
    autoToolMode: boolean; // For future agentic auto-selection
    contextAggression: 'respect' | 'none' | 'minimal' | 'signatures';
    tokenEconomyMode: boolean;
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
    const isCrlf = content.includes('\r\n');
    const normalizedContent = content.replace(/\r\n/g, '\n');
    
    // CRITICAL: We DO NOT trimEnd() here because trailing newlines 
    // are often used as anchors in AIDER blocks.
    let normalizedSearch = searchBlock.replace(/\r\n/g, '\n');
    let normalizedReplace = replaceBlock.replace(/\r\n/g, '\n');

    // 1. Handle Empty Search (Prepend/Append logic)
    if (normalizedSearch.trim() === "") {
        const result = normalizedContent.endsWith('\n') ? normalizedContent + normalizedReplace : normalizedContent + '\n' + normalizedReplace;
        return { success: true, result: isCrlf ? result.replace(/\n/g, '\r\n') : result };
    }

    const contentLines = normalizedContent.split('\n');
    const searchLines = normalizedSearch.split('\n');
    const replaceLines = normalizedReplace.split('\n');

    // 2. Find Match using a "Sliding Window" 
    // We iterate through every line of the file looking for the start of the block
    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
        let match = true;
        let indentDelta: string | null = null;

        for (let j = 0; j < searchLines.length; j++) {
            const cLine = contentLines[i + j];
            const sLine = searchLines[j];

            // --- IMPROVED COMPARISON ---
            // We compare trimmed versions to ignore trailing spaces/tabs
            // but we also allow for the AI to have missed an empty line 
            // if the original file has one (lenient blank line matching)
            const cTrim = cLine.trim();
            const sTrim = sLine.trim();

            if (cTrim !== sTrim) {
                // Special case: if both are empty-ish, it's a match
                if (cTrim === "" && sTrim === "") {
                    // Match
                } else {
                    match = false;
                    break;
                }
            }

            // Detect Indentation Shift (e.g., file has 4 spaces, AI provided 2)
            if (sTrim.length > 0 && indentDelta === null) {
                const cIndent = cLine.match(/^\s*/)?.[0] || "";
                const sIndent = sLine.match(/^\s*/)?.[0] || "";
                
                // We store the original file's indentation to re-apply it to the replacement
                indentDelta = cIndent; 
            }
        }

        if (match) {
            // SUCCESS: Match found. Now reconstruct the file.
            const targetIndent = indentDelta || "";
            
            // Re-apply original indentation to the replacement lines
            const adjustedReplace = replaceLines.map(line => {
                if (line.trim().length === 0) return "";
                // If AI already provided indentation, we try to preserve the relative nesting
                const aiIndent = line.match(/^\s*/)?.[0] || "";
                const searchBaseIndent = searchLines.find(l => l.trim().length > 0)?.match(/^\s*/)?.[0] || "";
                
                if (aiIndent.startsWith(searchBaseIndent)) {
                    // Re-base AI indentation onto the file's indentation
                    return targetIndent + aiIndent.substring(searchBaseIndent.length) + line.trimStart();
                }
                return targetIndent + line.trimStart();
            });

            const before = contentLines.slice(0, i);
            const after = contentLines.slice(i + searchLines.length);
            const finalResult = [...before, ...adjustedReplace, ...after].join('\n');
            
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
export async function getEnvironmentAwarenessBlock(): Promise<string> {
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    const userName = config.get<string>('userInfo.name') || os.userInfo().username || 'Developer';
    const shells = await getAvailableShells();

    return `
    ### 💻 ENVIRONMENT AWARENESS
    - **User**: ${userName}
    - **Operating System**: ${os.platform()} (${os.type()} ${os.release()})
    - **Primary Shell**: ${os.platform() === 'win32' ? 'cmd / powershell' : 'bash / zsh'}
    - **Available Shells**: ${shells.join(', ')}
    - **Sovereign Rule**: This is a MULTILINGUAL environment. DO NOT assume Python, Node.js, or any compiler is installed. You MUST use 'get_environment_details' or 'execute_command' to verify the availability of tools before proposing scripts.
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
    const envAwareness = await getEnvironmentAwarenessBlock();

    // CALL THE TEMPLATE BUILDER
    const basePrompt = PromptTemplates.build(
        promptType, 
        finalPersona, 
        memory, 
        shells, 
        capabilities, 
        forceFullCode, 
        context
    );

    // 🛡️ PROTOCOL GATE: Mode-Specific Operational Constraints
    const isAutonomous = capabilities?.agentMode === true || promptType === 'agent';
    const isBuilder = capabilities?.workerType === 'builder';

    let operationalMandate = "";

    if (isAutonomous || isBuilder) {
        // Builders and Agents have full tool access
        operationalMandate = "\n### 🦾 OPERATIONAL AUTHORITY: ACTIVE\nYou have permission to use JSON tool calls to interact with the filesystem, terminal, and vision systems directly.\n";
    } else {
        // Discussion mode is strictly Tag-Based
        operationalMandate = `
    ### 🛡️ DISCUSSION MODE: USER-VALIDATED TOOLS
    You are currently in 'Discussion Mode'. While you cannot execute code autonomously, you can request that the user performs actions for you.

    **HOW TO REQUEST ACTIONS:**
    You have a set of equipped tools. To use one, output its specific XML tag. The user will see an 'Execute' button and must manually approve the run.

    ### 🛠️ EQUIPPED TOOL TAGS (YOUR CAPABILITIES)
    ${(context as any).toolManager?.getEnabledTools().map((t: any) => `- **${t.name}**: ${t.description}\n  Tag: \`${t.manualTagFormat || `<lollms_tool name="${t.name}" params='{...}' />`}\``).join('\n')}

    **STRICT RULES:**
    1. **ONE AT A TIME**: Do not request more than one tool per response.
    2. **JSON PARAMS**: The \`params\` attribute MUST be a single-line, valid JSON string.
    3. **WAIT FOR OUTPUT**: Once you output the tag, the UI will present an 'Execute' button to the user. Do not assume the action is finished until the user clicks it and provides the output in the next turn.

    **AUTHORIZED TAGS:**
    - \`<add_files_to_context>\`: To expand your vision.
    - \`<lollms_tool>\`: For any equipped tool (e.g. execute_command, scrape_website).
    - \`<project_memory>\`: To save technical discoveries.

    **STRICT RULE**: You are FORBIDDEN from outputting raw JSON tool calls. Use the \`<lollms_tool />\` tag format only.
    `;
    }

    // SANITIZATION: If NOT autonomous, we do not append the tool descriptions usually 
    // added by the AgentManager.
    return basePrompt + operationalMandate + "\n" + envAwareness;
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
    // Fence-aware thinking tag stripper:
    // Only strip tags if they are NOT inside a backtick code fence.
    const fenceRegex = /(`{1,3})[\s\S]*?\1/g;
    const matches: {start: number, end: number}[] = [];
    let m;
    while ((m = fenceRegex.exec(responseText)) !== null) {
        matches.push({ start: m.index, end: m.index + m[0].length });
    }

    const thinkRegex = /<(think|thinking|analysis|reasoning)>([\s\S]*?)(?:<\/\1>|$)/gi;
    return responseText.replace(thinkRegex, (match, tag, inner, offset) => {
        // If the match is inside a code block, preserve it as literal text
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

export function extractAndStripMemory(responseText: string): { content: string, memory: string | null } {
    const match = responseText.match(/<memory>([\s\S]*?)<\/memory>/);
    return match ? { content: responseText.replace(match[0], '').trim(), memory: match[1].trim() } : { content: responseText, memory: null };
}
