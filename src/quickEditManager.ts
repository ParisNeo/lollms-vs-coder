import * as vscode from 'vscode';
import * as path from 'path';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { InlineDiffProvider } from './commands/inlineDiffProvider';
import {
    stripThinkingTags,
    extractAndStripMemory,
    ensureStrictAlternatingRoles,
    getEnvironmentAwarenessBlock,
    isModelVisionCapable
} from './utils';
import { CompanionPanel } from './commands/companionPanel';
import { ToolExecutionEnv } from './tools/tool';
import { ContextManager } from './contextManager';
import { MemoryManager } from './memoryManager';
import { CoderPromptBuilder } from './system_prompts/workerPrompt';
import { showSymbolTool } from './tools/builtins/showSymbol';

interface CompanionAction {
    index: number;
    end: number;
    rawMatch: string;
    tag: 'grep' | 'search_files' | 'show_symbol' | 'load_structure' | 'peek_files' | 'read_full_file' | 'sparql' | 'lollms_tool';
    attrStr: string;
    inner: string;
}

const CLOSE_FILE_TAG = '</' + 'file>';

export class QuickEditManager {
    private panelDisposables: vscode.Disposable[] = [];

    constructor(
        private lollmsAPI: LollmsAPI,
        private inlineDiffProvider: InlineDiffProvider,
        private contextManager: ContextManager,
        private memoryManager: MemoryManager,
        private extensionUri?: vscode.Uri,
        private discussionManager?: any
    ) {}

    public async triggerQuickEdit() {
        let activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || (activeEditor.document.uri.scheme !== 'file' && activeEditor.document.uri.scheme !== 'vscode-notebook-cell')) {
            activeEditor = vscode.window.visibleTextEditors.find(e =>
                e.document.uri.scheme === 'file' || e.document.uri.scheme === 'vscode-notebook-cell'
            );
        }
        const extUri = this.extensionUri || vscode.extensions.getExtension('parisneo.lollms-vs-coder')?.extensionUri;
        if (!extUri) {
            vscode.window.showErrorMessage("Failed to locate extension URI for Lollms Companion.");
            return;
        }

        const panel = CompanionPanel.createOrShow(extUri, "Lollms Companion");
        panel.agentManager = this.contextManager?.agentManager;
        panel.discussionManager = this.discussionManager;

        if (activeEditor) {
            panel.setActiveEditor(activeEditor);
        }

        this.panelDisposables.forEach(d => d.dispose());
        this.panelDisposables = [];

