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

    public static createOrShow(extensionUri: vscode.Uri, gitIntegration: GitIntegration, lollmsAPI: LollmsAPI) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (CommitInspectorPanel.currentPanel) {
            CommitInspectorPanel.currentPanel._panel.reveal(column);
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

        CommitInspectorPanel.currentPanel = new CommitInspectorPanel(panel, extensionUri, gitIntegration, lollmsAPI);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, gitIntegration: GitIntegration, lollmsAPI: LollmsAPI) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._gitIntegration = gitIntegration;
        this._lollmsAPI = lollmsAPI;

        this._panel.webview.html = this._getHtmlForWebview();
        
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._setWebviewMessageListener(this._panel.webview);

        // Initial load
        this.loadCommits();
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

    private _setWebviewMessageListener(webview: vscode.Webview) {
        webview.onDidReceiveMessage(async (message) => {
            const folder = vscode.workspace.workspaceFolders?.[0];
            if (!folder) return;

            switch (message.command) {
                case 'refresh':
                    await this.loadCommits();
                    break;
                case 'analyzeCommit':
                    if (message.hash) {
                        await this.analyzeCommit(folder, message.hash);
                    }
                    break;
            }
        }, null, this._disposables);
    }

    private async analyzeCommit(folder: vscode.WorkspaceFolder, hash: string) {
        this._panel.webview.postMessage({ command: 'setLoading', value: true });
        
        try {
            const diff = await this._gitIntegration.getCommitDiff(folder, hash);
            
            // Construct the prompt for analysis
            const systemPrompt = getProcessedSystemPrompt('codeInspectorPersona' as any) || "You are a senior security auditor and code reviewer.";
            
            const userPrompt = `Please analyze the following Git Commit Diff.
            
**Task:**
1.  **Summarize** the changes briefly.
2.  **Security Analysis:** Look for hardcoded secrets, injection vulnerabilities (SQLi, XSS), unsafe API usage, or logic flaws.
3.  **Malicious Code Detection:** Identify any suspicious obfuscation, backdoors, or code that seems to act like a "bad actor" (e.g., unauthorized network calls, file system tampering).
4.  **Quality:** Mention any major code quality issues or bugs introduced.

**Commit Hash:** ${hash}

**Diff Content:**
\`\`\`diff
${diff.substring(0, 15000)} 
\`\`\`
(Note: Diff may be truncated if too large)
`;

            const response = await this._lollmsAPI.sendChat([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ]);

            this._panel.webview.postMessage({ command: 'showAnalysis', report: response });

        } catch (error: any) {
            this._panel.webview.postMessage({ command: 'error', message: `Analysis failed: ${error.message}` });
        } finally {
            this._panel.webview.postMessage({ command: 'setLoading', value: false });
        }
    }

    private _getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Commit Inspector</title>
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
        .commit-msg { font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .commit-meta { font-size: 0.85em; opacity: 0.8; margin-top: 4px; display: flex; justify-content: space-between; }
        
        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none; padding: 6px 12px; cursor: pointer;
        }
        button:hover { background-color: var(--vscode-button-hoverBackground); }
        
        #analysis-report {
            margin-top: 20px;
            line-height: 1.6;
        }
        #loading { display: none; margin-top: 20px; font-style: italic; }
        pre { background: var(--vscode-textCodeBlock-background); padding: 10px; overflow-x: auto; }
    </style>
</head>
<body>
    <div class="sidebar">
        <div class="header">
            <span>Recent Commits</span>
            <button id="refresh-btn">↻</button>
        </div>
        <div class="commit-list" id="commit-list">
            <!-- Commits will be injected here -->
        </div>
    </div>
    <div class="main-content">
        <h1>Commit Analysis</h1>
        <div id="placeholder">Select a commit from the sidebar to inspect it.</div>
        <div id="loading">Analyzing commit... this may take a moment.</div>
        <div id="analysis-report"></div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const listContainer = document.getElementById('commit-list');
        const reportContainer = document.getElementById('analysis-report');
        const loadingDiv = document.getElementById('loading');
        const placeholder = document.getElementById('placeholder');

        document.getElementById('refresh-btn').addEventListener('click', () => {
            vscode.postMessage({ command: 'refresh' });
        });

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'updateCommits':
                    renderCommits(message.commits);
                    break;
                case 'setLoading':
                    if (message.value) {
                        loadingDiv.style.display = 'block';
                        reportContainer.innerHTML = '';
                        placeholder.style.display = 'none';
                    } else {
                        loadingDiv.style.display = 'none';
                    }
                    break;
                case 'showAnalysis':
                    // Simple markdown rendering regex replacement for bold/code
                    let html = message.report
                        .replace(/^### (.*$)/gim, '<h3>$1</h3>')
                        .replace(/^## (.*$)/gim, '<h2>$1</h2>')
                        .replace(/^# (.*$)/gim, '<h1>$1</h1>')
                        .replace(/\\*\\*(.*)\\*\\*/gim, '<b>$1</b>')
                        .replace(/\\n/gim, '<br>')
                        .replace(/\`\`\`([\\s\\S]*?)\`\`\`/gim, '<pre>$1</pre>');
                    
                    reportContainer.innerHTML = html;
                    break;
                case 'error':
                    reportContainer.innerHTML = '<span style="color:red">Error: ' + message.message + '</span>';
                    loadingDiv.style.display = 'none';
                    break;
            }
        });

        function renderCommits(commits) {
            listContainer.innerHTML = '';
            commits.forEach(commit => {
                const el = document.createElement('div');
                el.className = 'commit-item';
                el.innerHTML = \`
                    <div class="commit-msg">\${commit.message}</div>
                    <div class="commit-meta">
                        <span>\${commit.author}</span>
                        <span>\${commit.date}</span>
                    </div>
                \`;
                el.addEventListener('click', () => {
                    // Highlight logic
                    document.querySelectorAll('.commit-item').forEach(i => i.classList.remove('selected'));
                    el.classList.add('selected');
                    
                    vscode.postMessage({ command: 'analyzeCommit', hash: commit.hash });
                });
                listContainer.appendChild(el);
            });
        }
    </script>
</body>
</html>`;
    }
}
