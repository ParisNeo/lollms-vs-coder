import * as vscode from 'vscode';
import { GitIntegration } from '../gitIntegration';

export class GitDashboardPanel {
    public static currentPanel: GitDashboardPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _git: GitIntegration;
    private _disposables: vscode.Disposable[] = [];
    private _isDisposed: boolean = false;

    public static createOrShow(extensionUri: vscode.Uri, git: GitIntegration) {
        if (GitDashboardPanel.currentPanel) {
            GitDashboardPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
            GitDashboardPanel.currentPanel.refresh();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'lollmsGitDashboard', 
            'Lollms Git Dashboard', 
            vscode.ViewColumn.One, 
            { 
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots:[vscode.Uri.joinPath(extensionUri, 'out', 'styles')]
            }
        );
        GitDashboardPanel.currentPanel = new GitDashboardPanel(panel, extensionUri, git);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, git: GitIntegration) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._git = git;
        this._panel.webview.html = this._getHtml(this._panel.webview);
        this._setListeners();
        
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    private _currentGraphLimit = 50;

    private async refresh(appendGraph: boolean = false) {
        if (this._isDisposed) return;
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) return;
        
        try {
            const limit = appendGraph ? 50 : this._currentGraphLimit;
            const skip = appendGraph ? this._currentGraphLimit : 0;

            const [status, branches, currentBranch, stashes, history, graph, submodules] = await Promise.all([
                this._git.getGitStatus(folder),
                this._git.getBranches(folder),
                this._git.getCurrentBranch(folder),
                this._git.getStashList(folder),
                this._git.getCommitHistory(folder, 15),
                this._git.getGitGraph(folder, limit, skip),
                this._git.getSubmodules(folder)
            ]);

            if (appendGraph) {
                this._currentGraphLimit += limit;
            }

            this._panel.webview.postMessage({ 
                command: appendGraph ? 'appendGraph' : 'update', 
                data: { status, branches, currentBranch, stashes, history, graph, submodules } 
            });
        } catch (error: any) {
            this._panel.webview.postMessage({ 
                command: 'error', 
                message: `Git Error: ${error.message}` 
            });
            vscode.window.showErrorMessage(`Failed to refresh Git Dashboard: ${error.message}`);
        }
    }

    private _setListeners() {
        this._panel.webview.onDidReceiveMessage(async (msg) => {
            const folder = vscode.workspace.workspaceFolders?.[0];
            if (!folder) return;
            try {
                switch (msg.command) {
                    case 'webviewReady':
                        await this.refresh();
                        break;
                    case 'loadMore':
                        await this.refresh(true);
                        break;
                    case 'refresh': 
                        await this.refresh(); 
                        break;
                    case 'stage': 
                        await this._git.stageFile(folder, msg.path); 
                        await this.refresh(); 
                        break;
                    case 'unstage': 
                        await this._git.unstageFile(folder, msg.path); 
                        await this.refresh(); 
                        break;
                    case 'discard': 
                        await this._git.discardChanges(folder, msg.path); 
                        await this.refresh(); 
                        break;
                    case 'branch': 
                        const name = await vscode.window.showInputBox({ prompt: "New branch name" });
                        if (name) { 
                            await this._git.createAndCheckoutBranch(folder, name); 
                            await this.refresh(); 
                        }
                        break;
                    case 'branchFromCommit':
                        const branchName = await vscode.window.showInputBox({ prompt: `New branch name from ${msg.ref}` });
                        if (branchName) {
                            await this._git.createAndCheckoutBranch(folder, branchName, msg.ref);
                            await this.refresh();
                            vscode.window.showInformationMessage(`Created and checked out ${branchName} from ${msg.ref}`);
                        }
                        break;
                    case 'switch': 
                        await this._git.checkout(folder, msg.branch); 
                        await this.refresh(); 
                        break;
                    case 'checkoutPrevious': 
                        await this._git.checkoutPrevious(folder); 
                        await this.refresh(); 
                        break;
                    case 'checkoutRef': 
                        await this._git.checkout(folder, msg.ref); 
                        await this.refresh(); 
                        vscode.window.showInformationMessage(`Checked out ${msg.ref}`);
                        break;
                    case 'mergeRef':
                        const confirmMerge = await vscode.window.showWarningMessage(`Merge ${msg.ref} into current branch?`, { modal: true }, "Merge");
                        if (confirmMerge === "Merge") {
                            const output = await this._git.mergeBranch(folder, msg.ref);
                            await this.refresh();
                            vscode.window.showInformationMessage(`Merged ${msg.ref}:\n${output}`);
                        }
                        break;
                    case 'compareRef':
                        const fullDiff = await this._git.getCompareDiff(folder, 'HEAD', msg.ref);
                        if (!fullDiff || !fullDiff.trim()) {
                            vscode.window.showInformationMessage(`No differences found between HEAD and ${msg.ref}`);
                            break;
                        }
                        const doc = await vscode.workspace.openTextDocument({ content: fullDiff, language: 'diff' });
                        await vscode.window.showTextDocument(doc, { preview: false });
                        break;
                    case 'stash': 
                        await this._git.stash(folder, "Manual Stash"); 
                        await this.refresh(); 
                        break;
                    case 'stashApply': 
                        await this._git.applyStash(folder, msg.index); 
                        await this.refresh(); 
                        break;
                    case 'commit': 
                        if (msg.message) { 
                            await this._git.commitWithMessage(msg.message, folder); 
                            await this.refresh(); 
                        }
                        break;
                    case 'generateMessage':
                        const message = await this._git.generateCommitMessage(folder);
                        this._panel.webview.postMessage({ command: 'setMessage', message });
                        break;
                    case 'openGitManager':
                        vscode.commands.executeCommand('lollms-vs-coder.gitManager');
                        break;
                    case 'inspectCommit':
                        vscode.commands.executeCommand('lollms-vs-coder.inspectCommit', msg.hash);
                        break;
                    case 'viewCommitFiles':
                        const files = await this._git.getChangedFiles(folder, msg.hash);
                        const selectedFile = await vscode.window.showQuickPick(files, { placeHolder: "Select a file to compare" });
                        if (selectedFile) {
                            const leftUri = vscode.Uri.joinPath(folder.uri, selectedFile).with({ scheme: 'git', query: msg.hash + '^' });
                            const rightUri = vscode.Uri.joinPath(folder.uri, selectedFile).with({ scheme: 'git', query: msg.hash });
                            await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `${selectedFile} (${msg.hash.substring(0,7)})`);
                        }
                        break;
                    case 'addSubmodule':
                        const url = await vscode.window.showInputBox({ prompt: "Submodule Repository URL" });
                        if (url) {
                            const subPath = await vscode.window.showInputBox({ prompt: "Path to clone into (e.g. lib/my-submodule)" });
                            if (subPath) {
                                await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: "Adding submodule..."}, async () => {
                                    await this._git.addSubmodule(folder, url, subPath);
                                });
                                await this.refresh();
                            }
                        }
                        break;
                    case 'removeSubmodule':
                        const choice = await vscode.window.showQuickPick(
                            [
                                { label: "Remove (Delete Content)", description: "Completely remove the submodule" },
                                { label: "Detach (Keep Content)", description: "Flatten into main repository" }
                            ],
                            { title: `Action for ${msg.path}` }
                        );

                        if (choice?.label === "Remove (Delete Content)") {
                            await this._git.removeSubmodule(folder, msg.path);
                            await this.refresh();
                        } else if (choice?.label === "Detach (Keep Content)") {
                            await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: "Detaching submodule..."}, async () => {
                                await this._git.detachSubmodule(folder, msg.path);
                            });
                            await this.refresh();
                        }
                        break;
                }
            } catch (e: any) { 
                vscode.window.showErrorMessage(e.message); 
            }
        }, null, this._disposables);
    }

    public dispose() {
        this._isDisposed = true;
        GitDashboardPanel.currentPanel = undefined;
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) { x.dispose(); }
        }
    }

    private _getHtml(webview: vscode.Webview) {
        const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'));
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${codiconsUri}" rel="stylesheet" />
    <style>
        :root {
            --border-radius: 6px;
            --gap: 16px;
        }
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-editor-foreground);
            background: var(--vscode-editor-background);
            padding: var(--gap);
            margin: 0;
            height: 100vh;
            box-sizing: border-box;
            overflow: hidden;
        }
        .dashboard-container {
            display: flex;
            gap: var(--gap);
            height: 100%;
        }
        .col-left {
            flex: 1;
            display: flex;
            flex-direction: column;
            gap: var(--gap);
            min-width: 350px;
            max-width: 450px;
        }
        .col-right {
            flex: 2;
            display: flex;
            flex-direction: column;
            gap: var(--gap);
            min-width: 400px;
        }
        .card {
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-widget-border);
            border-radius: var(--border-radius);
            display: flex;
            flex-direction: column;
            overflow: hidden;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        .flex-1 { flex: 1; }
        .flex-2 { flex: 2; }
        
        .card-header {
            padding: 10px 14px;
            background: var(--vscode-sideBarSectionHeader-background);
            border-bottom: 1px solid var(--vscode-widget-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .card-header h2 {
            margin: 0;
            font-size: 11px;
            font-weight: bold;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-sideBarTitle-foreground);
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .card-body {
            padding: 10px;
            overflow-y: auto;
            flex: 1;
        }
        .card-footer {
            padding: 12px;
            border-top: 1px solid var(--vscode-widget-border);
            background: var(--vscode-editor-background);
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        
        .btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: 1px solid transparent;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            font-weight: 500;
        }
        .btn:hover { background: var(--vscode-button-hoverBackground); }
        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
        .btn-danger {
            background: transparent;
            color: var(--vscode-errorForeground);
            border: 1px solid var(--vscode-errorForeground);
        }
        .btn-danger:hover {
            background: var(--vscode-inputValidation-errorBackground);
        }
        
        .icon-btn {
            background: transparent;
            color: var(--vscode-icon-foreground);
            border: none;
            border-radius: 4px;
            width: 24px;
            height: 24px;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }
        .icon-btn:hover {
            background: var(--vscode-toolbar-hoverBackground);
            color: var(--vscode-foreground);
        }

        .list-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 8px;
            border-radius: 4px;
            margin-bottom: 2px;
            border: 1px solid transparent;
        }
        .list-row:hover {
            background: var(--vscode-list-hoverBackground);
            border-color: var(--vscode-widget-border);
        }
        .item-label {
            font-size: 12px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            flex: 1;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .item-actions {
            display: flex;
            gap: 4px;
            opacity: 0;
            transition: opacity 0.1s;
            background: var(--vscode-editor-background);
            padding-left: 8px;
        }
        
        .list-row:hover .item-actions,
        .graph-html-row:hover .item-actions {
            opacity: 1;
            background: var(--vscode-list-hoverBackground);
        }

        textarea {
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 8px;
            font-family: var(--vscode-font-family);
            font-size: 13px;
            resize: vertical;
            min-height: 60px;
            outline: none;
        }
        textarea:focus { border-color: var(--vscode-focusBorder); }
        
        /* Timeline specific */
        .graph-html-row {
            position: absolute;
            left: 0;
            right: 0;
            height: 24px;
            display: flex;
            align-items: center;
            padding: 0 10px;
            border-radius: 4px;
            white-space: nowrap;
        }
        .graph-html-row:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        .graph-msg { color: var(--vscode-editor-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; margin-left: 8px; flex: 1; }
        .graph-author { font-size: 10px; opacity: 0.6; margin-left: 8px; white-space: nowrap; font-weight: 600; }
        .graph-date { font-size: 10px; opacity: 0.5; margin-left: 8px; white-space: nowrap; width: 90px; text-align: right; }
        .graph-hash-btn { 
            background: transparent; border: none; padding: 0;
            color: var(--vscode-textLink-foreground); font-size: 11px; margin-right: 8px; opacity: 0.8; font-family: monospace; cursor: pointer; text-decoration: underline; 
        }
        .graph-hash-btn:hover { opacity: 1; color: var(--vscode-textLink-activeForeground); }
        .branch-tag { 
            background: var(--vscode-badge-background); 
            color: var(--vscode-badge-foreground); 
            padding: 2px 6px; 
            border-radius: 10px; 
            font-size: 9px; 
            font-weight: bold; 
            margin-left: 6px; 
            border: 1px solid var(--vscode-contrastBorder, transparent);
            cursor: pointer;
        }
        .branch-tag:hover {
            filter: brightness(1.2);
        }
        .branch-tag.head { background: var(--vscode-charts-blue); color: white; }
        .branch-tag.remote { background: var(--vscode-charts-purple); color: white; }
        
        .badge-status {
            width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex-shrink: 0;
        }
        .badge-status.staged { background: var(--vscode-charts-green); box-shadow: 0 0 4px var(--vscode-charts-green); }
        .badge-status.unstaged { background: var(--vscode-charts-orange); }
        .badge-status.untracked { background: transparent; border: 1px solid var(--vscode-disabledForeground); }
        
        .spinner { display: inline-block; animation: spin 1s linear infinite; }
        @keyframes spin { 100% { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="dashboard-container">
        <!-- Left Column -->
        <div class="col-left">
            <!-- Working Tree -->
            <div class="card flex-2">
                <div class="card-header">
                    <h2><i class="codicon codicon-folder"></i> Working Tree</h2>
                    <button class="icon-btn" onclick="post('refresh')" title="Refresh"><i class="codicon codicon-refresh"></i></button>
                </div>
                <div class="card-body" id="files">
                    <div style="opacity:0.5; padding:20px; text-align:center;"><i class="codicon codicon-sync spinner"></i> Loading files...</div>
                </div>
                <div class="card-footer">
                    <textarea id="c-msg" placeholder="Commit message..."></textarea>
                    <div style="display:flex; justify-content: space-between; gap: 10px;">
                        <button class="btn btn-secondary" id="ai-gen-btn" onclick="generateAI()" style="flex: 1;"><i class="codicon codicon-sparkle"></i> Auto-Generate</button>
                        <button class="btn" onclick="commit()" style="flex: 1;"><i class="codicon codicon-check"></i> Commit</button>
                    </div>
                </div>
            </div>

            <!-- Submodules -->
            <div class="card flex-1">
                <div class="card-header">
                    <h2><i class="codicon codicon-repo"></i> Submodules</h2>
                    <button class="icon-btn" onclick="post('addSubmodule')" title="Add Submodule"><i class="codicon codicon-add"></i></button>
                </div>
                <div class="card-body" id="submodules">
                    <div style="opacity:0.5; padding:20px; text-align:center;"><i class="codicon codicon-sync spinner"></i> Loading submodules...</div>
                </div>
            </div>

            <!-- Stashes -->
            <div class="card flex-1">
                <div class="card-header">
                    <h2><i class="codicon codicon-archive"></i> Stashes</h2>
                    <button class="icon-btn" onclick="post('stash')" title="Stash All"><i class="codicon codicon-add"></i></button>
                </div>
                <div class="card-body" id="stashes">
                    <div style="opacity:0.5; padding:20px; text-align:center;"><i class="codicon codicon-sync spinner"></i> Loading stashes...</div>
                </div>
            </div>
        </div>

        <!-- Right Column -->
        <div class="col-right">
            <!-- Branches -->
            <div class="card flex-1">
                <div class="card-header">
                    <h2><i class="codicon codicon-git-branch"></i> Branches</h2>
                    <div style="display:flex; gap:4px;">
                        <button class="icon-btn" onclick="post('checkoutPrevious')" title="Checkout Previous Branch (-)"><i class="codicon codicon-arrow-left"></i></button>
                        <button class="icon-btn" onclick="post('branch')" title="New Branch"><i class="codicon codicon-add"></i></button>
                    </div>
                </div>
                <div class="card-body" id="branches">
                    <div style="opacity:0.5; padding:20px; text-align:center;"><i class="codicon codicon-sync spinner"></i> Loading branches...</div>
                </div>
            </div>

            <!-- Timeline -->
            <div class="card flex-2">
                <div class="card-header">
                    <h2><i class="codicon codicon-history"></i> Multi-Branch Timeline</h2>
                    <button class="btn btn-secondary" onclick="post('openGitManager')" title="Advanced Git Search & AI Query"><i class="codicon codicon-search"></i> Advanced Search</button>
                </div>
                <div class="card-body" id="graph-container" style="overflow-x: auto; position: relative; display: flex; flex-direction: column;">
                    <div id="graph-inner" style="flex: 1;">
                        <div style="opacity:0.5; padding:20px; text-align:center;"><i class="codicon codicon-sync spinner"></i> Building multi-branch timeline...</div>
                    </div>
                    <button class="btn btn-secondary" id="load-more-btn" onclick="post('loadMore')" style="margin: 10px; align-self: center;">Load More Commits...</button>
                </div>
            </div>
        </div>
    </div>

    <script>

        function setLoadingStates() {
            const loader = '<div style="opacity:0.5; padding:20px; text-align:center;"><i class="codicon codicon-sync spinner"></i> Loading...</div>';
            document.getElementById('files').innerHTML = loader;
            document.getElementById('submodules').innerHTML = loader;
            document.getElementById('stashes').innerHTML = loader;
            document.getElementById('branches').innerHTML = loader;
            document.getElementById('graph-inner').innerHTML = loader;
        }
        
        function generateAI() {
            const btn = document.getElementById('ai-gen-btn');
            btn.disabled = true;
            btn.innerHTML = '<i class="codicon codicon-sync spinner"></i> Generating...';
            post('generateMessage');
        }

        function commit() { 
            const m = document.getElementById('c-msg').value; 
            if(m) { post('commit', {message: m}); document.getElementById('c-msg').value = ''; } 
        }

        window.addEventListener('message', e => {
            const msg = e.data;
            if (msg.command === 'setMessage') {
                document.getElementById('c-msg').value = msg.message;
                const btn = document.getElementById('ai-gen-btn');
                btn.disabled = false;
                btn.innerHTML = '<i class="codicon codicon-sparkle"></i> Auto-Generate';
                return;
            }

            const { status, branches, currentBranch, stashes, history, graph, submodules } = msg.data;
            
            document.getElementById('files').innerHTML = [
                ...status.staged.map(f => \`
                    <div class="list-row">
                        <div class="item-label" title="\${escapeHtml(f)}"><span class="badge-status staged"></span> \${escapeHtml(f)}</div>
                        <div class="item-actions">
                            <button class="btn btn-secondary" onclick="post('unstage',{path:'\${jsEscape(f)}'})"><i class="codicon codicon-remove"></i> Unstage</button>
                        </div>
                    </div>\`),
                ...status.unstaged.map(f => \`
                    <div class="list-row">
                        <div class="item-label" title="\${escapeHtml(f)}"><span class="badge-status unstaged"></span> \${escapeHtml(f)}</div>
                        <div class="item-actions">
                            <button class="btn btn-secondary" onclick="post('stage',{path:'\${jsEscape(f)}'})"><i class="codicon codicon-add"></i> Stage</button>
                            <button class="btn btn-danger" onclick="post('discard',{path:'\${jsEscape(f)}'})"><i class="codicon codicon-discard"></i> Discard</button>
                        </div>
                    </div>\`),
                ...status.untracked.map(f => \`
                    <div class="list-row">
                        <div class="item-label" title="\${escapeHtml(f)}"><span class="badge-status untracked"></span> \${escapeHtml(f)}</div>
                        <div class="item-actions">
                            <button class="btn btn-secondary" onclick="post('stage',{path:'\${jsEscape(f)}'})"><i class="codicon codicon-add"></i> Track</button>
                        </div>
                    </div>\`)
            ].join('') || '<div style="opacity:0.5; padding:20px; text-align:center;">Clean working tree ✨</div>';

            document.getElementById('branches').innerHTML = branches.map(b => \`
                <div class="list-row">
                    <div class="item-label" style="\${b === currentBranch ? 'font-weight:bold; color:var(--vscode-textLink-foreground)' : ''}">
                        <i class="codicon \${b === currentBranch ? 'codicon-git-branch' : 'codicon-source-control'}"></i> \${escapeHtml(b)}
                    </div>
                    \${b !== currentBranch ? \`
                    <div class="item-actions">
                        <button class="btn btn-secondary" onclick="post('switch',{branch:'\${jsEscape(b)}'})"><i class="codicon codicon-arrow-swap"></i> Switch</button>
                    </div>\` : ''}
                </div>
            \`).join('');

            // --- PROFESSIONAL SVG GRAPH RENDERING ---
            const graphLines = graph.split('\\n').filter(l => l.trim());
            
            const colors =[
                'var(--vscode-charts-blue)', 
                'var(--vscode-charts-purple)', 
                'var(--vscode-charts-red)', 
                'var(--vscode-charts-green)', 
                'var(--vscode-charts-orange)', 
                'var(--vscode-charts-yellow)'
            ];

            const charW = 14;
            const charH = 24;
            let paths = '';
            let htmlRows = '';
            let maxCols = 0;

            // 1. Create a 2D grid representation of the graph characters for vertical lookahead
            const grid = graphLines.map(line => {
                const match = line.match(/^([\\*\\|\\/\\s\\\\\\_]+)/);
                return match ? match[1] : '';
            });

            // 2. Build the SVG strings
            graphLines.forEach((line, rowIndex) => {
                const match = line.match(/^([\\*\\|\\/\\s\\\\\\_]+)(.*)$/);
                if (!match) return;

                const graphPart = match[1];
                let textPart = match[2];
                maxCols = Math.max(maxCols, graphPart.length);

                const y = rowIndex * charH;
                const cy = y + charH / 2;

                for (let col = 0; col < graphPart.length; col++) {
                    const char = graphPart[col];
                    if (char === ' ') continue;

                    const cx = col * charW + charW / 2;
                    let color = colors[Math.floor(col / 2) % colors.length];

                    if (char === '*') {
                        const isHead = textPart.includes('HEAD');
                        const fill = isHead ? 'var(--vscode-editor-background)' : color;
                        const strokeW = isHead ? 3 : 0;
                        const r = isHead ? 5 : 4;
                        
                        // Look above: if the previous row has a commit or vertical line in this column, draw UP
                        if (rowIndex > 0) {
                            const prevChar = grid[rowIndex - 1][col];
                            if (prevChar === '*' || prevChar === '|') {
                                paths += \`<line x1="\${cx}" y1="\${y}" x2="\${cx}" y2="\${cy}" stroke="\${color}" stroke-width="2" />\`;
                            }
                        }
                        
                        // Look below: if the next row has a commit or vertical line in this column, draw DOWN
                        if (rowIndex < grid.length - 1) {
                            const nextChar = grid[rowIndex + 1][col];
                            if (nextChar === '*' || nextChar === '|') {
                                paths += \`<line x1="\${cx}" y1="\${cy}" x2="\${cx}" y2="\${y + charH}" stroke="\${color}" stroke-width="2" />\`;
                            }
                        }

                        // Draw the commit dot on top of lines
                        paths += \`<circle cx="\${cx}" cy="\${cy}" r="\${r}" fill="\${fill}" stroke="\${color}" stroke-width="\${strokeW}" />\`;
                    } else if (char === '|') {
                        paths += \`<line x1="\${cx}" y1="\${y}" x2="\${cx}" y2="\${y + charH}" stroke="\${color}" stroke-width="2" />\`;
                    } else if (char === '/') {
                        color = colors[Math.floor((col + 1) / 2) % colors.length] || color;
                        const startX = (col + 1) * charW + charW / 2;
                        const endX = (col - 1) * charW + charW / 2;
                        paths += \`<path d="M \${startX} \${y} C \${startX} \${y + charH/2}, \${endX} \${y + charH/2}, \${endX} \${y + charH}" stroke="\${color}" stroke-width="2" fill="none" />\`;
                    } else if (char === '\\\\') {
                        color = colors[Math.floor((col + 1) / 2) % colors.length] || color;
                        const startX = (col - 1) * charW + charW / 2;
                        const endX = (col + 1) * charW + charW / 2;
                        paths += \`<path d="M \${startX} \${y} C \${startX} \${y + charH/2}, \${endX} \${y + charH/2}, \${endX} \${y + charH}" stroke="\${color}" stroke-width="2" fill="none" />\`;
                    } else if (char === '_') {
                        const startX = (col - 1) * charW + charW / 2;
                        const endX = (col + 1) * charW + charW / 2;
                        paths += \`<line x1="\${startX}" y1="\${cy}" x2="\${endX}" y2="\${cy}" stroke="\${color}" stroke-width="2" />\`;
                    }
                }

                if (textPart.trim()) {
                    // Format is: hash|relative_date|author|decoration|subject
                    const parts = textPart.split('|');
                    const hash = parts[0] ? parts[0].trim() : '';
                    const date = parts[1] ? parts[1].trim() : '';
                    const author = parts[2] ? parts[2].trim() : '';
                    const decoration = parts[3] ? parts[3].trim() : '';
                    const message = parts[4] ? parts[4].trim() : '';

                    let tagsHtml = '';
                    if (decoration) {
                        const cleanDecoration = decoration.replace(/^\(|\)\$/g, '');
                        tagsHtml = cleanDecoration.split(',').map(t => {
                            t = t.trim();
                            let cls = 'branch-tag';
                            let branchName = t;
                            if (t.includes('HEAD')) {
                                cls += ' head';
                                branchName = t.split('->').pop().trim();
                            } else if (t.includes('origin/')) {
                                cls += ' remote';
                            }
                            return \`<span class="\${cls}" onclick="post('switch', {branch: '\${jsEscape(branchName)}'})" title="Checkout \${escapeHtml(branchName)}">\${escapeHtml(t)}</span>\`;
                        }).join('');
                    }

                    htmlRows += \`
                        <div class="graph-html-row" style="top: \${y}px; left: \${maxCols * charW + 10}px; height: \${charH}px;">
                            \${hash ? \`<button class="graph-hash-btn" onclick="post('inspectCommit', {hash: '\${jsEscape(hash)}'})" title="Inspect Commit with AI">\${hash}</button>\` : ''}
                            <span class="graph-msg" title="\${escapeHtml(message)}">\${escapeHtml(message)}</span>
                            <span class="graph-author" title="Author: \${escapeHtml(author)}">\${escapeHtml(author)}</span>
                            <span class="graph-date">\${escapeHtml(date)}</span>
                            \${tagsHtml}
                    \${hash ? \`
                    <div class="item-actions">
                        <button class="icon-btn" onclick="vscode.postMessage({command:'copyToClipboard', text:'\${hash}'})" title="Copy Hash"><i class="codicon codicon-copy"></i></button>
                        <button class="icon-btn" onclick="post('checkoutRef',{ref:'\${jsEscape(hash)}'})" title="Checkout Commit"><i class="codicon codicon-target"></i></button>
                        <button class="icon-btn" onclick="post('branchFromCommit',{ref:'\${jsEscape(hash)}'})" title="Create Branch From Here"><i class="codicon codicon-git-branch"></i></button>
                        <button class="icon-btn" onclick="post('mergeRef',{ref:'\${jsEscape(decoration ? decoration.split(',')[0].replace(/[()]/g, '').trim() : hash)}'})" title="Merge Branch/Commit"><i class="codicon codicon-git-merge"></i></button>
                        <button class="icon-btn" onclick="post('compareRef',{ref:'\${jsEscape(hash)}'})" title="Compare with HEAD"><i class="codicon codicon-git-compare"></i></button>
                    </div>\` : ''}
                        </div>\`;
                }
            });

            const svgWidth = maxCols * charW + 20;
            const svgHeight = graphLines.length * charH;

            document.getElementById('graph-inner').innerHTML = \`
                <div style="position: relative; height: \${svgHeight}px; width: 100%; min-width: 600px;">
                    <svg width="\${svgWidth}" height="\${svgHeight}" style="position: absolute; top: 0; left: 0; z-index: 1;">
                        \${paths}
                    </svg>
                    <div style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; z-index: 2;">
                        \${htmlRows}
                    </div>
                </div>
            \`;

            document.getElementById('submodules').innerHTML = submodules.map(s => \`
                <div class="list-row">
                    <div class="item-label" title="\${escapeHtml(s.path)}"><i class="codicon codicon-file-submodule"></i> \${escapeHtml(s.path)}</div>
                    <div class="item-actions" style="align-items: center;">
                        <span style="font-size:10px; opacity:0.5; font-family:monospace; margin-right: 8px;">\${s.hash.substring(0,7)}</span>
                        <button class="btn btn-danger" onclick="post('removeSubmodule',{path:'\${jsEscape(s.path)}'})" title="Remove"><i class="codicon codicon-trash"></i></button>
                    </div>
                </div>
            \`).join('') || '<div style="opacity:0.5; font-size:11px; padding:10px; text-align:center;">No submodules.</div>';

            document.getElementById('stashes').innerHTML = stashes.map((s, i) => \`
                <div class="list-row">
                    <div class="item-label" title="\${escapeHtml(s)}"><i class="codicon codicon-archive"></i> \${escapeHtml(s)}</div>
                    <div class="item-actions">
                        <button class="btn btn-secondary" onclick="post('stashApply',{index:\${i}})"><i class="codicon codicon-check"></i> Apply</button>
                    </div>
                </div>
            \`).join('') || '<div style="opacity:0.5; font-size:11px; padding:10px; text-align:center;">No stashes found.</div>';
            // Notify extension that webview is ready
            post('webviewReady');
        });

        window.addEventListener('message', e => {
            const msg = e.data;
            if (msg.command === 'appendGraph' || msg.command === 'update') {
                const { status, branches, currentBranch, stashes, history, graph, submodules } = msg.data;
                updateUI(status, branches, currentBranch, stashes, history, graph, submodules);
            }
        });

        function jsEscape(str) {
            return str.replace(/'/g, "\\'");
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

        function updateUI(status, branches, currentBranch, stashes, history, graph, submodules) {
            document.getElementById('files').innerHTML = [
                ...status.staged.map(f => \`
                    <div class="list-row">
                        <div class="item-label" title="\${escapeHtml(f)}"><span class="badge-status staged"></span> \${escapeHtml(f)}</div>
                        <div class="item-actions">
                            <button class="btn btn-secondary" onclick="post('unstage',{path:'\${jsEscape(f)}'})"><i class="codicon codicon-remove"></i> Unstage</button>
                        </div>
                    </div>\`),
                ...status.unstaged.map(f => \`
                    <div class="list-row">
                        <div class="item-label" title="\${escapeHtml(f)}"><span class="badge-status unstaged"></span> \${escapeHtml(f)}</div>
                        <div class="item-actions">
                            <button class="btn btn-secondary" onclick="post('stage',{path:'\${jsEscape(f)}'})"><i class="codicon codicon-add"></i> Stage</button>
                            <button class="btn btn-danger" onclick="post('discard',{path:'\${jsEscape(f)}'})"><i class="codicon codicon-discard"></i> Discard</button>
                        </div>
                    </div>\`),
                ...status.untracked.map(f => \`
                    <div class="list-row">
                        <div class="item-label" title="\${escapeHtml(f)}"><span class="badge-status untracked"></span> \${escapeHtml(f)}</div>
                        <div class="item-actions">
                            <button class="btn btn-secondary" onclick="post('stage',{path:'\${jsEscape(f)}'})"><i class="codicon codicon-add"></i> Track</button>
                        </div>
                    </div>\`)
            ].join('') || '<div style="opacity:0.5; padding:20px; text-align:center;">Clean working tree ✨</div>';

            document.getElementById('branches').innerHTML = branches.map(b => \`
                <div class="list-row">
                    <div class="item-label" style="\${b === currentBranch ? 'font-weight:bold; color:var(--vscode-textLink-foreground)' : ''}">
                        <i class="codicon \${b === currentBranch ? 'codicon-git-branch' : 'codicon-source-control'}"></i> \${escapeHtml(b)}
                    </div>
                    \${b !== currentBranch ? \`
                    <div class="item-actions">
                        <button class="btn btn-secondary" onclick="post('switch',{branch:'\${jsEscape(b)}'})"><i class="codicon codicon-arrow-swap"></i> Switch</button>
                    </div>\` : ''}
                </div>\`).join('');

            // Re-render graph (same as earlier rendering code)
            const graphLines = graph.split('\n').filter(l => l.trim());
            const colors = [
                'var(--vscode-charts-blue)',
                'var(--vscode-charts-purple)',
                'var(--vscode-charts-red)',
                'var(--vscode-charts-green)',
                'var(--vscode-charts-orange)',
                'var(--vscode-charts-yellow)'
            ];
            const charW = 14, charH = 24;
            let paths = '', htmlRows = '', maxCols = 0;
            const grid = graphLines.map(line => {
                const match = line.match(/^([\*\|\/\s\\\_]+)/);
                return match ? match[1] : '';
            });
            graphLines.forEach((line, rowIndex) => {
                const match = line.match(/^([\*\|\/\s\\\_]+)(.*)$/);
                if (!match) return;
                const graphPart = match[1];
                let textPart = match[2];
                maxCols = Math.max(maxCols, graphPart.length);
                const y = rowIndex * charH;
                const cy = y + charH / 2;
                for (let col = 0; col < graphPart.length; col++) {
                    const char = graphPart[col];
                    if (char === ' ') continue;
                    const cx = col * charW + charW / 2;
                    let color = colors[Math.floor(col / 2) % colors.length];
                    if (char === '*') {
                        const isHead = textPart.includes('HEAD');
                        const fill = isHead ? 'var(--vscode-editor-background)' : color;
                        const strokeW = isHead ? 3 : 0;
                        const r = isHead ? 5 : 4;
                        if (rowIndex > 0) {
                            const prevChar = grid[rowIndex - 1][col];
                            if (prevChar === '*' || prevChar === '|') {
                                paths += \`<line x1="\${cx}" y1="\${y}" x2="\${cx}" y2="\${cy}" stroke="\${color}" stroke-width="2" />\`;
                            }
                        }
                        if (rowIndex < grid.length - 1) {
                            const nextChar = grid[rowIndex + 1][col];
                            if (nextChar === '*' || nextChar === '|') {
                                paths += \`<line x1="\${cx}" y1="\${cy}" x2="\${cx}" y2="\${y + charH}" stroke="\${color}" stroke-width="2" />\`;
                            }
                        }
                        paths += \`<circle cx="\${cx}" cy="\${cy}" r="\${r}" fill="\${fill}" stroke="\${color}" stroke-width="\${strokeW}" />\`;
                    } else if (char === '|') {
                        paths += \`<line x1="\${cx}" y1="\${y}" x2="\${cx}" y2="\${y + charH}" stroke="\${color}" stroke-width="2" />\`;
                    } else if (char === '/') {
                        color = colors[Math.floor((col + 1) / 2) % colors.length] || color;
                        const startX = (col + 1) * charW + charW / 2;
                        const endX = (col - 1) * charW + charW / 2;
                        paths += \`<path d="M \${startX} \${y} C \${startX} \${y + charH/2}, \${endX} \${y + charH/2}, \${endX} \${y + charH}" stroke="\${color}" stroke-width="2" fill="none" />\`;
                    } else if (char === '\\') {
                        color = colors[Math.floor((col + 1) / 2) % colors.length] || color;
                        const startX = (col - 1) * charW + charW / 2;
                        const endX = (col + 1) * charW + charW / 2;
                        paths += \`<path d="M \${startX} \${y} C \${startX} \${y + charH/2}, \${endX} \${y + charH/2}, \${endX} \${y + charH}" stroke="\${color}" stroke-width="2" fill="none" />\`;
                    } else if (char === '_') {
                        const startX = (col - 1) * charW + charW / 2;
                        const endX = (col + 1) * charW + charW / 2;
                        paths += \`<line x1="\${startX}" y1="\${cy}" x2="\${endX}" y2="\${cy}" stroke="\${color}" stroke-width="2" />\`;
                    }
                }
                if (textPart.trim()) {
                    const parts = textPart.split('|');
                    const hash = parts[0]?.trim() ?? '';
                    const date = parts[1]?.trim() ?? '';
                    const author = parts[2]?.trim() ?? '';
                    const decoration = parts[3]?.trim() ?? '';
                    const message = parts[4]?.trim() ?? '';
                    let tagsHtml = '';
                    if (decoration) {
                        const cleanDecoration = decoration.replace(/^\(|\)\$/g, '');
                        tagsHtml = cleanDecoration.split(',').map(t => {
                            t = t.trim();
                            let cls = 'branch-tag';
                            let branchName = t;
                            if (t.includes('HEAD')) {
                                cls += ' head';
                                branchName = t.split('->').pop().trim();
                            } else if (t.includes('origin/')) {
                                cls += ' remote';
                            }
                            return \`<span class="\${cls}" onclick="post('switch', {branch: '\${jsEscape(branchName)}'})" title="Checkout \${escapeHtml(branchName)}">\${escapeHtml(t)}</span>\`;
                        }).join('');
                    }
                    htmlRows += \`
                        <div class="graph-html-row" style="top: \${y}px; left: \${maxCols * charW + 10}px; height: \${charH}px;">
                            \${hash ? \`<button class="graph-hash-btn" onclick="post('inspectCommit', {hash: '\${jsEscape(hash)}'})" title="Inspect Commit with AI">\${hash}</button>\` : ''}
                            <span class="graph-msg" title="\${escapeHtml(message)}">\${escapeHtml(message)}</span>
                            <span class="graph-author" title="Author: \${escapeHtml(author)}">\${escapeHtml(author)}</span>
                            <span class="graph-date">\${escapeHtml(date)}</span>
                            \${tagsHtml}
                            \${hash ? \`
                            <div class="item-actions">
                                <button class="icon-btn" onclick="vscode.postMessage({command:'copyToClipboard', text:'\${hash}'}); vscode.postMessage({command:'showInformationMessage', message:'Copied hash'})" title="Copy Hash"><i class="codicon codicon-copy"></i></button>
                                <button class="icon-btn" onclick="post('checkoutRef',{ref:'\${jsEscape(hash)}'})" title="Checkout Commit"><i class="codicon codicon-target"></i></button>
                                <button class="icon-btn" onclick="post('branchFromCommit',{ref:'\${jsEscape(hash)}'})" title="Create Branch From Here"><i class="codicon codicon-git-branch"></i></button>
                                <button class="btn btn-secondary" style="height:20px; font-size:10px; padding:0 4px;" onclick="post('mergeRef',{ref:'\${jsEscape(hash)}'})" title="Merge Commit">Merge</button>
                                <button class="icon-btn" onclick="post('compareRef',{ref:'\${jsEscape(hash)}'})" title="Compare with HEAD"><i class="codicon codicon-git-compare"></i></button>
                            </div>\` : ''}
                        </div>\`;
                }
            });
            const svgWidth = maxCols * charW + 20;
            const svgHeight = graphLines.length * charH;
            document.getElementById('graph-inner').innerHTML = \`
                <div style="position: relative; height: \${svgHeight}px; width: 100%; min-width: 600px;">
                    <svg width="\${svgWidth}" height="\${svgHeight}" style="position: absolute; top: 0; left: 0; z-index: 1;">
                        \${paths}
                    </svg>
                    <div style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; z-index: 2;">
                        \${htmlRows}
                    </div>
                </div>\`;
            // Update submodules and stashes
            document.getElementById('submodules').innerHTML = submodules.map(s => \`
                <div class="list-row">
                    <div class="item-label" title="\${escapeHtml(s.path)}"><i class="codicon codicon-file-submodule"></i> \${escapeHtml(s.path)}</div>
                    <div class="item-actions" style="align-items: center;">
                        <span style="font-size:10px; opacity:0.5; font-family:monospace; margin-right: 8px;">\${s.hash.substring(0,7)}</span>
                        <button class="btn btn-danger" onclick="post('removeSubmodule',{path:'\${jsEscape(s.path)}'})" title="Remove"><i class="codicon codicon-trash"></i></button>
                    </div>
                </div>\`).join('') || '<div style="opacity:0.5; font-size:11px; padding:10px; text-align:center;">No submodules.</div>';
            document.getElementById('stashes').innerHTML = stashes.map((s,i) => \`
                <div class="list-row">
                    <div class="item-label" title="\${escapeHtml(s)}"><i class="codicon codicon-archive"></i> \${escapeHtml(s)}</div>
                    <div class="item-actions">
                        <button class="btn btn-secondary" onclick="post('stashApply',{index:\${i}})"><i class="codicon codicon-check"></i> Apply</button>
                    </div>
                </div>\`).join('') || '<div style="opacity:0.5; font-size:11px; padding:10px; text-align:center;">No stashes found.</div>';
        }
    </script>
</body>
</html>`;
    }
}