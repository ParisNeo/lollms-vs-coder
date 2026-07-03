import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

interface HistoryItem {
    id: string;
    prompt: string;
    response: string;
    timestamp: number;
}

export class CompanionPanel {
    public static currentPanel: CompanionPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _history: HistoryItem[] = [];
    private _currentHistoryIndex: number = -1;
    
    // Caching the last actual file editor to prevent focus loss from clearing it
    private _lastActiveEditor: vscode.TextEditor | undefined;
    private _isAttached: boolean = false;
    private _disposables: vscode.Disposable[] = [];
    
    private _onDidSubmit = new vscode.EventEmitter<string>();
    public readonly onDidSubmit = this._onDidSubmit.event;

    private _contextInfo: string = "No active context";
    private _trustScore: number = 75;
    // Set by extension.ts after CompanionPanel is created, e.g.
    // CompanionPanel.currentPanel.agentManager = myAgentManagerInstance;
    // Typed as `any` here since this file doesn't own the AgentManager
    // class definition - tighten this to the real type if/when it's
    // imported into this module.
    public agentManager: any;
    // Snapshot of file content captured right before an apply, keyed by blockId,
    // so a "Reject" decision can restore the previous state.
    private _preApplySnapshots: Map<string, { filePath: string; content: string }> = new Map();

