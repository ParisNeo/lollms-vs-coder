import * as vscode from 'vscode';
import { GitIntegration, GitCommit, GitSearchOptions } from '../gitIntegration';
import { LollmsAPI } from '../lollmsAPI';

export class GitManagerPanel {
    public static currentPanel: GitManagerPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _gitIntegration: GitIntegration;
    private readonly _lollmsAPI: LollmsAPI;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri, gitIntegration: GitIntegration, lollmsAPI: LollmsAPI) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (GitManagerPanel.currentPanel) {
            GitManagerPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'lollmsGitManager',
            'Lollms Git Manager',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
                retainContextWhenHidden: true
            }
        );

        GitManagerPanel.currentPanel = new GitManagerPanel(panel, extensionUri, gitIntegration, lollmsAPI);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, gitIntegration: GitIntegration, lollmsAPI: LollmsAPI) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._gitIntegration = gitIntegration;
        this._lollmsAPI = lollmsAPI;

        this._panel.webview.html = this._getHtmlForWebview();
        
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._setWebviewMessageListener(this._panel.webview);

        // Load initial recent history
        this.performSearch({});
    }

    public dispose() {
        GitManagerPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) { x.dispose(); }
        }
    }

    private _setWebviewMessageListener(webview: vscode.Webview) {
        webview.onDidReceiveMessage(async (message) => {
            const folder = vscode.workspace.workspaceFolders?.[0];
            if (!folder) {
                vscode.window.showErrorMessage("No workspace folder open.");
                return;
            }

            switch (message.command) {
                case 'search':
                    await this.performSearch(message.options);
                    break;
                case 'askAI':
                    await this.askAI(message.query);
                    break;
                case 'viewCommit':
                    // Open the existing Commit Inspector for details
                    vscode.commands.executeCommand('lollms-vs-coder.inspectCommit');
                    // We could also show details in this panel, but reusing inspector is nice.
                    // Actually, let's show details here for a smoother experience or a modal.
                    // For now, let's just show a quick diff in the panel or simple info.
                    await this.showCommitDetails(message.hash);
                    break;
            }
        }, null, this._disposables);
    }

    private async performSearch(options: GitSearchOptions) {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) return;

        this._panel.webview.postMessage({ command: 'setLoading', value: true });
        try {
            const commits = await this._gitIntegration.searchCommits(folder, options);
            this._panel.webview.postMessage({ command: 'updateResults', commits });
        } catch (e: any) {
            vscode.window.showErrorMessage("Search failed: " + e.message);
        } finally {
            this._panel.webview.postMessage({ command: 'setLoading', value: false });
        }
    }

    private async showCommitDetails(hash: string) {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) return;

        try {
            const diff = await this._gitIntegration.getCommitDiff(folder, hash);
            this._panel.webview.postMessage({ command: 'showCommitDetails', hash, diff });
        } catch (e: any) {
            vscode.window.showErrorMessage("Failed to get diff: " + e.message);
        }
    }

    private async askAI(query: string) {
        if (!query.trim()) return;
        
        this._panel.webview.postMessage({ command: 'setAiLoading', value: true });

        try {
            const systemPrompt = `You are a Git Search Assistant.
            User will ask a question about the git history.
            You must output ONLY a JSON object representing the search parameters.
            
            Parameters:
            - message: string (regex for commit message)
            - author: string
            - file: string (path)
            - diffFilter: string (A=Added, D=Deleted, M=Modified)
            - content: string (search in content changes/pickaxe)
            
            Examples:
            "When did I delete main.ts?" -> {"file": "main.ts", "diffFilter": "D"}
            "Who changed the login logic?" -> {"message": "login"} or {"content": "login"} (Infer best guess)
            "Commits by Bob about fix" -> {"author": "Bob", "message": "fix"}
            
            Return JSON only. No markdown.`;

            const response = await this._lollmsAPI.sendChat([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: query }
            ]);

            // Clean response
            const jsonStr = response.replace(/```json/g, '').replace(/```/g, '').trim();
            const options = JSON.parse(jsonStr);

            // Send back to UI to populate form and trigger search
            this._panel.webview.postMessage({ command: 'aiSearchReady', options, explanation: `Interpreted: ${JSON.stringify(options)}` });
            await this.performSearch(options);

        } catch (e: any) {
            vscode.window.showErrorMessage("AI Interpretation failed: " + e.message);
        } finally {
            this._panel.webview.postMessage({ command: 'setAiLoading', value: false });
        }
    }

    private _getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Git Manager</title>
    <style>
        body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); padding: 20px; }
        .container { display: flex; flex-direction: column; gap: 20px; }
        
        .card { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); padding: 15px; border-radius: 4px; }
        
        h2 { margin-top: 0; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 10px; }
        
        .search-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
        input, select { 
            background: var(--vscode-input-background); 
            color: var(--vscode-input-foreground); 
            border: 1px solid var(--vscode-input-border);
            padding: 5px;
        }
        
        .btn { 
            background: var(--vscode-button-background); 
            color: var(--vscode-button-foreground); 
            border: none; padding: 8px 15px; cursor: pointer; 
        }
        .btn:hover { background: var(--vscode-button-hoverBackground); }
        
        .ai-section { display: flex; gap: 10px; }
        .ai-section input { flex: 1; }

        .results-list { max-height: 400px; overflow-y: auto; border: 1px solid var(--vscode-panel-border); }
        .commit-item { padding: 10px; border-bottom: 1px solid var(--vscode-panel-border); cursor: pointer; }
        .commit-item:hover { background: var(--vscode-list-hoverBackground); }
        .commit-header { display: flex; justify-content: space-between; font-weight: bold; }
        .commit-meta { font-size: 0.85em; opacity: 0.8; }
        
        #details-view { display: none; margin-top: 20px; border-top: 2px solid var(--vscode-panel-border); padding-top: 20px; }
        pre { background: var(--vscode-textCodeBlock-background); padding: 10px; overflow-x: auto; }
        
        .loading { opacity: 0.5; pointer-events: none; }
    </style>
