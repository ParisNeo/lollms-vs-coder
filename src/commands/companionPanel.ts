import * as vscode from 'vscode';

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
    
    // Track the last actual file editor to prevent focus loss from clearing it
    private _lastActiveEditor: vscode.TextEditor | undefined;
    private _isAttached: boolean = false;
    private _disposables: vscode.Disposable[] = [];
    
    private _onDidSubmit = new vscode.EventEmitter<string>();
    public readonly onDidSubmit = this._onDidSubmit.event;

    private _contextInfo: string = "No active context";

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
            if (editor && editor.document.uri.scheme === 'file') {
                if (!this._isAttached) {
                    this._lastActiveEditor = editor;
                    this.updateContextInfoFromEditor();
                }
            }
        }, null, this._disposables);

        vscode.window.onDidChangeTextEditorSelection(e => {
            if (this._lastActiveEditor && e.textEditor === this._lastActiveEditor) {
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
                        this.updateHistoryList();
                        break;
                    case 'submitPrompt':
                        this._onDidSubmit.fire(message.text || message.query || "");
                        break;
                    case 'copyToClipboard':
                        if (message.text) {
                            await vscode.env.clipboard.writeText(message.text);
                            vscode.window.setStatusBarMessage("Lollms: Copied to clipboard", 2000);
                        }
                        break;
                    case 'replaceCode':
                        try {
                            const normalizedContent = message.content
                                .replace(/^\s*<<<<<<< SEARCH/gm, '<<<<<<< SEARCH')
                                .replace(/^\s*=======/gm, '=======')
                                .replace(/^\s*>>>>>>> REPLACE/gm, '>>>>>>> REPLACE');

                            const res: any = await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', message.filePath, normalizedContent, undefined, undefined, message.options);
                            this._panel.webview.postMessage({
                                command: 'applyAllResult',
                                success: res?.success ?? false,
                                error: res?.error
                            });
                        } catch (e: any) {
                            this._panel.webview.postMessage({ command: 'applyAllResult', success: false, error: e.message });
                        }
                        break;
                    case 'applyFileContent':
                        try {
                            const res: any = await vscode.commands.executeCommand('lollms-vs-coder.applyFileContent', message.filePath, message.content, { autoSave: true, silent: true });
                            this._panel.webview.postMessage({
                                command: 'applyAllResult',
                                success: res?.success ?? false,
                                error: res?.error
                            });
                        } catch (e: any) {
                            this._panel.webview.postMessage({ command: 'applyAllResult', success: false, error: e.message });
                        }
                        break;
                }
            }
        );
        this._panel.webview.html = this._getHtmlForWebview();
    }

    public getActiveEditor(): vscode.TextEditor | undefined {
        if (this._lastActiveEditor && this._lastActiveEditor.document.isClosed) {
            this._lastActiveEditor = undefined;
            this.updateContextInfoFromEditor();
        }
        return this._lastActiveEditor;
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
        html += "    <script src=\"" + prismJsUri + "\"></script>\n";
        html += "    <style>\n";
        html += "        body {\n";
        html += "            font-family: var(--vscode-font-family);\n";
        html += "            background-color: var(--vscode-editor-background);\n";
        html += "            color: var(--vscode-editor-foreground);\n";
        html += "            padding: 0; margin: 0;\n";
        html += "            display: flex; height: 100vh; overflow: hidden;\n";
        html += "        }\n";
        
        // Friendly Face Styling
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
        html += "        }\n";
        html += "        .robot-eye {\n";
        html += "            width: 4px; height: 4px; background: #00ffcc;\n";
        html += "            border-radius: 50%; box-shadow: 0 0 6px #00ffcc;\n";
        html += "            animation: eye-blink 4s infinite;\n";
        html += "        }\n";
        html += "        .robot-face.speaking .robot-eye {\n";
        html += "            background: #ff007f; box-shadow: 0 0 6px #ff007f;\n";
        html += "        }\n";
        html += "        .robot-mouth {\n";
        html += "            position: absolute; bottom: 2px; left: 50%; transform: translateX(-50%);\n";
        html += "            width: 8px; height: 2px; background: #00ffcc; border-radius: 1px;\n";
        html += "            transition: height 0.1s ease;\n";
        html += "        }\n";
        html += "        .robot-face.speaking .robot-mouth {\n";
        html += "            animation: mouth-talk 0.2s infinite alternate;\n";
        html += "            background: #ff007f;\n";
        html += "        }\n";
        html += "        @keyframes eye-blink {\n";
        html += "            0%, 95%, 100% { transform: scaleY(1); }\n";
        html += "            97% { transform: scaleY(0.1); }\n";
        html += "        }\n";
        html += "        @keyframes mouth-talk {\n";
        html += "            0% { height: 1px; }\n";
        html += "            100% { height: 4px; }\n";
        html += "        }\n";

        // Memory Scratchpad HUD Styling
        html += "        .friendship-hud {\n";
        html += "            margin: 0 16px 12px 16px;\n";
        html += "            border: 1px dashed var(--vscode-widget-border);\n";
        html += "            border-radius: 6px; background: rgba(155, 89, 182, 0.03);\n";
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

        this.updateContextInfoFromEditor();

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
        html += "        }\n";
        html += "        textarea {\n";
        html += "            flex: 1;\n";
        html += "            height: 60px;\n";
        html += "            resize: vertical;\n";
        html += "            background-color: var(--vscode-input-background);;\n";
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
        html += "            </div>\n";
        html += "            <div class=\"actions\" style=\"display:flex; gap:8px;\">\n";
        html += "                <button class=\"secondary danger\" onclick=\"clearResponse()\" title=\"Wipe Memory (Start Over)\"><span class=\"codicon codicon-trash\"></span> Wipe</button>\n";
        html += "                <button class=\"secondary\" onclick=\"copyFullResponse()\" title=\"Copy Markdown\"><span class=\"codicon codicon-copy\"></span></button>\n";
        html += "            </div>\n";
        html += "        </div>\n";
        
        // Friendship Scratchpad HUD
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
        html += "        <div class=\"input-area\">\n";
        html += "            <div class=\"context-info\">\n";
        html += "                <button id=\"attach-btn\" class=\"icon-btn\" onclick=\"toggleAttach()\">\n";
        html += "                    <span class=\"codicon codicon-pin\"></span>\n";
        html += "                </button>\n";
        html += "                <span class=\"codicon codicon-target\"></span>\n";
        html += "                <span id=\"context-info-text\">Syncing...</span>\n";
        html += "            </div>\n";
        html += "            <div class=\"input-container\">\n";
        html += "                <textarea id=\"prompt-input\" placeholder=\"Ask a question or request a change...\"></textarea>\n";
        html += "                <button onclick=\"submitPrompt()\" id=\"send-btn\" style=\"height: fit-content; align-self: flex-end;\">\n";
        html += "                    <span class=\"codicon codicon-send\"></span> Send\n";
        html += "                </button>\n";
        html += "            </div>\n";
        html += "        </div>\n";
        html += "    </div>\n";
        html += "    <script>\n";
        html += "        const vscode = acquireVsCodeApi();\n";
        html += "        const container = document.getElementById('markdown-content');\n";
        html += "        const promptInput = document.getElementById('prompt-input');\n";
        html += "        let activeContentBuffer = \"\";\n";
        html += "        vscode.postMessage({ command: 'webview-ready' });\n";
        html += "        function toggleHistory() {\n";
        html += "            document.getElementById('sidebar').classList.toggle('open');\n";
        html += "            document.querySelector('.sidebar-overlay').classList.toggle('open');\n";
        html += "        }\n";
        html += "        function openTools() {\n";
        html += "            vscode.postMessage({ command: 'openTools' });\n";
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
        html += "            bubble.style.cssText = \"margin-bottom: 20px; padding: 12px 16px; border-radius: 8px; border: 1px solid var(--vscode-widget-border); border-left: 4px solid var(--vscode-charts-blue); background: var(--vscode-editor-inactiveSelectionBackground);\";\n";
        html += "            const header = document.createElement('div');\n";
        html += "            header.style.cssText = \"font-size: 11px; font-weight: bold; margin-bottom: 8px; opacity: 0.8; display: flex; align-items: center; gap: 6px;\";\n";
        html += "            header.innerHTML = '<span class=\"codicon codicon-account\"></span> <span>You (Selection Prompt)</span>';\n";
        html += "            const body = document.createElement('div');\n";
        html += "            body.style.cssText = \"font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-all;\";\n";
        html += "            body.textContent = text;\n";
        html += "            bubble.appendChild(header);\n";
        html += "            bubble.appendChild(body);\n";
        html += "            container.appendChild(bubble);\n";
        html += "            container.scrollTop = container.scrollHeight;\n";
        html += "        }\n";

        html += "        function setFaceMood(state) {\n";
        html += "            const face = document.getElementById('friend-face');\n";
        html += "            if (!face) return;\n";
        html += "            if (state === 'speaking') {\n";
        html += "                face.classList.add('speaking');\n";
        html += "            } else {\n";
        html += "                face.classList.remove('speaking');\n";
        html += "            }\n";
        html += "        }\n";

        html += "        function submitPrompt() {\n";
        html += "            const text = promptInput.value.trim();\n";
        html += "            if (!text) return;\n";
        html += "            container.innerHTML = \"\";\n";
        html += "            renderUserBubble(text);\n";
        html += "            const waiting = document.createElement('div');\n";
        html += "            waiting.id = 'companion-waiting-placeholder';\n";
        html += "            waiting.style.cssText = \"display: flex; align-items: center; gap: 8px; padding: 12px; color: var(--vscode-descriptionForeground); font-style: italic;\";\n";
        html += "            waiting.innerHTML = '<span class=\"codicon codicon-sync spin\"></span> Connecting to Lollms...';\n";
        html += "            container.appendChild(waiting);\n";
        html += "            setFaceMood('speaking');\n";
        html += "            vscode.postMessage({ command: 'submitPrompt', text: text });\n";
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
        html += "                case 'appendChunk':\n";
        html += "                    const waiting = document.getElementById('companion-waiting-placeholder');\n";
        html += "                    if (waiting) waiting.remove();\n";
        html += "                    appendChunk(message.text);\n";
        html += "                    break;\n";
        html += "                case 'renderResponse':\n";
        html += "                    const w = document.getElementById('companion-waiting-placeholder');\n";
        html += "                    if (w) w.remove();\n";
        html += "                    renderResponse(message.text, message.prompt);\n";
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
        html += "            }\n";
        html += "        });\n";

        html += "        function renderResponse(text, prompt) {\n";
        html += "            activeContentBuffer = text;\n";
        html += "            if (!text) {\n";
        html += "                container.innerHTML = '<div style=\"color: var(--vscode-descriptionForeground); text-align: center; margin-top: 40px;\"><h3>👋 Lollms Companion</h3><p>Select code or place your cursor, then type below.</p></div>';\n";
        html += "                return;\n";
        html += "            }\n";
        html += "            const parsed = processThinkTags(activeContentBuffer);\n";
        html += "            let thoughtsHtml = \"\";\n";
        
        // Update Friendship Scratchpad HUD real-time with internal monologue thoughts
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
        html += "                                DOMPurify.sanitize(marked.parse(t.content || \"*Contemplating...*\")) +\n";
        html += "                            '</div>' +\n";
        html += "                        '</details>' +\n";
        html += "                    '</div>';\n";
        html += "                });\n";
        html += "            }\n";
        html += "            const finalMarkdown = parsed.processedContent;\n";
        html += "            container.innerHTML = \"\";\n";
        html += "            if (prompt) {\n";
        html += "                renderUserBubble(prompt);\n";
        html += "            }\n";
        html += "            const responseContainer = document.createElement('div');\n";
        html += "            responseContainer.style.cssText = \"margin-bottom: 20px; padding: 12px 16px; border-radius: 8px; border: 1px solid var(--vscode-widget-border); border-left: 4px solid var(--vscode-charts-green); background: var(--vscode-editor-background);\";\n";
        html += "            const responseHeader = document.createElement('div');\n";
        html += "            responseHeader.style.cssText = \"font-size: 11px; font-weight: bold; margin-bottom: 8px; opacity: 0.8; display: flex; align-items: center; gap: 6px; color: var(--vscode-textLink-foreground);\";\n";
        html += "            responseHeader.innerHTML = '<span class=\"codicon codicon-sparkle\"></span> <span>Lollms Response</span>';\n";
        html += "            const responseBody = document.createElement('div');\n";
        html += "            responseBody.className = \"markdown-body\";\n";
        html += "            responseBody.innerHTML = thoughtsHtml + DOMPurify.sanitize(marked.parse(finalMarkdown));\n";
        html += "            responseContainer.appendChild(responseHeader);\n";
        html += "            responseContainer.appendChild(responseBody);\n";
        html += "            container.appendChild(responseContainer);\n";
        html += "            document.querySelectorAll('pre code').forEach((block) => {\n";
        html += "                const pre = block.parentElement;\n";
        html += "                const code = block.textContent;\n";
        html += "                const copyBtn = document.createElement('button');\n";
        html += "                copyBtn.className = 'copy-code secondary';\n";
        html += "                copyBtn.textContent = 'Copy';\n";
        html += "                copyBtn.onclick = () => { vscode.postMessage({ command: 'copyToClipboard', text: code }); };\n";
        html += "                pre.appendChild(copyBtn);\n";
        html += "                const actionsDiv = document.createElement('div');\n";
        html += "                actionsDiv.style.marginTop = '8px'; actionsDiv.style.display = 'flex'; actionsDiv.style.gap = '8px';\n";
        html += "                const insertBtn = document.createElement('button');\n";
        html += "                insertBtn.innerHTML = '<span class=\"codicon codicon-arrow-right\"></span> Insert';\n";
        html += "                insertBtn.onclick = () => vscode.postMessage({ command: 'insertAtCursor', text: code });\n";
        html += "                const replaceBtn = document.createElement('button');\n";
        html += "                replaceBtn.innerHTML = '<span class=" + '"codicon codicon-replace"' + "></span> Replace';\n";
        html += "                replaceBtn.onclick = () => vscode.postMessage({ command: 'replaceSelection', text: code });\n";
        html += "                actionsDiv.appendChild(insertBtn);\n";
        html += "                actionsDiv.appendChild(replaceBtn);\n";
        html += "                pre.parentNode.insertBefore(actionsDiv, pre.nextSibling);\n";
        html += "            });\n";
        html += "            Prism.highlightAllUnder(container);\n";
        html += "            container.scrollTop = container.scrollHeight;\n";
        html += "        }\n";

        html += "        function appendChunk(chunk) {\n";
        html += "            activeContentBuffer += chunk;\n";
        html += "            renderResponse(activeContentBuffer, \"\");\n";
        html += "        }\n";

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

        html += "    </script>\n";
        html += "</body>\n";
        html += "</html>";

        return html;
    }
}
