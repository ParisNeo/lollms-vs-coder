import * as vscode from 'vscode';

export class InfoPanel {
    public static currentPanel: InfoPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _content: string;

    public static createOrShow(extensionUri: vscode.Uri, title: string, content: string) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (InfoPanel.currentPanel) {
            InfoPanel.currentPanel._panel.reveal(column);
            InfoPanel.currentPanel.updateContent(title, content);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'lollmsInfoPanel',
            title,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri]
            }
        );

        InfoPanel.currentPanel = new InfoPanel(panel, extensionUri, content);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, content: string) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._content = content;

        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview, this._panel.title, this._content);
        this._setWebviewMessageListener();

        this._panel.onDidDispose(() => this.dispose(), null, []);
    }
    
    public updateContent(title: string, content: string) {
        this._panel.title = title;
        this._content = content;
        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview, title, content);
    }

    public dispose() {
        InfoPanel.currentPanel = undefined;
        this._panel.dispose();
    }

    private _setWebviewMessageListener() {
        this._panel.webview.onDidReceiveMessage(message => {
            switch (message.command) {
                case 'saveInfoToFile':
                    vscode.commands.executeCommand('lollms-vs-coder.saveInfoToFile', this._content);
                    return;
            }
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview, title: string, content: string): string {
        const prismJsUri = "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js";
        const prismCssUri = "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css";
        const codiconCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'));

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${title}</title>
            <script src="https://cdn.jsdelivr.net/npm/marked@5.1.1/marked.min.js"></script>
            <script src="https://cdn.jsdelivr.net/npm/dompurify@3.0.5/dist/purify.min.js"></script>
            <link href="${prismCssUri}" rel="stylesheet" />
            <link href="${codiconCssUri}" rel="stylesheet" />
            <script src="${prismJsUri}"></script>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-python.min.js"></script>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-javascript.min.js"></script>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-typescript.min.js"></script>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-bash.min.js"></script>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-json.min.js"></script>
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
                }
                .container {
                    padding: 1.5em;
                    flex: 1;
                    overflow-y: auto;
                    line-height: 1.6;
                }
                .footer {
                    padding: 0.8em 1.5em;
                    display: flex;
                    gap: 10px;
                    justify-content: flex-end;
                    background-color: var(--vscode-editorWidget-background);
                    border-top: 1px solid var(--vscode-panel-border);
                }
                button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: 1px solid var(--vscode-button-border);
                    padding: 8px 14px;
                    cursor: pointer;
                    border-radius: 4px;
                }
                button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                pre {
                    background-color: var(--vscode-textCodeBlock-background);
                    padding: 1em;
                    border-radius: 6px;
                    overflow-x: auto;
                    border: 1px solid var(--vscode-widget-border);
                }
                code {
                    font-family: var(--vscode-editor-font-family);
                    font-size: 0.9em;
                }
                h1, h2, h3 { border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 0.3em; }

                /* Search Widget */
                .search-widget {
                    position: fixed;
                    top: 20px;
                    right: 40px;
                    z-index: 1000;
                    display: none;
                    background: var(--vscode-editorWidget-background);
                    border: 1px solid var(--vscode-widget-border);
                    box-shadow: 0 4px 10px rgba(0,0,0,0.3);
                    padding: 6px;
                    border-radius: 4px;
                    align-items: center;
                    gap: 6px;
                }
                .search-widget.visible { display: flex; }
                .search-widget input {
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    padding: 4px 8px;
                    width: 200px;
                    outline: none;
                    border-radius: 2px;
                }
                .search-widget input:focus { border-color: var(--vscode-focusBorder); }
                .search-icon-btn {
                    background: transparent;
                    border: none;
                    color: var(--vscode-icon-foreground);
                    cursor: pointer;
                    padding: 4px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: 3px;
                }
                .search-icon-btn:hover { background-color: var(--vscode-toolbar-hoverBackground); }
                .matches-count {
                    font-size: 12px;
                    margin: 0 6px;
                    min-width: 40px;
                    text-align: center;
                    opacity: 0.8;
                }
                mark {
                    background-color: var(--vscode-editor-findMatchHighlightBackground);
                    color: inherit;
                    border-radius: 2px;
                }
                mark.current {
                    background-color: var(--vscode-editor-findMatchBackground);
                    border: 1px solid var(--vscode-editor-findMatchBorder);
                }
            </style>
        </head>
        <body>
            <div class="search-widget" id="search-widget">
                <input type="text" id="search-input" placeholder="Find">
                <span class="matches-count" id="matches-count"></span>
                <button class="search-icon-btn" id="prev-match-btn" title="Previous Match (Shift+Enter)">
                    <span class="codicon codicon-arrow-up"></span>
                </button>
                <button class="search-icon-btn" id="next-match-btn" title="Next Match (Enter)">
                    <span class="codicon codicon-arrow-down"></span>
                </button>
                <button class="search-icon-btn" id="close-search-btn" title="Close (Esc)">
                    <span class="codicon codicon-close"></span>
                </button>
            </div>

            <div class="container" id="content-container">
                <!-- Content will be rendered here -->
            </div>
            <div class="footer">
                <button id="copy-btn">Copy</button>
                <button id="save-btn">Save to File...</button>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                const contentContainer = document.getElementById('content-container');
                const copyBtn = document.getElementById('copy-btn');
                const saveBtn = document.getElementById('save-btn');
                
                // Search Elements
                const searchWidget = document.getElementById('search-widget');
                const searchInput = document.getElementById('search-input');
                const matchesCount = document.getElementById('matches-count');
                let searchMatches = [];
                let currentMatchIndex = -1;

                const rawContent = ${JSON.stringify(content)};
                
                // Configure marked for breaks and GFM
                marked.setOptions({ breaks: true, gfm: true });
                contentContainer.innerHTML = DOMPurify.sanitize(marked.parse(rawContent));
                Prism.highlightAll();

                // Actions
                copyBtn.addEventListener('click', () => {
                    navigator.clipboard.writeText(rawContent);
                    copyBtn.textContent = 'Copied!';
                    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
                });

                saveBtn.addEventListener('click', () => {
                    vscode.postMessage({ command: 'saveInfoToFile' });
                });

                // --- Search Logic ---
                function openSearch() {
                    searchWidget.classList.add('visible');
                    searchInput.focus();
                    const selection = window.getSelection().toString();
                    if (selection) {
                        searchInput.value = selection;
                        performSearch();
                    }
                }

                function closeSearch() {
                    searchWidget.classList.remove('visible');
                    clearHighlights();
                }

                function clearHighlights() {
                    searchMatches.forEach(mark => {
                        const parent = mark.parentNode;
                        parent.replaceChild(document.createTextNode(mark.textContent), mark);
                        parent.normalize();
                    });
                    searchMatches = [];
                    currentMatchIndex = -1;
                    matchesCount.textContent = '';
                }

                function performSearch() {
                    clearHighlights();
                    const query = searchInput.value;
                    if (!query) return;

                    const escapedQuery = query.replace(/[.*+?^$\{}()|[\\]\\\\]/g, '\\\\$&');
                    const regex = new RegExp(escapedQuery, 'gi');
                    
                    const walker = document.createTreeWalker(
                        contentContainer, 
                        NodeFilter.SHOW_TEXT,
                        {
                            acceptNode: function(node) {
                                // Skip non-content
                                if (node.parentNode.nodeName === 'SCRIPT' || node.parentNode.nodeName === 'STYLE') {
                                    return NodeFilter.FILTER_REJECT;
                                }
                                return NodeFilter.FILTER_ACCEPT;
                            }
                        }
                    );
                    
                    const textNodes = [];
                    while(walker.nextNode()) textNodes.push(walker.currentNode);

                    textNodes.forEach(node => {
                        const text = node.textContent;
                        if (!text.match(regex)) return;

                        const fragment = document.createDocumentFragment();
                        let lastIndex = 0;
                        let match;
                        regex.lastIndex = 0;

                        while ((match = regex.exec(text)) !== null) {
                            fragment.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
                            
                            const mark = document.createElement('mark');
                            mark.textContent = match[0];
                            fragment.appendChild(mark);
                            searchMatches.push(mark);
                            
                            lastIndex = regex.lastIndex;
                        }
                        fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
                        node.parentNode.replaceChild(fragment, node);
                    });

                    if (searchMatches.length > 0) {
                        currentMatchIndex = 0;
                        updateMatchState();
                    } else {
                        matchesCount.textContent = '0/0';
                    }
                }

                function updateMatchState() {
                    searchMatches.forEach(m => m.classList.remove('current'));
                    if (currentMatchIndex >= 0 && currentMatchIndex < searchMatches.length) {
                        const current = searchMatches[currentMatchIndex];
                        current.classList.add('current');
                        current.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        matchesCount.textContent = (currentMatchIndex + 1) + ' of ' + searchMatches.length;
                    }
                }

                function nextMatch() {
                    if (searchMatches.length === 0) return;
                    currentMatchIndex = (currentMatchIndex + 1) % searchMatches.length;
                    updateMatchState();
                }

                function prevMatch() {
                    if (searchMatches.length === 0) return;
                    currentMatchIndex = (currentMatchIndex - 1 + searchMatches.length) % searchMatches.length;
                    updateMatchState();
                }

                // Keyboard bindings
                document.addEventListener('keydown', (e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                        e.preventDefault();
                        openSearch();
                    }
                    if (e.key === 'Escape' && searchWidget.classList.contains('visible')) {
                        closeSearch();
                    }
                });

                searchInput.addEventListener('input', performSearch);
                searchInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        if (e.shiftKey) prevMatch();
                        else nextMatch();
                        e.preventDefault();
                    }
                });

                document.getElementById('next-match-btn').addEventListener('click', nextMatch);
                document.getElementById('prev-match-btn').addEventListener('click', prevMatch);
                document.getElementById('close-search-btn').addEventListener('click', closeSearch);
            </script>
        </body>
        </html>`;
    }
}