    public static createOrShow(extensionUri: vscode.Uri, title: string) {
        const column = vscode.window.activeTextEditor
            ? vscode.ViewColumn.Beside
            : undefined;

        if (CompanionPanel.currentPanel) {
            CompanionPanel.currentPanel._panel.reveal(column);
            CompanionPanel.currentPanel.updateTitle(title);
            return CompanionPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            'lollmsCompanion',
            title,
            column || vscode.ViewColumn.Two,
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'media'),
                    vscode.Uri.joinPath(extensionUri, 'out')
                ],
                retainContextWhenHidden: true
            }
        );

        CompanionPanel.currentPanel = new CompanionPanel(panel, extensionUri);
        return CompanionPanel.currentPanel;
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        // Cache the active editor on start
        const active = vscode.window.activeTextEditor;
        if (active && active.document.uri.scheme === 'file') {
            this._lastActiveEditor = active;
        }
        this.updateContextInfoFromEditor();

        // Stable Editor Tracker: Only update if the new editor is a real file
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor && editor.document && editor.document.uri.scheme === 'file') {
                if (!this._isAttached) {
                    this._lastActiveEditor = editor;
                    this.updateContextInfoFromEditor();
                }
            }
        }, null, this._disposables);

        vscode.window.onDidChangeTextEditorSelection(e => {
            if (this._lastActiveEditor && e.textEditor && e.textEditor === this._lastActiveEditor) {
                if (!this._isAttached) {
                    this.updateContextInfoFromEditor();
                }
            }
        }, null, this._disposables);

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'webview-ready':
                        this.setContextInfo(this._contextInfo);
                        this._panel.webview.postMessage({ command: 'updateAttachState', isAttached: this._isAttached });
                        this._panel.webview.postMessage({ command: 'updateTrustScore', score: this._trustScore });
                        this.updateHistoryList();
                        break;
                    case 'submitPrompt':
                        // Pack mode details with submission
                        const payload = JSON.stringify({
                            text: message.text || message.query || "",
                            mode: message.mode || 'standard'
                        });
                        this._onDidSubmit.fire(payload);
                        break;
                    case 'copyToClipboard':
                        if (message.text) {
                            await vscode.env.clipboard.writeText(message.text);
                            vscode.window.setStatusBarMessage("Lollms: Copied to clipboard", 2000);
                        }
                        break;
                    case 'toggleAttach':
                        this.toggleAttach();
                        break;
                    case 'loadHistory':
                        this.loadHistoryItem(message.id);
                        break;
                    case 'deleteHistory':
                        this.deleteHistoryItem(message.id);
                        break;
                    case 'clearHistory':
                        this._history = [];
                        this._currentHistoryIndex = -1;
                        this.updateHistoryList();
                        this._panel.webview.postMessage({ command: 'clearResponse' });
                        break;
                    case 'adjustTrustScore':
                        this._trustScore = Math.max(0, Math.min(100, this._trustScore + (message.delta || 0)));
                        this._panel.webview.postMessage({ command: 'updateTrustScore', score: this._trustScore });
                        break;
                    case 'replaceCode':
                        try {
                            const normalizedContent = message.content
                                .replace(/^\s*<<<<<<< SEARCH/gm, '<<<<<<< SEARCH')
                                .replace(/^\s*=======/gm, '=======')
                                .replace(/^\s*>>>>>>> REPLACE/gm, '>>>>>>> REPLACE');

                            await this._captureSnapshot(message.options?.blockId, message.filePath);

                            const res: any = await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', message.filePath, normalizedContent, undefined, undefined, message.options);
                            if (res?.success ?? false) {
                                await this._revealAppliedFile(message.filePath);
                            }
                            this._panel.webview.postMessage({
                                command: 'applyAllResult',
                                success: res?.success ?? false,
                                error: res?.error,
                                blockId: message.options?.blockId,
                                hunkIndex: message.options?.hunkIndex
                            });
                        } catch (e: any) {
                            this._panel.webview.postMessage({ command: 'applyAllResult', success: false, error: e.message, blockId: message.options?.blockId });
                        }
                        break;
                    case 'applyFileContent':
                        try {
                            await this._captureSnapshot(message.options?.blockId, message.filePath);

                            const res: any = await vscode.commands.executeCommand('lollms-vs-coder.applyFileContent', message.filePath, message.content, message.options);
                            if (res?.success ?? false) {
                                await this._revealAppliedFile(message.filePath);
                            }
                            this._panel.webview.postMessage({
                                command: 'applyAllResult',
                                success: res?.success ?? false,
                                error: res?.error,
                                blockId: message.options?.blockId,
                                hunkIndex: message.options?.hunkIndex
                            });
                        } catch (e: any) {
                            this._panel.webview.postMessage({ command: 'applyAllResult', success: false, error: e.message, blockId: message.options?.blockId });
                        }
                        break;
                    case 'reviewDecision':
                        await this._handleReviewDecision(message.blockId, message.decision, message.filePath);
                        break;
                    case 'executeLollmsCommand':
                        const { command, params } = message.details;
                        if (command === 'lollms-vs-coder.runSparqlQueryDirectly') {
                            const result = this.agentManager?.codeGraphManager?.executeSparql(params.query) || "SPARQL-lite Error: Graph Engine unavailable.";
                            this._panel.webview.postMessage({
                                command: 'applyAllResult',
                                messageId: params.messageId,
                                blockId: params.blockId,
                                success: !result.includes("Error"),
                                sparqlResult: result
                            });
                        } else {
                            await vscode.commands.executeCommand(command, params);
                        }
                        break;
                    case 'workspaceAction':
                        await this._handleWorkspaceAction(message.action, message.params);
                        break;
                    case 'runAgenticLoop':
                        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0 && this.agentManager) {
                            this._panel.webview.postMessage({ command: 'setLoading', isLoading: true });
                            try {
                                const discussion = {
                                    id: 'temp-companion-' + Date.now(),
                                    title: 'Companion Agentic Flow',
                                    messages: [{ role: 'user', content: message.objective }],
                                    timestamp: Date.now(),
                                    groupId: null,
                                    capabilities: { agentMode: true }
                                };
                                await this.agentManager.handleUserMessage(message.objective, discussion, vscode.workspace.workspaceFolders[0]);
                            } catch (e: any) {
                                vscode.window.showErrorMessage(`Agent failed: ${e.message}`);
                            } finally {
                                this._panel.webview.postMessage({ command: 'setLoading', isLoading: false });
                            }
                        }
                        break;
                }
            }
        );
        this._panel.webview.html = this._getHtmlForWebview();
    }

    /**
     * After a patch is applied to disk, open/reveal the file in the editor
     * column the user was actually working in - never in the Companion
     * panel's own column, so the panel stays visible side-by-side.
     * preserveFocus keeps keyboard focus on the chat input so typing isn't
     * interrupted.
     */
    private async _handleWorkspaceAction(action: string, params: any) {
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) return;

            let fileUri = vscode.Uri.file(params.filePath);
            if (!path.isAbsolute(params.filePath)) {
                fileUri = vscode.Uri.joinPath(workspaceFolder.uri, params.filePath);
            }

            if (action === 'openFile' || action === 'selectCode') {
                const doc = await vscode.workspace.openTextDocument(fileUri);
                // Oppose companion column
                const targetColumn = this._panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
                const editor = await vscode.window.showTextDocument(doc, { viewColumn: targetColumn, preview: false });

                if (action === 'selectCode' && params.text) {
                    const text = doc.getText();
                    const idx = text.indexOf(params.text);
                    if (idx !== -1) {
                        const start = doc.positionAt(idx);
                        const end = doc.positionAt(idx + params.text.length);
                        editor.selection = new vscode.Selection(start, end);
                        editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
                    }
                } else if (params.line !== undefined) {
                    const pos = new vscode.Position(Math.max(0, params.line - 1), 0);
                    editor.selection = new vscode.Selection(pos, pos);
                    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                }
            } else if (action === 'setBreakpoint') {
                const line = parseInt(params.line || "1", 10);
                const position = new vscode.Position(line - 1, 0);
                const location = new vscode.Location(fileUri, position);
                const breakpoint = new vscode.SourceBreakpoint(location);
                vscode.debug.addBreakpoints([breakpoint]);
                vscode.window.showInformationMessage(`✅ Breakpoint added to ${path.basename(params.filePath)}:${line}`);
            } else if (action === 'runScript') {
                // Execute active python/shell script inside terminal
                const { runCommandInTerminal } = require('../extensionState');
                const isPy = params.filePath.endsWith('.py');
                const cmd = isPy ? `python -u "${fileUri.fsPath}"` : `node "${fileUri.fsPath}"`;

                vscode.window.showInformationMessage(`🚀 Launching script: ${path.basename(params.filePath)}`);
                const res = await runCommandInTerminal(cmd, workspaceFolder.uri.fsPath, "Companion Runner");
                this._panel.webview.postMessage({
                    command: 'appendChunk',
                    text: `\n\n### 🖥️ SCRIPT RUN RESULT:\n\`\`\`\n${res.output}\n\`\`\`\n`
                });
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Workspace operation failed: ${e.message}`);
        }
    }

    private async _revealAppliedFile(filePath: string | undefined) {
        if (!filePath) {
            return;
        }
        try {
            const uri = vscode.Uri.file(filePath);
            const companionColumn = this._panel.viewColumn || vscode.ViewColumn.Two;

            // Explicitly force the target column to be opposite of the Companion Panel.
            // If companion is in Column Two, Besided, or Three, we target Column One.
            // If companion is in Column One, we target Column Two.
            let targetColumn = vscode.ViewColumn.One;
            if (companionColumn === vscode.ViewColumn.One) {
                targetColumn = vscode.ViewColumn.Two;
            }

            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc, {
                viewColumn: targetColumn,
                preserveFocus: true, // Crucial: Keep focus in the companion panel
                preview: false
            });
            this._lastActiveEditor = editor;
        } catch {
            // File may have been deleted/renamed by the apply step, or the
            // path is otherwise invalid - nothing more we can do here.
        }
    }

    /**
     * Snapshot the on-disk content of a file right before a patch is applied,
     * so a later "Reject" can restore it exactly.
     */
    private async _captureSnapshot(blockId: string | undefined, filePath: string | undefined) {
        if (!blockId || !filePath) {
            return;
        }
        try {
            const uri = vscode.Uri.file(filePath);
            const bytes = await vscode.workspace.fs.readFile(uri);
            this._preApplySnapshots.set(blockId, { filePath, content: Buffer.from(bytes).toString('utf8') });
        } catch {
            // File may not exist yet (new file creation) - nothing to snapshot.
        }
    }

    /**
     * Handle the user's Accept/Reject decision from the review card.
     * Accept: drop the snapshot (write already happened).
     * Reject: restore the pre-apply snapshot to disk.
     */
    private async _handleReviewDecision(blockId: string | undefined, decision: string, filePath?: string) {
        if (!blockId) {
            return;
        }
        const snapshot = this._preApplySnapshots.get(blockId);
        if (decision === 'reject') {
            try {
                if (snapshot) {
                    const uri = vscode.Uri.file(snapshot.filePath);
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(snapshot.content, 'utf8'));
                    vscode.window.setStatusBarMessage("Lollms: Change reverted", 2000);
                } else if (filePath) {
                    // No snapshot means the file didn't exist before the apply - remove it.
                    const uri = vscode.Uri.file(filePath);
                    await vscode.workspace.fs.delete(uri);
                    vscode.window.setStatusBarMessage("Lollms: New file removed", 2000);
                }
            } catch (e: any) {
                vscode.window.showErrorMessage("Lollms: Failed to revert change - " + e.message);
            }
        }
        this._preApplySnapshots.delete(blockId);
    }

    public getActiveEditor(): vscode.TextEditor | undefined {
        if (this._lastActiveEditor && this._lastActiveEditor.document.isClosed) {
            this._lastActiveEditor = undefined;
            this.updateContextInfoFromEditor();
        }
        return this._lastActiveEditor;
    }

    public setActiveEditor(editor: vscode.TextEditor) {
        this._lastActiveEditor = editor;
        this.updateContextInfoFromEditor();
    }

    private toggleAttach() {
        this._isAttached = !this._isAttached;
        this._panel.webview.postMessage({ command: 'updateAttachState', isAttached: this._isAttached });
        
        if (!this._isAttached) {
            const active = vscode.window.activeTextEditor;
            if (active && active.document.uri.scheme === 'file') {
                this._lastActiveEditor = active;
            }
            this.updateContextInfoFromEditor();
        }
    }

    private updateContextInfoFromEditor() {
        if (!this._lastActiveEditor) {
             this.setContextInfo("No active editor");
             return;
        }
        const doc = this._lastActiveEditor.document;
        const sel = this._lastActiveEditor.selection;
        
        let info = "";
        
        if (doc.uri.scheme === 'vscode-notebook-cell') {
            const notebook = vscode.window.visibleNotebookEditors.find(ne => ne.notebook.getCells().some(c => c.document === doc))?.notebook;
            const nbName = notebook ? vscode.workspace.asRelativePath(notebook.uri) : "Notebook Cell";
            
            let cellIndexStr = "";
            if (notebook) {
                const cell = notebook.getCells().find(c => c.document === doc);
                if (cell) {
                    cellIndexStr = " (Cell " + (cell.index + 1) + ")";
                }
            }
            info = nbName + cellIndexStr;
        } else {
            info = vscode.workspace.asRelativePath(doc.uri);
        }

        if (!sel.isEmpty) {
            info += " (Lines " + (sel.start.line + 1) + "-" + (sel.end.line + 1) + " Selected)";
        } else {
            info += " (Ln " + (sel.active.line + 1) + ", Col " + (sel.active.character + 1) + ")";
        }
        this.setContextInfo(info);
    }

    public setContextInfo(info: string) {
        this._contextInfo = info;
        this._panel.webview.postMessage({ command: 'updateContextInfo', text: info });
    }

    public setLoading(isLoading: boolean) {
        this._panel.webview.postMessage({ command: 'setLoading', isLoading });
        if (isLoading) {
            this._panel.webview.postMessage({ command: 'setMood', mood: 'thinking' });
        }
    }

    public updateHistoryList() {
        this._panel.webview.postMessage({ command: 'updateHistory', history: this._history });
    }

    public addHistory(prompt: string, response: string) {
        const newItem: HistoryItem = {
            id: Date.now().toString(),
            prompt,
            response,
            timestamp: Date.now()
        };
        this._history.unshift(newItem); 
        this.updateHistoryList();
        this._panel.webview.postMessage({ command: 'renderResponse', text: response, prompt: prompt });
    }

    public updateContent(content: string, prompt: string) {
        this._panel.webview.postMessage({ command: 'renderResponse', text: content, prompt: prompt });
    }

    public updateTitle(title: string) {
        this._panel.title = title;
    }

    private loadHistoryItem(id: string) {
        const index = this._history.findIndex(h => h.id === id);
        if (index !== -1) {
            this._currentHistoryIndex = index;
            const item = this._history[index];
            this._panel.webview.postMessage({ command: 'renderResponse', text: item.response, prompt: item.prompt });
        }
    }

    private deleteHistoryItem(id: string) {
        this._history = this._history.filter(h => h.id !== id);
        this.updateHistoryList();
        if (this._history.length > 0) {
            this.loadHistoryItem(this._history[0].id);
        } else {
            this._panel.webview.postMessage({ command: 'clearResponse' });
        }
    }

    public dispose() {
        CompanionPanel.currentPanel = undefined;
        this._panel.dispose();
        this._onDidSubmit.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _getHtmlForWebview(): string {
        const markedUri = "https://cdn.jsdelivr.net/npm/marked@5.1.1/marked.min.js";
        const domPurifyUri = "https://cdn.jsdelivr.net/npm/dompurify@3.0.5/dist/purify.min.js";
        const prismJsUri = "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js";
        const prismCssUri = "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css";
        const webview = this._panel.webview;
        const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'));
        const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'chatPanel.css'));

        let html = "";
        html += "<!DOCTYPE html>\n";
        html += "<html lang=\"en\">\n";
        html += "<head>\n";
        html += "    <meta charset=\"UTF-8\">\n";
        html += "    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n";
        html += "    <meta http-equiv=\"Content-Security-Policy\" content=\"";
        html += "        default-src 'none';";
        html += "        style-src 'unsafe-inline' " + webview.cspSource + " https://cdn.jsdelivr.net https://cdnjs.cloudflare.com;";
        html += "        font-src " + webview.cspSource + " https://cdn.jsdelivr.net https://cdnjs.cloudflare.com;";
        html += "        img-src " + webview.cspSource + " data:;";
        html += "        script-src 'unsafe-inline' 'unsafe-eval' " + webview.cspSource + " https://cdn.jsdelivr.net https://cdnjs.cloudflare.com;";
        html += "        connect-src https://cdn.jsdelivr.net https://cdnjs.cloudflare.com;";
        html += "    \">\n";
        html += "    <title>Lollms Companion</title>\n";
        html += "    <script src=\"" + markedUri + "\"></script>\n";
        html += "    <script src=\"" + domPurifyUri + "\"></script>\n";
        html += "    <link href=\"" + prismCssUri + "\" rel=\"stylesheet\" />\n";
        html += "    <link href=\"" + codiconUri + "\" rel=\"stylesheet\" />\n";
        html += "    <link href=\"" + cssUri + "\" rel=\"stylesheet\" />\n";
        html += "    <script src=\"" + prismJsUri + "\"></script>\n";
        html += "    <script src=\"https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-python.min.js\"></script>\n";
        html += "    <script src=\"https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-typescript.min.js\"></script>\n";
        html += "    <script src=\"https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-javascript.min.js\"></script>\n";
        html += "    <script src=\"https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-diff.min.js\"></script>\n";
        html += "    <style>\n";
        html += "        body {\n";
        html += "            font-family: var(--vscode-font-family);\n";
        html += "            background-color: var(--vscode-editor-background);\n";
        html += "            color: var(--vscode-editor-foreground);\n";
        html += "            padding: 0; margin: 0;\n";
        html += "            display: flex; height: 100vh; overflow: hidden; position: relative;\n";
        html += "        }\n";
        html += "        /* --- COMPANION COMPACT SPACE SAVING OVERRIDES --- */\n";
        html += "        .markdown-body { font-size: 12px !important; line-height: 1.4 !important; }\n";
        html += "        .markdown-body p, .markdown-body ul, .markdown-body ol { margin-top: 0 !important; margin-bottom: 6px !important; }\n";
        html += "        .markdown-body h1, .markdown-body h2, .markdown-body h3 { font-size: 13px !important; margin-top: 10px !important; margin-bottom: 6px !important; }\n";
        html += "        .code-collapsible { margin: 6px 0 !important; }\n";
        html += "        .code-summary { padding: 4px 8px !important; font-size: 10px !important; }\n";
        html += "        .code-collapsible > pre { max-height: 250px !important; }\n";
        html += "        .code-line-gutter { width: 30px !important; padding: 8px 4px !important; font-size: 10px !important; }\n";
        html += "        .code-collapsible > pre > code { padding: 8px !important; font-size: 11px !important; }\n";
        html += "        .processing-block { margin: 6px 0 !important; }\n";
        html += "        .processing-header { padding: 6px 8px !important; font-size: 10px !important; }\n";
        html += "        .processing-body { padding: 8px !important; font-size: 10px !important; max-height: 120px !important; }\n";
        html += "        .friend-avatar-container {\n";
        html += "            display: flex; align-items: center; justify-content: center;\n";
        html += "            width: 38px; height: 38px;\n";
        html += "            background: rgba(155, 89, 182, 0.15);\n";
        html += "            border-radius: 50%; border: 1.5px solid #9b59b6;\n";
        html += "            position: relative; overflow: hidden; box-shadow: 0 0 10px rgba(155, 89, 182, 0.25);\n";
        html += "        }\n";
        html += "        .robot-face {\n";
        html += "            width: 20px; height: 16px; background: #2d2d2d; border-radius: 3px;\n";
        html += "            position: relative; display: flex; align-items: center; justify-content: space-around;\n";
        html += "            padding: 0 2px; box-sizing: border-box; border: 1px solid #9b59b6;\n";
        html += "            transition: all 0.3s ease;\n";
        html += "        }\n";
        html += "        /* Micro-expressions based on active state */\n";
        html += "        .robot-face.speaking { border-color: #ff007f; box-shadow: 0 0 10px rgba(255, 0, 127, 0.5); }\n";
        html += "        .robot-face.thinking { border-color: #9b59b6; box-shadow: 0 0 15px rgba(155, 89, 182, 0.6); animation: float-face 2s infinite ease-in-out; }\n";
        html += "        .robot-face.success { border-color: var(--vscode-charts-green); box-shadow: 0 0 12px rgba(46, 204, 113, 0.6); }\n";
        html += "        .robot-face.error { border-color: var(--vscode-charts-red); box-shadow: 0 0 12px rgba(231, 76, 60, 0.6); }\n";
        html += "        @keyframes float-face {\n";
        html += "            0%, 100% { transform: translateY(0); }\n";
        html += "            50% { transform: translateY(-3px); }\n";
        html += "        }\n";
        html += "        .robot-eye {\n";
        html += "            width: 4px; height: 4px; background: #00ffcc;\n";
        html += "            border-radius: 50%; box-shadow: 0 0 6px #00ffcc;\n";
        html += "            animation: eye-blink 4s infinite;\n";
        html += "            transition: background 0.3s;\n";
        html += "        }\n";
        html += "        .robot-face.speaking .robot-eye { background: #ff007f; box-shadow: 0 0 6px #ff007f; }\n";
        html += "        .robot-face.thinking .robot-eye { background: #9b59b6; box-shadow: 0 0 6px #9b59b6; }\n";
        html += "        .robot-face.success .robot-eye { background: var(--vscode-charts-green); box-shadow: 0 0 6px var(--vscode-charts-green); }\n";
        html += "        .robot-face.error .robot-eye { background: var(--vscode-charts-red); box-shadow: 0 0 6px var(--vscode-charts-red); }\n";
        html += "        .robot-mouth {\n";
        html += "            position: absolute; bottom: 2px; left: 50%; transform: translateX(-50%);\n";
        html += "            width: 8px; height: 2px; background: #00ffcc; border-radius: 1px;\n";
        html += "            transition: all 0.1s ease;\n";
        html += "        }\n";
        html += "        .robot-face.speaking .robot-mouth {\n";
        html += "            animation: mouth-talk 0.2s infinite alternate;\n";
        html += "            background: #ff007f;\n";
        html += "        }\n";
        html += "        .robot-face.thinking .robot-mouth { height: 1px; width: 6px; background: #9b59b6; }\n";
        html += "        .robot-face.success .robot-mouth { height: 3px; width: 8px; border-radius: 0 0 4px 4px; background: var(--vscode-charts-green); }\n";
        html += "        .robot-face.error .robot-mouth { height: 3px; width: 8px; border-radius: 4px 4px 0 0; background: var(--vscode-charts-red); }\n";
        html += "        @keyframes eye-blink {\n";
        html += "            0%, 95%, 100% { transform: scaleY(1); }\n";
        html += "            97% { transform: scaleY(0.1); }\n";
        html += "        }\n";
        html += "        @keyframes mouth-talk {\n";
        html += "            0% { height: 1px; }\n";
        html += "            100% { height: 5px; }\n";
        html += "        }\n";
        html += "        /* --- AFFECTIVE MATRIX STATUS --- */\n";
        html += "        .affective-matrix {\n";
        html += "            margin: 0 16px 10px 16px;\n";
        html += "            padding: 8px 12px; background: rgba(155, 89, 182, 0.05); \n";
        html += "            border: 1px solid var(--vscode-widget-border); border-radius: 6px;\n";
        html += "            display: flex; flex-direction: column; gap: 4px;\n";
        html += "        }\n";
        html += "        .matrix-header {\n";
        html += "            display: flex; justify-content: space-between; font-size: 10px; font-weight: bold;\n";
        html += "            color: #9b59b6; text-transform: uppercase; letter-spacing: 0.5px;\n";
        html += "        }\n";
        html += "        .matrix-bar {\n";
        html += "            height: 4px; background: rgba(255, 255, 255, 0.05); border-radius: 2px;\n";
        html += "            overflow: hidden; width: 100%;\n";
        html += "        }\n";
        html += "        .matrix-bar-fill {\n";
        html += "            height: 100%; background: linear-gradient(to right, #e74c3c, #9b59b6, #2ecc71); \n";
        html += "            width: 75%; transition: width 0.5s ease-out;\n";
        html += "        }\n";
        html += "        .friendship-hud {\n";
        html += "            margin: 0 16px 12px 16px;\n";
        html += "            border: 1px dashed var(--vscode-widget-border);\n";
        html += "            border-radius: 6px; background: rgba(155, 89, 182, 0.02);\n";
        html += "            overflow: hidden;\n";
        html += "        }\n";
        html += "        .hud-header {\n";
        html += "            padding: 6px 12px; font-size: 11px; font-weight: bold;\n";
        html += "            color: #9b59b6; display: flex; align-items: center; justify-content: space-between;\n";
        html += "            background: rgba(155, 89, 182, 0.05); border-bottom: 1px dashed var(--vscode-widget-border);\n";
        html += "            cursor: pointer; user-select: none;\n";
        html += "        }\n";
        html += "        .hud-header::-webkit-details-marker { display:none; }\n";
        html += "        .hud-header::marker { display:none; content:''; }\n";
        html += "        .hud-scroll-container {\n";
        html += "            padding: 10px 14px;\n";
        html += "            font-size: 11px;\n";
        html += "            max-height: 120px;\n";
        html += "            overflow-y: auto;\n";
        html += "            color: var(--vscode-descriptionForeground);\n";
        html += "        }\n";
        html += "        /* --- COGNITIVE MODE TOOLBAR --- */\n";
        html += "        .cognitive-toolbar {\n";
        html += "            display: flex;\n";
        html += "            gap: 6px;\n";
        html += "            margin: 0 16px 10px 16px;\n";
        html += "            background: rgba(0, 0, 0, 0.2);\n";
        html += "            padding: 3px;\n";
        html += "            border-radius: 20px;\n";
        html += "            border: 1px solid var(--vscode-widget-border);\n";
        html += "            box-sizing: border-box;\n";
        html += "        }\n";
        html += "        .cognitive-pill {\n";
        html += "            flex: 1;\n";
        html += "            padding: 6px;\n";
        html += "            font-size: 11px;\n";
        html += "            font-weight: bold;\n";
        html += "            text-align: center;\n";
        html += "            border-radius: 18px;\n";
        html += "            cursor: pointer;\n";
        html += "            opacity: 0.6;\n";
        html += "            transition: all 0.25s ease-out;\n";
        html += "            display: flex;\n";
        html += "            align-items: center;\n";
        html += "            justify-content: center;\n";
        html += "            gap: 6px;\n";
        html += "            color: var(--vscode-foreground);\n";
        html += "            user-select: none;\n";
        html += "        }\n";
        html += "        .cognitive-pill:hover {\n";
        html += "            opacity: 0.9;\n";
        html += "            background: rgba(255, 255, 255, 0.05);\n";
        html += "        }\n";
        html += "        .cognitive-pill.active {\n";
        html += "            opacity: 1;\n";
        html += "            background: var(--vscode-button-background);\n";
        html += "            color: var(--vscode-button-foreground);\n";
        html += "        }\n";
        html += "        #pill-move37.active {\n";
        html += "            background: linear-gradient(135deg, #9b59b6, #ff007f) !important;\n";
        html += "            color: white !important;\n";
        html += "            box-shadow: 0 0 10px rgba(155, 89, 182, 0.5);\n";
        html += "            animation: move37-pulse 1.5s infinite alternate;\n";
        html += "        }\n";
        html += "        @keyframes move37-pulse {\n";
        html += "            from { box-shadow: 0 0 10px rgba(155, 89, 182, 0.4), 0 0 20px rgba(255, 0, 127, 0.2); }\n";
        html += "            to { box-shadow: 0 0 15px rgba(155, 89, 182, 0.8), 0 0 30px rgba(255, 0, 127, 0.4); }\n";
        html += "        }\n";
        html += "        .input-container.move37-active textarea {\n";
        html += "            border-color: #9b59b6 !important;\n";
        html += "            box-shadow: 0 0 10px rgba(155, 89, 182, 0.3) !important;\n";
        html += "        }\n";
        html += "        /* --- SURGICAL REVIEW CARDS --- */\n";
        html += "        .review-card {\n";
        html += "            margin: 15px 0;\n";
        html += "            border: 1.5px solid var(--vscode-focusBorder);\n";
        html += "            border-radius: 8px; background: var(--vscode-editorWidget-background);\n";
        html += "            overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.3);\n";
        html += "            display: flex; flex-direction: column;\n";
        html += "            animation: popCard 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);\n";
        html += "        }\n";
        html += "        @keyframes popCard {\n";
        html += "            from { opacity: 0; transform: scale(0.95) translateY(10px); }\n";
        html += "            to { opacity: 1; transform: scale(1) translateY(0); }\n";
        html += "        }\n";
        html += "        .review-header {\n";
        html += "            background: var(--vscode-sideBarSectionHeader-background);\n";
        html += "            padding: 8px 12px; font-size: 11px; font-weight: bold;\n";
        html += "            color: var(--vscode-textLink-foreground); border-bottom: 1px solid var(--vscode-widget-border);\n";
        html += "            display: flex; justify-content: space-between; align-items: center;\n";
        html += "        }\n";
        html += "        .review-body {\n";
        html += "            padding: 12px 15px; font-size: 12px; line-height: 1.5;\n";
        html += "            display: flex; align-items: center; gap: 8px;\n";
        html += "        }\n";
        html += "        .review-actions-row {\n";
        html += "            display: flex; gap: 8px; padding: 8px 12px;\n";
        html += "            border-top: 1px solid var(--vscode-widget-border); background: rgba(0,0,0,0.15);\n";
        html += "        }\n";
        html += "        .review-btn-accept {\n";
        html += "            background: var(--vscode-charts-green) !important; color: white !important;\n";
        html += "            flex: 1; justify-content: center; height: 28px;\n";
        html += "        }\n";
        html += "        .review-btn-reject {\n";
        html += "            background: var(--vscode-charts-red) !important; color: white !important;\n";
        html += "            flex: 1; justify-content: center; height: 28px;\n";
        html += "        }\n";
        html += "        .spinner {\n";
        html += "            width: 14px; height: 14px; border-radius: 50%;\n";
        html += "            border: 2px solid rgba(255,255,255,0.2); border-top-color: var(--vscode-textLink-foreground);\n";
        html += "            animation: spin 0.8s linear infinite;\n";
        html += "        }\n";
        html += "        .plan-scratchpad {\n";
        html += "            border-left: 3px solid #9b59b6;\n";
        html += "            background: rgba(155, 13, 214, 0.03);\n";
        html += "            margin-bottom: 12px;\n";
        html += "            border-radius: 4px;\n";
        html += "        }\n";
        html += "        .code-collapsible {\n";
        html += "            margin-top: 10px;\n";
        html += "            border: 1px solid var(--vscode-widget-border);\n";
        html += "            border-radius: 6px;\n";
        html += "            background: rgba(0,0,0,0.2);\n";
        html += "            overflow: hidden;\n";
        html += "        }\n";
        html += "        .scratchpad-header {\n";
        html += "            padding: 6px 12px;\n";
        html += "            font-weight: bold;\n";
        html += "            color: #9b59b6;\n";
        html += "            cursor: pointer;\n";
        html += "            display: flex;\n";
        html += "            align-items: center;\n";
        html += "            gap: 6px;\n";
        html += "            font-size: 11px;\n";
        html += "        }\n";
        html += "        .scratchpad-content {\n";
        html += "            padding: 10px 15px;\n";
        html += "            font-size: 11px;\n";
        html += "            opacity: 0.9;\n";
        html += "            background: rgba(0,0,0,0.05);\n";
        html += "        }\n";
        html += "        .sidebar {\n";
        html += "            width: 300px;\n";
        html += "            border-right: 1px solid var(--vscode-panel-border);\n";
        html += "            display: flex; flex-direction: column;\n";
        html += "            background-color: var(--vscode-sideBar-background);\n";
        html += "            position: absolute;\n";
        html += "            top: 0; left: 0; bottom: 0;\n";
        html += "            z-index: 20;\n";
        html += "            transform: translateX(-100%);\n";
        html += "            transition: transform 0.3s ease-in-out;\n";
        html += "            box-shadow: 2px 0 5px rgba(0,0,0,0.3);\n";
        html += "        }\n";
        html += "        .sidebar.open {\n";
        html += "            transform: translateX(0);\n";
        html += "        }\n";
        html += "        .sidebar-overlay {\n";
        html += "            display: none;\n";
        html += "            position: fixed;\n";
        html += "            top: 0; left: 0; right: 0; bottom: 0;\n";
        html += "            background: rgba(0,0,0,0.5);\n";
        html += "            z-index: 10;\n";
        html += "        }\n";
        html += "        .sidebar-overlay.open { display: block; }\n";
        html += "        .sidebar-header {\n";
        html += "            padding: 10px;\n";
        html += "            font-weight: bold;\n";
        html += "            border-bottom: 1px solid var(--vscode-panel-border);\n";
        html += "            display: flex; justify-content: space-between; align-items: center;\n";
        html += "        }\n";
        html += "        .clear-btn { background: none; border: none; color: var(--vscode-errorForeground); cursor: pointer; }\n";
        html += "        .close-sidebar-btn { background: none; border: none; color: var(--vscode-foreground); cursor: pointer; font-size: 1.2em; }\n";
        html += "        .history-list {\n";
        html += "            flex: 1; overflow-y: auto;\n";
        html += "        }\n";
        html += "        .history-item {\n";
        html += "            padding: 8px 10px;\n";
        html += "            border-bottom: 1px solid var(--vscode-input-border);\n";
        html += "            cursor: pointer;\n";
        html += "            font-size: 0.9em;\n";
        html += "        }\n";
        html += "        .history-item:hover { background-color: var(--vscode-list-hoverBackground); }\n";
        html += "        .history-item.active { background-color: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }\n";
        html += "        .history-prompt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n";
        html += "        .history-actions { display: flex; justify-content: space-between; align-items: center; margin-top: 4px; opacity: 0.7; font-size: 0.8em; }\n";
        html += "        .delete-btn { background: none; border: none; color: var(--vscode-foreground); cursor: pointer; padding: 0 4px; }\n";
        html += "        .delete-btn:hover { color: var(--vscode-errorForeground); background-color: rgba(255,0,0,0.2); border-radius: 3px; }\n";
        html += "        .main {\n";
        html += "            flex: 1; display: flex; flex-direction: column; min-width: 0;\n";
        html += "            position: relative;\n";
        html += "        }\n";
        html += "        .header {\n";
        html += "            padding: 10px 20px;\n";
        html += "            background-color: var(--vscode-editorWidget-background);\n";
        html += "            border-bottom: 1px solid var(--vscode-widget-border);\n";
        html += "            display: flex; justify-content: space-between; align-items: center;\n";
        html += "        }\n";
        html += "        .header-left { display: flex; align-items: center; gap: 10px; }\n";
        html += "        .title { font-weight: 600; }\n";
        html += "        .content {\n";
        html += "            flex: 1; padding: 20px; overflow-y: auto; line-height: 1.6;\n";
        html += "        }\n";
        html += "        .input-area {\n";
        html += "            border-top: 1px solid var(--vscode-widget-border);\n";
        html += "            padding: 15px;\n";
        html += "            background-color: var(--vscode-editorWidget-background);\n";
        html += "        }\n";
        html += "        .context-info {\n";
        html += "            font-size: 0.8em;\n";
        html += "            color: var(--vscode-descriptionForeground);\n";
        html += "            margin-bottom: 8px;\n";
        html += "            display: flex;\n";
        html += "            align-items: center;\n";
        html += "            gap: 5px;\n";
        html += "        }\n";
        html += "        .input-container {\n";
        html += "            display: flex;\n";
        html += "            gap: 10px;\n";
        html += "            align-items: flex-end;\n";
        html += "        }\n";
        html += "        textarea {\n";
        html += "            flex: 1;\n";
        html += "            height: 60px;\n";
        html += "            resize: vertical;\n";
        html += "            background-color: var(--vscode-input-background);\n";
        html += "            color: var(--vscode-input-foreground);\n";
        html += "            border: 1px solid var(--vscode-input-border);\n";
        html += "            border-radius: 4px;\n";
        html += "            padding: 8px;\n";
        html += "            font-family: var(--vscode-font-family);\n";
        html += "        }\n";
        html += "        textarea:focus { border-color: var(--vscode-focusBorder); outline: none; }\n";
        html += "        button {\n";
        html += "            background-color: var(--vscode-button-background);\n";
        html += "            color: var(--vscode-button-foreground);\n";
        html += "            border: none; padding: 6px 12px; border-radius: 2px; cursor: pointer;\n";
        html += "            display: flex; align-items: center; gap: 5px;\n";
        html += "        }\n";
        html += "        button:hover { background-color: var(--vscode-button-hoverBackground); }\n";
        html += "        button:disabled { opacity: 0.6; cursor: not-allowed; }\n";
        html += "        button.secondary {\n";
        html += "            background-color: var(--vscode-button-secondaryBackground);\n";
        html += "            color: var(--vscode-button-secondaryForeground);\n";
        html += "        }\n";
        html += "        button:hover { filter: brightness(1.2); }\n";
        html += "        button.secondary:hover { background-color: var(--vscode-button-secondaryHoverBackground); }\n";
        html += "        /* --- INTEGRITY BADGE --- */\n";
        html += "        .integrity-badge {\n";
        html += "            display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px;\n";
        html += "            border-radius: 12px; background: rgba(46, 204, 113, 0.1); border: 1px solid var(--vscode-charts-green);\n";
        html += "            color: var(--vscode-charts-green); font-size: 9px; font-weight: bold;\n";
        html += "            text-transform: uppercase;\n";
        html += "        }\n";
        html += "        .icon-btn {\n";
        html += "            background: none; border: none; color: var(--vscode-icon-foreground); \n";
        html += "            cursor: pointer; padding: 2px; margin-right: 5px; min-width: 24px;\n";
        html += "        }\n";
        html += "        .icon-btn:hover { color: var(--vscode-foreground); background-color: var(--vscode-toolbar-hoverBackground); }\n";
        html += "        .icon-btn.attached { color: var(--vscode-textLink-foreground); background-color: var(--vscode-editor-inactiveSelectionBackground); }\n"; 
        html += "        code { font-family: var(--vscode-editor-font-family); background-color: var(--vscode-textCodeBlock-background); padding: 2px 4px; border-radius: 3px; }\n";
        html += "        pre { background-color: var(--vscode-textCodeBlock-background); padding: 16px; border-radius: 5px; overflow-x: auto; position: relative; }\n";
        html += "        pre button.copy-code { position: absolute; top: 5px; right: 5px; opacity: 0.7; }\n";
        html += "        pre button.copy-code:hover { opacity: 1; }\n";
        html += "        @keyframes spin { 100% { transform: rotate(360deg); } }\n";
        html += "        .spin { animation: spin 1s linear infinite; }\n";
        html += "        /* Aider Hunk Visualizer Styles */\n";
        html += "        .hunk-tabs-container { display: flex; flex-direction: column; background-color: var(--vscode-editor-inactiveSelectionBackground); border-top: 1px solid var(--vscode-widget-border); }\n";
        html += "        .hunk-tabs-nav { display: flex; flex-wrap: wrap; gap: 2px; padding: 4px 8px 0 8px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-widget-border); }\n";
        html += "        .hunk-tab { padding: 4px 10px; font-size: 10px; font-weight: 800; cursor: pointer; border-radius: 4px 4px 0 0; border: 1px solid transparent; border-bottom: none; opacity: 0.6; display: flex; align-items: center; gap: 6px; }\n";
        html += "        .hunk-tab:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }\n";
        html += "        .hunk-tab.active { opacity: 1; background: var(--vscode-editor-background); border-color: var(--vscode-widget-border); margin-bottom: -1px; z-index: 2; }\n";
        html += "        .hunk-tab.status-completed { color: var(--vscode-charts-green); }\n";
        html += "        .hunk-tab-content { display: none; padding: 0; background: var(--vscode-editor-background); }\n";
        html += "        .hunk-tab-content.active { display: flex; flex-direction: column; }\n";
        html += "        .aider-hunk-bubble { width: 100%; box-sizing: border-box; display: flex; flex-direction: column; }\n";
        html += "        .aider-hunk-content { padding: 0; max-height: 300px; overflow-y: auto; }\n";
        html += "        .aider-hunk-header { display: flex; justify-content: space-between; align-items: center; padding: 6px 12px; background-color: var(--vscode-keybindingTable-headerBackground); border-bottom: 1px solid var(--vscode-widget-border); font-size: 11px; font-weight: 700; color: var(--vscode-descriptionForeground); }\n";
        html += "        .aider-hunk-actions { display: flex; gap: 6px; }\n";
        html += "        .aider-diff-line { display: flex; width: 100%; font-family: var(--vscode-editor-font-family); font-size: 11px; line-height: 1.5; white-space: pre; }\n";
        html += "        .aider-diff-removed { background-color: rgba(244, 71, 71, 0.15); color: var(--vscode-charts-red); }\n";
        html += "        .aider-diff-added { background-color: rgba(15, 157, 88, 0.15); color: var(--vscode-charts-green); }\n";
        html += "        .aider-diff-unchanged { opacity: 0.6; }\n";
        html += "        .aider-diff-code { padding: 0 12px; }\n";
        html += "    </style>\n";
        html += "</head>\n";
        html += "<body>\n";
        html += "    <div class=\"sidebar-overlay\" onclick=\"toggleHistory()\"></div>\n";
        html += "    <div class=\"sidebar\" id=\"sidebar\">\n";
        html += "        <div class=\"sidebar-header\">\n";
        html += "            <span>History</span>\n";
        html += "            <div>\n";
        html += "                <button class=\"clear-btn\" onclick=\"clearHistory()\" title=\"Clear All\" style=\"display:inline;\">Clear</button>\n";
        html += "                <button class=\"close-sidebar-btn\" onclick=\"toggleHistory()\" title=\"Close\">✕</button>\n";
        html += "            </div>\n";
        html += "        </div>\n";
        html += "        <div class=\"history-list\" id=\"history-list\"></div>\n";
        html += "    </div>\n";
        html += "    <div class=\"main\">\n";
        html += "        <div class=\"header\">\n";
        html += "            <div class=\"header-left\">\n";
        html += "                <button class=\"secondary\" onclick=\"toggleHistory()\" title=\"Show History\">\n";
        html += "                    <span class=\"codicon codicon-history\"></span>\n";
        html += "                </button>\n";
        html += "                <div class=\"friend-avatar-container\" title=\"Lollms - Your best coding friend, always here to help!\">\n";
        html += "                    <div class=\"robot-face\" id=\"friend-face\">\n";
        html += "                        <div class=\"robot-eye\"></div>\n";
        html += "                        <div class=\"robot-eye\"></div>\n";
        html += "                        <div class=\"robot-mouth\"></div>\n";
        html += "                    </div>\n";
        html += "                </div>\n";
        html += "                <span class=\"title\">Lollms Companion</span>\n";
        html += "                <div class=\"integrity-badge\" title=\"Operates with zero telemetry, protecting your IP.\">\n";
        html += "                    <span class=\"codicon codicon-shield\"></span> Zero-Telemetry\n";
        html += "                </div>\n";
        html += "            </div>\n";
        html += "            <div class=\"actions\" style=\"display:flex; gap:8px;\">\n";
        html += "                <button class=\"secondary danger\" onclick=\"clearResponse()\" title=\"Wipe Memory (Start Over)\"><span class=\"codicon codicon-trash\"></span> Wipe</button>\n";
        html += "                <button class=\"secondary\" onclick=\"copyFullResponse()\" title=\"Copy Markdown\"><span class=\"codicon codicon-copy\"></span></button>\n";
        html += "            </div>\n";
        html += "        </div>\n";
        
        // Friendship Scratchpad & Affective Matrix HUD
        html += "        <div class=\"affective-matrix\">\n";
        html += "            <div class=\"matrix-header\">\n";
        html += "                <span>Symbiosis State: <span id=\"matrix-label-text\">Symbiotic</span></span>\n";
        html += "                <span id=\"matrix-score-val\">75%</span>\n";
        html += "            </div>\n";
        html += "            <div class=\"matrix-bar\">\n";
        html += "                <div class=\"matrix-bar-fill\" id=\"matrix-bar-fill\"></div>\n";
        html += "            </div>\n";
        html += "        </div>\n";

        html += "        <div class=\"friendship-hud\">\n";
        html += "            <details open>\n";
        html += "                <summary class=\"hud-header\">\n";
        html += "                    <span><i class=\"codicon codicon-chip\"></i> Friendship Scratchpad (Short Term Memory)</span>\n";
        html += "                </summary>\n";
        html += "                <div class=\"hud-scroll-container\" id=\"hud-scratchpad-body\">\n";
        html += "                    Standing by. Ready to pair-program with you!\n";
        html += "                </div>\n";
        html += "            </details>\n";
        html += "        </div>\n";

        html += "        <div class=\"content\" id=\"markdown-content\"></div>\n";
        html += "        <div class=\"input-area-wrapper\">\n";
        html += "            <div class=\"input-area-container\">\n";
        html += "                <div class=\"cognitive-toolbar\" style=\"display: flex; gap: 6px; margin: 0 16px 10px 16px; justify-content: center;\">\n";
        html += "                    <div class=\"cognitive-pill active\" id=\"pill-standard\" onclick=\"setCognitiveMode('standard')\">\n";
        html += "                        <span class=\"codicon codicon-workspace-trusted\"></span> Focused Co-Pilot\n";
        html += "                    </div>\n";
        html += "                    <div class=\"cognitive-pill\" id=\"pill-grounding\" onclick=\"setCognitiveMode('grounding')\">\n";
        html += "                        <span class=\"codicon codicon-layers\"></span> Grounding Mode\n";
        html += "                    </div>\n";
        html += "                    <div class=\"cognitive-pill\" id=\"pill-move37\" onclick=\"setCognitiveMode('move37')\">\n";
        html += "                        <span class=\"codicon codicon-sparkle\"></span> Move 37\n";
        html += "                    </div>\n";
        html += "                </div>\n";
        html += "                <div class=\"input-area\">\n";
        html += "                    <div class=\"context-info\" style=\"margin-bottom: 8px; font-size: 11px; display: flex; align-items: center; gap: 6px; color: var(--vscode-descriptionForeground);\">\n";
        html += "                        <span class=\"codicon codicon-target\"></span>\n";
        html += "                        <span id=\"context-info-text\">Syncing...</span>\n";
        html += "                    </div>\n";
        html += "                    <div class=\"rich-input-toolbar\" style=\"border: none; border-radius: 0; background: transparent; padding: 2px 0; margin-bottom: 8px; border-bottom: 1px solid var(--vscode-widget-border);\">\n";
        html += "                        <button class=\"toolbar-tool\" onclick=\"wrapText('python')\" title=\"Python Block\"><i class=\"codicon codicon-symbol-method\"></i><span>Python</span></button>\n";
        html += "                        <button class=\"toolbar-tool\" onclick=\"wrapText('code')\" title=\"Code Block\"><i class=\"codicon codicon-code\"></i><span>Code</span></button>\n";
        html += "                        <div class=\"toolbar-separator\"></div>\n";
        html += "                        <button class=\"toolbar-tool\" onclick=\"wrapText('h1')\" title=\"Heading 1\"><span>H1</span></button>\n";
        html += "                        <button class=\"toolbar-tool\" onclick=\"wrapText('h2')\" title=\"Heading 2\"><span>H2</span></button>\n";
        html += "                        <button class=\"toolbar-tool\" onclick=\"wrapText('h3')\" title=\"Heading 3\"><span>H3</span></button>\n";
        html += "                        <div class=\"toolbar-separator\"></div>\n";
        html += "                        <button class=\"toolbar-tool\" onclick=\"wrapText('list')\" title=\"Bullet List\"><i class=\"codicon codicon-list-unordered\"></i></button>\n";
        html += "                        <button class=\"toolbar-tool\" onclick=\"wrapText('bold')\" title=\"Bold\"><i class=\"codicon codicon-bold\"></i></button>\n";
        html += "                        <button class=\"toolbar-tool\" onclick=\"wrapText('italic')\" title=\"Italic\"><i class=\"codicon codicon-italic\"></i></button>\n";
        html += "                    </div>\n";
        html += "                    <div class=\"input-row\">\n";
        html += "                        <div class=\"control-buttons\">\n";
        html += "                            <button id=\"moreActionsButton\" title=\"Menu\" onclick=\"toggleHistory()\"><i class=\"codicon codicon-menu\"></i></button>\n";
        html += "                        </div>\n";
        html += "                        <textarea id=\"prompt-input\" placeholder=\"Ask a question or request a change...\"></textarea>\n";
        html += "                        <div class=\"control-buttons\">\n";
        html += "                            <button onclick=\"submitPrompt()\" id=\"send-btn\" title=\"Send Message\"><i class=\"codicon codicon-send\"></i></button>\n";
        html += "                        </div>\n";
        html += "                    </div>\n";
        html += "                </div>\n";
        html += "            </div>\n";
        html += "        </div>\n";
        html += "    </div>\n";
        html += "    <script>\n";
        html += "        const vscode = acquireVsCodeApi();\n";
        html += "        const container = document.getElementById('markdown-content');\n";
        html += "        const promptInput = document.getElementById('prompt-input');\n";
        html += "        const move37Btn = document.getElementById('pill-move37');\n";
        html += "        let isMove37Active = false;\n";
        html += "        let activeContentBuffer = \"\";\n";
        html += "        let activePrompt = \"\";\n";        
        html += "        let activeMood = 'idle';\n";
        html += "        \n";
        html += "        vscode.postMessage({ command: 'webview-ready' });\n";
        html += "        \n";
        html += "        let activeMode = 'standard';\n";
        html += "        function setCognitiveMode(mode) {\n";
        html += "            activeMode = mode;\n";
        html += "            isMove37Active = (mode === 'move37');\n";
        html += "            document.getElementById('pill-standard').classList.toggle('active', mode === 'standard');\n";
        html += "            document.getElementById('pill-grounding').classList.toggle('active', mode === 'grounding');\n";
        html += "            document.getElementById('pill-move37').classList.toggle('active', mode === 'move37');\n";
        html += "            document.getElementById('input-container').classList.toggle('move37-active', isMove37Active);\n";
        html += "            \n";
        html += "            const inp = document.getElementById('prompt-input');\n";
        html += "            if (isMove37Active) {\n";
        html += "                inp.placeholder = 'Unleash a lateral leap... Propose an unexpected, elegant shortcut.';\n";
        html += "                setMood('thinking');\n";
        html += "                vscode.postMessage({ command: 'adjustTrustScore', delta: 2 });\n";
        html += "            } else if (mode === 'grounding') {\n";
        html += "                inp.placeholder = 'Query the entire project with full context...';\n";
        html += "                setMood('idle');\n";
        html += "            } else {\n";
        html += "                inp.placeholder = 'Ask a question or request a change...';\n";
        html += "                setMood('idle');\n";
        html += "            }\n";
        html += "        }\n";
        html += "        \n";
        html += "        function toggleHistory() {\n";
        html += "            document.getElementById('sidebar').classList.toggle('open');\n";
        html += "            document.querySelector('.sidebar-overlay').classList.toggle('open');\n";
        html += "        }\n";
        html += "        function toggleAttach() {\n";
        html += "            vscode.postMessage({ command: 'toggleAttach' });\n";
        html += "        }\n";
        
        // Exact, double-escaped index-based processThinkTags function
        html += "        function processThinkTags(content) {\n";
        html += "            var thoughts = [];\n";
        html += "            if (typeof content !== 'string') return { thoughts: thoughts, processedContent: '' };\n";
        html += "            var openTags = ['<think>', '<thinking>', '<analysis>', '<reasoning>'];\n";
        html += "            var closeTags = ['</think>', '</thinking>', '</analysis>', '</reasoning>'];\n";
        html += "            var protectedRanges = [];\n";
        html += "            var fenceRegex = new RegExp('\\\\x60{3}[\\\\s\\\\S]*?(?:\\\\x60{3}|$)|\\\\x60[^\\\\x60\\\\n\\\\r]+\\\\x60', 'g');\n";
        html += "            var fMatch;\n";
        html += "            while ((fMatch = fenceRegex.exec(content)) !== null) {\n";
        html += "                protectedRanges.push({ start: fMatch.index, end: fMatch.index + fMatch[0].length });\n";
        html += "            }\n";
        html += "            var isProtected = function(index) {\n";
        html += "                return protectedRanges.some(function(r) { return index >= r.start && index < r.end; });\n";
        html += "            };\n";
        html += "            var processedContent = '';\n";
        html += "            var remaining = content;\n";
        html += "            var currentOffset = 0;\n";
        html += "            while (remaining.length > 0) {\n";
        html += "                var firstOpenIdx = -1;\n";
        html += "                var activeOpenTag = '';\n";
        html += "                for (var i = 0; i < openTags.length; i++) {\n";
        html += "                    var tag = openTags[i];\n";
        html += "                    var idx = remaining.indexOf(tag);\n";
        html += "                    if (idx !== -1 && !isProtected(currentOffset + idx)) {\n";
        html += "                        if (firstOpenIdx === -1 || idx < firstOpenIdx) {\n";
        html += "                            firstOpenIdx = idx;\n";
        html += "                            activeOpenTag = tag;\n";
        html += "                        }\n";
        html += "                    }\n";
        html += "                }\n";
        html += "                if (firstOpenIdx === -1) {\n";
        html += "                    processedContent += remaining;\n";
        html += "                    break;\n";
        html += "                }\n";
        html += "                processedContent += remaining.substring(0, firstOpenIdx);\n";
        html += "                var activeCloseTag = activeOpenTag.replace('<', '</');\n";
        html += "                var searchStartIdx = firstOpenIdx + activeOpenTag.length;\n";
        html += "                var closeIdx = remaining.indexOf(activeCloseTag, searchStartIdx);\n";
        html += "                while (closeIdx !== -1 && isProtected(currentOffset + closeIdx)) {\n";
        html += "                    closeIdx = remaining.indexOf(activeCloseTag, closeIdx + 1);\n";
        html += "                }\n";
        html += "                if (closeIdx === -1) {\n";
        html += "                    var thoughtContent = remaining.substring(searchStartIdx);\n";
        html += "                    thoughts.push({\n";
        html += "                        tag: activeOpenTag.replace(/[<>]/g, ''),\n";
        html += "                        content: thoughtContent.trim(),\n";
        html += "                        closed: false\n";
        html += "                    });\n";
        html += "                    break;\n";
        html += "                }\n";
        html += "                var thoughtContent = remaining.substring(searchStartIdx, closeIdx);\n";
        html += "                thoughts.push({\n";
        html += "                    tag: activeOpenTag.replace(/[<>]/g, ''),\n";
        html += "                    content: thoughtContent.trim(),\n";
        html += "                    closed: true\n";
        html += "                });\n";
        html += "                var nextOffset = closeIdx + activeCloseTag.length;\n";
        html += "                currentOffset += nextOffset;\n";
        html += "                remaining = remaining.substring(nextOffset);\n";
        html += "            }\n";
        html += "            return { thoughts: thoughts, processedContent: processedContent.trim() };\n";
        html += "        }\n";

        html += "        function renderUserBubble(text) {\n";
        html += "            const bubble = document.createElement('div');\n";
        html += "            bubble.className = 'message-wrapper user-msg-wrapper';\n";
        html += "            bubble.dataset.messageId = 'user_companion_msg';\n";
        html += "            bubble.style.cssText = \"margin-bottom: 20px; padding: 12px 16px; border-radius: 8px; border: 1px solid var(--vscode-widget-border); border-left: 4px solid var(--vscode-charts-blue); background: var(--vscode-editor-inactiveSelectionBackground); position: relative;\";\n";

        html += "            const header = document.createElement('div');\n";
        html += "            header.style.cssText = \"font-size: 11px; font-weight: bold; margin-bottom: 8px; opacity: 0.8; display: flex; align-items: center; gap: 6px;\";\n";
        html += "            header.innerHTML = '<span class=\"codicon codicon-account\"></span> <span>You (Selection Prompt)</span>';\n";

        html += "            const actions = document.createElement('div');\n";
        html += "            actions.className = 'message-actions';\n";
        html += "            actions.style.cssText = 'position: absolute; top: 10px; right: 10px; display: flex; gap: 4px;';\n";
        html += "            actions.innerHTML = '<button class=\"msg-action-btn edit-msg-btn\" onclick=\"event.stopPropagation(); startEdit(this.closest(\\\'.message-wrapper\\\'), \\\'user_companion_msg\\\', \\\'user\\\')\"><i class=\"codicon codicon-edit\"></i></button>';\n";

        html += "            const bodyEscaped = '\"font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-all;\"';\n";
        html += "            const body = document.createElement('div');\n";
        html += "            body.className = 'message-content';\n";
        html += "            body.style.cssText = bodyEscaped;\n";
        html += "            body.textContent = text;\n";
        html += "            bubble.appendChild(header);\n";
        html += "            bubble.appendChild(actions);\n";
        html += "            bubble.appendChild(body);\n";
        html += "            container.appendChild(bubble);\n";
        html += "            container.scrollTop = container.scrollHeight;\n";
        html += "            // Expose original content for the editor view\n";
        html += "            bubble.dataset.originalContent = JSON.stringify(text);\n";
        html += "        }\n";

        html += "        function setFaceMood(state) { \n";
        html += "            const face = document.getElementById('friend-face');\n";
        html += "            if (!face) return;\n";
        html += "            if (state === 'speaking') {\n";
        html += "                face.className = 'robot-face speaking';\n";
        html += "            } else if (state === 'thinking') {\n";
        html += "                face.className = 'robot-face thinking';\n";
        html += "            } else {\n";
        html += "                face.className = 'robot-face idle';\n";
        html += "            }\n";
        html += "        }\n";
        html += "        \n";
        html += "        function wrapText(type) {\n";
        html += "            const input = document.getElementById('prompt-input');\n";
        html += "            if (!input) return;\n";
        html += "            const start = input.selectionStart;\n";
        html += "            const end = input.selectionEnd;\n";
        html += "            const selected = input.value.substring(start, end);\n";
        html += "            let before = '';\n";
        html += "            let after = '';\n";
        html += "            let replacement = selected;\n";
        html += "            switch (type) {\n";
        html += "                case 'python': before = '```python\\n'; after = '\\n```'; break;\n";
        html += "                case 'code': before = '```\\n'; after = '\\n```'; break;\n";
        html += "                case 'bold': before = '**'; after = '**'; break;\n";
        html += "                case 'italic': before = '*'; after = '*'; break;\n";
        html += "                case 'h1': before = '# '; break;\n";
        html += "                case 'h2': before = '## '; break;\n";
        html += "                case 'h3': before = '### '; break;\n";
        html += "                case 'list': before = '- '; replacement = selected.split('\\n').join('\\n- '); break;\n";
        html += "            }\n";
        html += "            input.value = input.value.substring(0, start) + before + replacement + after + input.value.substring(end);\n";
        html += "            input.focus();\n";
        html += "            const newCursorPos = start + before.length + replacement.length + after.length;\n";
        html += "            input.setSelectionRange(newCursorPos, newCursorPos);\n";
        html += "        }\n";
        html += "        window.wrapText = wrapText;\n";

        html += "        function setMood(mood) {\n";
        html += "            const face = document.getElementById('friend-face');\n";
        html += "            if (!face) return;\n";
        html += "            activeMood = mood;\n";
        html += "            face.className = 'robot-face ' + mood;\n";
        html += "        }\n";

        html += "        function updateTrustScore(score) {\n";
        html += "            const fill = document.getElementById('matrix-bar-fill');\n";
        html += "            const scoreVal = document.getElementById('matrix-score-val');\n";
        html += "            const labelText = document.getElementById('matrix-label-text');\n";
        html += "            if (!fill || !scoreVal || !labelText) return;\n";
        html += "            fill.style.width = score + '%';\n";
        html += "            scoreVal.textContent = score + '%';\n";
        html += "            if (score > 80) {\n";
        html += "                labelText.textContent = 'Symbiotic Partnership 🧬';\n";
        html += "                labelText.style.color = 'var(--vscode-charts-green)';\n";
        html += "            } else if (score > 60) {\n";
        html += "                labelText.textContent = 'Trusting';\n";
        html += "                labelText.style.color = '#9b59b6';\n";
        html += "            } else {\n";
        html += "                labelText.textContent = 'Unaligned / Guarded 🛡️';\n";
        html += "                labelText.style.color = 'var(--vscode-charts-orange)';\n";
        html += "            }\n";
        html += "        }\n";

        html += "        function submitPrompt() {\n";
        html += "            let text = promptInput.value.trim();\n";
        html += "            if (!text) return;\n";
        html += "            activePrompt = text;\n";
        html += "            container.innerHTML = \"\";\n";
        html += "            renderUserBubble(text);\n";
        html += "            const waiting = document.createElement('div');\n";
        html += "            waiting.id = 'companion-waiting-placeholder';\n";
        html += "            waiting.style.cssText = \"display: flex; align-items: center; gap: 8px; padding: 12px; color: var(--vscode-descriptionForeground); font-style: italic;\";\n";
        html += "            waiting.innerHTML = '<span class=\"codicon codicon-sync spin\"></span> Connecting to Lollms...';\n";
        html += "            container.appendChild(waiting);\n";
        html += "            setMood('thinking');\n";
        html += "            \n";
        html += "            if (isMove37Active) {\n";
        html += "                text = '[MOVE 37: SERENDIPITY SPARK]\\n' + text;\n";
        html += "                setCognitiveMode('standard');\n";
        html += "            }\n";
        html += "            \n";
        html += "            vscode.postMessage({ command: 'submitPrompt', text: text, mode: activeMode });\n";
        html += "            promptInput.value = '';\n";
        html += "        }\n";

        html += "        promptInput.addEventListener('keydown', (e) => {\n";
        html += "            if (e.key === 'Enter' && !e.shiftKey) {\n";
        html += "                e.preventDefault();\n";
        html += "                submitPrompt();\n";
        html += "            }\n";
        html += "        });\n";
        html += "        promptInput.focus();\n";

        html += "        window.addEventListener('message', event => {\n";
        html += "            const message = event.data;\n";
        html += "            switch (message.command) {\n";
        html += "                case 'updateContextInfo':\n";
        html += "                    document.getElementById('context-info-text').textContent = message.text;\n";
        html += "                    break;\n";
        html += "                case 'updateAttachState':\n";
        html += "                    const btn = document.getElementById('attach-btn');\n";
        html += "                    if (message.isAttached) {\n";
        html += "                        btn.classList.add('attached');\n";
        html += "                        btn.title = \"Detach from context\";\n";
        html += "                    } else {\n";
        html += "                        btn.classList.remove('attached');\n";
        html += "                        btn.title = \"Attach to current context\";\n";
        html += "                    }\n";
        html += "                    break;\n";
        html += "                case 'setLoading':\n";
        html += "                    const sendBtn = document.getElementById('send-btn');\n";
        html += "                    if (message.isLoading) {\n";
        html += "                        sendBtn.disabled = true;\n";
        html += "                        sendBtn.innerHTML = '<span class=\"codicon codicon-sync spin\"></span>';\n";
        html += "                    } else {\n";
        html += "                        sendBtn.disabled = false;\n";
        html += "                        sendBtn.innerHTML = '<span class=\"codicon codicon-send\"></span> Send';\n";
        html += "                        promptInput.focus();\n";
        html += "                        setFaceMood('idle');\n";
        html += "                    }\n";
        html += "                    break;\n";
        html += "                case 'updateTrustScore':\n";
        html += "                    updateTrustScore(message.score);\n";
        html += "                    break;\n";
        html += "                case 'setMood':\n";
        html += "                    setMood(message.mood);\n";
        html += "                    break;\n";
        html += "                case 'appendChunk':\n";
        html += "                    const waiting = document.getElementById('companion-waiting-placeholder');\n";
        html += "                    if (waiting) waiting.remove();\n";
        html += "                    appendChunk(message.text);\n";
        html += "                    break;\n";
        html += "                case 'renderResponse':\n";
        html += "                    const w = document.getElementById('companion-waiting-placeholder');\n";
        html += "                    if (w) w.remove();\n";
        html += "                    if (message.prompt) {\n";
        html += "                        activePrompt = message.prompt;\n";
        html += "                    }\n";        
        html += "                    renderResponse(message.text, message.prompt, message.isFinal);\n";
        html += "                    setFaceMood('idle');\n";
        html += "                    break;\n";
        html += "                case 'clearResponse':\n";
        html += "                    container.innerHTML = \"\";\n";
        html += "                    renderResponse(\"\", \"\");\n";
        html += "                    document.getElementById('hud-scratchpad-body').textContent = 'Standing by. Ready to pair-program with you!';\n";
        html += "                    break;\n";
        html += "                case 'updateHistory':\n";
        html += "                    const list = document.getElementById('history-list');\n";
        html += "                    if (list) {\n";
        html += "                        list.innerHTML = (message.history || []).map(h => {\n";
        html += "                            const shortPrompt = h.prompt.substring(0, 50) + (h.prompt.length > 50 ? '...' : '');\n";
        html += "                            const timeStr = new Date(h.timestamp).toLocaleTimeString();\n";
        html += "                            return '<div class=\"history-item\" onclick=\"loadHistory(\\'' + h.id + '\\')\">' +\n";
        html += "                                '<div class=\"history-prompt\" title=\"' + h.prompt.replace(/\"/g, '&quot;') + '\">' + shortPrompt + '</div>' +\n";
        html += "                                '<div class=\"history-actions\">' +\n";
        html += "                                    '<span class=\"history-time\">' + timeStr + '</span>' +\n";
        html += "                                    '<button class=" + '"delete-btn"' + " onclick=\"deleteHistory(event, \\'' + h.id + '\\')\">×</button>' +\n";
        html += "                                '</div>' +\n";
        html += "                            '</div>';\n";
        html += "                        }).join('');\n";
        html += "                    }\n";
        html += "                    break;\n";

        html += "                case 'applyAllResult':\n";
        html += "                    const card = document.getElementById(message.blockId);\n";
        html += "                    if (card) {\n";
        html += "                        if (card.classList.contains('sparql-block')) {\n";
        html += "                            // Resolve the SPARQL execution view inside the Companion\n";
        html += "                            const headerActions = card.querySelector('.generation-header .code-actions');\n";
        html += "                            if (headerActions) {\n";
        html += "                                headerActions.innerHTML = '<i class=\"codicon codicon-check\" style=\"color: var(--vscode-charts-green)\"></i>';\n";
        html += "                            }\n";
        html += "                            const renderArea = card.querySelector('.sparql-results-render-area');\n";
        html += "                            if (renderArea && message.sparqlResult) {\n";
        html += "                                renderArea.style.display = 'block';\n";
        html += "                                renderArea.innerHTML = DOMPurify.sanitize(marked.parse(message.sparqlResult));\n";
        html += "                            }\n";
        html += "                        } else {\n";
        html += "                            const loader = card.querySelector('.spinner');\n";
        html += "                            if (loader) loader.style.display = 'none';\n";
        html += "                            const actions = card.querySelector('.review-actions-row');\n";
        html += "                            const body = card.querySelector('.review-body');\n";
        html += "                            if (actions) {\n";
        html += "                                actions.style.display = 'flex';\n";
        html += "                                if (message.success) {\n";
        html += "                                    if (body) body.innerHTML = '🏆 <b>Code successfully applied to disk!</b> Please review the changes live in your editor and select your final decision below:';\n";
        html += "                                    setMood('success');\n";
        html += "                                } else {\n";
        html += "                                    if (body) body.innerHTML = '<span style=\\\"color:var(--vscode-charts-red); font-weight:bold;\\\">⚠️ Write Failure:</span> ' + (message.error || 'Unknown error');\n";
        html += "                                    setMood('error');\n";
        html += "                                }\n";
        html += "                            }\n";
        html += "                        }\n";
        html += "                    }\n";
        html += "                    break;\n";
        html += "            }\n";
        html += "        });\n";

        html += "        function renderResponse(text, prompt, isFinal) {\n";
        html += "            activeContentBuffer = text;\n";
        html += "            if (!text) {\n";
        html += "                container.innerHTML = '<div style=" + '"color: var(--vscode-descriptionForeground); text-align: center; margin-top: 40px;"' + "><h3>Layout Active</h3><p>Start a new conversation session to begin.</p></div>';\n";
        html += "                return;\n";
        html += "            }\n";
        html += "            const parsed = processThinkTags(activeContentBuffer);\n";
        html += "            let thoughtsHtml = \"\";\n";
        html += "            if (parsed.thoughts.length > 0) {\n";
        html += "                const latestThought = parsed.thoughts[parsed.thoughts.length - 1].content;\n";
        html += "                const hudText = latestThought.length > 150 ? latestThought.substring(0, 150) + '...' : latestThought;\n";
        html += "                document.getElementById('hud-scratchpad-body').textContent = hudText;\n";
        html += "                parsed.thoughts.forEach((t, idx) => {\n";
        html += "                    const isClosed = t.closed || true;\n";
        html += "                    const iconHtml = isClosed ? '<span class=\"codicon codicon-circuit-board\"></span>' : '<span class=\"codicon codicon-sync spin\" style=\"color:#9b59b6;\"></span>';\n";
        html += "                    thoughtsHtml += '<div class=\"plan-scratchpad\" data-idx=\"' + idx + '\">' +\n";
        html += "                        '<details ' + (!isClosed ? 'open' : '') + '>' +\n";
        html += "                            '<summary class=\"scratchpad-header\">' +\n";
        html += "                                '<div style=\"display: flex; align-items: center; gap: 6px;\">' +\n";
        html += "                                    iconHtml +\n";
        html += "                                    '<span style=\"font-weight: bold;\">Thoughts (Reasoning)' + (!isClosed ? '...' : '') + '</span>' +\n";
        html += "                                '</div>' +\n";
        html += "                            '</summary>' +\n";
        html += "                            '<div class=\"scratchpad-content\">' +\n";
        html += "                                DOMPurify.sanitize(marked.parse(t.content || \"*AI is contemplating...*\")) +\n";
        html += "                            '</div>' +\n";
        html += "                        '</details>' +\n";
        html += "                    '</div>';\n";
        html += "                });\n";
        html += "            }\n";

        // Parse SPARQL-lite XML tags inside incoming text streams
        html += "            let finalMarkdown = parsed.processedContent;\n";
        html += "            const sparqlRegex = /<query_architecture>([\\s\\S]*?)<\\/query_architecture>/gi;\n";
        html += "            finalMarkdown = finalMarkdown.replace(sparqlRegex, (match, query) => {\n";
        html += "                const blockId = 'sparql-companion-' + Date.now();\n";
        html += "                return renderSparqlWidget(blockId, query.trim());\n";
        html += "            });\n";

        html += "            container.innerHTML = \"\";\n";
        html += "            if (prompt) {\n";
        html += "                renderUserBubble(prompt);\n";
        html += "            }\n";


        // --- START OF SELECTED CODE INTEGRATION ---
        html += "            const responseContainer = document.createElement('div');\n";
        html += "            responseContainer.className = 'message-wrapper assistant-msg-wrapper';\n";
        html += "            responseContainer.dataset.messageId = 'assistant_companion_msg';\n";
        html += "            responseContainer.style.cssText = \"margin-bottom: 20px; padding: 12px 16px; border-radius: 8px; border: 1px solid var(--vscode-widget-border); border-left: 4px solid var(--vscode-charts-green); background: var(--vscode-editor-background); position: relative;\";\n";
        html += "            const responseHeader = document.createElement('div');\n";
        html += "            responseHeader.style.cssText = \"font-size: 11px; font-weight: bold; margin-bottom: 8px; opacity: 0.8; display: flex; align-items: center; gap: 6px; color: var(--vscode-textLink-foreground);\";\n";
        html += "            responseHeader.innerHTML = '<span class=\"codicon codicon-sparkle\"></span> <span>Lollms Response</span>';\n";
        html += "            const actions = document.createElement('div');\n";
        html += "            actions.className = 'message-actions';\n";
        html += "            actions.style.cssText = 'position: absolute; top: 10px; right: 10px; display: flex; gap: 4px;';\n";
        html += "            actions.innerHTML = '<button class=\"msg-action-btn edit-msg-btn\" onclick=\"event.stopPropagation(); startEdit(this.closest(\\\'.message-wrapper\\\'), \\\'assistant_companion_msg\\\', \\\'assistant\\\')\"><i class=\"codicon codicon-edit\"></i></button>';\n";
        html += "            const responseBody = document.createElement('div');\n";
        html += "            responseBody.className = \"markdown-body message-content\";\n";
        html += "            responseBody.innerHTML = thoughtsHtml + DOMPurify.sanitize(marked.parse(finalMarkdown), {\n";
        html += "                ADD_TAGS: ['div', 'pre', 'button', 'span', 'i'],\n";
        html += "                ADD_ATTR: ['class', 'style', 'data-query', 'data-block-id', 'onclick']\n";
        html += "            });\n";
        html += "            responseContainer.appendChild(responseHeader);\n";
        html += "            responseContainer.appendChild(actions);\n";
        html += "            responseContainer.appendChild(responseBody);\n";
        html += "            container.appendChild(responseContainer);\n";
        html += "            responseContainer.dataset.originalContent = JSON.stringify(text);\n";

        // Inject Workspace Action Event Parsers inside Markdown Streams
        html += "            let parsedHtml = thoughtsHtml + DOMPurify.sanitize(marked.parse(finalMarkdown), {\n";
        html += "                ADD_TAGS: ['div', 'pre', 'button', 'span', 'i', 'a'],\n";
        html += "                ADD_ATTR: ['class', 'style', 'data-query', 'data-block-id', 'onclick', 'data-action', 'data-path', 'data-line', 'data-text']\n";
        html += "            });\n";
        html += "            \n";
        // Parse custom interactive links and trigger them automatically on render
        html += "            const actionRegex = /<(open_file|select_code|set_breakpoint|run_script)\\s+([^>]*?)\\s*\\/>/gi;\n";
        html += "            parsedHtml = parsedHtml.replace(actionRegex, (match, action, attrStr) => {\n";
        html += "                const attrs = {};\n";
        html += "                attrStr.replace(/(\\w+)=[\"']([^\"']*)[\"']/g, (_, k, v) => attrs[k] = v);\n";
        html += "                \n";
        html += "                let label = \"Action\";\n";
        html += "                let icon = \"zap\";\n";
        html += "                if (action === 'open_file') { label = 'Opening ' + (attrs.filePath ? attrs.filePath.split('/').pop() : 'file'); icon = 'file-code'; }\n";
        html += "                else if (action === 'select_code') { label = 'Highlighting code...'; icon = 'selection'; }\n";
        html += "                else if (action === 'set_breakpoint') { label = 'Breakpoint set (Line ' + attrs.line + ')'; icon = 'debug-breakpoint'; }\n";
        html += "                else if (action === 'run_script') { label = 'Running script...'; icon = 'play'; }\n";
        html += "                \n";
        html += "                const serializedParams = \"JSON.stringify(attrs).replace(/'/g, \"&apos;\")\";\n";
        html += "                setTimeout(() => {\n";
        html += "                    vscode.postMessage({ command: 'workspaceAction', action, params: attrs });\n";
        html += "                }, 50);\n";
        html += "                return `<div class=\"apply-row\" style=\"background: rgba(155, 89, 182, 0.05); border-left: 3px solid var(--vscode-charts-purple); margin: 6px 0; padding: 6px 10px;\">` +\n";
        html += "                       `  <span class=\"status-icon\"><i class=\"codicon codicon-\${icon}\" style=\"color: var(--vscode-charts-purple)\"></i></span>` +\n";
        html += "                       `  <span style=\"font-size: 11px; font-weight: bold; opacity: 0.9; margin-left: 6px;\">\${label}</span>` +\n";
        html += "                       `</div>`;\n";
        html += "            });\n";
        html += "            \n";
        html += "            responseBody.innerHTML = parsedHtml;\n";
        html += "            \n";
        html += "            // Leverage universal webview rendering engine\n";
        html += "            if (typeof enhanceCodeBlocks === 'function') {\n";
        html += "                enhanceCodeBlocks(responseBody, 'companion_msg', finalMarkdown, isFinal);\n";
        html += "            } else {\n";
        html += "                Prism.highlightAllUnder(responseBody);\n";
        html += "            }\n";
        html += "            container.scrollTop = container.scrollHeight;\n";
        html += "        }\n";

        html += "        function appendChunk(chunk) {\n";
        html += "            activeContentBuffer += chunk;\n";
        html += "            renderResponse(activeContentBuffer, activePrompt, false);\n";
        html += "        }\n";

        html += "        function clearResponse() {\n";
        html += "            container.innerHTML = \"\";\n";
        html += "            activeContentBuffer = \"\";\n";
        html += "            document.getElementById('hud-scratchpad-body').textContent = 'Standing by. Ready to pair-program with you!';\n";
        html += "        }\n";

        // Global workspace action triggers
        html += "        function triggerWorkspaceAction(button) {\n";
        html += "            const action = button.getAttribute('data-action');\n";
        html += "            const params = JSON.parse(button.getAttribute('data-params'));\n";
        html += "            vscode.postMessage({ command: 'workspaceAction', action, params });\n";
        html += "        }\n";
        html += "        window.triggerWorkspaceAction = triggerWorkspaceAction;\n";
        html += "        \n";
        html += "        function copyFullResponse() { vscode.postMessage({ command: 'copyToClipboard', text: activeContentBuffer }); }\n";
        html += "        function loadHistory(id) {\n";
        html += "            vscode.postMessage({ command: 'loadHistory', id: id });\n";
        html += "            toggleHistory();\n";
        html += "        }\n";
        html += "        function deleteHistory(e, id) {\n";
        html += "            e.stopPropagation();\n";
        html += "            vscode.postMessage({ command: 'deleteHistory', id: id });\n";
        html += "        }\n";
        html += "        function clearHistory() { vscode.postMessage({ command: 'clearHistory' }); }\n";

        // Inject essential visual rendering methods from core chatPanel view bundle
        html += "        const langMap = { 'js': 'javascript', 'ts': 'typescript', 'py': 'python', 'sh': 'bash', 'json': 'json', 'html': 'html', 'css': 'css', 'sparql': 'sparql' };\n";
        html += "        function renderLines(lines, type) {\n";
        html += "            return lines.map(line => {\n";
        html += "                const escaped = line.replace(/&/g, \"&amp;\").replace(/</g, \"&lt;\").replace(/>/g, \"&gt;\");\n";
        html += "                const safeLine = escaped.length === 0 ? ' ' : escaped;\n";
        html += "                return '<div class=\"aider-diff-line aider-diff-' + type + '\"><span class=\"aider-diff-code\">' + safeLine + '</span></div>';\n";
        html += "            }).join('');\n";
        html += "        }\n";

        // --- CUSTOM SPARQL WIDGET INJECTOR FOR COMPANION PANEL (AUTONOMOUS ON RENDERING) ---
        html += "        function renderSparqlWidget(blockId, queryText) {\n";
        html += "            const escapedQuery = queryText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');\n";
        html += "            \n";
        html += "            // Trigger background query immediately without blocking UI thread\n";
        html += "            setTimeout(() => {\n";
        html += "                vscode.postMessage({\n";
        html += "                    command: 'executeLollmsCommand',\n";
        html += "                    details: {\n";
        html += "                        command: 'lollms-vs-coder.runSparqlQueryDirectly',\n";
        html += "                        params: { query: queryText, messageId: 'companion_msg', blockId }\n";
        html += "                    }\n";
        html += "                });\n";
        html += "            }, 10);\n";
        html += "            \n";
        html += "            return `\\n\\n<div class=\"generation-block sparql-block\" id=\"\${blockId}\" data-query=\"\${encodeURIComponent(queryText)}\" style=\"border: 1px solid var(--vscode-charts-purple); border-radius: 6px; overflow:hidden; margin: 12px 0;\">\\n` +\n";
        html += "                   `  <div class=\"generation-header\" style=\"background: rgba(155, 89, 182, 0.1); padding: 8px 12px; display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid var(--vscode-widget-border);\">\\n` +\n";
        html += "                   `    <span style=\"color: var(--vscode-charts-purple); font-weight: 800; font-size:11px;\"><i class=\"codicon codicon-graph\"></i> SPARQL-lite Query (Auto-executing)</span>\\n` +\n";
        html += "                   `    <div class=\"code-actions\" style=\"display:flex; gap:6px;\">\\n` +\n";
        html += "                   `      <span class=\"codicon codicon-sync spin\" style=\"color: var(--vscode-charts-purple)\"></span>\\n` +\n";
        html += "                   `    </div>\\n` +\n";
        html += "                   `  </div>\\n` +\n";
        html += "                   `  <div class=\"generation-body\" style=\"padding:12px; background:var(--vscode-editor-background); display:flex; flex-direction:column; gap:8px;\">\\n` +\n";
        html += "                   `    <pre style=\"margin:0; padding:8px; background:rgba(0,0,0,0.15); border-radius:4px; font-family:monospace; font-size:11px; white-space:pre-wrap;\">\text</pre>\\n` +\n"; // Use pre-escaped placeholder to bypass template literals
        html += "                   `    <div class=\"sparql-results-render-area\" style=\"display:block; max-height:180px; overflow-y:auto; border-top:1px solid var(--vscode-widget-border); padding-top:8px; font-size:11px;\">` +\n";
        html += "                   `       <div style=\"opacity:0.6; display:flex; gap:8px; align-items:center;\"><div class=\"spinner\"></div> Running query...</div>` +\n";
        html += "                   `    </div>\\n` +\n";
        html += "                   `  </div>\\n` +\n";
        html += "                   `</div>\\n\\n`.replace('text', escapedQuery);\n";
        html += "        }\n";
        html += "        function extractFilePaths(content) {\n";
        html += "            const infos = [];\n";
        html += "            const lines = content.split('\\n');\n";
        html += "            let inBlock = false;\n";
        html += "            let currentOffset = 0;\n";
        html += "            for (let i = 0; i < lines.length; i++) {\n";
        html += "                const line = lines[i].trim();\n";
        html += "                if (!inBlock) {\n";
        html += "                    if (line.startsWith('<<<<<<< SEARCH')) {\n";
        html += "                        inBlock = true;\n";
        html += "                        let inferredPath = '';\n";
        html += "                        for (let k = i - 1; k >= Math.max(0, i - 10); k--) {\n";
        html += "                            const pathMatch = lines[k].match(/[\`\"']?([a-zA-Z0-9._\\-\\/]+\\.[a-z0-9]+)[\`\"']?/);\n";
        html += "                            if (pathMatch) { inferredPath = pathMatch[1]; break; }\n";
        html += "                        }\n";
        html += "                        infos.push({ type: 'replace', path: inferredPath, isClosed: false });\n";
        html += "                    } else if (line.startsWith('```')) {\n";
        html += "                        const match = line.match(/^(\`{3,})/);\n";
        html += "                        if (true) {\n";
        html += "                        const nextLine = lines[i+1] ? lines[i+1].trim() : '';\n";
        html += "                        inBlock = true;\n";
        html += "                        let type = 'file';\n";
        html += "                        let pathStr = '';\n";
        html += "                        const headerText = line.substring(match[0].length).trim();\n";
        html += "                        if (headerText.includes(':')) {\n";
        html += "                            const parts = headerText.split(':');\n";
        html += "                            type = parts[0].trim();\n";
        html += "                            pathStr = parts.slice(1).join(':').trim();\n";
        html += "                        }\n";
        html += "                        infos.push({ type, path: pathStr, isClosed: false });\n";
        html += "                        }\n";
        html += "                    }\n";
        html += "                } else {\n";
        html += "                    if (line.startsWith('>>>>>>> REPLACE') || line.startsWith('```')) {\n";
        html += "                        inBlock = false;\n";
        html += "                        infos[infos.length - 1].isClosed = true;\n";
        html += "                    }\n";
        html += "                }\n";
        html += "            }\n";
        html += "            return infos;\n";
        html += "        }\n";
        html += "        function enhanceCodeBlocks(container, messageId, contentSource, isFinal) {\n";
        html += "            const pres = Array.from(container.querySelectorAll('pre'));\n";
        html += "            const codeBlockInfos = extractFilePaths(contentSource);\n";
        html += "            pres.forEach((pre, index) => {\n";
        html += "                const code = pre.querySelector('code');\n";
        html += "                if (!code) return;\n";
        html += "                const langMatch = code.className.match(/language-(\\S+)/);\n";
        html += "                let language = langMatch ? langMatch[1] : 'plaintext';\n";
        html += "                if (language.includes(':')) language = language.split(':')[0];\n";
        html += "                let filePath = '', isDiff = false;\n";
        html += "                const info = codeBlockInfos[index];\n";
        html += "                if (info) filePath = info.path;\n";
        html += "                if (langMap[language.toLowerCase()]) language = langMap[language.toLowerCase()];\n";
        html += "                let codeText = code.innerText;\n";
        html += "                const aiderRegex = /<<<<<<< SEARCH\\r?\\n([\\s\\S]*?)\\r?\\n=======(?:\\r?\\n(?!>>>>>>> REPLACE)([\\s\\S]*?))?\\r?\\n>>>>>>> REPLACE/g;\n";
        html += "                const aiderMatches = [...codeText.matchAll(aiderRegex)];\n";
        html += "                const isAider = aiderMatches.length > 0;\n";
        html += "                const details = document.createElement('details');\n";
        html += "                details.className = 'code-collapsible';\n";
        html += "                details.open = true;\n";
        html += "                details.id = 'block-' + messageId + '-' + index;\n";
        html += "                details.setAttribute('data-raw-code', codeText);\n";
        html += "                const summary = document.createElement('summary');\n";
        html += "                summary.className = 'code-summary';\n";
        html += "                summary.innerHTML = '<div class=\"summary-lang-label\"><span class=\"lang-badge\" data-lang=\"' + language.toLowerCase() + '\">' + language + '</span> : <span class=\"path-display-label\" style=\"font-family: var(--vscode-editor-font-family); font-size: 11px; font-weight: bold; margin-left: 8px; color: var(--vscode-textLink-foreground);\">' + filePath + '</span></div>';\n";
        html += "                const actions = document.createElement('div');\n";
        html += "                actions.className = 'code-actions';\n";
        html += "                summary.appendChild(actions);\n";
        html += "                const copyBtn = document.createElement('button');\n";
        html += "                copyBtn.className = 'code-action-btn';\n";
        html += "                copyBtn.innerHTML = '<span class=\"codicon codicon-copy\"></span>';\n";
        html += "                copyBtn.onclick = (e) => {\n";
        html += "                    e.stopPropagation();\n";
        html += "                    vscode.postMessage({ command: 'copyToClipboard', text: codeText });\n";
        html += "                };\n";
        html += "                actions.appendChild(copyBtn);\n";
        html += "                let applyBtn = null;\n";
        html += "                if (filePath) {\n";
        html += "                    applyBtn = document.createElement('button');\n";
        html += "                    applyBtn.className = 'code-action-btn apply-btn';\n";
        html += "                    applyBtn.id = 'apply-btn-' + messageId + '-' + index;\n";
        html += "                    applyBtn.innerHTML = '<span class=\"codicon ' + (isAider ? 'codicon-arrow-swap' : 'codicon-tools') + '\"></span>';\n";
        html += "                    actions.appendChild(applyBtn);\n";
        html += "                }\n";
        html += "                details.appendChild(summary);\n";
        html += "                if (isAider) {\n";
        html += "                    const hunkGroup = document.createElement('div');\n";
        html += "                    hunkGroup.className = 'aider-hunk-group';\n";
        html += "                    aiderMatches.forEach((match, hIdx) => {\n";
        html += "                        const sLines = (match[1] || '').replace(/\\r\\n/g, '\\n').split('\\n');\n";
        html += "                        const rLines = (match[2] || '').replace(/\\r\\n/g, '\\n').split('\\n');\n";
        html += "                        const bubble = document.createElement('div');\n";
        html += "                        bubble.className = 'aider-hunk-bubble';\n";
        html += "                        bubble.innerHTML = '<div class=\"aider-hunk-header\" onclick=\"this.closest(\\\'.aider-hunk-bubble\\\').classList.toggle(\\\'collapsed\\\')\"><div style=\"display:flex; align-items:center; gap:8px; pointer-events: none;\"><i class=\"codicon codicon-chevron-down hunk-toggle-icon\"></i><span>HUNK ' + (hIdx+1) + '</span></div></div><div class=\"aider-hunk-content\">' + renderLines(sLines, 'removed') + renderLines(rLines, 'added') + '</div>';\n";
        html += "                        hunkGroup.appendChild(bubble);\n";
        html += "                    });\n";
        html += "                    details.appendChild(hunkGroup);\n";
        html += "                    pre.replaceWith(details);\n";
        html += "                } else {\n";
        html += "                    pre.replaceWith(details);\n";
        html += "                    details.appendChild(pre);\n";
        html += "                    Prism.highlightElement(code);\n";
        html += "                }\n";
        html += "                // --- Review card: body + accept/reject actions (populated after apply) ---\n";
        html += "                if (filePath) {\n";
        html += "                    const reviewBody = document.createElement('div');\n";
        html += "                    reviewBody.className = 'review-body';\n";
        html += "                    const spinner = document.createElement('div');\n";
        html += "                    spinner.className = 'spinner';\n";
        html += "                    spinner.style.display = 'none';\n";
        html += "                    const bodyText = document.createElement('span');\n";
        html += "                    bodyText.className = 'review-body-text';\n";
        html += "                    bodyText.textContent = 'Click the apply icon above to write this change to disk.';\n";
        html += "                    reviewBody.appendChild(spinner);\n";
        html += "                    reviewBody.appendChild(bodyText);\n";
        html += "                    const actionsRow = document.createElement('div');\n";
        html += "                    actionsRow.className = 'review-actions-row';\n";
        html += "                    actionsRow.style.display = 'none';\n";
        html += "                    const acceptBtn = document.createElement('button');\n";
        html += "                    acceptBtn.className = 'review-btn-accept';\n";
        html += "                    acceptBtn.innerHTML = '<span class=\"codicon codicon-check\"></span> Accept';\n";
        html += "                    const rejectBtn = document.createElement('button');\n";
        html += "                    rejectBtn.className = 'review-btn-reject';\n";
        html += "                    rejectBtn.innerHTML = '<span class=\"codicon codicon-discard\"></span> Reject';\n";
        html += "                    acceptBtn.onclick = (e) => {\n";
        html += "                        e.stopPropagation();\n";
        html += "                        vscode.postMessage({ command: 'reviewDecision', decision: 'accept', filePath, blockId: details.id });\n";
        html += "                        actionsRow.style.display = 'none';\n";
        html += "                        bodyText.textContent = '✅ Change accepted.';\n";
        html += "                    };\n";
        html += "                    rejectBtn.onclick = (e) => {\n";
        html += "                        e.stopPropagation();\n";
        html += "                        vscode.postMessage({ command: 'reviewDecision', decision: 'reject', filePath, blockId: details.id });\n";
        html += "                        actionsRow.style.display = 'none';\n";
        html += "                        bodyText.textContent = '↩️ Change reverted.';\n";
        html += "                        setMood('idle');\n";
        html += "                    };\n";
        html += "                    actionsRow.appendChild(acceptBtn);\n";
        html += "                    actionsRow.appendChild(rejectBtn);\n";
        html += "                    details.appendChild(reviewBody);\n";
        html += "                    details.appendChild(actionsRow);\n";
        html += "                    if (applyBtn) {\n";
        html += "                        applyBtn.onclick = (e) => {\n";
        html += "                            e.stopPropagation();\n";
        html += "                            spinner.style.display = 'block';\n";
        html += "                            bodyText.textContent = 'Applying change...';\n";
        html += "                            actionsRow.style.display = 'none';\n";
        html += "                            const cmd = isAider ? 'replaceCode' : 'applyFileContent';\n";
        html += "                            vscode.postMessage({\n";
        html += "                                command: cmd,\n";
        html += "                                filePath,\n";
        html += "                                content: codeText,\n";
        html += "                                options: { silent: false, blockId: details.id, hunkIndex: index }\n";
        html += "                            });\n";
        html += "                        };\n";
        html += "                    }\n";
        html += "                }\n";
        html += "            });\n";
        html += "        }\n";
        html += "    </script>\n";
        html += "</body>\n";
        html += "</html>";

        return html;
    }
}