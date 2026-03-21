import * as vscode from 'vscode';
import * as path from 'path';
import { ContextManager } from '../contextManager';
import { Logger } from '../logger';

export class SearchPanel {
    public static currentPanel: SearchPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _contextManager: ContextManager;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri, contextManager: ContextManager) {
        if (SearchPanel.currentPanel) {
            SearchPanel.currentPanel._panel.reveal(vscode.ViewColumn.Beside);
            return;
        }
        const panel = vscode.window.createWebviewPanel('lollmsSearch', 'Lollms: Power Search', vscode.ViewColumn.Beside, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out'), vscode.Uri.joinPath(extensionUri, 'media')]
        });
        SearchPanel.currentPanel = new SearchPanel(panel, extensionUri, contextManager);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, contextManager: ContextManager) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._contextManager = contextManager;
        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._setWebviewMessageListener(this._panel.webview);
    }

    private _setWebviewMessageListener(webview: vscode.Webview) {
        webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'executeSearch':
                    await this._handlePowerSearch(message.query, message.options);
                    break;
                case 'toggleContext':
                    const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, message.path);
                    await this._contextManager.getContextStateProvider()?.setStateForUris([uri], message.state ? 'included' : 'tree-only');
                    vscode.commands.executeCommand('lollms-vs-coder.refreshContext');
                    break;
                case 'peekFile':
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, message.path));
                    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: true });
                    break;
            }
        }, null, this._disposables);
    }

    private async _handlePowerSearch(rawQuery: string, options: any) {
        if (!rawQuery || rawQuery.length < 1) {
            this._panel.webview.postMessage({ command: 'updateResults', results: [], stats: { count: 0 } });
            return;
        }

        // 1. Parse Filter Metadata
        const extMatch = rawQuery.match(/ext:(\w+)/);
        const cleanQuery = rawQuery.replace(/ext:\w+/g, '').trim();
        const searchMode = options.searchMode || 'content'; // 'content' | 'path'

        let results: any[] = [];

        if (searchMode === 'path') {
            // TARGET: FILENAMES
            const allFiles = await this._contextManager.getWorkspaceFilePaths();
            const regex = options.useRegex ? new RegExp(cleanQuery, options.useCase ? '' : 'i') : null;
            
            results = allFiles
                .filter(f => {
                    const matchesExt = extMatch ? f.endsWith(`.${extMatch[1]}`) : true;
                    const matchesQuery = regex ? regex.test(f) : (options.useCase ? f.includes(cleanQuery) : f.toLowerCase().includes(cleanQuery.toLowerCase()));
                    return matchesExt && matchesQuery;
                })
                .map(f => ({ path: f, snippet: 'Filename match', line: 0 }));
        } else {
            // TARGET: CONTENT
            const searchOptions = {
                matchCase: options.useCase,
                wholeWord: options.useWord,
                include: extMatch ? `**/*.${extMatch[1]}` : undefined
            };
            // If useRegex is ON, we treat the query as a literal regex string.
            // If OFF, we escape it to prevent crashes on characters like '(' or '['
            const finalQuery = options.useRegex 
                ? cleanQuery 
                : cleanQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            results = await this._contextManager.searchWorkspaceContent(finalQuery, searchOptions);
        }

        const included = new Set(this._contextManager.getContextStateProvider()?.getIncludedFiles().map(f => f.path) || []);

        this._panel.webview.postMessage({
            command: 'updateResults',
            results: results.map(r => ({ 
                ...r, 
                isIncluded: included.has(r.path) 
            })),
            stats: { count: results.length }
        });
    }

    public dispose() { SearchPanel.currentPanel = undefined; this._panel.dispose(); }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'));
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <style>
                :root { --accent: #007acc; --bg: var(--vscode-editor-background); --fg: var(--vscode-editor-foreground); --panel-bg: var(--vscode-editorWidget-background); }
                body { font-family: var(--vscode-font-family); background: var(--bg); color: var(--fg); padding: 0; margin: 0; overflow: hidden; }
                .app { display: flex; flex-direction: column; height: 100vh; }
                
                /* Super Search Bar */
                .search-area { padding: 20px; background: var(--panel-bg); border-bottom: 1px solid var(--vscode-widget-border); box-shadow: 0 4px 15px rgba(0,0,0,0.2); }
                .input-container { position: relative; display: flex; align-items: center; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 8px; padding: 4px 12px; transition: all 0.2s; }
                .input-container:focus-within { border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 2px rgba(0,122,204,0.3); }
                input { flex: 1; background: transparent; border: none; color: var(--vscode-input-foreground); font-size: 14px; padding: 8px; outline: none; }
                
                .tool-ribbon { display: flex; gap: 8px; margin-top: 12px; align-items: center; }
                .opt-btn { background: var(--vscode-button-secondaryBackground); border: 1px solid transparent; color: var(--vscode-button-secondaryForeground); padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 11px; transition: all 0.1s; }
                .opt-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
                .opt-btn.active { background: var(--accent); color: white; border-color: rgba(255,255,255,0.2); }
                
                .mode-switcher { display: flex; background: var(--vscode-input-background); border-radius: 6px; padding: 2px; border: 1px solid var(--vscode-input-border); margin-right: 12px; }
                .mode-btn { background: transparent; border: none; color: var(--fg); padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 10px; font-weight: bold; opacity: 0.5; }
                .mode-btn.active { background: var(--bg); color: var(--accent); opacity: 1; box-shadow: 0 2px 5px rgba(0,0,0,0.2); }
                
                /* Results List */
                .results { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 12px; scroll-behavior: smooth; }
                .card { background: var(--panel-bg); border: 1px solid var(--vscode-widget-border); border-radius: 10px; overflow: hidden; transition: all 0.2s; animation: slideUp 0.3s ease-out; }
                .card:hover { transform: translateY(-2px); border-color: var(--accent); box-shadow: 0 6px 20px rgba(0,0,0,0.3); }
                .card-header { padding: 10px 15px; display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.03); cursor: pointer; }
                .filename { font-weight: 700; color: var(--vscode-textLink-foreground); display: flex; align-items: center; gap: 8px; }
                
                .snippet { padding: 12px; font-family: 'Fira Code', 'Consolas', monospace; font-size: 12px; background: #00000044; border-top: 1px solid var(--vscode-widget-border); position: relative; }
                .line-num { position: absolute; left: 0; color: var(--accent); opacity: 0.5; font-size: 9px; width: 30px; text-align: center; }
                
                .btn-add { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 11px; }
                .btn-add.included { background: var(--vscode-charts-red); }

                @keyframes popIn { 
                    0% { opacity: 0; transform: scale(0.95) translateY(10px); }
                    100% { opacity: 1; transform: scale(1) translateY(0); }
                }
                .card { 
                    animation: popIn 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275) both; 
                }
                /* Visual "Active" state for the search bar */
                .input-container.active { border-color: var(--vscode-charts-blue); }
                
                .keyboard-hint { font-size: 10px; opacity: 0.4; margin-left: auto; }
                code { background: #ffffff11; padding: 2px 4px; border-radius: 4px; font-size: 0.9em; }
            </style>
        </head>
        <body>
            <div class="app">
                <div class="search-area">
                    <div class="input-container">
                        <i class="codicon codicon-search"></i>
                        <input type="text" id="mainQuery" placeholder="Search... (e.g. 'auth ext:ts -exclude:test')" autofocus>
                        <div class="keyboard-hint">Press Enter to Deep Scan</div>
                    </div>
                    <div class="tool-ribbon">
                        <div class="mode-switcher">
                            <button class="mode-btn active" id="modeContent">Content</button>
                            <button class="mode-btn" id="modePath">Files</button>
                        </div>
                        <button class="opt-btn" id="optRegex" title="Use Regular Expression">.*</button>
                        <button class="opt-btn" id="optCase" title="Match Case">Ab</button>
                        <button class="opt-btn" id="optWord" title="Match Whole Word">\b</button>
                        <div style="width: 1px; height: 16px; background: var(--vscode-widget-border); margin: 0 10px;"></div>
                        <span id="resCount" style="font-size: 11px; opacity: 0.6;">0 results</span>
                    </div>
                </div>
                <div class="results" id="resultsList">
                    <div style="text-align:center; margin-top: 100px; opacity: 0.3;">
                        <i class="codicon codicon-rocket" style="font-size: 40px;"></i>
                        <p>Search your code with RegEx, extensions, and exclusions.</p>
                    </div>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                const qInput = document.getElementById('mainQuery');
                const list = document.getElementById('resultsList');
                
                const state = { 
                    useRegex: false, 
                    useCase: false, 
                    useWord: false,
                    searchMode: 'content' // Default
                };

                // Mode Buttons (Path vs Content)
                function setMode(mode) {
                    state.searchMode = mode;
                    document.getElementById('modeContent').classList.toggle('active', mode === 'content');
                    document.getElementById('modePath').classList.toggle('active', mode === 'path');
                    triggerSearch();
                }
                document.getElementById('modeContent').onclick = () => setMode('content');
                document.getElementById('modePath').onclick = () => setMode('path');

                // Option Toggles
                ['Regex', 'Case', 'Word'].forEach(opt => {
                    const btn = document.getElementById('opt' + opt);
                    btn.onclick = () => {
                        state['use' + opt] = !state['use' + opt];
                        btn.classList.toggle('active', state['use' + opt]);
                        triggerSearch();
                    };
                });

                let timer;
                function triggerSearch() {
                    clearTimeout(timer);
                    timer = setTimeout(() => {
                        vscode.postMessage({ 
                            command: 'executeSearch', 
                            query: qInput.value, 
                            options: state 
                        });
                    }, 300);
                }

                qInput.oninput = triggerSearch;
                qInput.onkeydown = (e) => { if(e.key === 'Enter') triggerSearch(); };

                window.addEventListener('message', e => {
                    if (e.data.command === 'updateResults') {
                        render(e.data.results);
                        document.getElementById('resCount').textContent = e.data.results.length + ' results';
                    }
                });

                function render(results) {
                    list.innerHTML = results.length ? '' : '<div style="text-align:center; margin-top: 50px; opacity: 0.5;">No matches found.</div>';
                    results.forEach((res, i) => {
                        const card = document.createElement('div');
                        card.className = 'card';
                        card.innerHTML = \`
                            <div class="card-header">
                                <div class="filename" onclick="peek('\${res.path}')">
                                    <i class="codicon codicon-file-code"></i> \${res.path}
                                </div>
                                <button class="btn-add \${res.isIncluded ? 'included' : ''}" onclick="toggle(this, '\${res.path}')">
                                    \${res.isIncluded ? 'Unsync' : 'Inject to LLM'}
                                </button>
                            </div>
                            <div class="snippet">
                                <span class="line-num">L\${res.line || '?'}</span>
                                \${escapeHtml(res.snippet)}
                            </div>
                        \`;
                        list.appendChild(card);
                    });
                }

                function toggle(btn, path) {
                    const isAdding = btn.textContent.trim() === 'Inject to LLM';
                    btn.textContent = isAdding ? 'Unsync' : 'Inject to LLM';
                    btn.classList.toggle('included', isAdding);
                    vscode.postMessage({ command: 'toggleContext', path, state: isAdding });
                }

                function peek(path) { vscode.postMessage({ command: 'peekFile', path }); }
                function escapeHtml(t) { return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
            </script>
        </body>
        </html>`;
    }
}