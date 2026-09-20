import * as vscode from 'vscode';
import * as path from 'path';
import { GitIntegration, GitFileVersionCommit } from '../gitIntegration';
import { Logger } from '../logger';

export class FileHistoryComparePanel {
    public static currentPanel: FileHistoryComparePanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _gitIntegration: GitIntegration;
    private _currentFolder: vscode.WorkspaceFolder;
    private _currentFilePath: string; // Relative to workspace folder
    private _disposables: vscode.Disposable[] = [];

    private _commits: GitFileVersionCommit[] = [];
    private _refA: string = 'WORKING_TREE';
    private _refB: string = '';
    private _contentCache: Map<string, string> = new Map();
    private _isWebviewReady: boolean = false;
    private _isLoadingHistory: boolean = false;
    private _diffRequestId: number = 0;
    private _skipCount: number = 0;
    private readonly _pageSize: number = 50;
    private _hasMoreCommits: boolean = true;

    public static async createOrShow(
        extensionUri: vscode.Uri,
        gitIntegration: GitIntegration,
        folder: vscode.WorkspaceFolder,
        filePath: string
    ) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : vscode.ViewColumn.One;

        if (FileHistoryComparePanel.currentPanel) {
            try {
                FileHistoryComparePanel.currentPanel._panel.reveal(column);
                await FileHistoryComparePanel.currentPanel.changeFile(folder, filePath);
                return;
            } catch {
                FileHistoryComparePanel.currentPanel = undefined;
            }
        }

