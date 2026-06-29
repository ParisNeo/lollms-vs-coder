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
    
    // Track the editor the user was last using
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

        // Initialize with current active editor if available
        if (vscode.window.activeTextEditor) {
            this._lastActiveEditor = vscode.window.activeTextEditor;
            this.updateContextInfoFromEditor();
        }

        // Track editor changes
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor && editor.viewColumn !== undefined) { // Ignore panel focus itself
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
                        // Surgical in-line Search/Replace application
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
                        // Full File overwrite application
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
        // Load the HTML once on initialization
        this._panel.webview.html = this._getHtmlForWebview();
    }

    public getActiveEditor(): vscode.TextEditor | undefined {
        // If attached, verify the editor is still valid (not closed)
        if (this._isAttached && this._lastActiveEditor) {
            if (this._lastActiveEditor.document.isClosed) {
                this._isAttached = false; // Auto-detach if file closed
                this._panel.webview.postMessage({ command: 'updateAttachState', isAttached: false });
                vscode.window.showWarningMessage("Attached document was closed. Detaching context.");
                return vscode.window.activeTextEditor;
            }
            return this._lastActiveEditor;
        }
        return this._lastActiveEditor;
    }

    private toggleAttach() {
        this._isAttached = !this._isAttached;
        this._panel.webview.postMessage({ command: 'updateAttachState', isAttached: this._isAttached });
        
        if (!this._isAttached) {
            // Re-sync with current reality if we detached
             if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.viewColumn !== undefined) {
                this._lastActiveEditor = vscode.window.activeTextEditor;
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
        
        // Handle Notebook Cell
        if (doc.uri.scheme === 'vscode-notebook-cell') {
            const notebook = vscode.window.visibleNotebookEditors.find(ne => ne.notebook.getCells().some(c => c.document === doc))?.notebook;
            const nbName = notebook ? vscode.workspace.asRelativePath(notebook.uri) : "Notebook Cell";
            
            // Find cell index
            let cellIndexStr = "";
            if (notebook) {
                const cell = notebook.getCells().find(c => c.document === doc);
                if (cell) {
                    cellIndexStr = ` (Cell ${cell.index + 1})`;
                }
            }
            info = `${nbName}${cellIndexStr}`;
        } else {
            info = vscode.workspace.asRelativePath(doc.uri);
        }

        if (!sel.isEmpty) {
            info += ` (Lines ${sel.start.line+1}-${sel.end.line+1} Selected)`;
        } else {
            info += ` (Ln ${sel.active.line+1}, Col ${sel.active.character+1})`;
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

    private async handleOpenTools() {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder.companion');
        const webSearch = config.get<boolean>('enableWebSearch');
        const arxivSearch = config.get<boolean>('enableArxivSearch');

        const items: vscode.QuickPickItem[] = [
            { 
                label: 'Web Search', 
                picked: webSearch, 
                description: 'Enable Google Search tool for Companion' 
            },
            { 
                label: 'ArXiv Search', 
                picked: arxivSearch, 
                description: 'Enable ArXiv Search tool for Companion' 
            }
        ];

        const selected = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            placeHolder: 'Select active tools for Lollms Companion'
        });

        if (selected) {
            const newWebSearch = selected.some(i => i.label === 'Web Search');
            const newArxivSearch = selected.some(i => i.label === 'ArXiv Search');
            
            await config.update('enableWebSearch', newWebSearch, vscode.ConfigurationTarget.Global);
            await config.update('enableArxivSearch', newArxivSearch, vscode.ConfigurationTarget.Global);
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

    private async insertAtCursor(text: string) {
        const editor = this.getActiveEditor(); 
        if (editor) {
            await editor.edit(editBuilder => {
                editBuilder.insert(editor.selection.active, text);
            });
            vscode.window.showTextDocument(editor.document, {
                viewColumn: editor.viewColumn,
                preserveFocus: false
            });
        } else {
            vscode.window.showWarningMessage('No active text editor found. Please click inside a file to activate it.');
        }
    }

    private async replaceSelection(text: string) {
        const editor = this.getActiveEditor();
        if (editor) {
            // Trigger the inline diff session instead of immediate replacement
            // This allows the user to review (Accept/Reject) the changes from the companion panel.
            await vscode.commands.executeCommand('lollms-vs-coder.triggerInlineDiff', editor, editor.selection, text);
        } else {
            vscode.window.showWarningMessage('No active text editor found. Please click inside a file to activate it.');
        }
    }

    private _getHtmlForWebview(): string {
        const markedUri = "https://cdn.jsdelivr.net/npm/marked@5.1.1/marked.min.js";
        const domPurifyUri = "https://cdn.jsdelivr.net/npm/dompurify@3.0.5/dist/purify.min.js";
        const prismJsUri = "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js";
        const prismCssUri = "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css";
        const codiconUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'));

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Lollms Companion</title>
            <script src="${markedUri}"></script>
            <script src="${domPurifyUri}"></script>
            <link href="${prismCssUri}" rel="stylesheet" />
            <link href="${codiconUri}" rel="stylesheet" />
            <script src="${prismJsUri}"></script>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    padding: 0; margin: 0;
                    display: flex; height: 100vh; overflow: hidden;
                }

                /* --- FLOATING THOUGHTS STYLING --- */
                .plan-scratchpad {
                    border-left: 3px solid #9b59b6;
                    background: rgba(155, 89, 182, 0.05);
                    margin-bottom: 12px;
                    border-radius: 4px;
                }
                .scratchpad-header {
                    padding: 6px 12px;
                    font-weight: bold;
                    color: #9b59b6;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    font-size: 11px;
                }
                .scratchpad-content {
                    padding: 10px 15px;
                    font-size: 11px;
                    opacity: 0.9;
                    background: rgba(0,0,0,0.05);
                }

                .sidebar {
                    width: 300px;
                    border-right: 1px solid var(--vscode-panel-border);
                    display: flex; flex-direction: column;
                    background-color: var(--vscode-sideBar-background);
                    position: absolute;
                    top: 0; left: 0; bottom: 0;
                    z-index: 20;
                    transform: translateX(-100%);
                    transition: transform 0.3s ease-in-out;
                    box-shadow: 2px 0 5px rgba(0,0,0,0.3);
                }
                .sidebar.open {
                    transform: translateX(0);
                }

                .sidebar-overlay {
                    display: none;
                    position: fixed;
                    top: 0; left: 0; right: 0; bottom: 0;
                    background: rgba(0,0,0,0.5);
                    z-index: 10;
                }
                .sidebar-overlay.open { display: block; }

                .sidebar-header {
                    padding: 10px;
                    font-weight: bold;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    display: flex; justify-content: space-between; align-items: center;
                }
                .clear-btn { background: none; border: none; color: var(--vscode-errorForeground); cursor: pointer; }
                .close-sidebar-btn { background: none; border: none; color: var(--vscode-foreground); cursor: pointer; font-size: 1.2em; }

                .history-list {
                    flex: 1; overflow-y: auto;
                }
                .history-item {
                    padding: 8px 10px;
                    border-bottom: 1px solid var(--vscode-input-border);
                    cursor: pointer;
                    font-size: 0.9em;
                }
                .history-item:hover { background-color: var(--vscode-list-hoverBackground); }
                .history-item.active { background-color: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
                .history-prompt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .history-actions { display: flex; justify-content: space-between; align-items: center; margin-top: 4px; opacity: 0.7; font-size: 0.8em; }
                .delete-btn { background: none; border: none; color: var(--vscode-foreground); cursor: pointer; padding: 0 4px; }
                .delete-btn:hover { color: var(--vscode-errorForeground); background-color: rgba(255,0,0,0.2); border-radius: 3px; }

                .main {
                    flex: 1; display: flex; flex-direction: column; min-width: 0;
                    position: relative;
                }
                .header {
                    padding: 10px 20px;
                    background-color: var(--vscode-editorWidget-background);
                    border-bottom: 1px solid var(--vscode-widget-border);
                    display: flex; justify-content: space-between; align-items: center;
                }
                .header-left { display: flex; align-items: center; gap: 10px; }
                .title { font-weight: 600; }

                .content {
                    flex: 1; padding: 20px; overflow-y: auto; line-height: 1.6;
                }

                .input-area {
                    border-top: 1px solid var(--vscode-widget-border);
                    padding: 15px;
                    background-color: var(--vscode-editorWidget-background);
                }
                .context-info {
                    font-size: 0.8em;
                    color: var(--vscode-descriptionForeground);
                    margin-bottom: 8px;
                    display: flex;
                    align-items: center;
                    gap: 5px;
                }
                .input-container {
                    display: flex;
                    gap: 10px;
                }
                textarea {
                    flex: 1;
                    height: 60px;
                    resize: vertical;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 4px;
                    padding: 8px;
                    font-family: var(--vscode-font-family);
                }
                textarea:focus { border-color: var(--vscode-focusBorder); outline: none; }

                button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none; padding: 6px 12px; border-radius: 2px; cursor: pointer;
                    display: flex; align-items: center; gap: 5px;
                }
                button:hover { background-color: var(--vscode-button-hoverBackground); }
                button:disabled { opacity: 0.6; cursor: not-allowed; }
                button.secondary {
                    background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                }

                .icon-btn {
                    background: none; border: none; color: var(--vscode-icon-foreground); 
                    cursor: pointer; padding: 2px; margin-right: 5px; min-width: 24px;
                }
                .icon-btn:hover { color: var(--vscode-foreground); background-color: var(--vscode-toolbar-hoverBackground); }
                .icon-btn.attached { color: var(--vscode-textLink-foreground); background-color: var(--vscode-editor-inactiveSelectionBackground); } 

                code { font-family: var(--vscode-editor-font-family); background-color: var(--vscode-textCodeBlock-background); padding: 2px 4px; border-radius: 3px; }
                pre { background-color: var(--vscode-textCodeBlock-background); padding: 16px; border-radius: 5px; overflow-x: auto; position: relative; }
                pre button.copy-code { position: absolute; top: 5px; right: 5px; opacity: 0.7; }
                pre button.copy-code:hover { opacity: 1; }

                @keyframes spin { 100% { transform: rotate(360deg); } }
                .spin { animation: spin 1s linear infinite; }
            </style>
        </head>
        <body>
            <div class="sidebar-overlay" onclick="toggleHistory()"></div>

            <div class="sidebar" id="sidebar">
                <div class="sidebar-header">
                    <span>History</span>
                    <div>
                        <button class="clear-btn" onclick="clearHistory()" title="Clear All" style="display:inline;">Clear</button>
                        <button class="close-sidebar-btn" onclick="toggleHistory()" title="Close">✕</button>
                    </div>
                </div>
                <div class="history-list" id="history-list">
                    <!-- Populated dynamically via updateHistory -->
                </div>
            </div>

            <div class="main">
                <div class="header">
                    <div class="header-left">
                        <button class="secondary" onclick="toggleHistory()" title="Show History">
                            <span class="codicon codicon-history"></span>
                        </button>
                        <button class="secondary" onclick="openTools()" title="Configure Tools">
                            <span class="codicon codicon-tools"></span>
                        </button>
                        <span class="title">Lollms Companion</span>
                    </div>
                    <div class="actions">
                        <button class="secondary" onclick="copyFullResponse()" title="Copy Markdown"><span class="codicon codicon-copy"></span></button>
                    </div>
                </div>

                <div class="content" id="markdown-content"></div>

                <div class="input-area">
                    <div class="context-info">
                        <button id="attach-btn" class="icon-btn" onclick="toggleAttach()">
                            <span class="codicon codicon-pin"></span>
                        </button>
                        <span class="codicon codicon-target"></span>
                        <span id="context-info-text">Syncing...</span>
                    </div>
                    <div class="input-container">
                        <textarea id="prompt-input" placeholder="Ask a question or request a change (e.g., 'Refactor this')..."></textarea>
                        <button onclick="submitPrompt()" id="send-btn" style="height: fit-content; align-self: flex-end;">
                            <span class="codicon codicon-send"></span> Send
                        </button>
                    </div>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                const container = document.getElementById('markdown-content');
                const promptInput = document.getElementById('prompt-input');
                let activeContentBuffer = "";

                // Notify extension that webview is ready
                vscode.postMessage({ command: 'webview-ready' });

                function toggleHistory() {
                    document.getElementById('sidebar').classList.toggle('open');
                    document.querySelector('.sidebar-overlay').classList.toggle('open');
                }

                function openTools() {
                    vscode.postMessage({ command: 'openTools' });
                }

                function toggleAttach() {
                    vscode.postMessage({ command: 'toggleAttach' });
                }

                // --- THOUGHT PARSING LOGIC ---
                function processThinkTags(content) {
                    const thoughts = [];
                    if (typeof content !== 'string') return { thoughts, processedContent: '' };

                    const protectedRanges = [];
                    const fenceRegex = new RegExp("\\\`\\\`\\\`[\\\\s\\\\S]*?(?:\\\`\\\`\\\`|$)|\\\`[^\\\`\\\\n\\\\r]+\\\`", "g");
                    let fMatch;
                    while ((fMatch = fenceRegex.exec(content)) !== null) {
                        protectedRanges.push({ start: fMatch.index, end: fMatch.index + fMatch[0].length });
                    }

                    const isIndexProtected = (index) => {
                        return protectedRanges.some(r => index >= r.start && index < r.end);
                    };

                    const lines = content.split('\n');
                    let workingContent = "";
                    const openTags = ['<think>', '<thinking>', '<analysis>', '<reasoning>'];
                    const closeTags = ['</think>', '</thinking>', '</analysis>', '</reasoning>'];

                    let activeThought = null;
                    let currentOffset = 0;

                    for (let i = 0; i < lines.length; i++) {
                        const lineText = lines[i];
                        const lineTrim = lineText.trim();
                        const lineWithNL = lineText + (i < lines.length - 1 ? '\n' : '');

                        if (isIndexProtected(currentOffset)) {
                            if (activeThought) {
                                activeThought.content += lineWithNL;
                            } else {
                                workingContent += lineWithNL;
                            }
                            currentOffset += lineWithNL.length;
                            continue;
                        }

                        const openMatch = openTags.find(tag => lineTrim.startsWith(tag));
                        const closeMatch = closeTags.find(tag => lineTrim.startsWith(tag));

                        if (openMatch && !activeThought) {
                            const tagName = openMatch.replace(/[<>]/g, '');
                            activeThought = {
                                tag: tagName,
                                content: lineTrim.substring(openMatch.length) + (i < lines.length - 1 ? '\n' : ''),
                                closed: false
                            };
                        } else if (closeMatch && activeThought) {
                            activeThought.closed = true;
                            activeThought.content = activeThought.content.trim();
                            thoughts.push(activeThought);
                            activeThought = null;
                        } else if (closeMatch && !activeThought) {
                            const tagName = closeMatch.replace(/[<\/>]/g, '');
                            thoughts.push({
                                tag: tagName,
                                content: workingContent.trim(),
                                closed: true
                            });
                            workingContent = ""; 
                        } else {
                            if (activeThought) {
                                activeThought.content += lineWithNL;
                            } else {
                                workingContent += lineWithNL;
                            }
                        }
                        currentOffset += lineWithNL.length;
                    }

                    if (activeThought) {
                        activeThought.content = activeThought.content.trim();
                        thoughts.push(activeThought);
                    }

                    return { thoughts, processedContent: workingContent.trim() };
                }

                function renderResponse(text, prompt) {
                    activeContentBuffer = text;
                    if (!text) {
                        container.innerHTML = '<div style="color: var(--vscode-descriptionForeground); text-align: center; margin-top: 40px;"><h3>👋 Lollms Companion</h3><p>Select code or place your cursor, then type below.</p></div>';
                        return;
                    }

                    const parsed = processThinkTags(text);
                    let thoughtsHtml = "";

                    if (parsed.thoughts.length > 0) {
                        parsed.thoughts.forEach((t, idx) => {
                            const isClosed = t.closed;
                            const iconHtml = isClosed 
                                ? '<span class="codicon codicon-circuit-board"></span>' 
                                : '<span class="codicon codicon-sync spin" style="color:#9b59b6;"></span>';

                            thoughtsHtml += \`
                                <div class="plan-scratchpad" data-idx="\${idx}">
                                    <details \${!isClosed ? 'open' : ''}>
                                        <summary class="scratchpad-header">
                                            <div style="display: flex; align-items: center; gap: 6px;">
                                                \${iconHtml}
                                                <span style="font-weight: bold;">Thoughts (Reasoning)\${!isClosed ? '...' : ''}</span>
                                            </div>
                                        </summary>
                                        <div class="scratchpad-content">
                                            \${DOMPurify.sanitize(marked.parse(t.content || "*Contemplating...*"))}
                                        </div>
                                    </details>
                                </div>\`;
                        });
                    }

                    const finalMarkdown = parsed.processedContent;
                    container.innerHTML = thoughtsHtml + DOMPurify.sanitize(marked.parse(finalMarkdown));

                    document.querySelectorAll('pre code').forEach((block) => {
                        const pre = block.parentElement;
                        const code = block.textContent;

                        // Copy Button
                        const copyBtn = document.createElement('button');
                        copyBtn.className = 'copy-code secondary';
                        copyBtn.textContent = 'Copy';
                        copyBtn.onclick = () => { vscode.postMessage({ command: 'copyToClipboard', text: code }); };
                        pre.appendChild(copyBtn);

                        // Actions
                        const actionsDiv = document.createElement('div');
                        actionsDiv.style.marginTop = '8px'; actionsDiv.style.display = 'flex'; actionsDiv.style.gap = '8px';

                        const insertBtn = document.createElement('button');
                        insertBtn.innerHTML = '<span class="codicon codicon-arrow-right"></span> Insert';
                        insertBtn.onclick = () => vscode.postMessage({ command: 'insertAtCursor', text: code });

                        const replaceBtn = document.createElement('button');
                        replaceBtn.innerHTML = '<span class="codicon codicon-replace"></span> Replace';
                        replaceBtn.onclick = () => vscode.postMessage({ command: 'replaceSelection', text: code });

                        actionsDiv.appendChild(insertBtn);
                        actionsDiv.appendChild(replaceBtn);
                        pre.insertAdjacentElement('afterend', actionsDiv);
                    });

                    Prism.highlightAllUnder(container);
                    container.scrollTop = container.scrollHeight;
                }

                function appendChunk(chunk) {
                    activeContentBuffer += chunk;
                    renderResponse(activeContentBuffer, "");
                }

                function copyFullResponse() { vscode.postMessage({ command: 'copyToClipboard', text: activeContentBuffer }); }
                function loadHistory(id) { 
                    vscode.postMessage({ command: 'loadHistory', id: id }); 
                    toggleHistory(); // Close drawer on selection
                }

                function deleteHistory(e, id) { 
                    e.stopPropagation();
                    vscode.postMessage({ command: 'deleteHistory', id: id }); 
                }

                function clearHistory() { vscode.postMessage({ command: 'clearHistory' }); }

                function submitPrompt() {
                    const text = promptInput.value.trim();
                    if (!text) return;
                    vscode.postMessage({ command: 'submitPrompt', text: text });
                    promptInput.value = '';
                }

                promptInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        submitPrompt();
                    }
                });

                // Auto-focus input
                promptInput.focus();

                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.command) {
                        case 'updateContextInfo':
                            document.getElementById('context-info-text').textContent = message.text;
                            break;
                        case 'updateAttachState':
                            const btn = document.getElementById('attach-btn');
                            if (message.isAttached) {
                                btn.classList.add('attached');
                                btn.title = "Detach from context";
                            } else {
                                btn.classList.remove('attached');
                                btn.title = "Attach to current context";
                            }
                            break;
                        case 'setLoading':
                            const sendBtn = document.getElementById('send-btn');
                            if (message.isLoading) {
                                sendBtn.disabled = true;
                                sendBtn.innerHTML = '<span class="codicon codicon-sync spin"></span>';
                            } else {
                                sendBtn.disabled = false;
                                sendBtn.innerHTML = '<span class="codicon codicon-send"></span> Send';
                                promptInput.focus();
                            }
                            break;
                        case 'appendChunk':
                            appendChunk(message.text);
                            break;
                        case 'renderResponse':
                            renderResponse(message.text, message.prompt);
                            break;
                        case 'clearResponse':
                            renderResponse("", "");
                            break;
                        case 'updateHistory':
                            const list = document.getElementById('history-list');
                            if (list) {
                                list.innerHTML = (message.history || []).map(h => \`
                                    <div class="history-item" onclick="loadHistory('\${h.id}')">
                                        <div class="history-prompt" title="\${h.prompt}">\${h.prompt.substring(0, 50)}\${h.prompt.length > 50 ? '...' : ''}</div>
                                        <div class="history-actions">
                                            <span class="history-time">\${new Date(h.timestamp).toLocaleTimeString()}</span>
                                            <button class="delete-btn" onclick="deleteHistory(event, '\${h.id}')">×</button>
                                        </div>
                                    </div>
                                \`).join('');
                            }
                            break;
                    }
                });
            </script>
        </body>
        </html>`;
    }
}
