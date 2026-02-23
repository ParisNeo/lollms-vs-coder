import * as vscode from 'vscode';
import { ContextManager } from '../contextManager';

export class SearchAddProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'lollmsSearchAddView';
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _contextManager: ContextManager
    ) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtml();

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case 'search':
                    await this._doSearch(msg.text);
                    break;
                case 'addFile':
                    await vscode.commands.executeCommand('lollms-vs-coder.addFilesToContext', [msg.path]);
                    break;
                case 'addAll':
                    await vscode.commands.executeCommand('lollms-vs-coder.addFilesToContext', msg.paths);
                    vscode.window.showInformationMessage(`Added ${msg.paths.length} files to Lollms context.`);
                    break;
            }
        });
    }

    private async _doSearch(query: string) {
        if (!query) return;
        const results: string[] = [];
        const options: vscode.FindTextInFilesOptions = {
            include: '**/*',
            useIgnoreFiles: true,
        };

        await vscode.workspace.findTextInFiles({ pattern: query }, options, (result) => {
            const relPath = vscode.workspace.asRelativePath(result.uri);
            if (!results.includes(relPath)) {
                results.push(relPath);
            }
        });

        this._view?.webview.postMessage({ command: 'results', files: results });
    }

    private _getHtml() {
        return `<!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { padding: 10px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
                    .search-container { display: flex; gap: 5px; margin-bottom: 10px; }
                    input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px; }
                    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 8px; cursor: pointer; }
                    button:hover { background: var(--vscode-button-hoverBackground); }
                    .file-item { display: flex; align-items: center; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid var(--vscode-widget-border); font-size: 12px; }
                    .file-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 5px; }
                    .add-btn { font-size: 10px; padding: 2px 6px; }
                    #results-info { font-size: 11px; opacity: 0.8; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
                </style>
            </head>
            <body>
                <div class="search-container">
                    <input type="text" id="searchInput" placeholder="Search code content...">
                    <button id="searchBtn">Search</button>
                </div>
                <div id="results-info" style="display:none">
                    <span id="count"></span>
                    <button id="addAllBtn" class="add-btn">Add All</button>
                </div>
                <div id="resultsList"></div>
                <script>
                    const vscode = acquireVsCodeApi();
                    let currentFiles = [];
                    
                    document.getElementById('searchBtn').onclick = () => {
                        const text = document.getElementById('searchInput').value;
                        vscode.postMessage({ command: 'search', text });
                    };

                    document.getElementById('addAllBtn').onclick = () => {
                        vscode.postMessage({ command: 'addAll', paths: currentFiles });
                    };

                    window.addEventListener('message', event => {
                        const msg = event.data;
                        if (msg.command === 'results') {
                            currentFiles = msg.files;
                            const list = document.getElementById('resultsList');
                            const info = document.getElementById('results-info');
                            list.innerHTML = '';
                            
                            if (msg.files.length > 0) {
                                info.style.display = 'flex';
                                document.getElementById('count').textContent = msg.files.length + ' files found';
                                msg.files.forEach(f => {
                                    const div = document.createElement('div');
                                    div.className = 'file-item';
                                    div.innerHTML = '<span class="file-path">' + f + '</span><button class="add-btn">Add</button>';
                                    div.querySelector('button').onclick = () => vscode.postMessage({ command: 'addFile', path: f });
                                    list.appendChild(div);
                                });
                            } else {
                                info.style.display = 'none';
                                list.innerHTML = 'No results found.';
                            }
                        }
                    });
                </script>
            </body>
            </html>`;
    }
}