        const fileName = path.basename(filePath);
        const panel = vscode.window.createWebviewPanel(
            'lollmsFileHistoryCompare',
            `History: ${fileName}`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    extensionUri,
                    vscode.Uri.joinPath(extensionUri, 'out'),
                    vscode.Uri.joinPath(extensionUri, 'out', 'styles'),
                    vscode.Uri.joinPath(extensionUri, 'media')
                ]
            }
        );

        FileHistoryComparePanel.currentPanel = new FileHistoryComparePanel(panel, extensionUri, gitIntegration, folder, filePath);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        gitIntegration: GitIntegration,
        folder: vscode.WorkspaceFolder,
        filePath: string
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._gitIntegration = gitIntegration;
        this._currentFolder = folder;
        this._currentFilePath = filePath.replace(/\\/g, '/').replace(/^\/+/, '');

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._setWebviewMessageListener();
        this._panel.webview.html = this._getHtmlForWebview();

        // Fallback timer: ensures data loads even if the webview-ready handshake is missed
        setTimeout(() => {
            if (!this._isWebviewReady && !this._isLoadingHistory) {
                this.loadHistory(false);
            }
        }, 500);
    }

    public async changeFile(folder: vscode.WorkspaceFolder, filePath: string) {
        this._currentFolder = folder;
        this._currentFilePath = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
        this._contentCache.clear();
        this._commits = [];
        this._skipCount = 0;
        this._hasMoreCommits = true;
        this._refA = 'WORKING_TREE';
        this._refB = '';
        this._panel.title = `History: ${path.basename(filePath)}`;
        await this.loadHistory(false);
    }

    public dispose() {
        FileHistoryComparePanel.currentPanel = undefined;
        try {
            this._panel.dispose();
        } catch {}
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) x.dispose();
        }
    }

    private async loadHistory(append: boolean = false) {
        if (this._isLoadingHistory) return;
        this._isLoadingHistory = true;

        this._panel.webview.postMessage({ command: 'setLoading', loading: true, status: append ? 'Loading more commits...' : 'Fetching history across all branches...' });

        try {
            const newBatch = await this._gitIntegration.getFileHistoryAllBranches(
                this._currentFolder, 
                this._currentFilePath, 
                this._pageSize, 
                this._skipCount
            );

            if (append) {
                const existingHashes = new Set(this._commits.map(c => c.hash));
                for (const c of newBatch) {
                    if (!existingHashes.has(c.hash)) {
                        this._commits.push(c);
                    }
                }
            } else {
                this._commits = newBatch;
            }

            this._skipCount += this._pageSize;
            this._hasMoreCommits = newBatch.length >= this._pageSize;

            this._panel.webview.postMessage({
                command: 'setFileDetails',
                filePath: this._currentFilePath,
                fileName: path.basename(this._currentFilePath),
                commits: this._commits,
                refA: this._refA,
                refB: this._refB,
                hasMore: this._hasMoreCommits
            });

            // LAZY LOADING MANDATE: Do NOT compute/load heavy diffs on initial load.
            // If the user already explicitly selected a commit refB, update it; otherwise show the placeholder.
            if (!append && this._refB && this._refB !== 'WORKING_TREE') {
                await this.updateDiffView();
            } else if (!append) {
                this._panel.webview.postMessage({
                    command: 'showDiffPlaceholder',
                    fileName: path.basename(this._currentFilePath),
                    commitCount: this._commits.length,
                    latestCommit: this._commits.length > 0 ? this._commits[0] : null
                });
            }
        } catch (err: any) {
            Logger.error(`Failed to load history for ${this._currentFilePath}`, err);
            this._panel.webview.postMessage({ command: 'setError', error: err.message || 'Failed to read git history.' });
        } finally {
            this._isLoadingHistory = false;
            this._panel.webview.postMessage({ command: 'setLoading', loading: false });
        }
    }

    private async getFileContent(ref: string): Promise<string> {
        if (this._contentCache.has(ref)) {
            return this._contentCache.get(ref)!;
        }

        const content = await this._gitIntegration.getFileContentAtRef(this._currentFolder, ref, this._currentFilePath);
        this._contentCache.set(ref, content);
        return content;
    }

    private async updateDiffView() {
        if (!this._refB) return;
        const currentReq = ++this._diffRequestId;

        this._panel.webview.postMessage({ 
            command: 'setDiffLoading', 
            loading: true, 
            status: `Comparing ${this.getRefDisplayInfo(this._refA).label} ↔ ${this.getRefDisplayInfo(this._refB).label}...` 
        });

        try {
            const [contentA, contentB, rawDiff] = await Promise.all([
                this.getFileContent(this._refA),
                this.getFileContent(this._refB || this._refA),
                this._gitIntegration.getFileDiffBetweenRefs(this._currentFolder, this._refA, this._refB || this._refA, this._currentFilePath)
            ]);

            if (currentReq !== this._diffRequestId) {
                return; // Newer request superseded this diff computation
            }

            const infoA = this.getRefDisplayInfo(this._refA);
            const infoB = this.getRefDisplayInfo(this._refB || this._refA);

            this._panel.webview.postMessage({
                command: 'renderDiff',
                refA: this._refA,
                refB: this._refB || this._refA,
                infoA,
                infoB,
                contentA,
                contentB,
                rawDiff
            });
        } catch (err: any) {
            if (currentReq === this._diffRequestId) {
                this._panel.webview.postMessage({ command: 'setError', error: `Diff error: ${err.message}` });
            }
        } finally {
            if (currentReq === this._diffRequestId) {
                this._panel.webview.postMessage({ command: 'setDiffLoading', loading: false });
            }
        }
    }

    private getRefDisplayInfo(ref: string): { label: string, detail: string } {
        if (ref === 'WORKING_TREE') {
            return { label: 'Working Tree (Current Disk)', detail: 'Current file state on disk' };
        }
        const commit = this._commits.find(c => c.hash === ref);
        if (commit) {
            return {
                label: `Commit ${commit.hash.substring(0, 7)}`,
                detail: `${commit.message} - by ${commit.author} on ${commit.date}`
            };
        }
        return { label: ref.substring(0, 7), detail: ref };
    }

    private _setWebviewMessageListener() {
        this._panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'webview-ready':
                    this._isWebviewReady = true;
                    if (!this._isLoadingHistory && this._commits.length === 0) {
                        await this.loadHistory(false);
                    }
                    break;
                case 'selectRefA':
                    this._refA = message.ref;
                    await this.updateDiffView();
                    break;
                case 'selectRefB':
                    this._refB = message.ref;
                    await this.updateDiffView();
                    break;
                case 'swapRefs': {
                    const temp = this._refA;
                    this._refA = this._refB;
                    this._refB = temp;
                    await this.updateDiffView();
                    break;
                }
                case 'refresh':
                    this._contentCache.clear();
                    this._skipCount = 0;
                    this._commits = [];
                    await this.loadHistory(false);
                    break;
                case 'loadMore':
                    await this.loadHistory(true);
                    break;
                case 'copyContent': {
                    const content = await this.getFileContent(message.ref);
                    await vscode.env.clipboard.writeText(content);
                    const info = this.getRefDisplayInfo(message.ref);
                    vscode.window.showInformationMessage(`Copied content of ${info.label} to clipboard.`);
                    break;
                }
                case 'copyDiff':
                    if (message.diff) {
                        await vscode.env.clipboard.writeText(message.diff);
                        vscode.window.showInformationMessage(`Copied unified diff to clipboard.`);
                    }
                    break;
                case 'restoreVersion':
                    await this.handleRestore(message.ref);
                    break;
                case 'openNativeDiff':
                    await this.handleOpenNativeDiff();
                    break;
                case 'chooseDifferentFile':
                    await this.handleChooseDifferentFile();
                    break;
            }
        }, null, this._disposables);
    }

    private async handleRestore(ref: string) {
        if (ref === 'WORKING_TREE') {
            vscode.window.showInformationMessage("Selected version is already the current working tree on disk.");
            return;
        }

        const info = this.getRefDisplayInfo(ref);
        const confirm = await vscode.window.showWarningMessage(
            `Restore file "${this._currentFilePath}" to ${info.label}?`,
            { modal: true, detail: `This will overwrite your current file on disk with: "${info.detail}".` },
            "Restore Version"
        );

        if (confirm === "Restore Version") {
            try {
                const targetContent = await this.getFileContent(ref);
                const fileUri = vscode.Uri.joinPath(this._currentFolder.uri, this._currentFilePath);

                await vscode.workspace.fs.writeFile(fileUri, Buffer.from(targetContent, 'utf8'));
                this._contentCache.delete('WORKING_TREE');

                vscode.window.showInformationMessage(`✅ Restored "${path.basename(this._currentFilePath)}" to ${info.label}.`);
                await this.updateDiffView();
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to restore file: ${err.message}`);
            }
        }
    }

    private async handleOpenNativeDiff() {
        try {
            const cacheDir = vscode.Uri.joinPath(this._currentFolder.uri, '.lollms', 'diff_cache');
            await vscode.workspace.fs.createDirectory(cacheDir);

            const baseName = path.basename(this._currentFilePath);
            const shortA = this._refA === 'WORKING_TREE' ? 'working' : this._refA.substring(0, 7);
            const shortB = this._refB === 'WORKING_TREE' ? 'working' : (this._refB ? this._refB.substring(0, 7) : 'working');

            let uriA: vscode.Uri;
            let uriB: vscode.Uri;

            if (this._refA === 'WORKING_TREE') {
                uriA = vscode.Uri.joinPath(this._currentFolder.uri, this._currentFilePath);
            } else {
                uriA = vscode.Uri.joinPath(cacheDir, `${shortA}_${baseName}`);
                const contentA = await this.getFileContent(this._refA);
                await vscode.workspace.fs.writeFile(uriA, Buffer.from(contentA, 'utf8'));
            }

            if (this._refB === 'WORKING_TREE' || !this._refB) {
                uriB = vscode.Uri.joinPath(this._currentFolder.uri, this._currentFilePath);
            } else {
                uriB = vscode.Uri.joinPath(cacheDir, `${shortB}_${baseName}`);
                const contentB = await this.getFileContent(this._refB);
                await vscode.workspace.fs.writeFile(uriB, Buffer.from(contentB, 'utf8'));
            }

            const title = `${baseName} (${shortA} ↔ ${shortB})`;
            await vscode.commands.executeCommand('vscode.diff', uriA, uriB, title);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to open native diff: ${err.message}`);
        }
    }

    private async handleChooseDifferentFile() {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            defaultUri: this._currentFolder.uri,
            openLabel: "View Version History"
        });

        if (uris && uris[0]) {
            const targetUri = uris[0];
            const folder = vscode.workspace.getWorkspaceFolder(targetUri);
            if (folder) {
                const relPath = path.relative(folder.uri.fsPath, targetUri.fsPath).replace(/\\/g, '/');
                await this.changeFile(folder, relPath);
            }
        }
    }

    private _getHtmlForWebview(): string {
        const codiconsUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'));
        const cspSource = this._panel.webview.cspSource;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; font-src ${cspSource}; script-src 'unsafe-inline';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>File Version History & Restore</title>
    <link href="${codiconsUri}" rel="stylesheet" />
    <style>
        :root {
            --added-bg: rgba(15, 157, 88, 0.15);
            --added-fg: var(--vscode-charts-green, #4caf50);
            --removed-bg: rgba(244, 71, 71, 0.15);
            --removed-fg: var(--vscode-charts-red, #f44336);
        }
        body {
            font-family: var(--vscode-font-family, sans-serif);
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 0;
            margin: 0;
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
        }
        .header {
            padding: 8px 16px;
            background: var(--vscode-editorWidget-background);
            border-bottom: 1px solid var(--vscode-widget-border);
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            flex-wrap: wrap;
        }
        .file-info {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 13px;
            font-weight: bold;
        }
        .file-path {
            color: var(--vscode-textLink-foreground);
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 12px;
        }
        .btn-group {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-wrap: wrap;
        }
        button {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-widget-border);
            padding: 4px 10px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 11px;
            display: inline-flex;
            align-items: center;
            gap: 5px;
            transition: all 0.15s;
        }
        button:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        button.primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
        }
        button.primary:hover {
            filter: brightness(1.1);
        }
        button.restore-btn {
            background-color: #28a745;
            color: white;
            border: none;
            font-weight: bold;
        }
        button.restore-btn:hover {
            filter: brightness(1.15);
        }
        .main-container {
            display: flex;
            flex: 1;
            min-height: 0;
            overflow: hidden;
        }
        .sidebar {
            width: 380px;
            border-right: 1px solid var(--vscode-widget-border);
            background: var(--vscode-sideBar-background);
            display: flex;
            flex-direction: column;
            flex-shrink: 0;
        }
        .sidebar-header {
            padding: 8px 12px;
            background: var(--vscode-sideBarSectionHeader-background);
            font-size: 11px;
            font-weight: bold;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid var(--vscode-widget-border);
        }
        .search-box {
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-widget-border);
            background: var(--vscode-editor-background);
        }
        .search-box input {
            width: 100%;
            padding: 4px 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-size: 11px;
            box-sizing: border-box;
            outline: none;
        }
        .commits-list {
            flex: 1;
            overflow-y: auto;
        }
        .commit-row {
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-widget-border);
            cursor: pointer;
            transition: background 0.1s;
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        .commit-row:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .commit-row.selected-a {
            border-left: 4px solid #007acc;
            background: rgba(0, 122, 204, 0.12);
        }
        .commit-row.selected-b {
            border-right: 4px solid #9b59b6;
            background: rgba(155, 89, 182, 0.12);
        }
        .commit-row.selected-both {
            border-left: 4px solid #007acc;
            border-right: 4px solid #9b59b6;
            background: rgba(255, 255, 255, 0.08);
        }
        .commit-top {
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 11px;
        }
        .commit-hash {
            font-family: var(--vscode-editor-font-family, monospace);
            font-weight: bold;
            color: var(--vscode-textLink-foreground);
        }
        .commit-date {
            font-size: 10px;
            opacity: 0.7;
        }
        .commit-msg {
            font-size: 12px;
            font-weight: 500;
            line-height: 1.4;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .commit-meta {
            font-size: 10px;
            opacity: 0.85;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            flex-wrap: wrap;
        }
        .ref-badge {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 1px 6px;
            border-radius: 8px;
            font-size: 9px;
            font-weight: bold;
        }
        .quick-pick-btns {
            display: flex;
            gap: 4px;
            margin-top: 2px;
        }
        .quick-pick-btns button {
            padding: 1px 6px;
            font-size: 9px;
            height: 18px;
        }
        .diff-panel {
            flex: 1;
            display: flex;
            flex-direction: column;
            min-width: 0;
            background: var(--vscode-editor-background);
            position: relative;
        }
        .diff-toolbar {
            padding: 8px 16px;
            background: var(--vscode-editorWidget-background);
            border-bottom: 1px solid var(--vscode-widget-border);
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            flex-wrap: wrap;
        }
        .version-legend {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 11px;
            flex-wrap: wrap;
        }
        .legend-select-group {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .legend-select {
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            padding: 3px 6px;
            border-radius: 4px;
            font-size: 11px;
            max-width: 200px;
            outline: none;
        }
        .diff-view-mode-toggle {
            display: flex;
            align-items: center;
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 4px;
            padding: 2px;
            gap: 2px;
        }
        .diff-view-mode-toggle button {
            border: none;
            background: transparent;
            padding: 2px 8px;
            font-size: 10px;
        }
        .diff-view-mode-toggle button.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .diff-view-area {
            flex: 1;
            overflow: auto;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 12px;
            line-height: 1.5;
            padding: 0;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
        }
        .split-diff-container {
            display: flex;
            flex: 1;
            height: 100%;
            overflow: hidden;
        }
        .split-pane {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            border-right: 1px solid var(--vscode-widget-border);
        }
        .split-pane-header {
            padding: 6px 12px;
            background: var(--vscode-sideBarSectionHeader-background);
            font-size: 11px;
            font-weight: bold;
            border-bottom: 1px solid var(--vscode-widget-border);
        }
        .split-pane-content {
            flex: 1;
            overflow: auto;
            white-space: pre;
            padding: 0;
            box-sizing: border-box;
        }
        .unified-diff-content {
            white-space: pre;
            padding: 0;
            box-sizing: border-box;
        }
        .diff-line {
            display: flex;
            width: 100%;
            min-height: 1.5em;
            line-height: 1.5;
            box-sizing: border-box;
        }
        .diff-line-num {
            width: 48px;
            text-align: right;
            padding-right: 8px;
            color: var(--vscode-editorLineNumber-foreground, #858585);
            background: var(--vscode-editorGutter-background, rgba(0,0,0,0.2));
            user-select: none;
            flex-shrink: 0;
            border-right: 1px solid var(--vscode-widget-border);
            margin-right: 8px;
            font-size: 11px;
        }
        .diff-line-content {
            flex: 1;
            white-space: pre;
            overflow-x: visible;
        }
        .diff-line.added {
            background-color: rgba(15, 157, 88, 0.22) !important;
            color: var(--vscode-charts-green, #4caf50) !important;
        }
        .diff-line.added .diff-line-num {
            color: var(--vscode-charts-green, #4caf50) !important;
            background: rgba(15, 157, 88, 0.35) !important;
            font-weight: bold;
        }
        .diff-line.removed {
            background-color: rgba(244, 71, 71, 0.22) !important;
            color: var(--vscode-charts-red, #f44336) !important;
        }
        .diff-line.removed .diff-line-num {
            color: var(--vscode-charts-red, #f44336) !important;
            background: rgba(244, 71, 71, 0.35) !important;
            font-weight: bold;
        }
        .diff-line.empty-placeholder {
            background: rgba(128, 128, 128, 0.08) !important;
            opacity: 0.35;
        }
        .diff-line.header-line {
            background: rgba(86, 156, 214, 0.15);
            color: #569cd6;
            font-weight: bold;
        }

        
        .diff-stats-badge {
            font-size: 10px;
            padding: 2px 6px;
            border-radius: 10px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            font-weight: bold;
        }
        .diff-empty {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            opacity: 0.6;
            gap: 8px;
            padding: 40px;
            text-align: center;
        }
        .loading-overlay {
            position: absolute;
            inset: 0;
            background: rgba(0,0,0,0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            font-size: 12px;
            z-index: 1000;
        }
        .spinner {
            width: 16px;
            height: 16px;
            border: 2px solid currentColor;
            border-bottom-color: transparent;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }
        @keyframes spin { 100% { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="header">
        <div class="file-info">
            <i class="codicon codicon-history"></i>
            <span id="header-file-name">Loading file history...</span>
            <span class="file-path" id="header-file-path"></span>
        </div>
        <div class="btn-group">
            <button id="btn-change-file" title="Inspect a different file"><i class="codicon codicon-folder-opened"></i> Change File...</button>
            <button id="btn-refresh" title="Refresh git history"><i class="codicon codicon-refresh"></i> Refresh</button>
        </div>
    </div>

    <div class="main-container">
        <!-- Sidebar: Commits list across all branches -->
        <div class="sidebar">
            <div class="sidebar-header">
                <span>Commits (All Branches)</span>
                <span id="commit-count" style="opacity:0.6;">0</span>
            </div>
            <div class="search-box">
                <input type="text" id="commit-filter" placeholder="Filter commits (message, author, hash, branch)..." />
            </div>
            <div class="commits-list" id="commits-list">
                <div style="padding: 20px; text-align: center; opacity: 0.6;">Loading history...</div>
            </div>
            <div id="sidebar-footer" style="padding: 8px 12px; border-top: 1px solid var(--vscode-widget-border); display: none; justify-content: center; background: var(--vscode-sideBar-background);">
                <button id="btn-load-more-commits" style="width: 100%; justify-content: center;"><i class="codicon codicon-arrow-down"></i> Load More Commits</button>
            </div>
        </div>

        <!-- Main Panel: Diff & Restoration Controls -->
        <div class="diff-panel">
            <div class="diff-toolbar">
                <div class="version-legend">
                    <div class="legend-select-group">
                        <span style="font-weight:bold; color:#007acc">Base (A):</span>
                        <select id="select-ref-a" class="legend-select"></select>
                    </div>

                    <button id="btn-swap" title="Swap Version A and Version B"><i class="codicon codicon-arrow-swap"></i></button>

                    <div class="legend-select-group">
                        <span style="font-weight:bold; color:#9b59b6">Compare (B):</span>
                        <select id="select-ref-b" class="legend-select"></select>
                    </div>

                    <span id="diff-stats-label" class="diff-stats-badge" style="display:none;"></span>
                </div>

                <div class="btn-group">
                    <div class="diff-view-mode-toggle">
                        <button id="btn-mode-split" class="active">Split</button>
                        <button id="btn-mode-unified">Unified</button>
                    </div>

                    <button id="btn-copy-a" title="Copy Version A file content to clipboard"><i class="codicon codicon-copy"></i> Copy A</button>
                    <button id="btn-copy-b" title="Copy Version B file content to clipboard"><i class="codicon codicon-copy"></i> Copy B</button>
                    <button id="btn-copy-diff" title="Copy unified patch diff to clipboard"><i class="codicon codicon-clippy"></i> Copy Diff</button>
                    <button id="btn-native-diff" class="primary" title="Open in VS Code native side-by-side diff editor"><i class="codicon codicon-diff"></i> VS Code Diff</button>
                    <button id="btn-restore-a" class="restore-btn" title="Replace current disk file with Version A"><i class="codicon codicon-discard"></i> Restore A</button>
                    <button id="btn-restore-b" class="restore-btn" title="Replace current disk file with Version B"><i class="codicon codicon-discard"></i> Restore B</button>
                </div>
            </div>

            <div class="diff-view-area" id="diff-content">
                <div class="diff-empty">
                    <i class="codicon codicon-git-compare" style="font-size:32px;"></i>
                    <span>Select commits from the list to view differences.</span>
                </div>
            </div>
        </div>
    </div>

    <div class="loading-overlay" id="loading-overlay" style="display:none;">
        <div class="spinner"></div>
        <span id="loading-text">Loading...</span>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let commitsData = [];
        let activeRefA = 'WORKING_TREE';
        let activeRefB = '';
        let currentRawDiff = '';
        let currentContentA = '';
        let currentContentB = '';
        let currentInfoA = null;
        let currentInfoB = null;
        let viewMode = 'split';

        const listEl = document.getElementById('commits-list');
        const filterInput = document.getElementById('commit-filter');
        const diffArea = document.getElementById('diff-content');
        const loadingOverlay = document.getElementById('loading-overlay');
        const loadingText = document.getElementById('loading-text');

        const selectA = document.getElementById('select-ref-a');
        const selectB = document.getElementById('select-ref-b');
        const statsBadge = document.getElementById('diff-stats-label');

        const btnModeSplit = document.getElementById('btn-mode-split');
        const btnModeUnified = document.getElementById('btn-mode-unified');

        filterInput.addEventListener('input', function() { renderCommitList(filterInput.value.trim()); });

        selectA.onchange = function() {
            activeRefA = selectA.value;
            vscode.postMessage({ command: 'selectRefA', ref: selectA.value });
        };
        selectB.onchange = function() {
            activeRefB = selectB.value;
            vscode.postMessage({ command: 'selectRefB', ref: selectB.value });
        };

        btnModeSplit.onclick = function() {
            viewMode = 'split';
            btnModeSplit.classList.add('active');
            btnModeUnified.classList.remove('active');
            renderCurrentView();
        };

        btnModeUnified.onclick = function() {
            viewMode = 'unified';
            btnModeUnified.classList.add('active');
            btnModeSplit.classList.remove('active');
            renderCurrentView();
        };

        document.getElementById('btn-refresh').onclick = function() { vscode.postMessage({ command: 'refresh' }); };
        document.getElementById('btn-change-file').onclick = function() { vscode.postMessage({ command: 'chooseDifferentFile' }); };
        document.getElementById('btn-swap').onclick = function() { vscode.postMessage({ command: 'swapRefs' }); };
        document.getElementById('btn-load-more-commits').onclick = function() { vscode.postMessage({ command: 'loadMore' }); };

        document.getElementById('btn-copy-a').onclick = function() { vscode.postMessage({ command: 'copyContent', ref: activeRefA }); };
        document.getElementById('btn-copy-b').onclick = function() { vscode.postMessage({ command: 'copyContent', ref: activeRefB || activeRefA }); };
        document.getElementById('btn-copy-diff').onclick = function() { vscode.postMessage({ command: 'copyDiff', diff: currentRawDiff }); };
        document.getElementById('btn-native-diff').onclick = function() { vscode.postMessage({ command: 'openNativeDiff' }); };

        document.getElementById('btn-restore-a').onclick = function() { vscode.postMessage({ command: 'restoreVersion', ref: activeRefA }); };
        document.getElementById('btn-restore-b').onclick = function() { vscode.postMessage({ command: 'restoreVersion', ref: activeRefB || activeRefA }); };

        window.addEventListener('message', function(event) {
            const msg = event.data;
            switch (msg.command) {
                case 'setLoading':
                    loadingOverlay.style.display = msg.loading ? 'flex' : 'none';
                    if (msg.status) loadingText.textContent = msg.status;
                    break;
                case 'setFileDetails':
                    document.getElementById('header-file-name').textContent = msg.fileName;
                    document.getElementById('header-file-path').textContent = '(' + msg.filePath + ')';
                    commitsData = msg.commits || [];
                    activeRefA = msg.refA || 'WORKING_TREE';
                    activeRefB = msg.refB || (commitsData.length > 0 ? commitsData[0].hash : 'WORKING_TREE');
                    document.getElementById('commit-count').textContent = commitsData.length;

                    const footer = document.getElementById('sidebar-footer');
                    if (footer) {
                        footer.style.display = msg.hasMore ? 'flex' : 'none';
                    }

                    populateDropdowns();
                    renderCommitList();
                    break;
                case 'showDiffPlaceholder':
                    renderDiffPlaceholder(msg);
                    break;
                case 'setDiffLoading':
                    if (msg.loading) {
                        diffArea.innerHTML = '<div class="diff-empty"><div class="spinner" style="width:28px; height:28px; border-width:3px;"></div><span style="font-weight:bold; font-size:13px; margin-top:10px;">' + escapeHtml(msg.status || 'Generating diff...') + '</span></div>';
                    }
                    break;
                case 'renderDiff':
                    activeRefA = msg.refA;
                    activeRefB = msg.refB;
                    currentRawDiff = msg.rawDiff || '';
                    currentContentA = msg.contentA || '';
                    currentContentB = msg.contentB || '';
                    currentInfoA = msg.infoA;
                    currentInfoB = msg.infoB;
                    selectA.value = msg.refA;
                    selectB.value = msg.refB;
                    renderCurrentView();
                    highlightSelectedRows();
                    break;
                case 'setError':
                    diffArea.innerHTML = '<div style="color:var(--vscode-errorForeground); padding:20px;">' + escapeHtml(msg.error) + '</div>';
                    break;
            }
        });

        function escapeHtml(text) {
            if (!text) return '';
            return String(text)
                .split('&').join('&amp;')
                .split('<').join('&lt;')
                .split('>').join('&gt;')
                .split('"').join('&quot;');
        }

        function parseHunkHeader(line) {
            if (!line || !line.startsWith('@@')) return null;
            const endIdx = line.indexOf('@@', 2);
            if (endIdx === -1) return null;
            const headerContent = line.substring(2, endIdx).trim();
            const parts = headerContent.split(' ').filter(function(p) { return p.length > 0; });
            if (parts.length < 2) return null;

            const partA = parts[0];
            const partB = parts[1];

            if (!partA.startsWith('-') || !partB.startsWith('+')) return null;

            const subA = partA.substring(1).split(',');
            const subB = partB.substring(1).split(',');

            const startA = parseInt(subA[0], 10) || 1;
            const lenA = subA.length > 1 ? (parseInt(subA[1], 10) || 0) : 1;

            const startB = parseInt(subB[0], 10) || 1;
            const lenB = subB.length > 1 ? (parseInt(subB[1], 10) || 0) : 1;

            return { startA: startA, lenA: lenA, startB: startB, lenB: lenB };
        }

        function populateDropdowns() {
            let opts = '<option value="WORKING_TREE">Current Working Tree (Disk)</option>';
            commitsData.forEach(function(c) {
                const short = c.hash.substring(0, 7);
                const msg = c.message.length > 30 ? c.message.substring(0, 27) + '...' : c.message;
                opts += '<option value="' + c.hash + '">' + short + ' - ' + escapeHtml(msg) + '</option>';
            });

            selectA.innerHTML = opts;
            selectB.innerHTML = opts;
            selectA.value = activeRefA;
            selectB.value = activeRefB;
        }

        function renderCommitList(query) {
            query = query || '';
            listEl.innerHTML = '';

            // Working Tree Entry (Top item)
            const workingRow = document.createElement('div');
            const isWorkingA = activeRefA === 'WORKING_TREE';
            const isWorkingB = activeRefB === 'WORKING_TREE';
            const selWorkingClass = isWorkingA && isWorkingB ? ' selected-both' : (isWorkingA ? ' selected-a' : (isWorkingB ? ' selected-b' : ''));
            workingRow.className = 'commit-row' + selWorkingClass;
            workingRow.dataset.hash = 'WORKING_TREE';

            workingRow.innerHTML = '' +
                '<div class="commit-top">' +
                    '<span class="commit-hash"><i class="codicon codicon-edit"></i> Working Tree</span>' +
                    '<span class="commit-date">Current Disk</span>' +
                '</div>' +
                '<div class="commit-msg">Current uncommitted file state on disk</div>' +
                '<div class="commit-meta">' +
                    '<span class="ref-badge" style="background:#28a745">ACTIVE</span>' +
                    '<div class="quick-pick-btns">' +
                        '<button class="btn-set-a">Set A</button>' +
                        '<button class="btn-set-b">Set B</button>' +
                    '</div>' +
                '</div>';

            attachRowListeners(workingRow, 'WORKING_TREE');
            listEl.appendChild(workingRow);

            const filtered = query
                ? commitsData.filter(function(c) {
                    return c.message.toLowerCase().indexOf(query.toLowerCase()) !== -1 ||
                           c.author.toLowerCase().indexOf(query.toLowerCase()) !== -1 ||
                           c.hash.toLowerCase().indexOf(query.toLowerCase()) !== -1 ||
                           (c.refs && c.refs.toLowerCase().indexOf(query.toLowerCase()) !== -1);
                  })
                : commitsData;

            if (filtered.length === 0 && commitsData.length === 0) {
                const emptyNotice = document.createElement('div');
                emptyNotice.style.cssText = 'padding: 16px; opacity: 0.7; text-align: center; font-size: 11px;';
                emptyNotice.textContent = 'No prior git commits found for this file path.';
                listEl.appendChild(emptyNotice);
                return;
            }

            filtered.forEach(function(commit) {
                const row = document.createElement('div');
                const isA = activeRefA === commit.hash;
                const isB = activeRefB === commit.hash;
                const selClass = isA && isB ? ' selected-both' : (isA ? ' selected-a' : (isB ? ' selected-b' : ''));
                row.className = 'commit-row' + selClass;
                row.dataset.hash = commit.hash;

                let refsBadgeHtml = '';
                if (commit.refs) {
                    let cleanRef = commit.refs.trim();
                    if (cleanRef.startsWith('(')) cleanRef = cleanRef.slice(1);
                    if (cleanRef.endsWith(')')) cleanRef = cleanRef.slice(0, -1);
                    refsBadgeHtml = '<span class="ref-badge">' + escapeHtml(cleanRef) + '</span>';
                }

                row.innerHTML = '' +
                    '<div class="commit-top">' +
                        '<span class="commit-hash">' + commit.hash.substring(0, 7) + '</span>' +
                        '<span class="commit-date">' + escapeHtml(commit.date) + '</span>' +
                    '</div>' +
                    '<div class="commit-msg" title="' + escapeHtml(commit.message) + '">' + escapeHtml(commit.message) + '</div>' +
                    '<div class="commit-meta">' +
                        '<span><i class="codicon codicon-person"></i> ' + escapeHtml(commit.author) + '</span>' +
                        refsBadgeHtml +
                        '<div class="quick-pick-btns">' +
                            '<button class="btn-set-a">Set A</button>' +
                            '<button class="btn-set-b">Set B</button>' +
                            '<button class="restore-btn btn-row-restore" title="Restore to this commit">Restore</button>' +
                        '</div>' +
                    '</div>';

                attachRowListeners(row, commit.hash);
                listEl.appendChild(row);
            });
        }

        function attachRowListeners(rowEl, ref) {
            const btnA = rowEl.querySelector('.btn-set-a');
            const btnB = rowEl.querySelector('.btn-set-b');
            const btnRestore = rowEl.querySelector('.btn-row-restore');

            if (btnA) {
                btnA.onclick = function(e) {
                    e.stopPropagation();
                    activeRefA = ref;
                    selectA.value = ref;
                    vscode.postMessage({ command: 'selectRefA', ref: ref });
                };
            }
            if (btnB) {
                btnB.onclick = function(e) {
                    e.stopPropagation();
                    activeRefB = ref;
                    selectB.value = ref;
                    vscode.postMessage({ command: 'selectRefB', ref: ref });
                };
            }
            if (btnRestore) {
                btnRestore.onclick = function(e) {
                    e.stopPropagation();
                    vscode.postMessage({ command: 'restoreVersion', ref: ref });
                };
            }

            rowEl.onclick = function(e) {
                if (e.target.tagName === 'BUTTON') return;
                activeRefB = ref;
                selectB.value = ref;
                vscode.postMessage({ command: 'selectRefB', ref: ref });
            };
        }

        function highlightSelectedRows() {
            document.querySelectorAll('.commit-row').forEach(function(row) {
                const hash = row.dataset.hash;
                const isA = activeRefA === hash;
                const isB = activeRefB === hash;
                row.className = 'commit-row' + (isA && isB ? ' selected-both' : (isA ? ' selected-a' : (isB ? ' selected-b' : '')));
            });
        }

        const NL = String.fromCharCode(10);
        const CR = String.fromCharCode(13);

        function cleanLine(l) {
            return l.endsWith(CR) ? l.slice(0, -1) : l;
        }

        function buildSideBySideDiff(contentA, contentB, rawDiff) {
            const linesA = contentA ? contentA.split(NL).map(cleanLine) : [];
            const linesB = contentB ? contentB.split(NL).map(cleanLine) : [];

            if (!rawDiff || !rawDiff.trim()) {
                const max = Math.max(linesA.length, linesB.length);
                const rowsA = [];
                const rowsB = [];
                const isIdentical = contentA === contentB;

                // For identical large files, collapse instead of generating thousands of elements
                if (isIdentical && max > 20) {
                    for (let i = 0; i < 4; i++) {
                        rowsA.push({ num: i + 1, text: linesA[i] || '', type: 'unchanged' });
                        rowsB.push({ num: i + 1, text: linesB[i] || '', type: 'unchanged' });
                    }
                    rowsA.push({ num: '...', text: '--- ' + (max - 8) + ' identical lines hidden ---', type: 'collapsed' });
                    rowsB.push({ num: '...', text: '--- ' + (max - 8) + ' identical lines hidden ---', type: 'collapsed' });
                    for (let i = max - 4; i < max; i++) {
                        rowsA.push({ num: i + 1, text: linesA[i] || '', type: 'unchanged' });
                        rowsB.push({ num: i + 1, text: linesB[i] || '', type: 'unchanged' });
                    }
                    return { rowsA: rowsA, rowsB: rowsB };
                }

                for (let i = 0; i < max; i++) {
                    const textA = i < linesA.length ? linesA[i] : '';
                    const textB = i < linesB.length ? linesB[i] : '';
                    rowsA.push({
                        num: i < linesA.length ? (i + 1) : '',
                        text: textA,
                        type: isIdentical ? 'unchanged' : (i < linesA.length ? 'removed' : 'empty')
                    });
                    rowsB.push({
                        num: i < linesB.length ? (i + 1) : '',
                        text: textB,
                        type: isIdentical ? 'unchanged' : (i < linesB.length ? 'added' : 'empty')
                    });
                }
                return { rowsA: rowsA, rowsB: rowsB };
            }

            const diffLines = rawDiff.split(NL).map(cleanLine);
            const hunks = [];
            let curHunk = null;

            for (let i = 0; i < diffLines.length; i++) {
                const line = diffLines[i];
                if (line.startsWith('@@')) {
                    if (curHunk) hunks.push(curHunk);
                    const parsed = parseHunkHeader(line);
                    if (parsed) {
                        curHunk = {
                            startA: parsed.startA,
                            lenA: parsed.lenA,
                            startB: parsed.startB,
                            lenB: parsed.lenB,
                            lines: []
                        };
                    } else {
                        curHunk = { startA: 1, lenA: 1, startB: 1, lenB: 1, lines: [] };
                    }
                } else if (curHunk) {
                    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ') || line.startsWith('index ')) {
                        // skip header
                    } else if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '') {
                        curHunk.lines.push(line);
                    }
                }
            }
            if (curHunk) hunks.push(curHunk);

            const rowsA = [];
            const rowsB = [];
            const CONTEXT_PAD = 4; // Display 4 context lines around changes

            let lineIdxA = 1;
            let lineIdxB = 1;

            for (let h = 0; h < hunks.length; h++) {
                const hunk = hunks[h];
                const distanceA = hunk.startA - lineIdxA;

                // Folding / collapsing large spans of unchanged lines
                if (distanceA > (CONTEXT_PAD * 2 + 2)) {
                    // 1. Context lines before collapse
                    for (let c = 0; c < CONTEXT_PAD && lineIdxA < hunk.startA; c++) {
                        rowsA.push({ num: lineIdxA, text: linesA[lineIdxA - 1] || '', type: 'unchanged' });
                        rowsB.push({ num: lineIdxB, text: linesB[lineIdxB - 1] || '', type: 'unchanged' });
                        lineIdxA++;
                        lineIdxB++;
                    }

                    const skipCount = (hunk.startA - CONTEXT_PAD) - lineIdxA;
                    if (skipCount > 0) {
                        rowsA.push({ num: '...', text: '↕ ' + skipCount + ' unchanged lines hidden', type: 'collapsed' });
                        rowsB.push({ num: '...', text: '↕ ' + skipCount + ' unchanged lines hidden', type: 'collapsed' });
                        lineIdxA += skipCount;
                        lineIdxB += skipCount;
                    }
                }

                // Unchanged lines leading directly into the hunk
                while (lineIdxA < hunk.startA && lineIdxA <= linesA.length) {
                    rowsA.push({ num: lineIdxA, text: linesA[lineIdxA - 1] || '', type: 'unchanged' });
                    rowsB.push({ num: lineIdxB, text: linesB[lineIdxB - 1] || '', type: 'unchanged' });
                    lineIdxA++;
                    lineIdxB++;
                }

                // Process hunk lines
                let curHunkIdx = 0;
                while (curHunkIdx < hunk.lines.length) {
                    const hLine = hunk.lines[curHunkIdx];
                    if (hLine.startsWith(' ')) {
                        const text = hLine.substring(1);
                        rowsA.push({ num: lineIdxA, text: linesA[lineIdxA - 1] !== undefined ? linesA[lineIdxA - 1] : text, type: 'unchanged' });
                        rowsB.push({ num: lineIdxB, text: linesB[lineIdxB - 1] !== undefined ? linesB[lineIdxB - 1] : text, type: 'unchanged' });
                        lineIdxA++;
                        lineIdxB++;
                        curHunkIdx++;
                    } else {
                        const removed = [];
                        const added = [];
                        while (curHunkIdx < hunk.lines.length && (hunk.lines[curHunkIdx].startsWith('-') || hunk.lines[curHunkIdx].startsWith('+'))) {
                            if (hunk.lines[curHunkIdx].startsWith('-')) {
                                removed.push(hunk.lines[curHunkIdx].substring(1));
                            } else if (hunk.lines[curHunkIdx].startsWith('+')) {
                                added.push(hunk.lines[curHunkIdx].substring(1));
                            }
                            curHunkIdx++;
                        }

                        const maxChange = Math.max(removed.length, added.length);
                        for (let k = 0; k < maxChange; k++) {
                            if (k < removed.length) {
                                rowsA.push({ num: lineIdxA, text: linesA[lineIdxA - 1] !== undefined ? linesA[lineIdxA - 1] : removed[k], type: 'removed' });
                                lineIdxA++;
                            } else {
                                rowsA.push({ num: '', text: '', type: 'empty' });
                            }

                            if (k < added.length) {
                                rowsB.push({ num: lineIdxB, text: linesB[lineIdxB - 1] !== undefined ? linesB[lineIdxB - 1] : added[k], type: 'added' });
                                lineIdxB++;
                            } else {
                                rowsB.push({ num: '', text: '', type: 'empty' });
                            }
                        }
                    }
                }
            }

            // Collapse trailing unchanged lines after last hunk
            const remainingA = linesA.length - lineIdxA + 1;
            if (remainingA > (CONTEXT_PAD * 2 + 2)) {
                for (let c = 0; c < CONTEXT_PAD; c++) {
                    rowsA.push({ num: lineIdxA, text: linesA[lineIdxA - 1] || '', type: 'unchanged' });
                    rowsB.push({ num: lineIdxB, text: linesB[lineIdxB - 1] || '', type: 'unchanged' });
                    lineIdxA++;
                    lineIdxB++;
                }
                const skipTrailing = (linesA.length - CONTEXT_PAD) - lineIdxA + 1;
                if (skipTrailing > 0) {
                    rowsA.push({ num: '...', text: '↕ ' + skipTrailing + ' unchanged lines hidden', type: 'collapsed' });
                    rowsB.push({ num: '...', text: '↕ ' + skipTrailing + ' unchanged lines hidden', type: 'collapsed' });
                    lineIdxA += skipTrailing;
                    lineIdxB += skipTrailing;
                }
            }

            while (lineIdxA <= linesA.length || lineIdxB <= linesB.length) {
                const textA = lineIdxA <= linesA.length ? linesA[lineIdxA - 1] : '';
                const textB = lineIdxB <= linesB.length ? linesB[lineIdxB - 1] : '';
                rowsA.push({ num: lineIdxA <= linesA.length ? lineIdxA : '', text: textA, type: 'unchanged' });
                rowsB.push({ num: lineIdxB <= linesB.length ? lineIdxB : '', text: textB, type: 'unchanged' });
                lineIdxA++;
                lineIdxB++;
            }

            return { rowsA: rowsA, rowsB: rowsB };
        }

        function updateDiffStats(diffText) {
            if (!diffText || !diffText.trim()) {
                statsBadge.style.display = 'none';
                return;
            }
            const lines = diffText.split(NL);
            let added = 0;
            let removed = 0;
            for (let i = 0; i < lines.length; i++) {
                const l = lines[i];
                if (l.startsWith('+') && !l.startsWith('+++')) added++;
                else if (l.startsWith('-') && !l.startsWith('---')) removed++;
            }
            statsBadge.style.display = 'inline-block';
            statsBadge.textContent = '+' + added + ' -' + removed + ' lines';
        }

        function renderCurrentView() {
            updateDiffStats(currentRawDiff);

            if (viewMode === 'split') {
                renderSplitView();
            } else {
                renderUnifiedView();
            }
        }

        function renderDiffPlaceholder(data) {
            const fileName = data.fileName || 'File';
            const count = data.commitCount || 0;
            const latest = data.latestCommit;

            let buttonHtml = '';
            if (latest) {
                buttonHtml = '<button class="primary" id="btn-compare-latest" style="margin-top:14px; font-weight:bold; padding:8px 18px; font-size:12px;">' +
                    '<i class="codicon codicon-git-compare"></i> Compare Working Tree with Latest (' + latest.hash.substring(0, 7) + ')' +
                '</button>';
            }

            diffArea.innerHTML = '<div class="diff-empty">' +
                '<i class="codicon codicon-history" style="font-size:42px; color:var(--vscode-textLink-foreground); opacity:0.85;"></i>' +
                '<span style="font-weight:bold; font-size:15px; margin-top:10px;">' + escapeHtml(fileName) + ' &middot; History Loaded</span>' +
                '<span style="font-size:12px; opacity:0.75; max-width:440px; line-height:1.5;">' +
                    (count > 0 ? count + ' commits recorded across branches.' : 'No previous commits found.') +
                    '<br>Click any commit in the sidebar to inspect differences, or compare with latest.' +
                '</span>' +
                buttonHtml +
            '</div>';

            const btn = document.getElementById('btn-compare-latest');
            if (btn && latest) {
                btn.onclick = function() {
                    activeRefA = 'WORKING_TREE';
                    activeRefB = latest.hash;
                    selectA.value = 'WORKING_TREE';
                    selectB.value = latest.hash;
                    vscode.postMessage({ command: 'selectRefB', ref: latest.hash });
                };
            }
        }

        function renderSplitView() {
            const labelA = currentInfoA ? currentInfoA.label : activeRefA.substring(0, 7);
            const labelB = currentInfoB ? currentInfoB.label : activeRefB.substring(0, 7);

            const sideBySide = buildSideBySideDiff(currentContentA, currentContentB, currentRawDiff);
            const rowsA = sideBySide.rowsA;
            const rowsB = sideBySide.rowsB;

            diffArea.innerHTML = '' +
                '<div class="split-diff-container">' +
                    '<div class="split-pane">' +
                        '<div class="split-pane-header" style="color:#007acc"><i class="codicon codicon-circle-filled"></i> Base (A): ' + escapeHtml(labelA) + '</div>' +
                        '<div class="split-pane-content" id="split-content-a"></div>' +
                    '</div>' +
                    '<div class="split-pane">' +
                        '<div class="split-pane-header" style="color:#9b59b6"><i class="codicon codicon-circle-filled"></i> Compare (B): ' + escapeHtml(labelB) + '</div>' +
                        '<div class="split-pane-content" id="split-content-b"></div>' +
                    '</div>' +
                '</div>';

            const paneA = document.getElementById('split-content-a');
            const paneB = document.getElementById('split-content-b');

            // Non-blocking chunked line insertion
            const totalRows = rowsA.length;
            const chunkSize = 400;
            let currentIdx = 0;

            function renderNextChunk() {
                const end = Math.min(currentIdx + chunkSize, totalRows);
                let chunkHtmlA = '';
                let chunkHtmlB = '';

                for (let i = currentIdx; i < end; i++) {
                    const rA = rowsA[i];
                    const clsA = rA.type === 'removed' ? ' removed' : (rA.type === 'empty' ? ' empty-placeholder' : (rA.type === 'collapsed' ? ' header-line' : ''));
                    const numStrA = rA.num !== '' ? String(rA.num) : '&nbsp;';
                    chunkHtmlA += '<div class="diff-line' + clsA + '">' +
                        '<span class="diff-line-num">' + numStrA + '</span>' +
                        '<span class="diff-line-content">' + escapeHtml(rA.text) + '</span>' +
                        '</div>';

                    const rB = rowsB[i];
                    const clsB = rB.type === 'added' ? ' added' : (rB.type === 'empty' ? ' empty-placeholder' : (rB.type === 'collapsed' ? ' header-line' : ''));
                    const numStrB = rB.num !== '' ? String(rB.num) : '&nbsp;';
                    chunkHtmlB += '<div class="diff-line' + clsB + '">' +
                        '<span class="diff-line-num">' + numStrB + '</span>' +
                        '<span class="diff-line-content">' + escapeHtml(rB.text) + '</span>' +
                        '</div>';
                }

                if (paneA) paneA.insertAdjacentHTML('beforeend', chunkHtmlA);
                if (paneB) paneB.insertAdjacentHTML('beforeend', chunkHtmlB);

                currentIdx = end;
                if (currentIdx < totalRows) {
                    requestAnimationFrame(renderNextChunk);
                }
            }

            renderNextChunk();

            if (paneA && paneB) {
                let syncFromA = false;
                let syncFromB = false;

                paneA.onscroll = function() {
                    if (!syncFromB) {
                        syncFromA = true;
                        paneB.scrollTop = paneA.scrollTop;
                        paneB.scrollLeft = paneA.scrollLeft;
                    }
                    syncFromB = false;
                };
                paneB.onscroll = function() {
                    if (!syncFromA) {
                        syncFromB = true;
                        paneA.scrollTop = paneB.scrollTop;
                        paneA.scrollLeft = paneB.scrollLeft;
                    }
                    syncFromA = false;
                };
            }
        }

        function renderUnifiedView() {
            if (!currentRawDiff || !currentRawDiff.trim()) {
                diffArea.innerHTML = '' +
                    '<div class="diff-empty">' +
                        '<i class="codicon codicon-check" style="font-size:32px; color:#28a745"></i>' +
                        '<span style="font-weight:bold; font-size:13px;">Identical Versions</span>' +
                        '<span style="font-size:11px;">No differences detected between Base (A) and Compare (B).</span>' +
                    '</div>';
                return;
            }

            const rawLines = currentRawDiff.split(NL).map(cleanLine);
            let html = '<div class="unified-diff-content">';
            let lineNumA = 0;
            let lineNumB = 0;

            for (let i = 0; i < rawLines.length; i++) {
                const line = rawLines[i];
                const escaped = escapeHtml(line);

                if (line.startsWith('@@')) {
                    const parsed = parseHunkHeader(line);
                    if (parsed) {
                        lineNumA = parsed.startA;
                        lineNumB = parsed.startB;
                    }
                    html += '<div class="diff-line header-line"><span class="diff-line-num">...</span><span class="diff-line-content">' + escaped + '</span></div>';
                } else if (line.startsWith('+') && !line.startsWith('+++')) {
                    html += '<div class="diff-line added"><span class="diff-line-num">+' + lineNumB + '</span><span class="diff-line-content">' + escaped + '</span></div>';
                    lineNumB++;
                } else if (line.startsWith('-') && !line.startsWith('---')) {
                    html += '<div class="diff-line removed"><span class="diff-line-num">-' + lineNumA + '</span><span class="diff-line-content">' + escaped + '</span></div>';
                    lineNumA++;
                } else if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ') || line.startsWith('index ')) {
                    html += '<div class="diff-line header-line"><span class="diff-line-num">&nbsp;</span><span class="diff-line-content">' + escaped + '</span></div>';
                } else {
                    const numDisplay = lineNumA > 0 ? lineNumA : '';
                    html += '<div class="diff-line"><span class="diff-line-num">' + (numDisplay || '&nbsp;') + '</span><span class="diff-line-content">' + escaped + '</span></div>';
                    if (lineNumA > 0) lineNumA++;
                    if (lineNumB > 0) lineNumB++;
                }
            }

            html += '</div>';
            diffArea.innerHTML = html;
        }

        function buildSideBySideDiff(contentA, contentB, rawDiff) {
            const linesA = contentA.split('\\n').map(function(l) { return l.endsWith('\\r') ? l.slice(0, -1) : l; });
            const linesB = contentB.split('\\n').map(function(l) { return l.endsWith('\\r') ? l.slice(0, -1) : l; });

            if (!rawDiff || !rawDiff.trim()) {
                const max = Math.max(linesA.length, linesB.length);
                const rowsA = [];
                const rowsB = [];
                for (let i = 0; i < max; i++) {
                    const textA = i < linesA.length ? linesA[i] : '';
                    const textB = i < linesB.length ? linesB[i] : '';
                    const isIdentical = contentA === contentB;
                    rowsA.push({
                        num: i < linesA.length ? i + 1 : '',
                        text: textA,
                        type: isIdentical ? 'unchanged' : (i < linesA.length ? 'removed' : 'empty')
                    });
                    rowsB.push({
                        num: i < linesB.length ? i + 1 : '',
                        text: textB,
                        type: isIdentical ? 'unchanged' : (i < linesB.length ? 'added' : 'empty')
                    });
                }
                return { rowsA: rowsA, rowsB: rowsB };
            }

            const diffLines = rawDiff.split('\\n').map(function(l) { return l.endsWith('\\r') ? l.slice(0, -1) : l; });
            const hunks = [];
            let curHunk = null;

            for (let i = 0; i < diffLines.length; i++) {
                const line = diffLines[i];
                const match = line.match(/^@@\\s+-(\\d+)(?:,(\\d+))?\\s+\\+(\\d+)(?:,(\\d+))?\\s+@@/);
                if (match) {
                    if (curHunk) hunks.push(curHunk);
                    curHunk = {
                        startA: parseInt(match[1], 10),
                        lenA: match[2] !== undefined ? parseInt(match[2], 10) : 1,
                        startB: parseInt(match[3], 10),
                        lenB: match[4] !== undefined ? parseInt(match[4], 10) : 1,
                        lines: []
                    };
                } else if (curHunk) {
                    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ') || line.startsWith('index ')) {
                        // skip header
                    } else if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '') {
                        curHunk.lines.push(line);
                    }
                }
            }
            if (curHunk) hunks.push(curHunk);

            if (hunks.length === 0) {
                const max = Math.max(linesA.length, linesB.length);
                const rowsA = [];
                const rowsB = [];
                for (let i = 0; i < max; i++) {
                    rowsA.push({ num: i < linesA.length ? i + 1 : '', text: linesA[i] || '', type: 'unchanged' });
                    rowsB.push({ num: i < linesB.length ? i + 1 : '', text: linesB[i] || '', type: 'unchanged' });
                }
                return { rowsA: rowsA, rowsB: rowsB };
            }

            const rowsA = [];
            const rowsB = [];

            let lineIdxA = 1;
            let lineIdxB = 1;

            for (let h = 0; h < hunks.length; h++) {
                const hunk = hunks[h];

                while (lineIdxA < hunk.startA && lineIdxA <= linesA.length) {
                    const textA = linesA[lineIdxA - 1] !== undefined ? linesA[lineIdxA - 1] : '';
                    const textB = lineIdxB <= linesB.length ? linesB[lineIdxB - 1] : '';
                    rowsA.push({ num: lineIdxA, text: textA, type: 'unchanged' });
                    rowsB.push({ num: lineIdxB <= linesB.length ? lineIdxB : '', text: textB, type: 'unchanged' });
                    lineIdxA++;
                    lineIdxB++;
                }

                let curHunkIdx = 0;
                while (curHunkIdx < hunk.lines.length) {
                    const hLine = hunk.lines[curHunkIdx];
                    if (hLine.startsWith(' ')) {
                        const text = hLine.substring(1);
                        rowsA.push({ num: lineIdxA, text: linesA[lineIdxA - 1] !== undefined ? linesA[lineIdxA - 1] : text, type: 'unchanged' });
                        rowsB.push({ num: lineIdxB, text: linesB[lineIdxB - 1] !== undefined ? linesB[lineIdxB - 1] : text, type: 'unchanged' });
                        lineIdxA++;
                        lineIdxB++;
                        curHunkIdx++;
                    } else {
                        const removed = [];
                        const added = [];
                        while (curHunkIdx < hunk.lines.length && (hunk.lines[curHunkIdx].startsWith('-') || hunk.lines[curHunkIdx].startsWith('+'))) {
                            if (hunk.lines[curHunkIdx].startsWith('-')) {
                                removed.push(hunk.lines[curHunkIdx].substring(1));
                            } else if (hunk.lines[curHunkIdx].startsWith('+')) {
                                added.push(hunk.lines[curHunkIdx].substring(1));
                            }
                            curHunkIdx++;
                        }

                        const maxChange = Math.max(removed.length, added.length);
                        for (let k = 0; k < maxChange; k++) {
                            if (k < removed.length) {
                                rowsA.push({ num: lineIdxA, text: linesA[lineIdxA - 1] !== undefined ? linesA[lineIdxA - 1] : removed[k], type: 'removed' });
                                lineIdxA++;
                            } else {
                                rowsA.push({ num: '', text: '', type: 'empty' });
                            }

                            if (k < added.length) {
                                rowsB.push({ num: lineIdxB, text: linesB[lineIdxB - 1] !== undefined ? linesB[lineIdxB - 1] : added[k], type: 'added' });
                                lineIdxB++;
                            } else {
                                rowsB.push({ num: '', text: '', type: 'empty' });
                            }
                        }
                    }
                }
            }

            while (lineIdxA <= linesA.length || lineIdxB <= linesB.length) {
                const textA = lineIdxA <= linesA.length ? linesA[lineIdxA - 1] : '';
                const textB = lineIdxB <= linesB.length ? linesB[lineIdxB - 1] : '';
                rowsA.push({ num: lineIdxA <= linesA.length ? lineIdxA : '', text: textA, type: 'unchanged' });
                rowsB.push({ num: lineIdxB <= linesB.length ? lineIdxB : '', text: textB, type: 'unchanged' });
                lineIdxA++;
                lineIdxB++;
            }

            return { rowsA: rowsA, rowsB: rowsB };
        }


        // Notify extension host that webview is ready
        vscode.postMessage({ command: 'webview-ready' });
    </script>
</body>
</html>`;
    }
}

export default FileHistoryComparePanel;