</head>
<body>
    <div class="container">
        
        <!-- AI Search -->
        <div class="card">
            <h2>Ask Git</h2>
            <div class="ai-section">
                <input type="text" id="ai-input" placeholder="e.g., When did I delete src/utils.ts?">
                <button class="btn" id="ai-btn">Ask AI</button>
            </div>
            <div id="ai-status" style="margin-top:5px; font-size:0.9em; color:var(--vscode-descriptionForeground)"></div>
        </div>

        <!-- Structured Search -->
        <div class="card">
            <h2>Advanced Search</h2>
            <div class="search-grid">
                <input type="text" id="s-message" placeholder="Message (grep)">
                <input type="text" id="s-author" placeholder="Author">
                <input type="text" id="s-file" placeholder="File Path">
                <select id="s-filter">
                    <option value="">Any Change</option>
                    <option value="A">Added</option>
                    <option value="D">Deleted</option>
                    <option value="M">Modified</option>
                </select>
                <input type="text" id="s-content" placeholder="Content (Pickaxe -S)">
                <input type="number" id="s-count" value="50" placeholder="Limit">
            </div>
            <button class="btn" id="search-btn">Search Logs</button>
        </div>

        <!-- Results -->
        <div class="card">
            <h2>Results <span id="result-count"></span></h2>
            <div class="results-list" id="results-list">
                <!-- Items injected here -->
            </div>
        </div>

        <!-- Details -->
        <div id="details-view" class="card">
            <h3>Commit Details <span id="detail-hash"></span></h3>
            <pre id="detail-content"></pre>
        </div>

    </div>

    <script>
        const vscode = acquireVsCodeApi();
        
        // Elements
        const aiInput = document.getElementById('ai-input');
        const aiBtn = document.getElementById('ai-btn');
        const aiStatus = document.getElementById('ai-status');
        
        const sMessage = document.getElementById('s-message');
        const sAuthor = document.getElementById('s-author');
        const sFile = document.getElementById('s-file');
        const sFilter = document.getElementById('s-filter');
        const sContent = document.getElementById('s-content');
        const sCount = document.getElementById('s-count');
        const searchBtn = document.getElementById('search-btn');
        
        const resultsList = document.getElementById('results-list');
        const detailsView = document.getElementById('details-view');
        const detailHash = document.getElementById('detail-hash');
        const detailContent = document.getElementById('detail-content');

        // AI Search
        aiBtn.addEventListener('click', () => {
            const query = aiInput.value;
            if(query) {
                vscode.postMessage({ command: 'askAI', query });
            }
        });

        // Manual Search
        searchBtn.addEventListener('click', () => {
            const options = {
                message: sMessage.value,
                author: sAuthor.value,
                file: sFile.value,
                diffFilter: sFilter.value,
                content: sContent.value,
                count: parseInt(sCount.value) || 50
            };
            vscode.postMessage({ command: 'search', options });
        });

        // Handle messages
        window.addEventListener('message', event => {
            const msg = event.data;
            switch(msg.command) {
                case 'setLoading':
                    searchBtn.textContent = msg.value ? 'Searching...' : 'Search Logs';
                    if(msg.value) resultsList.style.opacity = '0.5';
                    else resultsList.style.opacity = '1';
                    break;
                case 'setAiLoading':
                    aiBtn.textContent = msg.value ? 'Thinking...' : 'Ask AI';
                    break;
                case 'aiSearchReady':
                    // Populate fields
                    sMessage.value = msg.options.message || '';
                    sAuthor.value = msg.options.author || '';
                    sFile.value = msg.options.file || '';
                    sFilter.value = msg.options.diffFilter || '';
                    sContent.value = msg.options.content || '';
                    aiStatus.textContent = msg.explanation;
                    break;
                case 'updateResults':
                    renderResults(msg.commits);
                    break;
                case 'showCommitDetails':
                    detailHash.textContent = msg.hash;
                    detailContent.textContent = msg.diff;
                    detailsView.style.display = 'block';
                    detailsView.scrollIntoView({ behavior: 'smooth' });
                    break;
            }
        });

        function renderResults(commits) {
            resultsList.innerHTML = '';
            document.getElementById('result-count').textContent = '(' + commits.length + ')';
            
            if(commits.length === 0) {
                resultsList.innerHTML = '<div style="padding:10px;">No commits found.</div>';
                return;
            }

            commits.forEach(c => {
                const div = document.createElement('div');
                div.className = 'commit-item';
                div.innerHTML = \`
                    <div class="commit-header">
                        <span>\${escapeHtml(c.message)}</span>
                        <span>\${c.date}</span>
                    </div>
                    <div class="commit-meta">\${c.author} | \${c.hash.substring(0,7)}</div>
                \`;
                div.addEventListener('click', () => {
                    vscode.postMessage({ command: 'viewCommit', hash: c.hash });
                });
                resultsList.appendChild(div);
            });
        }

        function escapeHtml(text) {
            if(!text) return '';
            return text
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        }
    </script>
</body>
</html>`;
    }
}
