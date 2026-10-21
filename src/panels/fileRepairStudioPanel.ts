import * as vscode from 'vscode';
import * as path from 'path';
import { LollmsServices } from '../lollmsContext';
import { stripThinkingTags, normalizeAiderContent } from '../utils';
import { Logger } from '../logger';

export type DiagnosticCriticality = 'critical' | 'type' | 'import' | 'warning' | 'cosmetic';

export interface FileDiagnosticItem {
    id: string;
    line: number;
    character: number;
    message: string;
    severity: vscode.DiagnosticSeverity;
    criticality: DiagnosticCriticality;
    criticalityScore: number;
    source?: string;
    code?: string;
    snippet?: string;
    selected: boolean;
}

export class FileRepairStudioPanel {
    public static panels = new Map<string, FileRepairStudioPanel>();
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _services: LollmsServices;
    private readonly _fileUri: vscode.Uri;
    private readonly _relPath: string;
    private _disposables: vscode.Disposable[] = [];
    private _activeAbortController: AbortController | null = null;
    private _diagnostics: FileDiagnosticItem[] = [];
    private _selectedErrorIds: Set<string> = new Set<string>();
    private _sortOrder: 'critical_to_cosmetic' | 'cosmetic_to_critical' | 'line_asc' | 'line_desc' | 'severity' | 'alpha' = 'critical_to_cosmetic';
    private _filterQuery = '';
    private _round = 0;
    private get _maxRounds(): number {
        return vscode.workspace.getConfiguration('lollmsVsCoder').get<number>('fileRepairStudioMaxRounds', 20) || 20;
    }
    private _isRunning = false;
    private _selectedModel = '';
    private _temperature: number | undefined = 0.2;
    private _reasoningEffort: 'none' | 'low' | 'medium' | 'high' | 'max' = 'medium';

    public static async createOrShow(
        extensionUri: vscode.Uri,
        services: LollmsServices,
        fileTarget?: vscode.Uri | string,
        initialErrors?: any[]
    ): Promise<FileRepairStudioPanel> {
        let targetUri: vscode.Uri | undefined;

        if (fileTarget instanceof vscode.Uri) {
            targetUri = fileTarget;
        } else if (typeof fileTarget === 'string' && fileTarget.trim()) {
            const resolution = await services.contextManager.resolveWorkspaceFromPath(fileTarget.trim());
            targetUri = resolution ? resolution.uri : vscode.Uri.file(fileTarget.trim());
        }

        if (!targetUri) {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor && activeEditor.document.uri.scheme === 'file') {
                targetUri = activeEditor.document.uri;
            }
        }