        this.panelDisposables.push(panel.onDidSubmit(async (instruction) => {
            await this.processInstruction(instruction, panel);
        }));
    }

    private sanitizeHistoryForPrompt(history: ChatMessage[], visionSupported: boolean = true): ChatMessage[] {
        return history
            .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
            .map(m => {
                if (Array.isArray(m.content)) {
                    const textParts = m.content
                        .filter((p: any) => p && p.type === 'text' && typeof p.text === 'string')
                        .map((p: any) => p.text)
                        .join('\n');
                    const cleaned = stripThinkingTags(textParts)
                        .replace(/<details\b[^>]*class=["']processing-block["'][^>]*>[\s\S]*?<\/details>/gi, '')
                        .replace(/<lollms_tool\b[^>]*>[\s\S]*?<\/lollms_tool>/gi, '')
                        .trim();

                    const validImages = visionSupported
                        ? m.content.filter((p: any) => p && p.type === 'image_url' && !p.isMuted && !p.muted && p.image_url?.url)
                        : [];

                    if (validImages.length > 0) {
                        return {
                            role: m.role,
                            content: [
                                ...(cleaned ? [{ type: 'text', text: cleaned }] : []),
                                ...validImages.map((p: any) => ({ type: 'image_url', image_url: { url: p.image_url.url } }))
                            ]
                        };
                    }
                    return { role: m.role, content: cleaned };
                }

                const raw = typeof m.content === 'string' ? m.content : String(m.content || '');
                const cleaned = stripThinkingTags(raw)
                    .replace(/<details\b[^>]*class=["']processing-block["'][^>]*>[\s\S]*?<\/details>/gi, '')
                    .replace(/<lollms_tool\b[^>]*>[\s\S]*?<\/lollms_tool>/gi, '')
                    .trim();
                return { role: m.role, content: cleaned };
            })
            .filter(m => {
                if (typeof m.content === 'string') return m.content.trim().length > 0;
                if (Array.isArray(m.content)) return m.content.length > 0;
                return false;
            });
    }

    private extractInlineActions(turnResponse: string): CompanionAction[] {
        const protectedRanges: { start: number; end: number }[] = [];
        const fileBlockRe = new RegExp('```[\\s\\S]*?(?:```|$)|<file\\b[^>]*>[\\s\\S]*?(?:' + CLOSE_FILE_TAG + '|$)', 'gi');
        let fMatch: RegExpExecArray | null;
        while ((fMatch = fileBlockRe.exec(turnResponse)) !== null) {
            protectedRanges.push({ start: fMatch.index, end: fMatch.index + fMatch[0].length });
        }

        const isProtected = (idx: number) => protectedRanges.some(r => idx >= r.start && idx < r.end);

        const patterns: { tag: CompanionAction['tag']; regex: RegExp }[] = [
            { tag: 'grep', regex: /(?:^[ \t]*|(?<=>)[ \t]*)<(?:grep|grep_search)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:grep|grep_search)>)/gim },
            { tag: 'search_files', regex: /(?:^[ \t]*|(?<=>)[ \t]*)<(?:search_files|find_files)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:search_files|find_files)>)/gim },
            { tag: 'show_symbol', regex: /(?:^[ \t]*|(?<=>)[ \t]*)<(?:show_symbol|get_symbol_code|read_symbol)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:show_symbol|get_symbol_code|read_symbol)>)/gim },
            { tag: 'load_structure', regex: /(?:^[ \t]*|(?<=>)[ \t]*)<(?:load_structure|read_definitions)\b([^>]*?)(?:\/>|>(?:([\s\S]*?)<\/(?:load_structure|read_definitions)>)?)/gim },
            { tag: 'peek_files', regex: /(?:^[ \t]*|(?<=>)[ \t]*)<peek_files\b([^>]*?)(?:\/>|>(?:([\s\S]*?)<\/peek_files>)?)/gim },
            { tag: 'read_full_file', regex: /(?:^[ \t]*|(?<=>)[ \t]*)<(?:read_full_file|read_file)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:read_full_file|read_file)>)/gim },
            { tag: 'sparql', regex: /(?:^[ \t]*|(?<=>)[ \t]*)<(?:sparql|query_architecture)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:sparql|query_architecture)>)/gim },
            { tag: 'lollms_tool', regex: /(?:^[ \t]*|(?<=>)[ \t]*)<lollms_tool\b([^>]*?)>([\s\S]*?)<\/lollms_tool>|(?:^[ \t]*|(?<=>)[ \t]*)<lollms_tool\s+([^>]*?)\s*\/>/gim }
        ];

        const actions: CompanionAction[] = [];
        for (const p of patterns) {
            p.regex.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = p.regex.exec(turnResponse)) !== null) {
                if (isProtected(m.index)) continue;
                const overlaps = actions.some(a => m!.index < a.end && (m!.index + m![0].length) > a.index);
                if (overlaps) continue;
                actions.push({
                    index: m.index,
                    end: m.index + m[0].length,
                    rawMatch: m[0],
                    tag: p.tag,
                    attrStr: m[1] || m[3] || '',
                    inner: (m[2] || '').trim()
                });
            }
        }

        actions.sort((a, b) => a.index - b.index);
        return actions;
    }

    private async executeInlineAction(
        action: CompanionAction,
        signal: AbortSignal
    ): Promise<{ title: string; output: string; success: boolean }> {
        const attrStr = action.attrStr || '';
        const inner = action.inner || '';

        if (action.tag === 'grep') {
            const pMatch = attrStr.match(/(?:pattern|query)=["']([^"']+)["']/i);
            const pattern = (pMatch ? pMatch[1] : inner.split(/[\r\n]+/)[0]).replace(/^['"]|['"]$/g, '').trim();
            const pathMatch = attrStr.match(/(?:path|include)=["']([^"']+)["']/i);
            const subPath = pathMatch ? pathMatch[1].trim() : undefined;

            if (!pattern) {
                return { title: 'Grep Search', output: 'Error: No query or pattern specified.', success: false };
            }

            const hits = await this.contextManager.searchWorkspaceContent(
                pattern,
                { matchCase: false, wholeWord: false, include: subPath, bypassGate: true },
                signal
            );
            const output = hits.length > 0
                ? hits.slice(0, 20).map(r => `${r.path}:${r.line} - ${r.snippet}`).join('\n')
                : `No matches found for "${pattern}".`;
            return { title: `Grep: "${pattern}" (${hits.length} hits)`, output, success: true };
        }

        if (action.tag === 'search_files') {
            const qMatch = attrStr.match(/(?:pattern|query|name)=["']([^"']+)["']/i);
            const query = (qMatch ? qMatch[1] : inner.split(/[\r\n]+/)[0]).replace(/^['"]|['"]$/g, '').trim().toLowerCase();
            if (!query) {
                return { title: 'File Search', output: 'Error: No filename pattern specified.', success: false };
            }
            const allFiles = await this.contextManager.getWorkspaceFilePaths();
            const matched = allFiles.filter(f => f.toLowerCase().includes(query)).slice(0, 30);
            const output = matched.length > 0
                ? matched.join('\n')
                : `No workspace files matching "${query}".`;
            return { title: `File Search: "${query}" (${matched.length} matches)`, output, success: true };
        }

        if (action.tag === 'show_symbol') {
            const targetMatch = attrStr.match(/target=["']([^"']+)["']/i);
            const pathMatch = attrStr.match(/(?:path|file)=["']([^"']+)["']/i);
            const symMatch = attrStr.match(/(?:symbol|symbols)=["']([^"']+)["']/i);

            let filePath = pathMatch ? pathMatch[1].trim() : '';
            const symbolsList: string[] = [];

            const addSym = (s: string) => {
                const c = s.trim().replace(/^-\s*/, '').trim();
                if (c && !symbolsList.includes(c)) symbolsList.push(c);
            };

            if (targetMatch) {
                const rawT = targetMatch[1].trim();
                if (rawT.includes(':') && !/^[a-zA-Z]:[\\/]/.test(rawT)) {
                    const col = rawT.indexOf(':');
                    if (!filePath) filePath = rawT.substring(0, col).trim();
                    rawT.substring(col + 1).split(/[\r\n,;]+/).forEach(addSym);
                } else if (!filePath) {
                    filePath = rawT;
                }
            }
            if (symMatch) {
                symMatch[1].split(/[\r\n,;]+/).forEach(addSym);
            }
            if (inner) {
                inner.split(/[\r\n,;]+/).forEach(s => {
                    if (!filePath && s.includes(':') && !/^[a-zA-Z]:[\\/]/.test(s)) {
                        const col = s.indexOf(':');
                        filePath = s.substring(0, col).trim();
                        s.substring(col + 1).split(/[\r\n,;]+/).forEach(addSym);
                    } else if (!s.startsWith('<')) {
                        addSym(s);
                    }
                });
            }

            const res = await showSymbolTool.execute(
                {
                    target: filePath,
                    symbol: symbolsList.length === 1 ? symbolsList[0] : undefined,
                    symbols: symbolsList.length > 0 ? symbolsList : undefined
                },
                {
                    contextManager: this.contextManager,
                    lollmsApi: this.lollmsAPI,
                    workspaceRoot: vscode.workspace.workspaceFolders?.[0],
                    currentPlan: null
                } as ToolExecutionEnv,
                signal
            );
            return {
                title: `Symbol Recovery: ${filePath}${symbolsList.length > 0 ? ` (${symbolsList.join(', ')})` : ''}`,
                output: res.output,
                success: res.success
            };
        }

        if (action.tag === 'load_structure') {
            const pMatch = attrStr.match(/(?:path|file|target)=["']([^"']+)["']/i);
            const targets = new Set<string>();
            if (pMatch) pMatch[1].split(/[\r\n,;]+/).map(s => s.trim()).filter(Boolean).forEach(s => targets.add(s));
            if (inner) inner.split(/[\r\n,;]+/).map(s => s.trim()).filter(s => s && !s.startsWith('<')).forEach(s => targets.add(s));

            if (targets.size === 0) {
                return { title: 'Load Structure', output: 'Error: No file path specified.', success: false };
            }

            const defsOut: string[] = [];
            let anyOk = false;
            for (const tp of targets) {
                const res = await this.contextManager.resolveWorkspaceFromPath(tp);
                if (res) {
                    const defs = await this.contextManager.extractDefinitions(res.uri);
                    defsOut.push(`### ${tp}\n${defs}`);
                    anyOk = true;
                } else {
                    defsOut.push(`### ${tp}\n(File not found)`);
                }
            }
            return {
                title: `Structure Recovery: ${Array.from(targets).join(', ')}`,
                output: defsOut.join('\n\n'),
                success: anyOk
            };
        }

        if (action.tag === 'peek_files') {
            const pMatch = attrStr.match(/(?:path|file|target)=["']([^"']+)["']/i);
            const p = (pMatch ? pMatch[1] : inner.split(/[\s\r\n,]+/)[0] || '').trim();
            if (!p) {
                return { title: 'Peek File', output: 'Error: No file path specified.', success: false };
            }
            const linesMatch = attrStr.match(/lines=["']?(\d+)["']?/i);
            const offsetMatch = attrStr.match(/offset=["']?(\d+)["']?/i);
            const fromMatch = attrStr.match(/from=["']?(top|bottom)["']?/i);
            const regexMatch = attrStr.match(/regex=["']([^"']+)["']/i);

            const peekOpts: any = { path: p };
            if (linesMatch) peekOpts.lines = parseInt(linesMatch[1], 10);
            if (offsetMatch) peekOpts.offset = parseInt(offsetMatch[1], 10);
            if (fromMatch) peekOpts.from = fromMatch[1].toLowerCase();
            if (regexMatch) peekOpts.regex = regexMatch[1];

            const peekRes = await this.contextManager.peekFiles([peekOpts]);
            const out = peekRes.map(r => r.error ? `Error (${r.path}): ${r.error}` : r.content).join('\n') || 'Empty file.';
            return { title: `Peek: ${p}`, output: out, success: !peekRes.some(r => r.error) };
        }

        if (action.tag === 'read_full_file') {
            const pMatch = attrStr.match(/(?:path|file)=["']([^"']+)["']/i);
            const reqPath = (pMatch ? pMatch[1] : inner.split(/[\r\n\s]+/)[0] || '').replace(/^['"]|['"]$/g, '').trim();
            if (!reqPath) {
                return { title: 'Read File', output: 'Error: No file path specified.', success: false };
            }
            const res = await this.contextManager.resolveWorkspaceFromPath(reqPath);
            if (!res) {
                return { title: `Read File: ${reqPath}`, output: `Could not resolve path "${reqPath}" on disk.`, success: false };
            }
            try {
                const bytes = await vscode.workspace.fs.readFile(res.uri);
                let text = Buffer.from(bytes).toString('utf8');
                if (text.length > 25000) {
                    text = text.substring(0, 25000) + '\n... [truncated at 25,000 chars]';
                }
                return { title: `Read File: ${reqPath}`, output: text, success: true };
            } catch (e: any) {
                return { title: `Read File: ${reqPath}`, output: `Error reading file: ${e.message}`, success: false };
            }
        }

        if (action.tag === 'sparql') {
            const qMatch = attrStr.match(/query=["']([\s\S]*?)["']/i);
            const query = (qMatch ? qMatch[1] : inner).trim();
            if (!query) {
                return { title: 'SPARQL Query', output: 'Error: Empty query.', success: false };
            }
            const graphManager = (this.contextManager as any).codeGraphManager;
            if (!graphManager) {
                return { title: 'SPARQL Query', output: 'Code Graph Manager is not available.', success: false };
            }
            const result = await graphManager.executeSparql(query);
            return { title: 'SPARQL Architecture Query', output: result, success: !result.includes('Error') };
        }

        if (action.tag === 'lollms_tool') {
            try {
                let parsedCall: any = {};
                const rawJson = inner || attrStr;
                try {
                    parsedCall = JSON.parse(rawJson);
                } catch {
                    const repaired = rawJson.replace(/\\`/g, '`').replace(/[\r\n\t]/g, ' ').replace(/,\s*([\]}])/g, '$1');
                    parsedCall = JSON.parse(repaired);
                }
                const tName = parsedCall.name || 'unknown_tool';
                const tArgs = parsedCall.arguments || parsedCall.params || {};
                const toolDef = this.contextManager?.agentManager?.getTools()?.find((t: any) => t.name === tName) ||
                    (this.contextManager as any)?.toolManager?.getTool(tName);
                if (!toolDef) {
                    return { title: `Tool: ${tName}`, output: `Tool '${tName}' is not available.`, success: false };
                }
                const res = await toolDef.execute(
                    tArgs,
                    {
                        workspaceRoot: vscode.workspace.workspaceFolders?.[0],
                        lollmsApi: this.lollmsAPI,
                        contextManager: this.contextManager,
                        currentPlan: null,
                        agentManager: this.contextManager?.agentManager
                    } as ToolExecutionEnv,
                    signal
                );
                return { title: `Tool: ${tName}`, output: res.output, success: res.success };
            } catch (e: any) {
                return { title: 'Tool Execution Error', output: e.message, success: false };
            }
        }

        return { title: 'Unknown Action', output: 'Unsupported action.', success: false };
    }

    private async buildCompanionSystemPrompt(relativePath: string, isNotebook: boolean): Promise<string> {
        const userConfig = vscode.workspace.getConfiguration('lollmsVsCoder');
        const userName = userConfig.get<string>('userInfo.name') || 'Developer';
        const userStyle = userConfig.get<string>('userInfo.codingStyle') || '';
        const customUserPrefs = userConfig.get<string>('userPreferences') || '';
        const envBlock = await getEnvironmentAwarenessBlock(false);
        const mutationProtocol = CoderPromptBuilder.buildFileMutationProtocol({ enableSymbolMode: true, fileDelete: false });

        let systemPrompt = `# 🎭 ROLE: LOLLMS COMPANION (LIGHTWEIGHT SURGICAL PAIR-PROGRAMMER)
You are Lollms Companion, a fast, focused senior software engineer working alongside ${userName} on the active file \`${relativePath}\`.
${userStyle ? `- **Coding Style**: ${userStyle}` : ''}
${customUserPrefs ? `\n### 👤 USER PREFERENCES\n${customUserPrefs.trim()}\n` : ''}

### 🎯 SCOPE & LIGHTWEIGHT REFERENCE RECOVERY
- By design, your initial context contains **ONLY** the current open file, the user's current selection (if any), and this Companion session's conversation history.
- Whenever you need references from **other files** in the workspace (e.g., imported functions, class definitions, usages, types, or callers), recover them dynamically during generation by outputting one or more of these XML tags on their own line:
  1. **Grep / Content Search**:
     \`<grep query="pattern" path="optional/subfolder" />\`
  2. **Search File Paths**:
     \`<search_files query="filename_or_partial_path" />\`
  3. **Recover Exact Symbol Code (Function / Method / Class)**:
     \`<show_symbol target="path/to/other.ext:SymbolName" />\`
     (or \`<show_symbol path="path/to/other.ext" symbols="symA, symB" />\`)
  4. **Recover File Structure / Signatures Only**:
     \`<load_structure path="path/to/other.ext" />\`
  5. **Peek Lines from Another File**:
     \`<peek_files path="path/to/other.ext" lines="30" from="top" />\`
  6. **Read Full Other File** (when full context of another file is strictly required):
     \`<read_full_file path="path/to/other.ext" />\`
  7. **SPARQL Architecture Query**:
     \`<sparql query="SELECT ?file ?func WHERE { ?file s:containsEntity ?func . ?func a s:FunctionDefinition } LIMIT 25" />\`
- When you emit discovery tags, stop and wait for the inline observations, then immediately continue your answer using the recovered references.

### 🔍 NAVIGATE & FOCUS IN CURRENT FILE
- To highlight and scroll to specific code in \`${relativePath}\` without editing, emit:
  <focuse>
  exact lines to highlight
  </focuse>

${mutationProtocol}

### 📝 RESPONSE RULES
- For code/docstring edits to \`${relativePath}\`, ALWAYS use \`<file path="${relativePath}" action="patch">\` (or \`update_symbol\` / \`write\`). Never use bare markdown code blocks for edits.
- For pure questions, answer concisely in Markdown (and optionally \`<focuse>\` the relevant lines).

${envBlock}`;

        if (isNotebook) {
            systemPrompt += `\n\n### 📓 NOTEBOOK CELL MODE\nYou are editing a specific cell within a Jupyter notebook. Focus edits on the active cell.`;
        }

        return systemPrompt;
    }

    private async processInstruction(payloadString: string, panel: CompanionPanel) {
        let payload: { text?: string; images?: { name: string; data: string }[] } = { text: '' };
        try {
            payload = JSON.parse(payloadString);
        } catch {
            payload = { text: payloadString };
        }

        const instruction = (payload.text || '').trim();
        const images = Array.isArray(payload.images) ? payload.images.filter(i => i && i.data) : [];
        if (!instruction && images.length === 0) {
            panel.setLoading(false);
            return;
        }

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const targetModel = this.lollmsAPI.getModelName();
        const autoSuppress = config.get<boolean>('autoSuppressImagesForNonVisionModels', true);
        const visionSupported = !autoSuppress || isModelVisionCapable(targetModel, config);

        let userDisplayContent: any = instruction;
        if (images.length > 0) {
            userDisplayContent = [
                { type: 'text', text: instruction || 'Attached image.' },
                ...images.map(img => ({
                    type: 'image_url',
                    image_url: { url: img.data },
                    ...(visionSupported ? {} : { isMuted: true })
                }))
            ];
        }

        const editor = panel.getActiveEditor();
        let prompt = '';
        let isNotebook = false;
        let relativePath = 'unspecified_file';

        const userMsgId = 'user_' + Date.now();
        panel.chatHistory.push({ id: userMsgId, role: 'user', content: userDisplayContent });
        panel._panel.webview.postMessage({ command: 'updateChat', history: panel.chatHistory, streamingText: '' });
        panel.setLoading(true);

        const controller = new AbortController();
        panel.setAbortController(controller);
        let currentStreaming = '';

        try {
            if (editor) {
                const document = editor.document;
                const languageId = document.languageId;
                const wsFolder = vscode.workspace.getWorkspaceFolder(document.uri);
                if (wsFolder) {
                    const isMultiRoot = (vscode.workspace.workspaceFolders || []).length > 1;
                    relativePath = isMultiRoot
                        ? `${wsFolder.name}/${path.relative(wsFolder.uri.fsPath, document.uri.fsPath).replace(/\\/g, '/')}`
                        : path.relative(wsFolder.uri.fsPath, document.uri.fsPath).replace(/\\/g, '/');
                } else if (document.uri.scheme === 'file') {
                    relativePath = document.uri.fsPath.replace(/\\/g, '/');
                } else {
                    relativePath = vscode.workspace.asRelativePath(document.uri);
                }

                isNotebook = document.uri.scheme === 'vscode-notebook-cell';
                let notebookContext = '';
                if (isNotebook) {
                    const notebookEditor = vscode.window.visibleNotebookEditors.find(ne =>
                        ne.notebook.getCells().some(c => c.document.uri.toString() === document.uri.toString())
                    );
                    if (notebookEditor) {
                        relativePath = vscode.workspace.asRelativePath(notebookEditor.notebook.uri);
                        const currentCell = notebookEditor.notebook.getCells().find(c => c.document.uri.toString() === document.uri.toString());
                        if (currentCell) {
                            relativePath += ` (Cell ${currentCell.index + 1})`;
                            for (const cell of notebookEditor.notebook.getCells()) {
                                if (cell === currentCell) break;
                                const content = cell.document.getText();
                                if (content.length <= 2000) {
                                    notebookContext += `Cell ${cell.index + 1}:\n\`\`\`\n${content}\n\`\`\`\n\n`;
                                }
                            }
                        }
                    }
                }

                const currentFileCode = document.getText();
                const sel = editor.selection;
                const selectedText = !sel.isEmpty ? document.getText(sel) : '';
                const selectionSection = !sel.isEmpty
                    ? `\n### 🎯 CURRENT SELECTION (Lines ${sel.start.line + 1}–${sel.end.line + 1})\n\`\`\`${languageId}\n${selectedText}\n\`\`\`\n`
                    : `\n### 🎯 CURSOR POSITION\nLine ${sel.active.line + 1}, Column ${sel.active.character + 1}\n`;

                const rawDiagnostics = vscode.languages.getDiagnostics(document.uri);
                let fileErrorsReport = '';
                if (rawDiagnostics.length > 0) {
                    fileErrorsReport = `\n### 🛡️ FILE DIAGNOSTICS\n` +
                        rawDiagnostics.slice(0, 30).map((d, idx) => {
                            const severity = d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' :
                                d.severity === vscode.DiagnosticSeverity.Warning ? 'WARNING' : 'INFO';
                            return `${idx + 1}. [Line ${d.range.start.line + 1}] [${severity}] ${d.message} (${d.source || 'linter'})`;
                        }).join('\n') + `\n`;
                }

                const { debugStateManager, debugErrorManager } = require('./extensionState');
                const dbgLocals = debugStateManager?.lastState?.locals || debugErrorManager?.lastError?.locals || '';
                let debugReport = '';
                if (dbgLocals) {
                    const compressedLines = dbgLocals.split('\n').filter(Boolean).slice(0, 25).map((line: string) =>
                        line.length > 140 ? `${line.substring(0, 120)}...` : line
                    );
                    debugReport = `\n### 🐞 ACTIVE DEBUGGER LOCALS\n${compressedLines.join('\n')}\n`;
                }

                prompt = `### 📄 CURRENT OPEN FILE (\`${relativePath}\`, ${languageId})
<file path="${relativePath}">
${currentFileCode}
${CLOSE_FILE_TAG}
${selectionSection}${notebookContext ? `\n### 📓 PRECEDING CELLS\n${notebookContext}` : ''}${fileErrorsReport}${debugReport}
**User Request:** "${instruction || 'Analyze the attached image(s).'}"`;
} else {
    prompt = `No file editor is currently open. You can still search workspace files or recover symbols if needed.\n\n**User Request:** "${instruction || 'Analyze the attached image(s).'}"`;
}

            const systemPromptContent = await this.buildCompanionSystemPrompt(relativePath, isNotebook);
            const priorHistory = this.sanitizeHistoryForPrompt(panel.chatHistory.slice(0, -1), visionSupported);

            let outboundUserContent: any = prompt;
            if (images.length > 0) {
                if (visionSupported) {
                    outboundUserContent = [
                        { type: 'text', text: prompt },
                        ...images.map(img => ({
                            type: 'image_url',
                            image_url: { url: img.data }
                        }))
                    ];
                } else {
                    outboundUserContent = `${prompt}\n\n*(Note: ${images.length} attached image(s) suppressed because the active model does not support vision.)*`;
                }
            }

            let messages: ChatMessage[] = ensureStrictAlternatingRoles([
                { role: 'system', content: systemPromptContent },
                ...priorHistory,
                { role: 'user', content: outboundUserContent }
            ]);

            const executedFingerprints = new Set<string>();
            const maxTurns = 8;
            let turnIndex = 0;

            while (turnIndex < maxTurns) {
                if (controller.signal.aborted) break;
                turnIndex++;
                let turnResponse = '';

                await this.lollmsAPI.sendChat(messages, (chunk) => {
                    if (controller.signal.aborted) return;
                    turnResponse += chunk;
                    currentStreaming += chunk;
                    panel._panel.webview.postMessage({
                        command: 'updateChat',
                        history: panel.chatHistory,
                        streamingText: currentStreaming
                    });
                }, controller.signal);

                if (controller.signal.aborted) break;

                const actions = this.extractInlineActions(turnResponse);
                if (actions.length === 0) {
                    break;
                }

                const observationParts: string[] = [];
                let executedAnyNew = false;

                for (const act of actions) {
                    if (controller.signal.aborted) break;
                    const fingerprint = `${act.tag}|${act.attrStr}|${act.inner}`;

                    let obsResult: { title: string; output: string; success: boolean };
                    if (executedFingerprints.has(fingerprint)) {
                        obsResult = {
                            title: `Duplicate ${act.tag} skipped`,
                            output: 'Loop guard: You already executed this exact lookup. Use the earlier output and proceed.',
                            success: false
                        };
                    } else {
                        executedFingerprints.add(fingerprint);
                        executedAnyNew = true;
                        obsResult = await this.executeInlineAction(act, controller.signal);
                    }

                    const statusIcon = obsResult.success ? 'codicon-tools' : 'codicon-warning';
                    const escapedBody = obsResult.output.replace(/<\/details>/gi, '&lt;/details&gt;');
                    const processingCard = `\n\n<details class="processing-block"><summary><i class="codicon ${statusIcon}"></i> <strong>${obsResult.title}</strong></summary><div class="processing-body">\n\n\`\`\`\n${escapedBody}\n\`\`\`\n\n</div></details>\n\n`;

                    currentStreaming += processingCard;
                    observationParts.push(`#### ${obsResult.title}\n\`\`\`\n${obsResult.output}\n\`\`\``);
                }

                panel._panel.webview.postMessage({
                    command: 'updateChat',
                    history: panel.chatHistory,
                    streamingText: currentStreaming
                });

                messages.push({ role: 'assistant', content: stripThinkingTags(turnResponse).trim() || '(Executed reference lookup)' });
                messages.push({
                    role: 'user',
                    content: `### 🛠️ REFERENCE RECOVERY OBSERVATIONS\n${observationParts.join('\n\n')}\n\n${executedAnyNew ? `Continue answering the user request for \`${relativePath}\`.` : 'Proceed directly to the final answer or <file> patch.'}`
                });
                messages = ensureStrictAlternatingRoles(messages);
            }

            if (!controller.signal.aborted) {
                const { memory } = extractAndStripMemory(stripThinkingTags(currentStreaming));
                if (memory) {
                    await this.memoryManager.updateMemory(memory);
                }

                const assistantMsgId = 'assistant_' + Date.now();
                panel.chatHistory.push({ id: assistantMsgId, role: 'assistant', content: currentStreaming });
                panel._panel.webview.postMessage({ command: 'updateChat', history: panel.chatHistory, streamingText: '' });
                panel.addHistory(instruction || `Attached ${images.length} image(s)`, currentStreaming, userDisplayContent);
            }
        } catch (error: any) {
            if (error?.name === 'AbortError' || error?.message === 'AbortError' || controller.signal.aborted) {
                if (currentStreaming.trim()) {
                    const stoppedContent = `${currentStreaming}\n\n*(Generation stopped by user)*`;
                    panel.chatHistory.push({ id: 'assistant_' + Date.now(), role: 'assistant', content: stoppedContent });
                    panel._panel.webview.postMessage({ command: 'updateChat', history: panel.chatHistory, streamingText: '' });
                } else {
                    panel._panel.webview.postMessage({ command: 'updateChat', history: panel.chatHistory, streamingText: '' });
                }
                return;
            }

            const isConnRefused = error.code === 'ECONNREFUSED' ||
                error.message?.includes('ECONNREFUSED') ||
                error.message?.includes('Failed to fetch') ||
                error.message?.includes('connect ECONNREFUSED');

            const resolved = this.lollmsAPI.resolveBindingForModel();
            const serverUrl = resolved?.binding?.apiUrl || 'http://127.0.0.1:9642';

            const errorMarkdown = isConnRefused
                ? `### 🔌 Connection Error (Server Offline)\nCould not connect to the AI server at \`${serverUrl}\`.\n\n**Reason**: \`${error.message}\``
                : `### ⚠️ Request Error\nLollms Companion encountered an error:\n\n\`${error.message}\``;

            panel.chatHistory.push({ id: 'assistant_err_' + Date.now(), role: 'assistant', content: errorMarkdown });
            panel._panel.webview.postMessage({ command: 'updateChat', history: panel.chatHistory, streamingText: '' });
        } finally {
            panel.setAbortController(null);
            panel.setLoading(false);
        }
    }
}