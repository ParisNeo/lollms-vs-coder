import * as vscode from 'vscode';
import { GitIntegration, GitCommit } from '../gitIntegration';
import { LollmsAPI, ChatMessage } from '../lollmsAPI';
import { getProcessedSystemPrompt } from '../utils';

export class CommitInspectorPanel {
    public static currentPanel: CommitInspectorPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _gitIntegration: GitIntegration;
    private readonly _lollmsAPI: LollmsAPI;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri, gitIntegration: GitIntegration, lollmsAPI: LollmsAPI, initialHash?: string) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (CommitInspectorPanel.currentPanel) {
            CommitInspectorPanel.currentPanel._panel.reveal(column);
            if (initialHash) {
                CommitInspectorPanel.currentPanel.selectCommit(initialHash);
            }
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'lollmsCommitInspector',
            'Lollms Commit Inspector',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
            }
        );

        CommitInspectorPanel.currentPanel = new CommitInspectorPanel(panel, extensionUri, gitIntegration, lollmsAPI, initialHash);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, gitIntegration: GitIntegration, lollmsAPI: LollmsAPI, initialHash?: string) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._gitIntegration = gitIntegration;
        this._lollmsAPI = lollmsAPI;

        this._panel.webview.html = this._getHtmlForWebview();
        
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._setWebviewMessageListener(this._panel.webview);

        // Initial load
        this.loadCommits().then(() => {
            if (initialHash) {
                this.selectCommit(initialHash);
            }
        });
    }

    public async selectCommit(hash: string) {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (folder) {
            // Highlight in UI
            this._panel.webview.postMessage({ command: 'highlightCommit', hash });
            
            // Load Analysis
            const existing = await this.loadAnalysis(folder, hash);
            if (existing) {
                this._panel.webview.postMessage({ command: 'showAnalysis', report: existing, hash: hash });
            } else {
                this._panel.webview.postMessage({ command: 'showStartAnalysis', hash: hash });
            }
        }
    }

    private async loadCommits() {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (folder) {
            const commits = await this._gitIntegration.getCommitHistory(folder);
            this._panel.webview.postMessage({ command: 'updateCommits', commits });
        } else {
            this._panel.webview.postMessage({ command: 'error', message: 'No workspace folder open.' });
        }
    }

    public dispose() {
        CommitInspectorPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) { x.dispose(); }
        }
    }

    private getAnalysisFilePath(folder: vscode.WorkspaceFolder, hash: string): vscode.Uri {
        return vscode.Uri.joinPath(folder.uri, '.lollms', 'commit_analysis', `${hash}.md`);
    }

    private async loadAnalysis(folder: vscode.WorkspaceFolder, hash: string): Promise<string | null> {
        const fileUri = this.getAnalysisFilePath(folder, hash);
        try {
            const content = await vscode.workspace.fs.readFile(fileUri);
            return Buffer.from(content).toString('utf8');
        } catch {
            return null;
        }
    }

    private async saveAnalysis(folder: vscode.WorkspaceFolder, hash: string, content: string) {
        const fileUri = this.getAnalysisFilePath(folder, hash);
        const parent = vscode.Uri.joinPath(fileUri, '..');
        try {
            await vscode.workspace.fs.createDirectory(parent);
        } catch {}
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));
    }

    private _setWebviewMessageListener(webview: vscode.Webview) {
        webview.onDidReceiveMessage(async (message) => {
            const folder = vscode.workspace.workspaceFolders?.[0];
            if (!folder) return;

            switch (message.command) {
                case 'refresh':
                    await this.loadCommits();
                    break;
                case 'selectCommit':
                    if (message.hash) {
                        await this.selectCommit(message.hash);
                    }
                    break;
                case 'analyzeCommit':
                    if (message.hash) {
                        await this.analyzeCommit(folder, message.hash);
                    }
                    break;
                case 'copyHash':
                    if (message.hash) {
                        await vscode.env.clipboard.writeText(message.hash);
                        vscode.window.showInformationMessage(`Copied commit hash: ${message.hash.substring(0, 7)}`);
                    }
                    break;
            }
        }, null, this._disposables);
    }

    private async analyzeCommit(folder: vscode.WorkspaceFolder, hash: string) {
        this._panel.webview.postMessage({ command: 'setLoading', value: true });
        
        try {
            const diff = await this._gitIntegration.getCommitDiff(folder, hash);
            
            const systemPrompt = await getProcessedSystemPrompt('inspector') || "You are a senior security auditor and code reviewer.";
            
            const userPrompt = `Please analyze the following Git Commit Diff.
            
**Task:**
1.  **Summarize** the changes briefly.
2.  **Security Analysis:** Look for hardcoded secrets, injection vulnerabilities (SQLi, XSS), unsafe API usage, or logic flaws.
3.  **Malicious Code Detection:** Identify any suspicious obfuscation, backdoors, or code that seems to act like a "bad actor".
4.  **Quality:** Mention any major code quality issues.

**Commit Hash:** ${hash}

**Diff Content:**
\`\`\`diff
${diff.substring(0, 15000)} 
\`\`\`
`;

            const response = await this._lollmsAPI.sendChat([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ]);

            await this.saveAnalysis(folder, hash, response);
            this._panel.webview.postMessage({ command: 'showAnalysis', report: response, hash: hash });

        } catch (error: any) {
            this._panel.webview.postMessage({ command: 'error', message: `Analysis failed: ${error.message}` });
        } finally {
            this._panel.webview.postMessage({ command: 'setLoading', value: false });
        }
    }

    private _getHtmlForWebview(): string {
        const markedUri = "https://cdn.jsdelivr.net/npm/marked@5.1.1/marked.min.js";
        const domPurifyUri = "https://cdn.jsdelivr.net/npm/dompurify@3.0.5/dist/purify.min.js";
        const prismJsUri = "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js";
        const prismCssUri = "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css";

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Commit Inspector</title>
    <script src="${markedUri}"></script>
    <script src="${domPurifyUri}"></script>
    <link href="${prismCssUri}" rel="stylesheet" />
    <script src="${prismJsUri}"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-diff.min.js"></script>
    <style>
        body {
            font-family: var(--vscode-font-family);
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 0; margin: 0;
            display: flex; height: 100vh;
        }
        .sidebar {
            width: 300px;
            border-right: 1px solid var(--vscode-panel-border);
            display: flex; flex-direction: column;
            background-color: var(--vscode-sideBar-background);
        }
        .main-content {
            flex: 1;
            padding: 20px;
            overflow-y: auto;
            display: flex; flex-direction: column;
        }
        .header {
            padding: 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex; justify-content: space-between; align-items: center;
            background-color: var(--vscode-sideBarSectionHeader-background);
        }
        .commit-list {
            flex: 1; overflow-y: auto;
        }
        .commit-item {
            padding: 8px 10px;
            border-bottom: 1px solid var(--vscode-list-hoverBackground);
            cursor: pointer;
        }
        .commit-item:hover { background-color: var(--vscode-list-hoverBackground); }
        .commit-item.selected { background-color: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
        .commit-msg { font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
        .commit-meta { font-size: 0.85em; opacity: 0.8; margin-top: 4px; display: flex; justify-content: space-between; }
        
        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none; padding: 6px 12px; cursor: pointer;
            border-radius: 2px;
        }
        button:hover { background-color: var(--vscode-button-hoverBackground); }
        
        .action-bar { margin-bottom: 15px; display: flex; gap: 10px; align-items: center; }
        
        #analysis-report {
            margin-top: 20px;
            line-height: 1.6;
        }
        #analysis-report h1, #analysis-report h2, #analysis-report h3 { border-bottom: 1px solid var(--vscode-textSeparator-foreground); padding-bottom: 0.3em; }
        
        #loading { display: none; margin-top: 20px; font-style: italic; display: flex; align-items: center; gap: 10px; }
        #placeholder { color: var(--vscode-descriptionForeground); margin-top: 20px; }
        
        #start-analysis-container { display: none; text-align: center; margin-top: 50px; }
        
        pre { border-radius: 4px; padding: 1em; overflow-x: auto; background-color: var(--vscode-textCodeBlock-background); }
        code { font-family: var(--vscode-editor-font-family); }
        
        .spinner {
            border: 2px solid var(--vscode-button-foreground);
            border-top: 2px solid transparent;
            border-radius: 50%;
            width: 16px;
            height: 16px;
            animation: spin 1s linear infinite;
            display: inline-block;
        }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

        .icon-btn { 
            background: none; border: none; color: var(--vscode-icon-foreground); 
            cursor: pointer; padding: 2px; display: flex; align-items: center; 
            opacity: 0.7; flex-shrink: 0; margin-right: 6px;
        }
        .icon-btn:hover { opacity: 1; background-color: var(--vscode-toolbar-hoverBackground); border-radius: 3px; }
        .commit-top { display: flex; align-items: center; }
    </style>
</head>
<body>
    <div class="sidebar">
        <div class="header">
            <span>Recent Commits</span>
            <button id="refresh-btn">↻</button>
        </div>
        <div class="commit-list" id="commit-list"></div>
    </div>
    <div class="main-content">
        <h1>Commit Analysis</h1>
        <div id="placeholder">Select a commit from the sidebar to view or start an analysis.</div>
        
        <div id="loading" style="display:none;">
            <div class="spinner"></div>
            <span>Analyzing commit... this may take a moment.</span>
        </div>

        <div id="start-analysis-container">
            <p>No analysis found for this commit.</p>
            <button id="start-analysis-btn">Start Analysis</button>
        </div>

        <div id="analysis-view" style="display:none;">
            <div class="action-bar">
                <button id="regenerate-btn">Regenerate Analysis</button>
            </div>
            <div id="analysis-report"></div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const listContainer = document.getElementById('commit-list');
        const reportContainer = document.getElementById('analysis-report');
        const analysisView = document.getElementById('analysis-view');
        const startAnalysisContainer = document.getElementById('start-analysis-container');
        const loadingDiv = document.getElementById('loading');
        const placeholder = document.getElementById('placeholder');
        
        let currentHash = null;

        document.getElementById('refresh-btn').addEventListener('click', () => {
            vscode.postMessage({ command: 'refresh' });
        });

        document.getElementById('start-analysis-btn').addEventListener('click', () => {
            if(currentHash) {
                vscode.postMessage({ command: 'analyzeCommit', hash: currentHash });
            }
        });

        document.getElementById('regenerate-btn').addEventListener('click', () => {
            if(currentHash) {
                vscode.postMessage({ command: 'analyzeCommit', hash: currentHash });
            }
        });

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'updateCommits':
                    renderCommits(message.commits);
                    break;
                case 'setLoading':
                    if (message.value) {
                        loadingDiv.style.display = 'flex';
                        analysisView.style.display = 'none';
                        startAnalysisContainer.style.display = 'none';
                        placeholder.style.display = 'none';
                    } else {
                        loadingDiv.style.display = 'none';
                    }
                    break;
                case 'highlightCommit':
                    document.querySelectorAll('.commit-item').forEach(i => i.classList.remove('selected'));
                    const item = document.querySelector(\`.commit-item[data-hash="\${message.hash}"]\`);
                    if(item) {
                        item.classList.add('selected');
                        item.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                    currentHash = message.hash;
                    break;
                case 'showAnalysis':
                    currentHash = message.hash;
                    const html = DOMPurify.sanitize(marked.parse(message.report));
                    reportContainer.innerHTML = html;
                    Prism.highlightAllUnder(reportContainer);
                    
                    analysisView.style.display = 'block';
                    startAnalysisContainer.style.display = 'none';
                    placeholder.style.display = 'none';
                    loadingDiv.style.display = 'none';
                    break;
                case 'showStartAnalysis':
                    currentHash = message.hash;
                    startAnalysisContainer.style.display = 'block';
                    analysisView.style.display = 'none';
                    placeholder.style.display = 'none';
                    loadingDiv.style.display = 'none';
                    break;
                case 'error':
                    reportContainer.innerHTML = '<span style="color:var(--vscode-errorForeground)">Error: ' + message.message + '</span>';
                    analysisView.style.display = 'block';
                    loadingDiv.style.display = 'none';
                    break;
            }
        });

        function renderCommits(commits) {
            listContainer.innerHTML = '';
            commits.forEach(commit => {
                const el = document.createElement('div');
                el.className = 'commit-item';
                el.setAttribute('data-hash', commit.hash);
                if (currentHash === commit.hash) el.classList.add('selected');
                el.innerHTML = \`
                    <div class="commit-top">
                        <button class="icon-btn copy-btn" title="Copy Hash" data-hash="\${commit.hash}">
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                                <path d="M4 4l1-1h5.414L14 6.586V14l-1 1H5l-1-1V4zm9 3l-3-3H5v10h8V7z"/>
                                <path d="M3 1L2 2v10l1 1V2h6.414l-1-1H3z"/>
                            </svg>
                        </button>
                        <div class="commit-msg">\${commit.message}</div>
                    </div>
                    <div class="commit-meta">
                        <span>\${commit.author}</span>
                        <span>\${commit.date}</span>
                    </div>
                \`;
                el.addEventListener('click', (e) => {
                    // Prevent select if copy button clicked
                    if (e.target.closest('.copy-btn')) return;
                    vscode.postMessage({ command: 'selectCommit', hash: commit.hash });
                });

                el.querySelector('.copy-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    vscode.postMessage({ command: 'copyHash', hash: commit.hash });
                });

                listContainer.appendChild(el);
            });
        }
    </script>
</body>
</html>`;
    }
}