        if (!targetUri) {
            const picked = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                openLabel: 'Open File in Repair Studio'
            });
            if (picked && picked[0]) {
                targetUri = picked[0];
            }
        }

        if (!targetUri) {
            throw new Error("No target file selected for Repair Studio.");
        }

        const key = targetUri.fsPath.toLowerCase();
        const existing = FileRepairStudioPanel.panels.get(key);
        if (existing) {
            existing._panel.reveal(vscode.ViewColumn.Active);
            if (initialErrors && initialErrors.length > 0) {
                existing.updateDiagnostics(initialErrors);
            } else {
                existing.refreshDiagnosticsFromHost();
            }
            return existing;
        }

        const fileName = path.basename(targetUri.fsPath);
        const panel = vscode.window.createWebviewPanel(
            'lollmsFileRepairStudio',
            `🛠️ Repair: ${fileName}`,
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    extensionUri,
                    vscode.Uri.joinPath(extensionUri, 'out'),
                    vscode.Uri.joinPath(extensionUri, 'out', 'styles'),
                    vscode.Uri.joinPath(extensionUri, 'media')
                ]
            }
        );

        panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'lollms-icon.svg');

        const instance = new FileRepairStudioPanel(panel, extensionUri, services, targetUri, initialErrors);
        FileRepairStudioPanel.panels.set(key, instance);
        return instance;
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        services: LollmsServices,
        fileUri: vscode.Uri,
        initialErrors?: any[]
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._services = services;
        this._fileUri = fileUri;
        this._relPath = vscode.workspace.asRelativePath(fileUri, false);

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._setWebviewMessageListener();
        this._panel.webview.html = this._getHtmlForWebview();

        if (initialErrors && initialErrors.length > 0) {
            this.updateDiagnostics(initialErrors);
        } else {
            this.refreshDiagnosticsFromHost();
        }

        // Listen for external file changes and diagnostic updates
        this._disposables.push(
            vscode.languages.onDidChangeDiagnostics(e => {
                if (e.uris.some(u => u.fsPath.toLowerCase() === this._fileUri.fsPath.toLowerCase())) {
                    if (!this._isRunning) {
                        this.refreshDiagnosticsFromHost();
                    }
                }
            })
        );
    }

    public dispose() {
        const key = this._fileUri.fsPath.toLowerCase();
        FileRepairStudioPanel.panels.delete(key);
        if (this._activeAbortController) {
            this._activeAbortController.abort();
            this._activeAbortController = null;
        }
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    private categorizeDiagnostic(d: vscode.Diagnostic): { criticality: DiagnosticCriticality; score: number } {
        const msg = (d.message || '').toLowerCase();
        const isError = d.severity === vscode.DiagnosticSeverity.Error;

        if (isError && /syntax|parse|expected|unterminated|unexpected token|cannot find name|is not defined|referenceerror|invalid/i.test(msg)) {
            return { criticality: 'critical', score: 100 };
        }
        if (isError && /type|assignable|property|does not exist on type|expected \d+ argument|incompatible|signature|mismatch/i.test(msg)) {
            return { criticality: 'type', score: 80 };
        }
        if (isError && /cannot find module|module not found|import|require|package|unresolved/i.test(msg)) {
            return { criticality: 'import', score: 60 };
        }
        if (d.severity === vscode.DiagnosticSeverity.Warning) {
            return { criticality: 'warning', score: 40 };
        }
        return { criticality: 'cosmetic', score: 20 };
    }

    public async refreshDiagnosticsFromHost() {
        const diags = vscode.languages.getDiagnostics(this._fileUri);
        const doc = await Promise.resolve(vscode.workspace.openTextDocument(this._fileUri)).catch(() => null);

        const items: FileDiagnosticItem[] = diags.map((d, idx) => {
            const cat = this.categorizeDiagnostic(d);
            const line = d.range.start.line + 1;
            const character = d.range.start.character + 1;
            const snippet = doc && line <= doc.lineCount ? doc.lineAt(line - 1).text.trim() : '';

            return {
                id: `diag_${line}_${character}_${idx}`,
                line,
                character,
                message: d.message,
                severity: d.severity,
                criticality: cat.criticality,
                criticalityScore: cat.score,
                source: d.source || '',
                code: typeof d.code === 'object' ? String(d.code.value) : (d.code !== undefined ? String(d.code) : ''),
                snippet,
                selected: true // Default selects all errors
            };
        });

        this.applyDiagnosticItems(items);
    }

    public async updateDiagnostics(rawErrors: any[]) {
        const doc = await Promise.resolve(vscode.workspace.openTextDocument(this._fileUri)).catch(() => null);

        const items: FileDiagnosticItem[] = rawErrors.map((e, idx) => {
            const line = typeof e.line === 'number' ? e.line : (e.range ? e.range.start.line + 1 : 1);
            const character = typeof e.character === 'number' ? e.character : (e.range ? e.range.start.character + 1 : 1);
            const msg = e.message || String(e);
            const fakeDiag = {
                message: msg,
                severity: e.severity !== undefined ? e.severity : vscode.DiagnosticSeverity.Error
            } as vscode.Diagnostic;
            const cat = this.categorizeDiagnostic(fakeDiag);
            const snippet = e.snippet || (doc && line <= doc.lineCount ? doc.lineAt(line - 1).text.trim() : '');

            return {
                id: `diag_${line}_${character}_${idx}`,
                line,
                character,
                message: msg,
                severity: fakeDiag.severity,
                criticality: cat.criticality,
                criticalityScore: cat.score,
                source: e.source || '',
                code: e.code ? String(e.code) : '',
                snippet,
                selected: true
            };
        });

        this.applyDiagnosticItems(items);
    }

    private async applyDiagnosticItems(items: FileDiagnosticItem[]) {
        this._diagnostics = items;
        // Default: select all errors
        this._selectedErrorIds = new Set(items.map(i => i.id));

        const doc = await Promise.resolve(vscode.workspace.openTextDocument(this._fileUri)).catch(() => null);
        const codeText = doc ? doc.getText() : '';

        this._panel.webview.postMessage({
            command: 'syncState',
            filePath: this._relPath,
            diagnostics: this._getSortedDiagnostics(),
            selectedCount: this._selectedErrorIds.size,
            totalCount: this._diagnostics.length,
            currentCode: codeText,
            sortOrder: this._sortOrder
        });
    }

    private _getSortedDiagnostics(): FileDiagnosticItem[] {
        const list = [...this._diagnostics].map(d => ({
            ...d,
            selected: this._selectedErrorIds.has(d.id)
        }));

        const q = this._filterQuery.toLowerCase().trim();
        const filtered = q
            ? list.filter(d => d.message.toLowerCase().includes(q) || (d.snippet && d.snippet.toLowerCase().includes(q)) || String(d.line).includes(q))
            : list;

        return filtered.sort((a, b) => {
            switch (this._sortOrder) {
                case 'critical_to_cosmetic':
                    return (b.criticalityScore - a.criticalityScore) || (a.line - b.line);
                case 'cosmetic_to_critical':
                    return (a.criticalityScore - b.criticalityScore) || (a.line - b.line);
                case 'line_asc':
                    return a.line - b.line;
                case 'line_desc':
                    return b.line - a.line;
                case 'severity':
                    return a.severity - b.severity || a.line - b.line;
                case 'alpha':
                    return a.message.localeCompare(b.message);
                default:
                    return (b.criticalityScore - a.criticalityScore) || (a.line - b.line);
            }
        });
    }

    private _setWebviewMessageListener() {
        this._panel.webview.onDidReceiveMessage(async message => {
            switch (message.command) {
                case 'ready': {
                    let models: any[] = [];
                    try {
                        models = await this._services.lollmsAPI.getModels(false);
                    } catch {}
                    const defaultModel = this._services.lollmsAPI.getModelName();
                    this._selectedModel = defaultModel;

                    this._panel.webview.postMessage({
                        command: 'initData',
                        filePath: this._relPath,
                        models,
                        selectedModel: defaultModel,
                        temperature: this._temperature,
                        reasoningEffort: this._reasoningEffort,
                        maxRounds: this._maxRounds
                    });
                    this.refreshDiagnosticsFromHost();
                    break;
                }
                case 'toggleErrorSelection': {
                    const id = message.id;
                    if (this._selectedErrorIds.has(id)) {
                        this._selectedErrorIds.delete(id);
                    } else {
                        this._selectedErrorIds.add(id);
                    }
                    this._panel.webview.postMessage({
                        command: 'updateDiagnosticsList',
                        diagnostics: this._getSortedDiagnostics(),
                        selectedCount: this._selectedErrorIds.size,
                        totalCount: this._diagnostics.length
                    });
                    break;
                }
                case 'selectAllErrors': {
                    this._selectedErrorIds = new Set(this._diagnostics.map(d => d.id));
                    this._panel.webview.postMessage({
                        command: 'updateDiagnosticsList',
                        diagnostics: this._getSortedDiagnostics(),
                        selectedCount: this._selectedErrorIds.size,
                        totalCount: this._diagnostics.length
                    });
                    break;
                }
                case 'deselectAllErrors': {
                    this._selectedErrorIds.clear();
                    this._panel.webview.postMessage({
                        command: 'updateDiagnosticsList',
                        diagnostics: this._getSortedDiagnostics(),
                        selectedCount: this._selectedErrorIds.size,
                        totalCount: this._diagnostics.length
                    });
                    break;
                }
                case 'invertErrorSelection': {
                    const next = new Set<string>();
                    for (const d of this._diagnostics) {
                        if (!this._selectedErrorIds.has(d.id)) next.add(d.id);
                    }
                    this._selectedErrorIds = next;
                    this._panel.webview.postMessage({
                        command: 'updateDiagnosticsList',
                        diagnostics: this._getSortedDiagnostics(),
                        selectedCount: this._selectedErrorIds.size,
                        totalCount: this._diagnostics.length
                    });
                    break;
                }
                case 'changeSortOrder': {
                    this._sortOrder = message.sortOrder;
                    this._panel.webview.postMessage({
                        command: 'updateDiagnosticsList',
                        diagnostics: this._getSortedDiagnostics(),
                        selectedCount: this._selectedErrorIds.size,
                        totalCount: this._diagnostics.length,
                        sortOrder: this._sortOrder
                    });
                    break;
                }
                case 'filterErrors': {
                    this._filterQuery = message.query || '';
                    this._panel.webview.postMessage({
                        command: 'updateDiagnosticsList',
                        diagnostics: this._getSortedDiagnostics(),
                        selectedCount: this._selectedErrorIds.size,
                        totalCount: this._diagnostics.length
                    });
                    break;
                }
                case 'updateSettings': {
                    if (message.model) this._selectedModel = message.model;
                    if (message.temperature !== undefined) this._temperature = message.temperature;
                    if (message.reasoningEffort) this._reasoningEffort = message.reasoningEffort;
                    break;
                }
                case 'runRepair': {
                    await this.runRepairPass(message.prompt);
                    break;
                }
                case 'stopRepair': {
                    this._isRunning = false;
                    if (this._activeAbortController) {
                        this._activeAbortController.abort();
                        this._activeAbortController = null;
                    }
                    this._panel.webview.postMessage({ command: 'repairStopped' });
                    break;
                }
                case 'rescan': {
                    await this.refreshDiagnosticsFromHost();
                    vscode.window.showInformationMessage(`Diagnostics re-scanned: ${this._diagnostics.length} error(s) remaining.`);
                    break;
                }
                case 'acceptAndClose': {
                    vscode.window.showInformationMessage(`✅ Accepted current file state for ${path.basename(this._fileUri.fsPath)} (${this._diagnostics.length} errors remaining).`);
                    this.dispose();
                    break;
                }
                case 'revealLineInEditor': {
                    const line = parseInt(message.line, 10);
                    if (!isNaN(line) && line > 0) {
                        const doc = await vscode.workspace.openTextDocument(this._fileUri);
                        const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
                        const pos = new vscode.Position(line - 1, 0);
                        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                    }
                    break;
                }
            }
        }, null, this._disposables);
    }

    private async runRepairPass(userPromptHint?: string) {
        if (this._isRunning) return;

        const targetErrors = this._diagnostics.filter(d => this._selectedErrorIds.has(d.id));
        if (targetErrors.length === 0) {
            vscode.window.showWarningMessage("Please select at least one error to repair.");
            return;
        }

        this._isRunning = true;
        this._round++;
        this._activeAbortController = new AbortController();
        const signal = this._activeAbortController.signal;

        this._panel.webview.postMessage({
            command: 'repairStarted',
            round: this._round,
            maxRounds: this._maxRounds,
            targetCount: targetErrors.length
        });

        try {
            // Read ground-truth current file content directly from disk
            const doc = await vscode.workspace.openTextDocument(this._fileUri);
            const currentContent = doc.getText();
            const docLang = doc.languageId;

            const errorReportLines = targetErrors.map((e, idx) => {
                const src = e.source ? ` [${e.source}]` : '';
                return `${idx + 1}. [Line ${e.line}:${e.character}]${src} (${e.criticality.toUpperCase()}) ${e.message}`;
            }).join('\n');

            const isPy = docLang === 'python';
            const langRule = isPy
                ? "This is Python code. Ensure exact indentation (spaces vs tabs) strictly matches the file nesting."
                : `Target language is ${docLang}. Ensure valid syntax, brackets, and complete imports.`;

            const systemPrompt = `You are the Senior Linter & Diagnostic Repair Architect (Guardian Protocol).
Your task is to fix the SELECTED line-by-line compiler/linter errors in the target file \`${this._relPath}\`.
You always see the ground-truth code of the target file as it currently sits on disk.

### 🛡️ STRICT REPAIR CONSTITUTION:
1. Fix ALL selected errors listed in the report.
2. ${langRule}
3. **PEEKING & SCOUTING OTHER FILES (IF NEEDED)**:
   If you need to verify an imported symbol, contract, or type defined in ANOTHER file:
   Output a discovery tag:
   - \`<peek_files path="path/to/other.ts" lines="30" from="top" />\`
   - \`<grep pattern="symbolName" path="src" />\`
   - \`<show_symbol target="path/to/other.ts:SymbolName" />\`
   - \`<read_full_file path="path/to/other.ts" />\`
   The environment will execute your discovery tool and return the exact code so you can verify imports before writing the patch.
4. **SURGICAL CODE DELIVERY**:
   When you are ready to apply fixes to \`${this._relPath}\`, output very short, focused AIDER SEARCH/REPLACE blocks (1-5 lines of change):
   \`\`\`${docLang}:${this._relPath}
   <<<<<<< SEARCH
   [exact lines currently on disk]
   =======
   [corrected lines]
   >>>>>>> REPLACE
   \`\`\`
   Or wrap in \`<file path="${this._relPath}" action="patch">...</file>

\`.
5. Provide a brief 1-2 sentence explanation of what was fixed outside code blocks.`;

            const userPrompt = `### 🔍 COMPILER / LINTER ERRORS DETECTED IN \`${this._relPath}\` (Round ${this._round}):
${errorReportLines}

${userPromptHint ? `### 👤 USER INSTRUCTIONS / HINTS:\n"${userPromptHint}"\n` : ''}
### 📄 CURRENT GROUND-TRUTH ON DISK (\`${this._relPath}\`):
\`\`\`${docLang}
${currentContent}
\`\`\`

Generate the surgical fix to resolve the selected errors.`;

            const conversation: any[] = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ];

            let turnStreamBuffer = "";
            let maxInternalTurns = 4;
            let finalCleanResponse = "";

            while (maxInternalTurns > 0) {
                if (signal.aborted || !this._isRunning) {
                    this._isRunning = false;
                    this._panel.webview.postMessage({ command: 'repairStopped' });
                    return;
                }
                maxInternalTurns--;
                turnStreamBuffer = "";

                const response = await this._services.lollmsAPI.sendChat(
                    conversation,
                    chunk => {
                        if (signal.aborted || !this._isRunning) return;
                        turnStreamBuffer += chunk;
                        this._panel.webview.postMessage({
                            command: 'repairStreamChunk',
                            chunk,
                            fullText: turnStreamBuffer,
                            round: this._round
                        });
                    },
                    signal,
                    this._selectedModel,
                    {
                        thinking: this._reasoningEffort !== 'none',
                        reasoningEffort: this._reasoningEffort,
                        temperature: this._temperature
                    }
                );

                if (signal.aborted || !this._isRunning) {
                    this._isRunning = false;
                    this._panel.webview.postMessage({ command: 'repairStopped' });
                    return;
                }

                finalCleanResponse = stripThinkingTags(response).trim();

                // Check for discovery tool execution on other files
                const peekMatch = finalCleanResponse.match(/<peek_files\b([^>]*?)>([\s\S]*?)<\/peek_files>/i) ||
                                  finalCleanResponse.match(/<peek_files\s+([^>]*?)\/>/i);
                const grepMatch = finalCleanResponse.match(/<grep\b([^>]*?)(?:\/>|>([\s\S]*?)<\/grep>)/i);
                const symMatch = finalCleanResponse.match(/<(?:show_symbol|get_symbol_code|read_symbol)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:show_symbol|get_symbol_code|read_symbol)>)/i);
                const readMatch = finalCleanResponse.match(/<(?:read_full_file|read_file)\b[^>]*path=["']([^"']+)["'][^>]*\/>/i);

                if (symMatch) {
                    const attrStr = symMatch[1] || "";
                    const targetMatch = attrStr.match(/target=["']([^"']+)["']/i);
                    const pathMatch = attrStr.match(/path=["']([^"']+)["']/i);
                    const symParam = attrStr.match(/symbol=["']([^"']+)["']/i);
                    const rawTarget = targetMatch ? targetMatch[1].trim() : (pathMatch ? pathMatch[1].trim() : "");
                    const rawSym = symParam ? symParam[1].trim() : "";

                    const { showSymbolTool } = require('../tools/builtins/showSymbol');
                    const toolRes = await showSymbolTool.execute(
                        { target: rawTarget, symbol: rawSym },
                        { contextManager: this._services.contextManager, lollmsApi: this._services.lollmsAPI, workspaceRoot: vscode.workspace.workspaceFolders?.[0], currentPlan: null },
                        signal
                    );

                    this._panel.webview.postMessage({
                        command: 'toolExecuted',
                        tool: 'show_symbol',
                        output: toolRes.output
                    });

                    conversation.push({ role: 'assistant', content: finalCleanResponse });
                    conversation.push({ role: 'user', content: `Tool Observation:\n${toolRes.output}\n\nNow deliver your surgical patch for ${this._relPath}.` });
                    continue;
                }

                if (readMatch) {
                    const reqPath = readMatch[1].trim();
                    const res = await this._services.contextManager.resolveWorkspaceFromPath(reqPath);
                    let readOutput = `(Could not read ${reqPath})`;
                    if (res) {
                        try {
                            const bytes = await vscode.workspace.fs.readFile(res.uri);
                            readOutput = Buffer.from(bytes).toString('utf8');
                        } catch (e: any) {
                            readOutput = `Error: ${e.message}`;
                        }
                    }

                    this._panel.webview.postMessage({
                        command: 'toolExecuted',
                        tool: 'read_full_file',
                        output: readOutput.slice(0, 500)
                    });

                    conversation.push({ role: 'assistant', content: finalCleanResponse });
                    conversation.push({ role: 'user', content: `Tool Observation for ${reqPath}:\n\`\`\`\n${readOutput.slice(0, 10000)}\n\`\`\`\n\nDeliver the surgical patch for ${this._relPath}.` });
                    continue;
                }

                if (peekMatch) {
                    const attrStr = peekMatch[1] || "";
                    const inner = (peekMatch[2] || "").trim();
                    const pMatch = attrStr.match(/path=["']([^"']+)["']/i);
                    const targetPath = pMatch ? pMatch[1].trim() : inner.split(/\s+/)[0];

                    const peekRes = await this._services.contextManager.peekFiles([{ path: targetPath, lines: 30 }]);
                    const snippet = peekRes.map(r => r.error ? `Error: ${r.error}` : r.content).join('\n');

                    this._panel.webview.postMessage({
                        command: 'toolExecuted',
                        tool: 'peek_files',
                        output: snippet
                    });

                    conversation.push({ role: 'assistant', content: finalCleanResponse });
                    conversation.push({ role: 'user', content: `Tool Observation for ${targetPath}:\n\`\`\`\n${snippet}\n\`\`\`\n\nDeliver the surgical patch for ${this._relPath}.` });
                    continue;
                }

                if (grepMatch) {
                    const attrStr = grepMatch[1] || "";
                    const pMatch = attrStr.match(/(?:pattern|query)=["']([^"']+)["']/i);
                    const pattern = pMatch ? pMatch[1].trim() : (grepMatch[2] || "").trim();
                    const searchRes = await this._services.contextManager.searchWorkspaceContent(pattern, { matchCase: false, wholeWord: false }, signal);
                    const snippet = searchRes.slice(0, 8).map(r => `${r.path}:${r.line} - ${r.snippet}`).join('\n') || "No matches found.";

                    this._panel.webview.postMessage({
                        command: 'toolExecuted',
                        tool: 'grep',
                        output: snippet
                    });

                    conversation.push({ role: 'assistant', content: finalCleanResponse });
                    conversation.push({ role: 'user', content: `Grep Results:\n${snippet}\n\nDeliver the surgical patch for ${this._relPath}.` });
                    continue;
                }

                // If no tools requested, we have the code patch
                break;
            }

            if (signal.aborted || !this._isRunning) {
                this._isRunning = false;
                this._panel.webview.postMessage({ command: 'repairStopped' });
                return;
            }

            // Apply patch to disk
            const normalizedPatch = normalizeAiderContent(finalCleanResponse);
            const patchRes: any = await vscode.commands.executeCommand(
                'lollms-vs-coder.replaceCode',
                this._relPath,
                normalizedPatch,
                undefined,
                undefined,
                { silent: true, autoSave: true }
            );

            // Re-read current disk state
            await new Promise(r => setTimeout(r, 800));
            const freshDoc = await vscode.workspace.openTextDocument(this._fileUri);
            const newDiskContent = freshDoc.getText();
            this._services.contextManager.refreshFileInCache(this._fileUri);

            // Re-scan diagnostics
            await this.refreshDiagnosticsFromHost();

            this._panel.webview.postMessage({
                command: 'repairPassCompleted',
                round: this._round,
                maxRounds: this._maxRounds,
                patchApplied: patchRes?.success ?? true,
                currentCode: newDiskContent,
                explanation: finalCleanResponse.replace(/```[\s\S]*?```/g, '').trim(),
                patch: normalizedPatch
            });

        } catch (err: any) {
            if (signal.aborted || !this._isRunning || err.name === 'AbortError' || err.message === 'AbortError') {
                this._isRunning = false;
                this._panel.webview.postMessage({ command: 'repairStopped' });
                return;
            }
            Logger.error("Repair pass error:", err);
            this._panel.webview.postMessage({
                command: 'repairError',
                error: err.message
            });
        } finally {
            this._isRunning = false;
            this._activeAbortController = null;
        }
    }

    private _getHtmlForWebview(): string {
        const codiconsUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'));
        const cspSource = this._panel.webview.cspSource;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; font-src ${cspSource}; script-src 'unsafe-inline' https://cdn.jsdelivr.net; connect-src *;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>File Repair Studio</title>
    <link href="${codiconsUri}" rel="stylesheet" />
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <style>
        body {
            font-family: var(--vscode-font-family);
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 0;
            margin: 0;
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
        }
        .header {
            padding: 10px 18px;
            background: var(--vscode-editorWidget-background);
            border-bottom: 1px solid var(--vscode-widget-border);
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            flex-shrink: 0;
        }
        .header-title-group {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .header-icon {
            width: 30px;
            height: 30px;
            border-radius: 6px;
            background: rgba(231, 76, 60, 0.15);
            color: var(--vscode-charts-red);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 16px;
        }
        .header-title {
            font-size: 13.5px;
            font-weight: 800;
            letter-spacing: 0.5px;
            color: var(--vscode-foreground);
        }
        .header-subtitle {
            font-size: 10px;
            opacity: 0.7;
            font-family: var(--vscode-editor-font-family, monospace);
        }
        .btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: bold;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            transition: all 0.15s;
        }
        .btn:hover { filter: brightness(1.15); }
        .btn.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-widget-border);
        }
        .btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
        .btn.green {
            background: var(--vscode-charts-green, #2ecc71) !important;
            color: white !important;
        }
        .btn.purple {
            background: var(--vscode-charts-purple, #9b59b6) !important;
            color: white !important;
        }
        .btn.red {
            background: var(--vscode-charts-red, #e74c3c) !important;
            color: white !important;
        }
        .toolbar-bar {
            padding: 6px 16px;
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-widget-border);
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            font-size: 11px;
            flex-wrap: wrap;
        }
        .main-layout {
            flex: 1;
            display: flex;
            overflow: hidden;
            width: 100%;
        }
        .left-stream-col {
            flex: 1.15;
            display: flex;
            flex-direction: column;
            border-right: 1px solid var(--vscode-widget-border);
            background: var(--vscode-editor-background);
            overflow: hidden;
        }
        .right-inspect-col {
            flex: 1;
            display: flex;
            flex-direction: column;
            background: var(--vscode-sideBar-background);
            overflow: hidden;
        }
        .chat-stream-box {
            flex: 1;
            overflow-y: auto;
            padding: 14px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        .bubble {
            padding: 10px 14px;
            border-radius: 8px;
            font-size: 11.5px;
            line-height: 1.45;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-widget-border);
        }
        .bubble.user {
            border-left: 3px solid var(--vscode-charts-blue);
            align-self: flex-end;
            width: 85%;
        }
        .bubble.assistant {
            border-left: 3px solid var(--vscode-charts-purple);
            align-self: flex-start;
            width: 95%;
        }
        .bubble.tool {
            border-left: 3px solid var(--vscode-charts-orange);
            background: rgba(214, 122, 13, 0.08);
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 10.5px;
        }
        .input-row-box {
            padding: 10px 14px;
            border-top: 1px solid var(--vscode-widget-border);
            background: var(--vscode-sideBar-background);
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        .textarea-box {
            flex: 1;
            height: 48px;
            resize: none;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            padding: 8px;
            font-family: inherit;
            font-size: 11.5px;
            outline: none;
        }
        .textarea-box:focus { border-color: var(--vscode-focusBorder); }
        .tab-btn-row {
            padding: 6px 12px;
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-bottom: 1px solid var(--vscode-widget-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .tab-btn {
            background: transparent;
            border: 1px solid transparent;
            color: var(--vscode-foreground);
            padding: 3px 8px;
            font-size: 10.5px;
            font-weight: 600;
            cursor: pointer;
            border-radius: 4px;
        }
        .tab-btn.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            font-weight: 700;
        }
        .filter-controls-row {
            padding: 6px 12px;
            background: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-widget-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
        }
        .error-card {
            padding: 8px 10px;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 6px;
            display: flex;
            flex-direction: column;
            gap: 4px;
            cursor: pointer;
            transition: border-color 0.15s, opacity 0.15s;
        }
        .error-card:hover { border-color: var(--vscode-focusBorder); }
        .error-card.unselected { opacity: 0.55; }
        .error-card.critical { border-left: 3px solid var(--vscode-charts-red); }
        .error-card.type { border-left: 3px solid var(--vscode-charts-orange); }
        .error-card.import { border-left: 3px solid var(--vscode-charts-purple); }
        .error-card.warning { border-left: 3px solid var(--vscode-charts-yellow); }
        .error-card.cosmetic { border-left: 3px solid var(--vscode-charts-blue); }
        .crit-badge {
            font-size: 8.5px;
            font-weight: 800;
            padding: 1px 5px;
            border-radius: 3px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .crit-badge.critical { background: rgba(231, 76, 60, 0.2); color: var(--vscode-charts-red); }
        .crit-badge.type { background: rgba(230, 126, 34, 0.2); color: var(--vscode-charts-orange); }
        .crit-badge.import { background: rgba(155, 89, 182, 0.2); color: var(--vscode-charts-purple); }
        .crit-badge.warning { background: rgba(241, 196, 15, 0.2); color: var(--vscode-charts-yellow); }
        .crit-badge.cosmetic { background: rgba(52, 152, 219, 0.2); color: var(--vscode-charts-blue); }
        .footer-bar {
            padding: 8px 18px;
            background: var(--vscode-editorWidget-background);
            border-top: 1px solid var(--vscode-widget-border);
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 11px;
            flex-shrink: 0;
        }
        .spinner {
            width: 12px;
            height: 12px;
            border: 2px solid currentColor;
            border-bottom-color: transparent;
            border-radius: 50%;
            display: inline-block;
            animation: spin 0.75s linear infinite;
        }
        @keyframes spin { 100% { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="header">
        <div class="header-title-group">
            <div class="header-icon"><i class="codicon codicon-tools"></i></div>
            <div>
                <div class="header-title">File Repair Studio (Guardian)</div>
                <div class="header-subtitle" id="targetFileSubtitle">Target: loading...</div>
            </div>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
            <span id="headerErrBadge" class="btn secondary" style="cursor:default; height:24px; font-size:10px;">0 Errors</span>
            <button id="btnTopAccept" class="btn green" style="height:24px; font-size:10px;"><i class="codicon codicon-check"></i> Accept at Any Time</button>
        </div>
    </div>

    <div class="toolbar-bar">
        <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap; flex:1;">
            <div style="display:flex; align-items:center; gap:6px;">
                <span style="font-weight:700;"><i class="codicon codicon-hubot"></i> Model:</span>
                <select id="modelSelect" style="background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); border:1px solid var(--vscode-dropdown-border); border-radius:4px; font-size:11px; height:22px; max-width:240px;"></select>
            </div>
            <div style="display:flex; align-items:center; gap:6px;">
                <span style="font-weight:700;"><i class="codicon codicon-thermometer"></i> Temp:</span>
                <select id="tempSelect" style="background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); border:1px solid var(--vscode-dropdown-border); border-radius:4px; font-size:11px; height:22px;">
                    <option value="auto">Auto</option>
                    <option value="0.0">0.0 (Deterministic)</option>
                    <option value="0.2" selected>0.2 (Precise Fix)</option>
                    <option value="0.5">0.5 (Balanced)</option>
                </select>
            </div>
            <div style="display:flex; align-items:center; gap:6px;">
                <span style="font-weight:700;"><i class="codicon codicon-circuit-board"></i> Effort:</span>
                <select id="effortSelect" style="background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); border:1px solid var(--vscode-dropdown-border); border-radius:4px; font-size:11px; height:22px;">
                    <option value="none">None (Fast)</option>
                    <option value="low">Low</option>
                    <option value="medium" selected>Medium</option>
                    <option value="high">High</option>
                    <option value="max">Max</option>
                </select>
            </div>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
            <span id="roundCounterBadge" style="opacity:0.8; font-family:monospace;">Round 0/20</span>
        </div>
    </div>

    <div class="main-layout">
        <!-- LEFT COLUMN: Repair Chat Stream & Instructions -->
        <div class="left-stream-col">
            <div style="padding:6px 12px; background:var(--vscode-sideBarSectionHeader-background); border-bottom:1px solid var(--vscode-widget-border); display:flex; justify-content:space-between; align-items:center; font-size:10.5px; font-weight:700; text-transform:uppercase;">
                <span><i class="codicon codicon-comment-discussion"></i> Repair Stream &amp; Tool Inspection</span>
                <span id="statusIndicatorText" style="opacity:0.7;">Ready</span>
            </div>

            <div class="chat-stream-box" id="chatStreamBox">
                <div class="bubble assistant">
                    <strong>🛡️ Guardian Repair Assistant Ready</strong><br>
                    I inspect the current code on disk, select target errors, and can scout other files using <code>&lt;peek_files&gt;</code>, <code>&lt;grep&gt;</code>, or <code>&lt;show_symbol&gt;</code> before generating surgical fixes.
                </div>
            </div>

            <div id="liveStreamingIndicator" style="display:none; padding:6px 12px; background:rgba(155,89,182,0.1); border-top:1px solid var(--vscode-widget-border); font-size:10.5px; color:var(--vscode-charts-purple); align-items:center; justify-content:space-between;">
                <div style="display:flex; align-items:center; gap:8px;">
                    <div class="spinner"></div>
                    <span id="streamingStatusMessage">Repairing selected errors...</span>
                </div>
                <button id="btnIndicatorStop" class="btn red" style="height:22px; font-size:10px; padding:0 8px;" title="Stop Repair immediately">
                    <i class="codicon codicon-primitive-square"></i> Stop
                </button>
            </div>

            <div class="input-row-box">
                <div style="display:flex; gap:8px; align-items:flex-end;">
                    <textarea id="promptInput" class="textarea-box" placeholder="Optional instructions (e.g. 'Ensure type safety', 'Import LollmsServices from ../lollmsContext')..."></textarea>
                    <button id="btnRunFix" class="btn purple" style="height:48px; width:65px; flex-direction:column; gap:2px;"><i class="codicon codicon-sparkle"></i> <span>Fix</span></button>
                </div>
                <div style="display:flex; justify-content:space-between; font-size:9.5px; opacity:0.65;">
                    <span>Press <kbd>Enter</kbd> to fix &middot; <kbd>Shift+Enter</kbd> for newline</span>
                    <span id="selectedErrorsHint">0 errors selected</span>
                </div>
            </div>
        </div>

        <!-- RIGHT COLUMN: Spotted Errors, Code Viewer, Diff -->
        <div class="right-inspect-col">
            <div class="tab-btn-row">
                <span style="font-weight:700; font-size:11px; text-transform:uppercase;"><i class="codicon codicon-warning" style="color:var(--vscode-charts-red)"></i> Spotted Errors (<span id="totalErrorsCount">0</span>)</span>
                <div style="display:flex; gap:4px;">
                    <button class="tab-btn active" id="tabBtnErrors">Errors</button>
                    <button class="tab-btn" id="tabBtnCode">Current Code</button>
                    <button class="tab-btn" id="tabBtnDiff">Last Diff</button>
                </div>
            </div>

            <!-- TAB 1: ERRORS LIST WITH ORDERING & SELECTION -->
            <div id="paneErrors" style="flex:1; display:flex; flex-direction:column; overflow:hidden;">
                <div class="filter-controls-row">
                    <!-- Ordering Dropdown (Critical to Cosmetic) -->
                    <div style="display:flex; align-items:center; gap:6px;">
                        <span style="font-weight:700; font-size:10.5px;"><i class="codicon codicon-sort-precedence"></i> Order:</span>
                        <select id="orderSelect" style="font-size:10.5px; padding:2px 4px; background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); border:1px solid var(--vscode-dropdown-border); border-radius:4px; height:22px;">
                            <option value="critical_to_cosmetic" selected>🔥 Critical to Cosmetic</option>
                            <option value="cosmetic_to_critical">❄️ Cosmetic to Critical</option>
                            <option value="line_asc">⬆️ Line Number (Asc)</option>
                            <option value="line_desc">⬇️ Line Number (Desc)</option>
                            <option value="severity">⚠️ Severity (Errors &gt; Warnings)</option>
                            <option value="alpha">🔤 Message (A - Z)</option>
                        </select>
                    </div>

                    <!-- Search Filter -->
                    <div style="display:flex; align-items:center; gap:4px; background:var(--vscode-input-background); border:1px solid var(--vscode-input-border); border-radius:4px; padding:2px 6px; flex:1; max-width:180px;">
                        <i class="codicon codicon-search" style="font-size:10px; opacity:0.6;"></i>
                        <input type="text" id="filterInput" placeholder="Filter errors..." style="background:transparent; border:none; outline:none; font-size:10.5px; color:var(--vscode-input-foreground); width:100%;">
                    </div>

                    <!-- Bulk Selection Actions -->
                    <div style="display:flex; align-items:center; gap:4px;">
                        <button class="btn secondary" id="btnSelectAll" style="height:22px; font-size:10px; padding:0 6px;">All</button>
                        <button class="btn secondary" id="btnSelectNone" style="height:22px; font-size:10px; padding:0 6px;">None</button>
                        <button class="btn secondary" id="btnSelectInvert" style="height:22px; font-size:10px; padding:0 6px;">Invert</button>
                    </div>
                </div>

                <div id="errorsListContainer" style="flex:1; overflow-y:auto; padding:8px; display:flex; flex-direction:column; gap:6px;"></div>
            </div>

            <!-- TAB 2: CURRENT CODE ON DISK -->
            <div id="paneCode" style="flex:1; display:none; overflow:auto; padding:10px; background:var(--vscode-editor-background);">
                <pre id="currentCodeView" style="margin:0; font-family:var(--vscode-editor-font-family, monospace); font-size:11.5px; line-height:1.45; white-space:pre;"></pre>
            </div>

            <!-- TAB 3: LAST PATCH DIFF -->
            <div id="paneDiff" style="flex:1; display:none; overflow:auto; padding:10px; background:var(--vscode-editor-background);">
                <pre id="lastPatchView" style="margin:0; font-family:var(--vscode-editor-font-family, monospace); font-size:11px; line-height:1.4; white-space:pre; opacity:0.9;">(No patch applied yet)</pre>
            </div>
        </div>
    </div>

    <div class="footer-bar">
        <span id="footerStatusSummary">Ready</span>
        <div style="display:flex; gap:8px;">
            <button id="btnFooterRescan" class="btn secondary" style="height:26px;"><i class="codicon codicon-refresh"></i> Re-scan</button>
            <button id="btnFooterAccept" class="btn green" style="height:26px;"><i class="codicon codicon-check"></i> Accept &amp; Keep File</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let targetFilePath = "";
        let diagnosticsList = [];
        let isFixing = false;
        let activeTab = 'errors';

        // Notify extension that webview is ready
        vscode.postMessage({ command: 'ready' });

        // Tab Switching
        const tabBtnErrors = document.getElementById('tabBtnErrors');
        const tabBtnCode = document.getElementById('tabBtnCode');
        const tabBtnDiff = document.getElementById('tabBtnDiff');
        const paneErrors = document.getElementById('paneErrors');
        const paneCode = document.getElementById('paneCode');
        const paneDiff = document.getElementById('paneDiff');

        function switchTab(tab) {
            activeTab = tab;
            tabBtnErrors.classList.toggle('active', tab === 'errors');
            tabBtnCode.classList.toggle('active', tab === 'code');
            tabBtnDiff.classList.toggle('active', tab === 'diff');

            paneErrors.style.display = tab === 'errors' ? 'flex' : 'none';
            paneCode.style.display = tab === 'code' ? 'block' : 'none';
            paneDiff.style.display = tab === 'diff' ? 'block' : 'none';
        }

        tabBtnErrors.onclick = () => switchTab('errors');
        tabBtnCode.onclick = () => switchTab('code');
        tabBtnDiff.onclick = () => switchTab('diff');

        // Selection Handlers
        document.getElementById('btnSelectAll').onclick = () => vscode.postMessage({ command: 'selectAllErrors' });
        document.getElementById('btnSelectNone').onclick = () => vscode.postMessage({ command: 'deselectAllErrors' });
        document.getElementById('btnSelectInvert').onclick = () => vscode.postMessage({ command: 'invertErrorSelection' });

        // Sorting & Filter Handlers
        document.getElementById('orderSelect').onchange = (e) => {
            vscode.postMessage({ command: 'changeSortOrder', sortOrder: e.target.value });
        };

        let filterDebounce = null;
        document.getElementById('filterInput').oninput = (e) => {
            clearTimeout(filterDebounce);
            filterDebounce = setTimeout(() => {
                vscode.postMessage({ command: 'filterErrors', query: e.target.value });
            }, 150);
        };

        // Settings change
        function postSettingsUpdate() {
            const model = document.getElementById('modelSelect').value;
            const tempVal = document.getElementById('tempSelect').value;
            const temp = tempVal === 'auto' ? undefined : parseFloat(tempVal);
            const effort = document.getElementById('effortSelect').value;
            vscode.postMessage({ command: 'updateSettings', model, temperature: temp, reasoningEffort: effort });
        }
        document.getElementById('modelSelect').onchange = postSettingsUpdate;
        document.getElementById('tempSelect').onchange = postSettingsUpdate;
        document.getElementById('effortSelect').onchange = postSettingsUpdate;

        // Run Fix / Stop Action
        const btnRunFix = document.getElementById('btnRunFix');
        const promptInput = document.getElementById('promptInput');
        const btnIndicatorStop = document.getElementById('btnIndicatorStop');

        function triggerFixOrStop() {
            if (isFixing) {
                isFixing = false;
                btnRunFix.classList.remove('red');
                btnRunFix.classList.add('purple');
                btnRunFix.innerHTML = '<i class="codicon codicon-sparkle"></i> <span>Fix</span>';
                document.getElementById('liveStreamingIndicator').style.display = 'none';
                document.getElementById('statusIndicatorText').textContent = 'Stopped by user';
                const streamEl = document.getElementById('activeStreamBubble');
                if (streamEl) {
                    streamEl.id = '';
                    streamEl.innerHTML += '<br><em style="color:var(--vscode-charts-orange); font-size:10px;">*(Repair stopped by user)*</em>';
                }
                vscode.postMessage({ command: 'stopRepair' });
            } else {
                const prompt = promptInput.value.trim();
                promptInput.value = '';
                vscode.postMessage({ command: 'runRepair', prompt });
            }
        }

        btnRunFix.onclick = triggerFixOrStop;
        if (btnIndicatorStop) {
            btnIndicatorStop.onclick = triggerFixOrStop;
        }

        promptInput.onkeydown = (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                triggerFixOrStop();
            }
        };

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && isFixing) {
                triggerFixOrStop();
            }
        });

        // Footer Actions
        document.getElementById('btnFooterRescan').onclick = () => vscode.postMessage({ command: 'rescan' });
        document.getElementById('btnFooterAccept').onclick = () => vscode.postMessage({ command: 'acceptAndClose' });
        document.getElementById('btnTopAccept').onclick = () => vscode.postMessage({ command: 'acceptAndClose' });

        // Render Error Cards with ordering and checkbox
        function renderErrorCards(diagnostics, selectedCount, totalCount) {
            const container = document.getElementById('errorsListContainer');
            const totalCountEl = document.getElementById('totalErrorsCount');
            const selectedHint = document.getElementById('selectedErrorsHint');
            const headerErrBadge = document.getElementById('headerErrBadge');
            const footerStatus = document.getElementById('footerStatusSummary');

            totalCountEl.textContent = String(totalCount);
            selectedHint.textContent = \`\${selectedCount} of \${totalCount} errors selected for fix\`;
            headerErrBadge.textContent = \`\${totalCount} Error\${totalCount === 1 ? '' : 's'}\`;
            headerErrBadge.style.color = totalCount === 0 ? 'var(--vscode-charts-green)' : 'var(--vscode-charts-red)';
            footerStatus.textContent = \`\${totalCount} error(s) remaining (\${selectedCount} selected for next pass). You can accept at any time.\`;

            if (diagnostics.length === 0) {
                container.innerHTML = \`
                    <div style="padding:30px; text-align:center; color:var(--vscode-charts-green); display:flex; flex-direction:column; align-items:center; gap:8px;">
                        <i class="codicon codicon-pass-filled" style="font-size:32px;"></i>
                        <span style="font-weight:700; font-size:13px;">No Diagnostics Errors Detected!</span>
                        <span style="font-size:11px; opacity:0.8;">The file is clean. Click Accept &amp; Keep File to finish.</span>
                    </div>\`;
                return;
            }

            container.innerHTML = diagnostics.map(d => {
                const critClass = d.criticality || 'critical';
                const isChecked = d.selected;

                return \`
                <div class="error-card \${critClass} \${isChecked ? '' : 'unselected'}" data-id="\${d.id}" data-line="\${d.line}">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <div style="display:flex; align-items:center; gap:6px;">
                            <input type="checkbox" class="err-check" data-id="\${d.id}" \${isChecked ? 'checked' : ''} style="margin:0; cursor:pointer;">
                            <span class="crit-badge \${critClass}">\${critClass.toUpperCase()}</span>
                            <span style="font-weight:700; font-size:10px;">Line \${d.line}:\${d.character}</span>
                        </div>
                        <span style="font-size:9.5px; opacity:0.65; font-family:monospace;">\${escapeHtml(d.source || d.code || '')}</span>
                    </div>
                    <div style="font-size:11px; margin-top:2px;">\${escapeHtml(d.message)}</div>
                    \${d.snippet ? \`<div style="font-family:monospace; font-size:10px; opacity:0.8; background:rgba(0,0,0,0.2); padding:3px 6px; border-radius:3px; margin-top:2px; overflow-x:auto;"><code>\${escapeHtml(d.snippet)}</code></div>\` : ''}
                </div>\`;
            }).join('');

            // Wire Card and Checkbox clicks
            container.querySelectorAll('.error-card').forEach(card => {
                const id = card.dataset.id;
                const line = card.dataset.line;
                const cb = card.querySelector('.err-check');

                card.onclick = (e) => {
                    if (e.target.tagName === 'INPUT') return;
                    vscode.postMessage({ command: 'toggleErrorSelection', id });
                    vscode.postMessage({ command: 'revealLineInEditor', line });
                };

                if (cb) {
                    cb.onchange = (e) => {
                        e.stopPropagation();
                        vscode.postMessage({ command: 'toggleErrorSelection', id });
                    };
                }
            });
        }

        function escapeHtml(str) {
            return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        // Webview Inbound Handlers
        window.addEventListener('message', event => {
            const msg = event.data;
            switch (msg.command) {
                case 'initData':
                    targetFilePath = msg.filePath;
                    document.getElementById('targetFileSubtitle').textContent = \`Target: \${msg.filePath}\`;
                    const modelSelect = document.getElementById('modelSelect');
                    modelSelect.innerHTML = (msg.models || []).map(m => \`<option value="\${m.id}" \${m.id === msg.selectedModel ? 'selected' : ''}>\${m.name || m.id}</option>\`).join('');
                    if (modelSelect.options.length === 0) {
                        modelSelect.innerHTML = \`<option value="\${msg.selectedModel}">\${msg.selectedModel}</option>\`;
                    }
                    break;
                case 'syncState':
                    targetFilePath = msg.filePath;
                    document.getElementById('targetFileSubtitle').textContent = \`Target: \${msg.filePath}\`;
                    renderErrorCards(msg.diagnostics, msg.selectedCount, msg.totalCount);
                    if (msg.currentCode) {
                        document.getElementById('currentCodeView').textContent = msg.currentCode;
                    }
                    if (msg.sortOrder) {
                        document.getElementById('orderSelect').value = msg.sortOrder;
                    }
                    break;
                case 'updateDiagnosticsList':
                    renderErrorCards(msg.diagnostics, msg.selectedCount, msg.totalCount);
                    if (msg.sortOrder) {
                        document.getElementById('orderSelect').value = msg.sortOrder;
                    }
                    break;
                case 'repairStarted':
                    isFixing = true;
                    btnRunFix.classList.remove('purple');
                    btnRunFix.classList.add('red');
                    btnRunFix.innerHTML = '<i class="codicon codicon-primitive-square"></i> <span>Stop</span>';
                    document.getElementById('liveStreamingIndicator').style.display = 'flex';
                    document.getElementById('statusIndicatorText').textContent = \`Fixing (\${msg.targetCount} selected errors)...\`;
                    document.getElementById('roundCounterBadge').textContent = \`Round \${msg.round}/\${msg.maxRounds}\`;
                    break;
                case 'repairStreamChunk':
                    let streamBubble = document.getElementById('activeStreamBubble');
                    if (!streamBubble) {
                        streamBubble = document.createElement('div');
                        streamBubble.id = 'activeStreamBubble';
                        streamBubble.className = 'bubble assistant';
                        document.getElementById('chatStreamBox').appendChild(streamBubble);
                    }
                    streamBubble.innerHTML = \`<strong>Repair Agent (Round \${msg.round}):</strong><br>\` + marked.parse(msg.fullText);
                    document.getElementById('chatStreamBox').scrollTop = document.getElementById('chatStreamBox').scrollHeight;
                    break;
                case 'toolExecuted':
                    const toolBubble = document.createElement('div');
                    toolBubble.className = 'bubble tool';
                    toolBubble.innerHTML = \`<strong><i class="codicon codicon-tools"></i> \${escapeHtml(msg.tool)}:</strong><br><pre style="margin:2px 0; overflow-x:auto;">\${escapeHtml(msg.output)}</pre>\`;
                    document.getElementById('chatStreamBox').appendChild(toolBubble);
                    document.getElementById('chatStreamBox').scrollTop = document.getElementById('chatStreamBox').scrollHeight;
                    break;
                case 'repairPassCompleted':
                    isFixing = false;
                    btnRunFix.classList.remove('red');
                    btnRunFix.classList.add('purple');
                    btnRunFix.innerHTML = '<i class="codicon codicon-sparkle"></i> <span>Fix</span>';
                    document.getElementById('liveStreamingIndicator').style.display = 'none';
                    document.getElementById('statusIndicatorText').textContent = 'Patch Applied to Disk';

                    const streamEl = document.getElementById('activeStreamBubble');
                    if (streamEl) streamEl.id = '';

                    const doneBubble = document.createElement('div');
                    doneBubble.className = 'bubble assistant';
                    doneBubble.innerHTML = \`<strong>✅ Applied Surgical Patch to Disk</strong><br>\${marked.parse(msg.explanation || 'Patch applied successfully.')}\`;
                    document.getElementById('chatStreamBox').appendChild(doneBubble);
                    document.getElementById('chatStreamBox').scrollTop = document.getElementById('chatStreamBox').scrollHeight;

                    if (msg.currentCode) {
                        document.getElementById('currentCodeView').textContent = msg.currentCode;
                    }
                    if (msg.patch) {
                        document.getElementById('lastPatchView').textContent = msg.patch;
                    }
                    break;
                case 'repairStopped':
                    isFixing = false;
                    btnRunFix.classList.remove('red');
                    btnRunFix.classList.add('purple');
                    btnRunFix.innerHTML = '<i class="codicon codicon-sparkle"></i> <span>Fix</span>';
                    document.getElementById('liveStreamingIndicator').style.display = 'none';
                    document.getElementById('statusIndicatorText').textContent = 'Stopped by user';
                    break;
                case 'repairError':
                    isFixing = false;
                    btnRunFix.classList.remove('red');
                    btnRunFix.classList.add('purple');
                    btnRunFix.innerHTML = '<i class="codicon codicon-sparkle"></i> <span>Fix</span>';
                    document.getElementById('liveStreamingIndicator').style.display = 'none';
                    alert("Repair Error: " + msg.error);
                    break;
            }
        });
    </script>
</body>
</html>`;
    }
}