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

        // Load initial recent history and starting baseline ref
        this.performSearch({});
        this.loadDefaultBaseRef();
    }

    private async getTargetWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
        const folders = vscode.workspace.workspaceFolders || [];
        for (const f of folders) {
            if (await this._gitIntegration.isGitRepo(f)) return f;
        }
        return folders[0];
    }

    private async loadDefaultBaseRef() {
        const folder = await this.getTargetWorkspaceFolder();
        if (!folder) return;
        try {
            const { ChatPanel } = await import('./chatPanel/chatPanel');
            const disc = ChatPanel.currentPanel?.getCurrentDiscussion();
            const preferred = disc?.gitState?.startCommitHash || disc?.gitState?.originalBranch;
            const [resolved, branches, currentBranch] = await Promise.all([
                this._gitIntegration.resolveStartingRef(folder, preferred),
                this._gitIntegration.getBranches(folder),
                this._gitIntegration.getCurrentBranch(folder)
            ]);
            this._panel.webview.postMessage({
                command: 'setDefaultBaseRef',
                baseRef: resolved?.ref || '',
                label: resolved?.label || '',
                branches,
                currentBranch
            });
        } catch {}
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
                case 'showFullDiffFromStart':
                    await this.showFullDiffFromStart(message.baseRef, message.targetRef);
                    break;
                case 'explainComparisonWithAI':
                    await this.explainComparisonWithAI(message.baseRef, message.targetRef, message.diff, message.files);
                    break;
                case 'openNativeFileDiffFromRef':
                    if (message.path && message.baseRef) {
                        const targetFolder = (await this.getTargetWorkspaceFolder()) || folder;
                        const gitCwd = (await this._gitIntegration.resolveGitCwd(targetFolder)) || targetFolder.uri.fsPath;
                        const targetRef = message.targetRef || 'WORKING_TREE';
                        const leftContent = await this._gitIntegration.getFileContentAtRef(targetFolder, message.baseRef, message.path);
                        const cacheDir = vscode.Uri.joinPath(targetFolder.uri, '.lollms', 'diff_cache');
                        await vscode.workspace.fs.createDirectory(cacheDir);
                        const shortBase = String(message.baseRef).replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 12);
                        const shortTarget = targetRef === 'WORKING_TREE' ? 'Current' : String(targetRef).replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 12);
                        const baseName = require('path').basename(message.path);
                        const leftUri = vscode.Uri.joinPath(cacheDir, `${shortBase}_${baseName}`);
                        await vscode.workspace.fs.writeFile(leftUri, Buffer.from(leftContent, 'utf8'));

                        let rightUri: vscode.Uri;
                        if (targetRef === 'WORKING_TREE') {
                            rightUri = vscode.Uri.file(require('path').join(gitCwd, message.path));
                        } else {
                            const rightContent = await this._gitIntegration.getFileContentAtRef(targetFolder, targetRef, message.path);
                            rightUri = vscode.Uri.joinPath(cacheDir, `${shortTarget}_${baseName}`);
                            await vscode.workspace.fs.writeFile(rightUri, Buffer.from(rightContent, 'utf8'));
                        }
                        await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `${baseName} (${shortBase} ↔ ${shortTarget})`);
                    }
                    break;
                case 'viewCommit':
                    vscode.commands.executeCommand('lollms-vs-coder.inspectCommit', message.hash);
                    await this.showCommitDetails(message.hash);
                    break;
                case 'copyHash':
                    await vscode.env.clipboard.writeText(message.hash);
                    vscode.window.showInformationMessage(`Copied commit hash: ${message.hash.substring(0, 7)}`);
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

    private async showFullDiffFromStart(requestedBaseRef?: string, requestedTargetRef?: string) {
        const folder = await this.getTargetWorkspaceFolder();
        if (!folder) return;

        try {
            const { ChatPanel } = await import('./chatPanel/chatPanel');
            const disc = ChatPanel.currentPanel?.getCurrentDiscussion();
            const fallbackPref = disc?.gitState?.startCommitHash || disc?.gitState?.originalBranch;
            const resolved = await this._gitIntegration.resolveStartingRef(folder, requestedBaseRef || fallbackPref);

            if (!resolved) {
                vscode.window.showInformationMessage("No starting Git commit or branch found to compare against.");
                return;
            }

            const targetRef = requestedTargetRef || 'WORKING_TREE';
            const [currentBranch, files, diff] = await Promise.all([
                this._gitIntegration.getCurrentBranch(folder),
                this._gitIntegration.getChangedFilesSince(folder, resolved.ref, targetRef),
                this._gitIntegration.getCompareDiff(folder, resolved.ref, targetRef)
            ]);

            this._panel.webview.postMessage({
                command: 'showFullDiffFromStartResult',
                baseRef: resolved.ref,
                baseLabel: resolved.label,
                targetRef,
                targetLabel: targetRef === 'WORKING_TREE' ? `Current (${currentBranch || 'HEAD'})` : targetRef,
                currentBranch: currentBranch || 'HEAD',
                files,
                diff
            });
        } catch (e: any) {
            vscode.window.showErrorMessage("Failed to compute full diff: " + e.message);
        }
    }

    private async explainComparisonWithAI(requestedBaseRef?: string, requestedTargetRef?: string, providedDiff?: string, providedFiles?: any[]) {
        const folder = await this.getTargetWorkspaceFolder();
        if (!folder) return;
        try {
            const resolved = await this._gitIntegration.resolveStartingRef(folder, requestedBaseRef);
            if (!resolved) return;
            const targetRef = requestedTargetRef || 'WORKING_TREE';
            const diffText = (providedDiff && providedDiff.trim()) ? providedDiff : await this._gitIntegration.getCompareDiff(folder, resolved.ref, targetRef);
            const filesList = Array.isArray(providedFiles) && providedFiles.length > 0 ? providedFiles : await this._gitIntegration.getChangedFilesSince(folder, resolved.ref, targetRef);

            if (!diffText || !diffText.trim()) {
                this._panel.webview.postMessage({ command: 'aiCompareSummaryResult', summary: `No differences detected between ${resolved.label} and ${targetRef}.` });
                return;
            }
            const excerpt = diffText.length > 12000 ? diffText.substring(0, 12000) + '\n... [truncated]' : diffText;
            const filesSummary = filesList.map((f: any) => `- [${f.status}] ${f.path}`).join('\n');
            const response = await this._lollmsAPI.sendChat([
                { role: 'system', content: 'You are a Senior Software Engineer reviewing Git branch differences. Explain clearly what changed between the two states.' },
                { role: 'user', content: `Compare **${resolved.label}** -> **${targetRef}**\n\nChanged Files (${filesList.length}):\n${filesSummary}\n\nDiff:\n\`\`\`diff\n${excerpt}\n\`\`\`` }
            ]);
            this._panel.webview.postMessage({ command: 'aiCompareSummaryResult', summary: response.trim() });
        } catch (e: any) {
            this._panel.webview.postMessage({ command: 'aiCompareSummaryResult', error: e.message });
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

            const jsonStr = response.replace(/```json/g, '').replace(/```/g, '').trim();
            const options = JSON.parse(jsonStr);

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
        
        .commit-header { display: flex; justify-content: space-between; align-items: center; }
        .commit-msg { font-weight: bold; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; flex: 1; margin-right: 10px; }
        
        .commit-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; font-size: 0.9em; }
        
        .icon-btn { 
            background: none; border: none; color: var(--vscode-icon-foreground); 
            cursor: pointer; padding: 2px; display: flex; align-items: center; 
            opacity: 0.7;
        }
        .icon-btn:hover { opacity: 1; background-color: var(--vscode-toolbar-hoverBackground); border-radius: 3px; }

        .commit-meta { font-size: 0.85em; opacity: 0.8; margin-top: 4px; }
        
        #details-view { display: none; margin-top: 20px; border-top: 2px solid var(--vscode-panel-border); padding-top: 20px; }
        pre { background: var(--vscode-textCodeBlock-background); padding: 10px; overflow-x: auto; }
        
        .loading { opacity: 0.5; pointer-events: none; }
    </style>
</head>
<body>
    <div class="container">
        <!-- Compare Branches / States -->
        <div class="card" style="border-left: 4px solid var(--vscode-charts-blue);">
            <h2>Compare Two Branches / States (What's the Difference?)</h2>
            <div class="ai-section" style="align-items: center; flex-wrap: wrap;">
                <select id="base-ref-select" style="min-width:170px;"></select>
                <span style="opacity:0.7; font-weight:bold;">&rarr;</span>
                <select id="target-ref-select" style="min-width:170px;"></select>
                <input type="text" id="base-ref-input" placeholder="Optional custom Base SHA/ref (overrides Base)" style="min-width:180px;">
                <button class="btn" id="full-diff-btn">What's the Difference?</button>
                <button class="btn" id="explain-diff-ai-btn">Explain with AI</button>
            </div>
            <div id="full-diff-hint" style="margin-top:6px; font-size:0.85em; color:var(--vscode-descriptionForeground);">
                Select any two branches or states (e.g. main &rarr; ai-task-... or Working Tree) to inspect all changes.
            </div>
            <div id="compare-ai-summary" style="display:none; margin-top:10px; padding:10px; background:var(--vscode-textCodeBlock-background); border:1px solid var(--vscode-panel-border); white-space:pre-wrap;"></div>
        </div>

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
        const baseRefSelect = document.getElementById('base-ref-select');
        const targetRefSelect = document.getElementById('target-ref-select');
        const baseRefInput = document.getElementById('base-ref-input');
        const fullDiffBtn = document.getElementById('full-diff-btn');
        const explainDiffAiBtn = document.getElementById('explain-diff-ai-btn');
        const compareAiSummary = document.getElementById('compare-ai-summary');
        const aiInput = document.getElementById('ai-input');
        const aiBtn = document.getElementById('ai-btn');
        const aiStatus = document.getElementById('ai-status');

        let lastFullDiffPayload = null;

        fullDiffBtn.addEventListener('click', () => {
            fullDiffBtn.textContent = 'Computing Diff...';
            const chosenBase = baseRefInput.value.trim() || baseRefSelect.value;
            const chosenTarget = targetRefSelect.value || 'WORKING_TREE';
            vscode.postMessage({ command: 'showFullDiffFromStart', baseRef: chosenBase, targetRef: chosenTarget });
        });

        explainDiffAiBtn.addEventListener('click', () => {
            explainDiffAiBtn.textContent = 'Thinking...';
            compareAiSummary.style.display = 'block';
            compareAiSummary.textContent = 'Analyzing differences between selected branches...';
            const chosenBase = baseRefInput.value.trim() || baseRefSelect.value;
            const chosenTarget = targetRefSelect.value || 'WORKING_TREE';
            vscode.postMessage({
                command: 'explainComparisonWithAI',
                baseRef: chosenBase,
                targetRef: chosenTarget,
                diff: lastFullDiffPayload?.diff || '',
                files: lastFullDiffPayload?.files || []
            });
        });
        
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
                case 'setDefaultBaseRef':
                    {
                        const branches = msg.branches || [];
                        const cur = msg.currentBranch || '';
                        let optsA = '';
                        if (msg.baseRef) {
                            optsA += '<option value="' + escapeHtml(msg.baseRef) + '">Start (' + escapeHtml(msg.label || msg.baseRef.substring(0, 7)) + ')</option>';
                        }
                        branches.forEach(b => {
                            optsA += '<option value="' + escapeHtml(b) + '">' + escapeHtml(b) + (b === cur ? ' (current)' : '') + '</option>';
                        });
                        optsA += '<option value="HEAD">HEAD</option>';
                        baseRefSelect.innerHTML = optsA;

                        let optsB = '<option value="WORKING_TREE">Working Tree (Current)</option><option value="HEAD">HEAD (' + escapeHtml(cur || 'Current') + ')</option>';
                        branches.forEach(b => {
                            optsB += '<option value="' + escapeHtml(b) + '">' + escapeHtml(b) + (b === cur ? ' (current)' : '') + '</option>';
                        });
                        targetRefSelect.innerHTML = optsB;
                    }
                    break;
                case 'aiCompareSummaryResult':
                    explainDiffAiBtn.textContent = 'Explain with AI';
                    compareAiSummary.style.display = 'block';
                    compareAiSummary.textContent = msg.error ? ('Error: ' + msg.error) : (msg.summary || '');
                    break;
                case 'showFullDiffFromStartResult':
                    fullDiffBtn.textContent = "What's the Difference?";
                    lastFullDiffPayload = msg;
                    renderFullDiffDetails(msg);
                    break;
                case 'showCommitDetails':
                    detailHash.textContent = msg.hash;
                    renderColoredDiff(detailContent, msg.diff);
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
                        <span class="commit-msg" title="\${escapeHtml(c.message)}">\${escapeHtml(c.message)}</span>
                        <div class="commit-right">
                            <button class="icon-btn copy-btn" title="Copy Hash" data-hash="\${c.hash}">
                                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                                    <path d="M4 4l1-1h5.414L14 6.586V14l-1 1H5l-1-1V4zm9 3l-3-3H5v10h8V7z"/>
                                    <path d="M3 1L2 2v10l1 1V2h6.414l-1-1H3z"/>
                                </svg>
                            </button>
                            <span>\${c.date}</span>
                        </div>
                    </div>
                    <div class="commit-meta">\${c.author} | \${c.hash.substring(0,7)}</div>
                \`;
                
                // Row click -> View details
                div.addEventListener('click', () => {
                    vscode.postMessage({ command: 'viewCommit', hash: c.hash });
                });
                
                // Button click -> Copy hash
                div.querySelector('.copy-btn').addEventListener('click', (e) => {
                    e.stopPropagation(); // Don't trigger viewCommit
                    vscode.postMessage({ command: 'copyHash', hash: c.hash });
                });
                
                resultsList.appendChild(div);
            });
        }

        function renderColoredDiff(targetEl, diffText) {
            if (!diffText || !diffText.trim()) {
                targetEl.textContent = '(No differences detected between starting state and current state)';
                return;
            }
            targetEl.innerHTML = diffText.split('\\n').map(line => {
                let color = 'inherit';
                let bg = 'transparent';
                if (line.startsWith('diff --git ')) { color = 'var(--vscode-textLink-foreground)'; bg = 'rgba(0,122,204,0.12)'; }
                else if (line.startsWith('+') && !line.startsWith('+++')) { color = 'var(--vscode-charts-green)'; bg = 'rgba(0,255,0,0.06)'; }
                else if (line.startsWith('-') && !line.startsWith('---')) { color = 'var(--vscode-charts-red)'; bg = 'rgba(255,0,0,0.06)'; }
                else if (line.startsWith('@@')) { color = 'var(--vscode-charts-blue)'; }
                return '<div style="color:' + color + '; background:' + bg + '; padding: 0 6px;">' + escapeHtml(line) + '</div>';
            }).join('');
        }

        function renderFullDiffDetails(msg) {
            const files = msg.files || [];
            const targetRef = msg.targetRef || 'WORKING_TREE';
            const targetLabel = msg.targetLabel || msg.currentBranch || 'HEAD';
            detailHash.textContent = (msg.baseLabel || msg.baseRef) + ' -> ' + targetLabel + ' (' + files.length + ' files changed)';
            const fileChips = files.map(f =>
                '<button class="btn" style="padding:3px 8px; font-size:11px; margin:2px;" data-file="' + escapeHtml(f.path) + '" data-base="' + escapeHtml(msg.baseRef) + '" data-target="' + escapeHtml(targetRef) + '">[' + escapeHtml(f.status) + '] ' + escapeHtml(f.path) + '</button>'
            ).join('');

            const existingBar = document.getElementById('full-diff-files-bar');
            if (existingBar) existingBar.remove();
            if (files.length > 0) {
                const bar = document.createElement('div');
                bar.id = 'full-diff-files-bar';
                bar.style.cssText = 'margin-bottom:10px; display:flex; flex-wrap:wrap; gap:4px;';
                bar.innerHTML = fileChips;
                bar.querySelectorAll('button').forEach(b => {
                    b.addEventListener('click', () => {
                        vscode.postMessage({ command: 'openNativeFileDiffFromRef', path: b.getAttribute('data-file'), baseRef: b.getAttribute('data-base'), targetRef: b.getAttribute('data-target') });
                    });
                });
                detailContent.parentElement.insertBefore(bar, detailContent);
            }

            renderColoredDiff(detailContent, msg.diff);
            detailsView.style.display = 'block';
            detailsView.scrollIntoView({ behavior: 'smooth' });
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
