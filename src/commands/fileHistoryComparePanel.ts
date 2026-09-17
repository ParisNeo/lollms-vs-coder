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
            if (!this._isWebviewReady) {
                this.loadHistory();
            }
        }, 300);
    }

    public async changeFile(folder: vscode.WorkspaceFolder, filePath: string) {
        this._currentFolder = folder;
        this._currentFilePath = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
        this._contentCache.clear();
        this._refA = 'WORKING_TREE';
        this._refB = '';
        this._panel.title = `History: ${path.basename(filePath)}`;
        await this.loadHistory();
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

    private async loadHistory() {
        this._panel.webview.postMessage({ command: 'setLoading', loading: true, status: 'Fetching history across all branches...' });

        try {
            this._commits = await this._gitIntegration.getFileHistoryAllBranches(this._currentFolder, this._currentFilePath, 250);

            // Default Version B to the most recent commit if available
            if (this._commits.length > 0) {
                if (!this._refB || this._refB === 'WORKING_TREE') {
                    this._refB = this._commits[0].hash;
                }
            } else {
                this._refB = 'WORKING_TREE';
            }

            this._panel.webview.postMessage({
                command: 'setFileDetails',
                filePath: this._currentFilePath,
                fileName: path.basename(this._currentFilePath),
                commits: this._commits,
                refA: this._refA,
                refB: this._refB
            });

            await this.updateDiffView();
        } catch (err: any) {
            Logger.error(`Failed to load history for ${this._currentFilePath}`, err);
            this._panel.webview.postMessage({ command: 'setError', error: err.message || 'Failed to read git history.' });
        } finally {
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
        this._panel.webview.postMessage({ command: 'setLoading', loading: true, status: 'Generating diff comparison...' });

        try {
            const [contentA, contentB, rawDiff] = await Promise.all([
                this.getFileContent(this._refA),
                this.getFileContent(this._refB || this._refA),
                this._gitIntegration.getFileDiffBetweenRefs(this._currentFolder, this._refA, this._refB || this._refA, this._currentFilePath)
            ]);

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
            this._panel.webview.postMessage({ command: 'setError', error: `Diff error: ${err.message}` });
        } finally {
            this._panel.webview.postMessage({ command: 'setLoading', loading: false });
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
                    await this.loadHistory();
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
                    await this.loadHistory();
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

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
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
            padding: 8px 12px;
        }
        .unified-diff-content {
            white-space: pre;
            padding: 12px;
        }
        .diff-line {
            display: flex;
            width: 100%;
            min-height: 1.4em;
        }
        .diff-line.added {
            background: var(--added-bg);
            color: var(--added-fg);
        }
        .diff-line.removed {
            background: var(--removed-bg);
            color: var(--removed-fg);
        }
        .diff-line.header-line {
            opacity: 0.6;
            font-weight: bold;
            color: #569cd6;
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
                    populateDropdowns();
                    renderCommitList();
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
            return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

                const refsBadgeHtml = commit.refs 
                    ? '<span class="ref-badge">' + escapeHtml(commit.refs.replace(/[()]/g, '')) + '</span>' 
                    : '';

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

        function updateDiffStats(diffText) {
            if (!diffText || diffText.trim() === '') {
                statsBadge.style.display = 'none';
                return;
            }
            const lines = diffText.split('\n');
            let added = 0;
            let removed = 0;
            lines.forEach(function(l) {
                if (l.startsWith('+') && !l.startsWith('+++')) added++;
                else if (l.startsWith('-') && !l.startsWith('---')) removed++;
            });
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

        function renderSplitView() {
            const labelA = currentInfoA ? currentInfoA.label : activeRefA.substring(0, 7);
            const labelB = currentInfoB ? currentInfoB.label : activeRefB.substring(0, 7);

            diffArea.innerHTML = '' +
                '<div class="split-diff-container">' +
                    '<div class="split-pane">' +
                        '<div class="split-pane-header" style="color:#007acc"><i class="codicon codicon-circle-filled"></i> Base (A): ' + escapeHtml(labelA) + '</div>' +
                        '<div class="split-pane-content" id="split-content-a">' + escapeHtml(currentContentA) + '</div>' +
                    '</div>' +
                    '<div class="split-pane">' +
                        '<div class="split-pane-header" style="color:#9b59b6"><i class="codicon codicon-circle-filled"></i> Compare (B): ' + escapeHtml(labelB) + '</div>' +
                        '<div class="split-pane-content" id="split-content-b">' + escapeHtml(currentContentB) + '</div>' +
                    '</div>' +
                '</div>';

            const paneA = document.getElementById('split-content-a');
            const paneB = document.getElementById('split-content-b');
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
            if (!currentRawDiff || currentRawDiff.trim() === '') {
                diffArea.innerHTML = '' +
                    '<div class="diff-empty">' +
                        '<i class="codicon codicon-check" style="font-size:32px; color:#28a745"></i>' +
                        '<span style="font-weight:bold; font-size:13px;">Identical Versions</span>' +
                        '<span style="font-size:11px;">No differences detected between Base (A) and Compare (B).</span>' +
                    '</div>';
                return;
            }

            const lines = currentRawDiff.split(/\r?\n/);
            let html = '<div class="unified-diff-content">';

            lines.forEach(function(line) {
                const escaped = escapeHtml(line);
                if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
                    html += '<div class="diff-line header-line">' + escaped + '</div>';
                } else if (line.startsWith('@@')) {
                    html += '<div class="diff-line header-line" style="background:rgba(86,156,214,0.1);">' + escaped + '</div>';
                } else if (line.startsWith('+')) {
                    html += '<div class="diff-line added">' + escaped + '</div>';
                } else if (line.startsWith('-')) {
                    html += '<div class="diff-line removed">' + escaped + '</div>';
                } else {
                    html += '<div class="diff-line">' + escaped + '</div>';
                }
            });

            html += '</div>';
            diffArea.innerHTML = html;
        }

        // Notify extension host that webview is ready
        vscode.postMessage({ command: 'webview-ready' });
    </script>
</body>
</html>`;
    }
}

export default FileHistoryComparePanel;