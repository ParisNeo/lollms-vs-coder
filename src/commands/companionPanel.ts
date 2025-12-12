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
            message => {
                switch (message.command) {
                    case 'webview-ready':
                        // Send initial state
                        this.setContextInfo(this._contextInfo);
                        this._panel.webview.postMessage({ command: 'updateAttachState', isAttached: this._isAttached });
                        break;
                    case 'submitPrompt':
                        this._onDidSubmit.fire(message.text);
                        return;
                    case 'copyToClipboard':
                        vscode.env.clipboard.writeText(message.text);
                        vscode.window.showInformationMessage('Copied to clipboard');
                        return;
                    case 'insertAtCursor':
                        this.insertAtCursor(message.text);
                        return;
                    case 'replaceSelection':
                        this.replaceSelection(message.text);
                        return;
                    case 'loadHistory':
                        this.loadHistoryItem(message.id);
                        return;
                    case 'deleteHistory':
                        this.deleteHistoryItem(message.id);
                        return;
                    case 'clearHistory':
                        this._history = [];
                        this._currentHistoryIndex = -1;
                        this.updateView("", "", true);
                        return;
                    case 'openTools':
                        this.handleOpenTools();
                        return;
                    case 'toggleAttach':
                        this.toggleAttach();
                        return;
                }
            },
            null,
            []
        );
        this.updateView("", "");
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
        const relativePath = vscode.workspace.asRelativePath(doc.uri);
        let info = `${relativePath}`;
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

    public addHistory(prompt: string, response: string) {
        const newItem: HistoryItem = {
            id: Date.now().toString(),
            prompt,
            response,
            timestamp: Date.now()
        };
        this._history.unshift(newItem); 
        this.updateView(response, prompt);
    }

    public updateContent(content: string, prompt: string) {
        this.updateView(content, prompt);
    }

    public updateTitle(title: string) {
        this._panel.title = title;
    }

    private loadHistoryItem(id: string) {
        const index = this._history.findIndex(h => h.id === id);
        if (index !== -1) {
            this._currentHistoryIndex = index;
            const item = this._history[index];
            this.updateView(item.response, item.prompt);
        }
    }

    private deleteHistoryItem(id: string) {
        this._history = this._history.filter(h => h.id !== id);
        if (this._history.length > 0) {
            this.loadHistoryItem(this._history[0].id);
        } else {
            this.updateView("", "", true);
        }
    }

    private updateView(content: string, prompt: string, isEmpty: boolean = false) {
        this._panel.webview.html = this._getHtmlForWebview(content, prompt, isEmpty);
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
            await editor.edit(editBuilder => {
                editBuilder.replace(editor.selection, text);
            });
            vscode.window.showTextDocument(editor.document, {
                viewColumn: editor.viewColumn,
                preserveFocus: false
            });
        } else {
            vscode.window.showWarningMessage('No active text editor found. Please click inside a file to activate it.');
        }
    }

    private _getHtmlForWebview(content: string, prompt: string, isEmpty: boolean): string {
        const markedUri = "https://cdn.jsdelivr.net/npm/marked@5.1.1/marked.min.js";
        const domPurifyUri = "https://cdn.jsdelivr.net/npm/dompurify@3.0.5/dist/purify.min.js";
        const prismJsUri = "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js";
        const prismCssUri = "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css";
        const codiconUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'));

        const historyHtml = this._history.map(h => `
            <div class="history-item ${h.prompt === prompt ? 'active' : ''}" onclick="loadHistory('${h.id}')">
                <div class="history-prompt">${h.prompt.substring(0, 50)}${h.prompt.length > 50 ? '...' : ''}</div>
                <div class="history-actions">
                    <span class="history-time">${new Date(h.timestamp).toLocaleTimeString()}</span>
                    <button class="delete-btn" onclick="deleteHistory(event, '${h.id}')">×</button>
                </div>
            </div>
        `).join('');

        const jsonContent = JSON.stringify(content);
        const initialContextInfo = this._contextInfo;
        const initialAttachState = this._isAttached;

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
                <div class="history-list">
                    ${historyHtml}
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
                        <button id="attach-btn" class="icon-btn ${initialAttachState ? 'attached' : ''}" onclick="toggleAttach()" title="${initialAttachState ? 'Detach from context' : 'Attach to current context'}">
                            <span class="codicon codicon-pin"></span>
                        </button>
                        <span class="codicon codicon-target"></span>
                        <span id="context-info-text">${initialContextInfo}</span>
                    </div>
                    <div class="input-container">
                        <textarea id="prompt-input" placeholder="Ask a question or request a change (e.g., 'Refactor this')...">${prompt && !content ? prompt : ''}</textarea>
                        <button onclick="submitPrompt()" id="send-btn" style="height: fit-content; align-self: flex-end;">
                            <span class="codicon codicon-send"></span> Send
                        </button>
                    </div>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                const content = ${isEmpty ? '""' : jsonContent};
                const container = document.getElementById('markdown-content');
                const promptInput = document.getElementById('prompt-input');

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

                function render() {
                    if (!content) {
                        container.innerHTML = '<div style="color: var(--vscode-descriptionForeground); text-align: center; margin-top: 40px;"><h3>👋 Lollms Companion</h3><p>Select code or place your cursor, then type below.</p></div>';
                        return;
                    }
                    container.innerHTML = DOMPurify.sanitize(marked.parse(content));
                    
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
                    
                    Prism.highlightAll();
                    container.scrollTop = container.scrollHeight;
                }

                render();

                function copyFullResponse() { vscode.postMessage({ command: 'copyToClipboard', text: content }); }
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
                    if (message.command === 'updateContextInfo') {
                        document.getElementById('context-info-text').textContent = message.text;
                    }
                    if (message.command === 'updateAttachState') {
                        const btn = document.getElementById('attach-btn');
                        if (message.isAttached) {
                            btn.classList.add('attached');
                            btn.title = "Detach from context";
                        } else {
                            btn.classList.remove('attached');
                            btn.title = "Attach to current context";
                        }
                    }
                    if (message.command === 'setLoading') {
                        const btn = document.getElementById('send-btn');
                        if (message.isLoading) {
                            btn.disabled = true;
                            btn.innerHTML = '<span class="codicon codicon-sync spin"></span>';
                        } else {
                            btn.disabled = false;
                            btn.innerHTML = '<span class="codicon codicon-send"></span> Send';
                            // Re-focus input after generation
                            promptInput.focus();
                        }
                    }
                });
            </script>
        </body>
        </html>`;
    }
}
