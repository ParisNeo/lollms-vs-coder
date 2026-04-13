import * as vscode from 'vscode';
import { GitIntegration, execAsync, MAX_BUFFER_SIZE } from '../gitIntegration';

export class GitDashboardPanel {
    public static currentPanel: GitDashboardPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _git: GitIntegration;
    private _disposables: vscode.Disposable[] = [];
    private _isDisposed: boolean = false;

    /**
    * Unified diff engine.
    * Handles: 
    * - Branch Comparison: ref1="HEAD", ref2="branch_name"
    * - Specific Commit: ref1="hash^", ref2="hash"
    * - Staged: ref1="--cached", ref2=""
    * - Unstaged: ref1="", ref2=""
    */
    public async getDiffContent(folder: vscode.WorkspaceFolder, ref1: string, ref2: string = "", path: string = ""): Promise<string> {
        if (!folder) return "";
        try {
            const pathArg = path ? `-- "${path}"` : "";
            const { stdout } = await execAsync(`git --no-pager diff ${ref1} ${ref2} ${pathArg}`, {
                cwd: folder.uri.fsPath,
                maxBuffer: MAX_BUFFER_SIZE,
                timeout: 10000
            });
            return stdout || '';
        } catch (e: any) {
            // Fallback to git show for full commit patches if diff fails
            if (ref2 && !path) {
                const { stdout } = await execAsync(`git --no-pager show --pretty="" -p ${ref2}`, { cwd: folder.uri.fsPath });
                return stdout || '';
            }
            return `Error generating diff: ${e.message}`;
        }
    }

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
                localResourceRoots:[
                    vscode.Uri.joinPath(extensionUri, 'out', 'styles'),
                    vscode.Uri.joinPath(extensionUri, 'media')
                ]
            }
        );
        GitDashboardPanel.currentPanel = new GitDashboardPanel(panel, extensionUri, git);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, git: GitIntegration) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._git = git;

        // Register listeners BEFORE setting HTML so no messages are missed
        this._setListeners();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.html = this._getHtml(this._panel.webview);

        // Trigger initial load from the extension side — no round-trip needed.
        // A short delay lets the webview DOM parse and attach its message listener first.
        setTimeout(() => this.refresh(), 100);
    }

    private _currentGraphLimit = 50;

    private async refresh(appendGraph: boolean = false) {
        if (this._isDisposed) return;
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            this._panel.webview.postMessage({ command: 'error', message: 'No workspace folder found.' });
            return;
        }

        this._panel.webview.postMessage({ command: 'status', message: 'Fetching Git data...' });

        try {
            const limit = 50;
            const skip = appendGraph ? this._currentGraphLimit : 0;
            const graphLimit = appendGraph ? limit : this._currentGraphLimit;

            const currentBranch = await this._git.getCurrentBranch(folder);
            const status = await this._git.getGitStatus(folder);
            const branches = await this._git.getBranches(folder);
            const stashes = await this._git.getStashList(folder);
            const tags = await this._git.getTags(folder);
            const submodules = await this._git.getSubmodules(folder);
            const graph = await this._git.getGitGraph(folder, graphLimit, skip);

            if (this._isDisposed) return;
            if (appendGraph) { this._currentGraphLimit += limit; }

            this._panel.webview.postMessage({ 
                command: appendGraph ? 'appendGraph' : 'update', 
                data: { status, branches, currentBranch, stashes, tags, graph: graph ?? '', submodules } 
            });

        } catch (error: any) {
            console.error('[GitDashboard] Unhandled error in refresh():', error);
            if (!this._isDisposed) {
                this._panel.webview.postMessage({ 
                    command: 'error', 
                    message: `Git Error: ${error.message}` 
                });
                vscode.window.showErrorMessage(`Failed to refresh Git Dashboard: ${error.message}`);
            }
        }
    }

    private _setListeners() {
        this._panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === 'ready') {
                await this.refresh();
                return;
            }
            const folder = vscode.workspace.workspaceFolders?.[0];
            if (!folder) {
                if (msg.command === 'refresh' || msg.command === 'loadMore') {
                    this._panel.webview.postMessage({ command: 'error', message: 'No active workspace folder.' });
                }
                return;
            }
            try {
                switch (msg.command) {
                    case 'loadMore':
                        await this.refresh(true);
                        break;
                    case 'refresh': 
                        await this.refresh(); 
                        break;
                    case 'selectCommit':
                        if (msg.hash) {
                            const files = await this._git.getChangedFiles(folder, msg.hash);
                            this._panel.webview.postMessage({ command: 'commitDetails', hash: msg.hash, files });
                        }
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
                        try {
                            await this._git.checkout(folder, msg.branch);
                            await this.refresh();
                        } catch (e: any) {
                            if (e.message.includes("overwritten by checkout") || e.message.includes("local changes")) {
                                const choices = ["📦 Stash & Switch", "🗑️ Discard & Switch", "Cancel"];
                                const result = await vscode.window.showErrorMessage(
                                    `Git Conflict: Your local changes would be overwritten by switching to "${msg.branch}".`,
                                    { modal: true },
                                    ...choices
                                );

                                if (result === "📦 Stash & Switch") {
                                    await this._git.stash(folder, `Auto-stash before switching to ${msg.branch}`);
                                    await this._git.checkout(folder, msg.branch);
                                    vscode.window.showInformationMessage(`Changes stashed and switched to ${msg.branch}.`);
                                } else if (result === "🗑️ Discard & Switch") {
                                    const confirm = await vscode.window.showWarningMessage(
                                        "This will PERMANENTLY delete all your uncommitted changes. Proceed?", 
                                        { modal: true }, 
                                        "Yes, Discard"
                                    );
                                    if (confirm === "Yes, Discard") {
                                        await this._git.discardChanges(folder, "."); 
                                        await this._git.checkout(folder, msg.branch);
                                    }
                                }
                                await this.refresh();
                            } else {
                                vscode.window.showErrorMessage(`Checkout failed: ${e.message}`);
                            }
                        }
                        break;
                    case 'renameBranch':
                        const newBranchName = await vscode.window.showInputBox({ 
                            prompt: `Rename branch '${msg.branch}' to:`,
                            value: msg.branch 
                        });
                        if (newBranchName && newBranchName !== msg.branch) {
                            try {
                                await this._git.renameBranch(folder, msg.branch, newBranchName);
                                await this.refresh();
                                vscode.window.showInformationMessage(`Renamed branch to '${newBranchName}'.`);
                            } catch (e: any) {
                                vscode.window.showErrorMessage(`Failed to rename branch: ${e.message}`);
                            }
                        }
                        break;
                    case 'deleteBranch':
                        const confirm = await vscode.window.showWarningMessage(
                            `Are you sure you want to delete branch '${msg.branch}'?`,
                            { modal: true },
                            "Delete"
                        );
                        if (confirm === "Delete") {
                            try {
                                await this._git.deleteBranch(folder, msg.branch);
                                await this.refresh();
                                vscode.window.showInformationMessage(`Deleted branch '${msg.branch}'.`);
                            } catch (e: any) {
                                vscode.window.showErrorMessage(`Failed to delete branch: ${e.message}`);
                            }
                        }
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
                    case 'stashApply': 
                        await this._git.applyStash(folder, msg.index); 
                        await this.refresh(); 
                        break;
                    case 'dropStash': 
                        await this._git.dropStash(folder, msg.index); 
                        await this.refresh(); 
                        break;
                    case 'createTag':
                        const rawTagName = await vscode.window.showInputBox({ 
                            prompt: "New Tag Name (Spaces will be replaced with '-')", 
                            placeHolder: "v1.0.0" 
                        });
                        
                        if (rawTagName) {
                            // Sanitize: replace spaces with hyphens, remove other illegal git ref chars
                            const sanitizedName = rawTagName.trim()
                                .replace(/\s+/g, '-')
                                .replace(/[~^:?*\[\\]/g, '');

                            if (!sanitizedName) {
                                vscode.window.showErrorMessage("Invalid tag name.");
                                break;
                            }

                            const tagMsg = await vscode.window.showInputBox({ 
                                prompt: "Tag Message (Optional)", 
                                placeHolder: "Release description..." 
                            });

                            try {
                                await this._git.createTag(folder, sanitizedName, tagMsg, msg.ref);
                                await this.refresh();
                                vscode.window.showInformationMessage(`Tag '${sanitizedName}' created.`);
                            } catch (e: any) {
                                vscode.window.showErrorMessage(`Git Error: ${e.message}`);
                            }
                        }
                        break;
                    case 'deleteTag':
                        const tagConfirm = await vscode.window.showWarningMessage(`Delete tag '${msg.name}'?`, { modal: true }, "Delete");
                        if (tagConfirm === "Delete") {
                            await this._git.deleteTag(folder, msg.name);
                            await this.refresh();
                        }
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
                    case 'getFileDiff':
                        if (msg.path) {
                            let diff = "";
                            try {
                                if (msg.isBranchComparison) {
                                    diff = await this.getDiffContent(folder, 'HEAD', `"${msg.path}"`);
                                } else if (msg.isCommitDiff) {
                                    if (msg.commitHash) {
                                        // Specific file in specific commit
                                        diff = await this.getDiffContent(folder, `${msg.commitHash}^`, msg.commitHash, msg.path);
                                    } else {
                                        // Full commit patch (using the path arg as hash)
                                        diff = await this.getDiffContent(folder, `${msg.path}^`, msg.path);
                                    }
                                } else {
                                    // Staged/Unstaged changes
                                    const ref1 = msg.staged ? "--cached" : "";
                                    diff = await this.getDiffContent(folder, ref1, "", msg.path);
                                }
                            } catch (e: any) { 
                                diff = `Lollms Git Error: ${e.message}`; 
                            }
                            this._panel.webview.postMessage({ command: 'showDiff', path: msg.path, diff });
                        }
                        break;
                    case 'copyToClipboard':
                        if (msg.text) {
                            await vscode.env.clipboard.writeText(msg.text);
                            vscode.window.showInformationMessage(`Copied to clipboard: ${msg.text.substring(0, 7)}`);
                        }
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
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'gitDashboard.js'));
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${codiconsUri}" rel="stylesheet" />
    <style>
        #global-loader {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: var(--vscode-editor-background);
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            z-index: 10000; gap: 15px;
        }
        #global-loader .spinner {
            width: 40px; height: 40px; border: 4px solid var(--vscode-button-background);
            border-top-color: transparent; border-radius: 50%; animation: spin 1s linear infinite;
        }
        :root {
            --sidebar-width: 260px;
            --right-panel-width: 320px;
            --border: 1px solid var(--vscode-widget-border);
            --header-bg: var(--vscode-sideBarSectionHeader-background);
        }
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-editor-foreground);
            background: var(--vscode-editor-background);
            margin: 0; padding: 0;
            height: 100vh; width: 100vw;
            overflow: hidden;
            display: flex; flex-direction: column;
        }

        /* TOOLBAR */
        .top-toolbar {
            height: 48px;
            background: var(--header-bg);
            border-bottom: var(--border);
            display: flex; align-items: center;
            padding: 0 15px; gap: 20px;
            flex-shrink: 0;
        }
        .toolbar-group { display: flex; align-items: center; gap: 8px; }
        .branch-breadcrumb { 
            font-size: 12px; font-weight: 600; opacity: 0.8; 
            display: flex; align-items: center; gap: 5px;
            background: var(--vscode-badge-background);
            padding: 4px 10px; border-radius: 15px;
        }

        /* MAIN LAYOUT */
        .main-layout {
            flex: 1; display: flex; width: 100%; overflow: hidden;
        }

        /* LEFT SIDEBAR */
        .sidebar-left {
            width: var(--sidebar-width);
            background: var(--vscode-sideBar-background);
            border-right: var(--border);
            display: flex; flex-direction: column;
            overflow-y: auto;
        }
        .nav-section { border-bottom: var(--border); }
        .nav-section-header {
            padding: 8px 12px; font-size: 11px; font-weight: bold;
            text-transform: uppercase; opacity: 0.6;
            display: flex; justify-content: space-between; align-items: center;
            cursor: pointer; user-select: none;
        }
        .nav-section-header:hover { opacity: 1; background: rgba(255,255,255,0.05); }
        .nav-section.collapsed .nav-content { display: none; }
        .nav-section.collapsed .nav-section-header i { transform: rotate(-90deg); }
        .nav-section-header i { transition: transform 0.2s; }
        
        .nav-item {
            padding: 6px 12px 6px 24px; font-size: 13px;
            display: flex; align-items: center; gap: 8px;
            cursor: pointer; transition: background 0.1s;
            position: relative;
        }
        .nav-item:hover { background: var(--vscode-list-hoverBackground); }
        .nav-item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
        .nav-item i { font-size: 14px; opacity: 0.7; }
        
        .nav-item:hover .item-actions { opacity: 1; pointer-events: auto; }
        .nav-item .item-actions { 
            opacity: 0;
            display: flex; 
            gap: 2px; 
            position: absolute;
            right: 8px;
            background: var(--vscode-list-hoverBackground);
            padding: 2px 4px;
            border-radius: 4px;
            box-shadow: -15px 0 15px var(--vscode-list-hoverBackground);
            align-items: center; 
            transition: opacity 0.1s; 
            pointer-events: none;
        }
        .nav-item.active .item-actions { 
            background: var(--vscode-list-activeSelectionBackground);
            box-shadow: -15px 0 15px var(--vscode-list-activeSelectionBackground);
        }
        
        .item-actions .icon-btn { 
            width: 20px; height: 20px; 
            background: rgba(255,255,255,0.05);
        }

        /* --- RICH GIT BADGES --- */
        .badge-pill {
            display: inline-flex;
            align-items: center;
            padding: 2px 8px;
            border-radius: 14px;
            font-size: 10px;
            font-weight: 700;
            margin-right: 6px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.2);
        }
        .badge-head { background: #61afef; color: #1e1e1e; font-weight: 900; }
        .badge-branch { background: rgba(86, 182, 194, 0.2); color: #56b6c2; border: 1px solid #56b6c2; }
        .badge-remote { background: rgba(209, 154, 102, 0.2); color: #d19a66; border: 1px solid #d19a66; }
        .badge-tag { background: #c678dd; color: white; }

        .graph-msg .badge-pill:first-child { margin-left: 0; }

        /* CENTER AREA */
        .center-stage {
            flex: 1; display: flex; flex-direction: column;
            background: var(--vscode-editor-background);
            min-width: 0;
        }
        .tabs-header {
            display: flex; background: var(--header-bg);
            border-bottom: var(--border); padding: 0 10px;
        }
        .tab {
            padding: 10px 15px; font-size: 12px; cursor: pointer;
            border-bottom: 2px solid transparent; opacity: 0.7;
        }
        .tab.active { opacity: 1; border-bottom-color: var(--vscode-button-background); font-weight: bold; }
        .view-container { flex: 1; overflow: auto; position: relative; }

        /* RIGHT PANEL */
        .sidebar-right {
            width: var(--right-panel-width);
            background: var(--vscode-sideBar-background);
            border-left: var(--border);
            display: flex; flex-direction: column;
            overflow-y: auto;
            padding: 15px;
        }

        /* STATUS BAR */
        .status-bar {
            height: 24px; background: var(--vscode-statusBar-background);
            color: var(--vscode-statusBar-foreground);
            font-size: 11px; display: flex; align-items: center;
            padding: 0 10px; gap: 15px; border-top: var(--border);
        }

        /* SHARED COMPONENTS */
        .btn {
            background: var(--vscode-button-background); color: var(--vscode-button-foreground);
            border: none; padding: 4px 12px; border-radius: 2px; cursor: pointer;
            font-size: 12px; display: inline-flex; align-items: center; gap: 5px;
        }
        .btn:hover { filter: brightness(1.1); }
        .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
        
        .list-row {
            padding: 6px 10px; display: flex; align-items: center; gap: 10px;
            border-radius: 4px; cursor: pointer;
        }
        .list-row:hover { background: var(--vscode-list-hoverBackground); }
        
        /* GRAPH VIEW OVERRIDES */
        #graph-inner { position: relative; padding: 10px; }
        .graph-html-row {
            position: absolute; left: 0; right: 0; height: 26px;
            display: flex; align-items: center; padding: 0 8px;
            border-radius: 4px; cursor: pointer;
            transition: background 0.1s;
        }
        .graph-html-row:hover { background: var(--vscode-list-hoverBackground); }
        .graph-html-row:hover .item-actions { opacity: 1; pointer-events: auto; }
        .graph-html-row.selected { background: var(--vscode-list-activeSelectionBackground); }
        
        .graph-msg { 
            flex: 1; 
            font-size: 12px; 
            white-space: nowrap; 
            overflow: hidden; 
            text-overflow: ellipsis; 
            margin-left: 8px;
            opacity: 0.9;
        }
        
        .item-actions { 
            opacity: 0; 
            display: flex; 
            gap: 2px; 
            margin-left: 12px; 
            align-items: center; 
            background: var(--vscode-list-hoverBackground);
            padding: 2px 4px;
            border-radius: 4px;
            box-shadow: -5px 0 10px var(--vscode-list-hoverBackground); /* Fade effect for text */
            pointer-events: none;
            transition: opacity 0.1s;
        }

        .icon-btn {
            background: transparent;
            border: none;
            color: var(--vscode-icon-foreground);
            cursor: pointer;
            width: 22px;
            height: 22px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 3px;
        }

        .icon-btn:hover {
            background: var(--vscode-toolbar-hoverBackground);
            color: var(--vscode-foreground);
        }
        
        textarea {
            width: 100%; background: var(--vscode-input-background);
            color: var(--vscode-input-foreground); border: var(--border);
            padding: 8px; border-radius: 4px; resize: vertical;
        }

        .spinner { animation: spin 1s linear infinite; }
        @keyframes spin { 100% { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="top-toolbar">
        <div class="toolbar-group">
            <button class="btn" onclick="post('refresh')"><i class="codicon codicon-cloud-download"></i> Pull</button>
            <button class="btn" onclick="post('refresh')"><i class="codicon codicon-cloud-upload"></i> Push</button>
            <button class="btn btn-secondary" onclick="post('refresh')"><i class="codicon codicon-sync"></i> Fetch</button>
        </div>
        <div class="branch-breadcrumb" id="active-branch-info">
            <i class="codicon codicon-git-branch"></i> <span id="current-branch-name">loading...</span>
        </div>
        <div style="flex:1"></div>
        <div class="toolbar-group">
            <button class="btn btn-secondary" onclick="post('stash')"><i class="codicon codicon-archive"></i> Stash</button>
            <button class="btn btn-secondary" onclick="post('openGitManager')"><i class="codicon codicon-search"></i> Search</button>
        </div>
    </div>

    <div class="main-layout">
        <!-- LEFT SIDEBAR -->
        <div class="sidebar-left">
            <div class="nav-section" id="section-changes">
                <div class="nav-section-header" onclick="toggleSection('section-changes')">
                    <span>CHANGES</span>
                    <i class="codicon codicon-chevron-down"></i>
                </div>
                <div class="nav-content" id="changes-list"></div>
            </div>
            <div class="nav-section" id="section-branches">
                <div class="nav-section-header" onclick="toggleSection('section-branches')">
                    <span>LOCAL BRANCHES</span>
                    <i class="codicon codicon-chevron-down"></i>
                </div>
                <div class="nav-content" id="local-branches-list"></div>
            </div>
            <div class="nav-section" id="section-tags">
                <div class="nav-section-header" onclick="toggleSection('section-tags')">
                    <span>TAGS</span>
                    <i class="codicon codicon-chevron-down"></i>
                </div>
                <div class="nav-content" id="tags-list"></div>
            </div>
            <div class="nav-section" id="section-stashes">
                <div class="nav-section-header" onclick="toggleSection('section-stashes')">
                    <span>STASHES</span>
                    <i class="codicon codicon-chevron-down"></i>
                </div>
                <div class="nav-content" id="stashes-list"></div>
            </div>
        </div>

        <!-- CENTER TABS -->
        <div class="center-stage">
            <div class="tabs-header">
                <div class="tab active" data-view="HISTORY">History</div>
                <div class="tab" data-view="STAGING">Staging</div>
                <div class="tab" data-view="DIFF">Diff</div>
            </div>
            <div class="view-container">
                <!-- HISTORY VIEW -->
                <div id="view-HISTORY" class="view">
                    <div id="graph-inner"></div>
                    <div style="display:flex; justify-content:center; padding:20px;">
                        <button class="btn btn-secondary" onclick="post('loadMore')">Load More Commits</button>
                    </div>
                </div>

                <!-- STAGING VIEW -->
                <div id="view-STAGING" class="view" style="display:none; padding:24px;">
                    <div id="staging-summary" style="margin-bottom: 20px;"></div>
                    <div style="display:flex; flex-direction:column; gap:12px;">
                        <textarea id="commit-msg-input" style="height: 120px;" placeholder="Commit message (Conventional Commits encouraged)"></textarea>
                        <div style="display:flex; gap:10px;">
                            <button class="btn" style="flex:1" onclick="commit()"><i class="codicon codicon-check"></i> Commit</button>
                            <button class="btn btn-secondary" onclick="generateAI()"><i class="codicon codicon-sparkle"></i> AI Message</button>
                        </div>
                    </div>
                </div>

                <!-- DIFF VIEW -->
                <div id="view-DIFF" class="view" style="display:none; padding:0;">
                    <div id="diff-content-area" style="font-family: var(--vscode-editor-font-family); font-size: 12px; white-space: pre; overflow: auto; height: 100%;">
                        <div style="opacity:0.5; padding:40px; text-align:center;">Select a file from the sidebar to view diff.</div>
                    </div>
                </div>
            </div>
        </div>

        <!-- RIGHT METADATA -->
        <div class="sidebar-right" id="metadata-panel">
            <div style="opacity:0.5; text-align:center; margin-top:50px;">
                <i class="codicon codicon-info" style="font-size:32px"></i>
                <p>Select a commit or file to view details.</p>
            </div>
        </div>
    </div>

    <div id="global-loader">
        <div class="spinner"></div>
        <div style="opacity: 0.7; font-size: 12px;">Syncing Git Repository...</div>
    </div>

    <div class="status-bar">
        <span id="status-branch-label">---</span>
        <span id="status-index-label">0 staged · 0 unstaged</span>
        <div style="flex:1"></div>
        <span id="status-msg">Ready</span>
    </div>

    <script src="${scriptUri}"></script>
</body>
</html>`;
    }
}