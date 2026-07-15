import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ChatMessage } from '../lollmsAPI';

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
    private _lastActiveEditor: vscode.TextEditor | undefined;
    private _isAttached: boolean = false;
    private _disposables: vscode.Disposable[] = [];

    private _onDidSubmit = new vscode.EventEmitter<string>();
    public readonly onDidSubmit = this._onDidSubmit.event;

    private _contextInfo: string = "No active context";
    private _trustScore: number = 75;
    private _preApplySnapshots: Map<string, { filePath: string; content: string }> = new Map();
    private _htmlCache: string | undefined;

    public agentManager: any;
    public chatHistory: ChatMessage[] = [];

    public static createOrShow(extensionUri: vscode.Uri, title: string) {
        const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : undefined;

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

        const active = vscode.window.activeTextEditor;
        if (active && active.document.uri.scheme === 'file') {
            this._lastActiveEditor = active;
        }
        this.updateContextInfoFromEditor();

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

        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
        this._setWebviewMessageListener(this._panel.webview);
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        if (this._htmlCache) {
            return this._htmlCache;
        }

        const htmlPath = vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'companionPanel.html');
        let htmlContent = "";
        try {
            htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf8');
        } catch (err: any) {
            return `<h3>Error loading Companion Panel layout. Details: ${err.message}</h3>`;
        }

        const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'));
        const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'chatPanel.css'));
        const bundleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'companionPanel.bundle.js'));

        const nonce = this.getNonce();

        let html = htmlContent
            .replace(/\{\{cspSource\}\}/g, webview.cspSource)
            .replace(/\{\{nonce\}\}/g, `nonce="${nonce}"`)
            .replace(/\{\{codiconUri\}\}/g, codiconUri.toString())
            .replace(/\{\{cssUri\}\}/g, cssUri.toString())
            .replace(/\{\{bundleUri\}\}/g, bundleUri.toString());

        this._htmlCache = html;
        return html;
    }

    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    private _setWebviewMessageListener(webview: vscode.Webview) {
        webview.onDidReceiveMessage(async (message) => {
            const folder = vscode.workspace.workspaceFolders?.[0];
            if (!folder) return;

            switch (message.command) {
                case 'webview-ready':
                    this.setContextInfo(this._contextInfo);
                    this._panel.webview.postMessage({ command: 'updateAttachState', isAttached: this._isAttached });
                    this._panel.webview.postMessage({ command: 'updateTrustScore', score: this._trustScore });
                    this.updateHistoryList();
                    break;
                case 'submitPrompt':
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
                case 'clearActiveChat':
                    this.chatHistory = [];
                    break;
                case 'clearHistory':
                    this._history = [];
                    this._currentHistoryIndex = -1;
                    this.chatHistory = [];
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
                                messages: [],
                                timestamp: Date.now(),
                                groupId: null,
                                plan: null,
                                capabilities: this.discussionManager.getLastCapabilities(),
                                personalityId: 'default_coder'
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
        }, null, this._disposables);
    }

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
        if (!filePath) return;
        try {
            const uri = vscode.Uri.file(filePath);
            const companionColumn = this._panel.viewColumn || vscode.ViewColumn.Two;

            let targetColumn = vscode.ViewColumn.One;
            if (companionColumn === vscode.ViewColumn.One) {
                targetColumn = vscode.ViewColumn.Two;
            }

            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc, {
                viewColumn: targetColumn,
                preserveFocus: true,
                preview: false
            });
            this._lastActiveEditor = editor;
        } catch {}
    }

    private async _captureSnapshot(blockId: string | undefined, filePath: string | undefined) {
        if (!blockId || !filePath) return;
        try {
            const uri = vscode.Uri.file(filePath);
            const bytes = await vscode.workspace.fs.readFile(uri);
            this._preApplySnapshots.set(blockId, { filePath, content: Buffer.from(bytes).toString('utf8') });
        } catch {}
    }

    private async _handleReviewDecision(blockId: string | undefined, decision: string, filePath?: string) {
        if (!blockId) return;
        const snapshot = this._preApplySnapshots.get(blockId);
        if (decision === 'reject') {
            try {
                if (snapshot) {
                    const uri = vscode.Uri.file(snapshot.filePath);
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(snapshot.content, 'utf8'));
                    vscode.window.setStatusBarMessage("Lollms: Change reverted", 2000);
                } else if (filePath) {
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
}
