import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { normalizeAiderContent } from '../utils';
import { ChatMessage } from '../lollmsAPI';

interface HistoryItem {
    id: string;
    prompt: string;
    response: string;
    timestamp: number;
}

export class CompanionPanel {
    public static currentPanel: CompanionPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _history: HistoryItem[] = [];
    private _currentHistoryIndex: number = -1;
    private _lastActiveEditor: vscode.TextEditor | undefined;
    private _isAttached: boolean = false;
    private _disposables: vscode.Disposable[] = [];

    private _onDidSubmit = new vscode.EventEmitter<string>();
    public readonly onDidSubmit = this._onDidSubmit.event;

    private _contextInfo: string = "No active context";
    private _trustScore: number = 75;
    private _preApplySnapshots: Map<string, { filePath: string; content: string }> = new Map();
    private _htmlCache: string | undefined;

    public agentManager: any;
    public discussionManager: any;
    public chatHistory: ChatMessage[] = [];

    public static createOrShow(extensionUri: vscode.Uri, title: string) {
        const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : undefined;

        if (CompanionPanel.currentPanel) {
            CompanionPanel.currentPanel._panel.reveal(column);
            CompanionPanel.currentPanel.updateTitle(title);
            return CompanionPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            'lollmsCompanion',
            title,
            column || vscode.ViewColumn.Two,
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'media'),
                    vscode.Uri.joinPath(extensionUri, 'out')
                ],
                retainContextWhenHidden: true
            }
        );

        CompanionPanel.currentPanel = new CompanionPanel(panel, extensionUri);
        return CompanionPanel.currentPanel;
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        const active = vscode.window.activeTextEditor;
        if (active && active.document.uri.scheme === 'file') {
            this._lastActiveEditor = active;
        }
        this.updateContextInfoFromEditor();

        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor && editor.document && editor.document.uri.scheme === 'file') {
                if (!this._isAttached) {
                    this._lastActiveEditor = editor;
                    this.updateContextInfoFromEditor();
                }
            }
        }, null, this._disposables);

        vscode.window.onDidChangeTextEditorSelection(e => {
            if (this._lastActiveEditor && e.textEditor && e.textEditor === this._lastActiveEditor) {
                if (!this._isAttached) {
                    this.updateContextInfoFromEditor();
                }
            }
        }, null, this._disposables);

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
        this._setWebviewMessageListener(this._panel.webview);
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const htmlPath = vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'companionPanel.html');
        const srcPath = vscode.Uri.joinPath(this._extensionUri, 'src', 'commands', 'companion', 'companionPanel.html');
        let htmlContent = "";
        try {
            if (fs.existsSync(srcPath.fsPath)) {
                htmlContent = fs.readFileSync(srcPath.fsPath, 'utf8');
                try {
                    const outDir = path.dirname(htmlPath.fsPath);
                    if (!fs.existsSync(outDir)) {
                        fs.mkdirSync(outDir, { recursive: true });
                    }
                    fs.writeFileSync(htmlPath.fsPath, htmlContent, 'utf8');
                } catch {}
            } else {
                htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf8');
            }
        } catch (err: any) {
            try {
                htmlContent = fs.readFileSync(srcPath.fsPath, 'utf8');
            } catch {
                return `<h3>Error loading Companion Panel layout. Details: ${err.message}</h3>`;
            }
        }

        const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'));
        const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'chatPanel.css'));
        const bundleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'companionPanel.bundle.js'));

        const nonce = this.getNonce();

        return htmlContent
            .replace(/\{\{cspSource\}\}/g, webview.cspSource)
            .replace(/\{\{nonce\}\}/g, `nonce="${nonce}"`)
            .replace(/\{\{codiconUri\}\}/g, codiconUri.toString())
            .replace(/\{\{cssUri\}\}/g, cssUri.toString())
            .replace(/\{\{bundleUri\}\}/g, bundleUri.toString());
    }

    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    private _setWebviewMessageListener(webview: vscode.Webview) {
            webview.onDidReceiveMessage(async (message) => {
                const folder = vscode.workspace.workspaceFolders?.[0];
                if (!folder) return;

                switch (message.command) {
                    case 'webview-ready':
                        this.setContextInfo(this._contextInfo);
                        this._panel.webview.postMessage({ command: 'updateAttachState', isAttached: this._isAttached });
                        this.updateHistoryList();
                        if (this.chatHistory && this.chatHistory.length > 0) {
                            this._panel.webview.postMessage({
                                command: 'updateChat',
                                history: this.chatHistory,
                                streamingText: ''
                            });
                        }
                        break;
                    case 'focusCode':
                        await this.focusCodeInEditor(message.code);
                        break;
                    case 'saveAndAsk':
                        await this.handleSaveAndAsk(message.messageId, message.text);
                        break;
                    case 'submitPrompt':
                        const payload = JSON.stringify({
                            text: message.text || message.query || ""
                        });
                        this._onDidSubmit.fire(payload);
                        break;
                    case 'copyToClipboard':
                        if (message.text) {
                            await vscode.env.clipboard.writeText(message.text);
                            vscode.window.setStatusBarMessage("Lollms: Copied to clipboard", 2000);
                        }
                        break;
                    case 'toggleAttach':
                        this.toggleAttach();
                        break;
                    case 'loadHistory':
                        this.loadHistoryItem(message.id);
                        break;
                    case 'deleteMessage':
                        this.deleteMessage(message.messageId);
                        break;
                    case 'deleteHistory':
                        this.deleteHistoryItem(message.id);
                        break;
                    case 'clearActiveChat':
                        this.chatHistory = [];
                        break;
                    case 'updateMessage':
                        if (message.messageId && message.newContent !== undefined) {
                            const msg = this.chatHistory.find(m => m.id === message.messageId);
                            if (msg) {
                                msg.content = message.newContent;
                            }
                            if (this._history.length > 0) {
                                const histItem = this._history.find(h => h.id === message.messageId);
                                if (histItem) {
                                    histItem.prompt = message.newContent;
                                }
                            }
                        }
                        break;
                    case 'clearHistory':
                        this._history = [];
                        this._currentHistoryIndex = -1;
                        this.chatHistory = [];
                        this.updateHistoryList();
                        this._panel.webview.postMessage({ command: 'clearResponse' });
                        break;

                    case 'applyAllChanges':
                        try {
                            const changes = message.changes || [];
                            const isUndo = message.undo === true;
                            let successCount = 0;

                            for (let i = 0; i < changes.length; i++) {
                                const c = changes[i];
                                let targetPath = c.path || c.filePath;
                                if (!targetPath && this._lastActiveEditor) {
                                    targetPath = vscode.workspace.asRelativePath(this._lastActiveEditor.document.uri);
                                }

                                const opts = {
                                    silent: true,
                                    autoSave: true,
                                    undo: isUndo,
                                    blockId: c.blockId,
                                    blockIndex: c.blockIndex,
                                    hunkIndex: c.hunkIndex
                                };

                                let res: any = null;
                                if (c.type === 'file' || c.action === 'write') {
                                    res = await vscode.commands.executeCommand('lollms-vs-coder.applyFileContent', targetPath, c.content, opts);
                                } else {
                                    const norm = normalizeAiderContent(c.content);
                                    res = await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', targetPath, norm, undefined, undefined, opts);
                                }

                                const ok = res?.success ?? false;
                                if (ok) {
                                    successCount++;
                                    await this._revealAppliedFile(targetPath);
                                }

                                this._panel.webview.postMessage({
                                    command: 'applyAllResult',
                                    success: ok,
                                    error: res?.error,
                                    blockId: c.blockId,
                                    hunkIndex: c.hunkIndex,
                                    filePath: targetPath,
                                    alreadyApplied: ok && !isUndo,
                                    undo: isUndo
                                });
                            }

                            vscode.window.setStatusBarMessage(
                                isUndo 
                                    ? `Lollms: Reverted ${successCount} patch(es)` 
                                    : `Lollms: Successfully applied ${successCount} patch(es)`,
                                3000
                            );
                        } catch (e: any) {
                            vscode.window.showErrorMessage(`Apply All failed: ${e.message}`);
                        }
                        break;
                    case 'replaceCode':
                        try {
                            let targetPath = message.filePath;
                            if (!targetPath && this._lastActiveEditor) {
                                targetPath = vscode.workspace.asRelativePath(this._lastActiveEditor.document.uri);
                            }

                            const normalizedContent = normalizeAiderContent(message.content);
                            const isUndo = message.options?.undo === true;
                            const isManual = !message.options?.silent && !isUndo;

                            const blockId = message.blockId || message.options?.blockId;
                            await this._captureSnapshot(blockId, targetPath);

                            const opts = { 
                                ...message.options, 
                                silent: !isManual, 
                                autoSave: !isManual,
                                undo: isUndo,
                                blockId: blockId
                            };

                            let res: any = await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', targetPath, normalizedContent, undefined, undefined, opts);

                            // If patch application failed, automatically trigger surgical AI self-correction with fresh disk content!
                            if (!res?.success && !isUndo) {
                                res = await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', targetPath, "REPAIR_REQUESTED", undefined, undefined, {
                                    ...opts,
                                    failingPatch: normalizedContent
                                });
                            }

                            if (res?.success ?? false) {
                                if (opts.silent || isUndo) {
                                    await this._revealAppliedFile(targetPath);
                                }
                            }

                            this._panel.webview.postMessage({
                                command: 'applyAllResult',
                                success: res?.success ?? false,
                                error: res?.error,
                                blockId: blockId,
                                hunkIndex: message.options?.hunkIndex,
                                filePath: targetPath,
                                alreadyApplied: res?.success && (opts.silent || isUndo ? !isUndo : false),
                                reviewingDiff: res?.success && isManual,
                                undo: isUndo
                            });
                        } catch (e: any) {
                            this._panel.webview.postMessage({ command: 'applyAllResult', success: false, error: e.message, blockId: message.options?.blockId || message.blockId });
                        }
                        break;
                    case 'acceptDiff':
                        try {
                            await vscode.commands.executeCommand('lollms-vs-coder.acceptDiff', message.filePath);
                            this._panel.webview.postMessage({
                                command: 'applyAllResult',
                                filePath: message.filePath,
                                blockId: message.blockId,
                                alreadyApplied: true,
                                success: true
                            });
                        } catch (e: any) {
                            vscode.window.showErrorMessage(`Failed to accept diff: ${e.message}`);
                        }
                        break;
                    case 'rejectDiff':
                        try {
                            await vscode.commands.executeCommand('lollms-vs-coder.rejectDiff', message.filePath);
                            this._panel.webview.postMessage({
                                command: 'applyAllResult',
                                filePath: message.filePath,
                                blockId: message.blockId,
                                alreadyApplied: false,
                                reviewingDiff: false,
                                success: true,
                                rejected: true
                            });
                        } catch (e: any) {
                            vscode.window.showErrorMessage(`Failed to reject diff: ${e.message}`);
                        }
                        break;
                    case 'applyFileContent':
                        try {
                            let targetPath = message.filePath;
                            if (!targetPath && this._lastActiveEditor) {
                                targetPath = vscode.workspace.asRelativePath(this._lastActiveEditor.document.uri);
                            }

                            const isManual = !message.options?.silent;
                            const blockId = message.blockId || message.options?.blockId;
                            await this._captureSnapshot(blockId, targetPath);

                            const opts = { 
                                ...message.options, 
                                silent: !isManual, 
                                autoSave: !isManual,
                                blockId: blockId
                            };

                            const res: any = await vscode.commands.executeCommand('lollms-vs-coder.applyFileContent', targetPath, message.content, opts);
                            if (res?.success ?? false) {
                                if (opts.silent) {
                                    await this._revealAppliedFile(targetPath);
                                }
                            }

                            this._panel.webview.postMessage({
                                command: 'applyAllResult',
                                success: res?.success ?? false,
                                error: res?.error,
                                blockId: blockId,
                                hunkIndex: message.options?.hunkIndex,
                                filePath: targetPath,
                                alreadyApplied: res?.success && (opts.silent ? true : res.alreadyApplied),
                                reviewingDiff: res?.success && isManual
                            });
                        } catch (e: any) {
                            this._panel.webview.postMessage({ command: 'applyAllResult', success: false, error: e.message, blockId: message.options?.blockId || message.blockId });
                        }
                        break;
                    case 'reviewDecision':
                        await this._handleReviewDecision(message.blockId, message.decision, message.filePath);
                        break;
                    case 'executeLollmsCommand':
                        const { command, params } = message.details;
                        if (command === 'lollms-vs-coder.runSparqlQueryDirectly') {
                            const result = await this.agentManager?.codeGraphManager?.executeSparql(params.query) || "SPARQL-lite Error: Graph Engine unavailable.";
                            this._panel.webview.postMessage({
                                command: 'applyAllResult',
                                messageId: params.messageId,
                                blockId: params.blockId,
                                success: !result.includes("Error"),
                                sparqlResult: result
                            });
                        } else {
                            await vscode.commands.executeCommand(command, params);
                        }
                        break;
                    case 'applyAllSteps': {
                        const { groupId, mode, steps, fromIndex = 0 } = message;
                        if (!Array.isArray(steps) || steps.length === 0) {
                            webview.postMessage({ command: 'multiStepsProgress', groupId, current: 0, total: 0, status: 'error', error: 'No steps supplied' });
                            break;
                        }
                        const ordered = [...steps].sort((a: any, b: any) => (a.number || 0) - (b.number || 0));
                        const seen = new Set<number>();
                        let duplicate: number | null = null;
                        for (const s of ordered) {
                            if (seen.has(s.number)) { duplicate = s.number; break; }
                            seen.add(s.number);
                        }
                        if (duplicate !== null) {
                            webview.postMessage({ command: 'multiStepsProgress', groupId, current: 0, total: ordered.length, status: 'error', error: `Duplicate step number ${duplicate}` });
                            break;
                        }

                        const entries: Array<{ stepNumber: number; targetPath: string; action: string; alreadyApplied: boolean }> = [];
                        let failureIndex: number | null = null;
                        let failureError = '';
                        try {
                            for (let i = fromIndex; i < ordered.length; i++) {
                                const step = ordered[i];
                                webview.postMessage({ command: 'multiStepsProgress', groupId, current: i + 1, total: ordered.length, status: 'running' });
                                try {
                                    const applied = await this._applyStepPatches(step as any, {
                                        groupId,
                                        stepIndex: i + 1,
                                        totalSteps: ordered.length,
                                        webview
                                    });
                                    for (const e of applied) {
                                        entries.push({
                                            stepNumber: step.number,
                                            targetPath: e.targetPath,
                                            action: e.action,
                                            alreadyApplied: e.alreadyApplied
                                        });
                                    }
                                    webview.postMessage({ command: 'multiStepsProgress', groupId, current: i + 1, total: ordered.length, status: 'step-ok' });
                                } catch (e: any) {
                                    failureIndex = i;
                                    failureError = e?.message || String(e);
                                    webview.postMessage({
                                        command: 'multiStepsProgress',
                                        groupId,
                                        current: i + 1,
                                        total: ordered.length,
                                        status: 'error',
                                        error: failureError,
                                        fromIndex: i
                                    });
                                    break;
                                }
                            }
                            // Labeled final list — posted on BOTH success and failure.
                            // TODO(webview): render multiStepsEntries as a step-labeled list.
                            webview.postMessage({ command: 'multiStepsEntries', groupId, entries });
                            if (failureIndex === null) {
                                webview.postMessage({ command: 'multiStepsProgress', groupId, current: ordered.length, total: ordered.length, status: 'done' });
                            }
                        } finally {
                            webview.postMessage({ command: 'setLoading', isLoading: false });
                        }
                        break;
                    }                        
                    case 'workspaceAction':
                        await this._handleWorkspaceAction(message.action, message.params);
                        break;
                    case 'runAgenticLoop':
                        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0 && this.agentManager) {
                            this._panel.webview.postMessage({ command: 'setLoading', isLoading: true });
                            try {
                                const discussion = {
                                    id: 'temp-companion-' + Date.now(),
                                    title: 'Companion Agentic Flow',
                                    messages: [],
                                    timestamp: Date.now(),
                                    groupId: null,
                                    plan: null,
                                    capabilities: this.discussionManager?.getLastCapabilities ? this.discussionManager.getLastCapabilities() : {},
                                    personalityId: 'default_coder'
                                };
                                await this.agentManager.handleUserMessage(message.objective, discussion, vscode.workspace.workspaceFolders[0]);
                            } catch (e: any) {
                                vscode.window.showErrorMessage(`Agent failed: ${e.message}`);
                            } finally {
                                this._panel.webview.postMessage({ command: 'setLoading', isLoading: false });
                            }
                        }
                        break;
                }
            }, null, this._disposables);
        }

    private async _handleWorkspaceAction(action: string, params: any) {
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) return;

            let fileUri = vscode.Uri.file(params.filePath);
            if (!path.isAbsolute(params.filePath)) {
                fileUri = vscode.Uri.joinPath(workspaceFolder.uri, params.filePath);
            }

            if (action === 'openFile' || action === 'selectCode') {
                const doc = await vscode.workspace.openTextDocument(fileUri);
                const targetColumn = this._panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
                const editor = await vscode.window.showTextDocument(doc, { viewColumn: targetColumn, preview: false });

                if ((action === 'selectCode' || action === 'focusCode') && (params.text || params.code)) {
                    await this.focusCodeInEditor(params.text || params.code);
                } else if (params.line !== undefined) {
                    const pos = new vscode.Position(Math.max(0, params.line - 1), 0);
                    editor.selection = new vscode.Selection(pos, pos);
                    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                }
            } else if (action === 'setBreakpoint') {
                const line = parseInt(params.line || "1", 10);
                const position = new vscode.Position(line - 1, 0);
                const location = new vscode.Location(fileUri, position);
                const breakpoint = new vscode.SourceBreakpoint(location);
                vscode.debug.addBreakpoints([breakpoint]);
                vscode.window.showInformationMessage(`✅ Breakpoint added to ${path.basename(params.filePath)}:${line}`);
            } else if (action === 'runScript') {
                const { runCommandInTerminal } = require('../extensionState');
                const isPy = params.filePath.endsWith('.py');
                const cmd = isPy ? `python -u "${fileUri.fsPath}"` : `node "${fileUri.fsPath}"`;

                vscode.window.showInformationMessage(`🚀 Launching script: ${path.basename(params.filePath)}`);
                const res = await runCommandInTerminal(cmd, workspaceFolder.uri.fsPath, "Companion Runner");
                this._panel.webview.postMessage({
                    command: 'appendChunk',
                    text: `\n\n### 🖥️ SCRIPT RUN RESULT:\n\`\`\`\n${res.output}\n\`\`\`\n`
                });
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Workspace operation failed: ${e.message}`);
        }
    }

    private async _revealAppliedFile(filePath: string | undefined) {
        if (!filePath) return;
        try {
            const folder = vscode.workspace.workspaceFolders?.[0];
            let uri = vscode.Uri.file(filePath);
            if (!path.isAbsolute(filePath) && folder) {
                uri = vscode.Uri.joinPath(folder.uri, filePath);
            }
            const companionColumn = this._panel.viewColumn || vscode.ViewColumn.Two;

            let targetColumn = vscode.ViewColumn.One;
            if (companionColumn === vscode.ViewColumn.One) {
                targetColumn = vscode.ViewColumn.Two;
            }

            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc, {
                viewColumn: targetColumn,
                preserveFocus: true,
                preview: false
            });
            this._lastActiveEditor = editor;
        } catch {}
    }

    private async _captureSnapshot(blockId: string | undefined, filePath: string | undefined) {
        if (!blockId || !filePath) return;
        try {
            const folder = vscode.workspace.workspaceFolders?.[0];
            let uri = vscode.Uri.file(filePath);
            if (!path.isAbsolute(filePath) && folder) {
                uri = vscode.Uri.joinPath(folder.uri, filePath);
            }
            const bytes = await vscode.workspace.fs.readFile(uri);
            this._preApplySnapshots.set(blockId, { filePath: uri.fsPath, content: Buffer.from(bytes).toString('utf8') });
        } catch {}
    }

    /**
     * Applies every <file> block found in a MultiSteps step, sequentially.
     * Halts on first failure so the outer loop can surface the failing step index.
     */
    /**
         * Applies every <file> block found in a MultiSteps step, sequentially.
         * Emits `applyAllResult` (per block) to clear per-patch-card spinners, and
         * `multiStepsEntry` (per block) to feed the step-labeled final list.
         * Halts on first failure so the outer loop can surface the failing step index.
         *
         * NOTE: hunk-parsing slowness lives in the replaceCode registry handler
         * (src/registries/fileCommands.ts) — out of scope for this panel.
         */
        private async _applyStepPatches(
            step: { number: number; targets?: string[]; instructions?: string; raw: string },
            ctx: { groupId: string; stepIndex: number; totalSteps: number; webview: vscode.Webview }
        ): Promise<Array<{ targetPath: string; action: string; alreadyApplied: boolean }>> {
            const { extractFileBlocks, parseFileTagAttributes } = require('../utils');
            const blocks = extractFileBlocks(step.raw || '');
            if (!blocks || blocks.length === 0) {
                throw new Error(`Step ${step.number}: no <file> blocks`);
            }

            const entries: Array<{ targetPath: string; action: string; alreadyApplied: boolean }> = [];

            for (let i = 0; i < blocks.length; i++) {
                const block = blocks[i];
                const attrs = parseFileTagAttributes(block.attrStr, block.rawContent);
                if (!attrs || !attrs.path) {
                    throw new Error(`Step ${step.number}: malformed <file> block (missing path)`);
                }

                const blockId = 'step' + step.number + '_b' + i;
                const action = attrs.action === 'write' ? 'write' : 'patch';
                const opts = { silent: true, autoSave: true, blockId, blockIndex: i, hunkIndex: 0 };

                let res: any;
                try {
                    if (action === 'write') {
                        res = await vscode.commands.executeCommand(
                            'lollms-vs-coder.applyFileContent',
                            attrs.path,
                            block.rawContent,
                            opts
                        );
                    } else {
                        // NOTE: hunk-parsing slowness lives in the replaceCode registry handler
                        // (src/registries/fileCommands.ts) — out of scope for this panel.
                        res = await vscode.commands.executeCommand(
                            'lollms-vs-coder.replaceCode',
                            attrs.path,
                            normalizeAiderContent(block.rawContent),
                            undefined,
                            undefined,
                            opts
                        );
                    }
                } catch (cmdErr: any) {
                    // Unblock the per-card spinner even on command throw.
                    ctx.webview.postMessage({
                        command: 'applyAllResult',
                        success: false,
                        error: cmdErr?.message || String(cmdErr),
                        blockId,
                        hunkIndex: 0,
                        filePath: attrs.path,
                        alreadyApplied: false,
                        undo: false
                    });
                    throw cmdErr;
                }

                const success = !(res && res.success === false);

                // Primary spinner unblock — same schema `applyAllChanges` uses.
                ctx.webview.postMessage({
                    command: 'applyAllResult',
                    success,
                    error: res?.error,
                    blockId,
                    hunkIndex: 0,
                    filePath: attrs.path,
                    alreadyApplied: !!res?.alreadyApplied,
                    undo: false
                });

                // Step-tagged entry for the final labeled list.
                ctx.webview.postMessage({
                    command: 'multiStepsEntry',
                    groupId: ctx.groupId,
                    stepIndex: ctx.stepIndex,
                    totalSteps: ctx.totalSteps,
                    targetPath: attrs.path,
                    action,
                    applied: success,
                    error: success ? undefined : res?.error
                });

                if (!success && !res?.alreadyApplied) {
                    throw new Error(res?.error || `Step ${step.number}: apply failed for ${attrs.path}`);
                }

                entries.push({ targetPath: attrs.path, action, alreadyApplied: !!res?.alreadyApplied });
            }

            return entries;
        }

    /**
     * Sequential-reprompt mode: synthesizes a single-step user prompt and
     * dispatches it through the same submitPrompt machinery, then applies
     * the returned <file> blocks. Recursion into applyAllSteps is forbidden.
     */
    private async _runSequentialStep(step: { targets: string[]; instructions: string; raw: string; number: number }, total: number, index: number, webview: vscode.Webview): Promise<void> {
        const targetList = (step.targets && step.targets.length > 0)
            ? step.targets.join(', ')
            : '(none specified — infer from instructions)';
        const body = step.instructions || step.raw || '';
        const synthesized =
            `[MultiSteps Apply — Step ${index + 1}/${total}]\n` +
            `Target files: ${targetList}\n` +
            `Instructions:\n${body}\n\n` +
            `Produce ONLY the code patches for this step as <file> blocks. Do not restate earlier steps.`;

        // Reuse the existing submission pipeline (same as submitPrompt case).
        const payload = JSON.stringify({ text: synthesized });
        this._onDidSubmit.fire(payload);

        // Note: the actual streamed assistant turn is handled by the orchestrator
        // listening on onDidSubmit; the applied file blocks would be captured
        // in the subsequent turn. For a fully deterministic apply in this mode,
        // the pipeline must dispatch through agentManager — left as a
        // documented seam (undo-batch snapshot also deferred).
        try {
            void webview;
        } finally {
            // Guarantee spinner clears for any future caller of sequential mode.
            webview.postMessage({ command: 'setLoading', isLoading: false });
        }
    }

    private async _handleReviewDecision(blockId: string | undefined, decision: string, filePath?: string) {
        if (!blockId) return;
        const snapshot = this._preApplySnapshots.get(blockId);
        if (decision === 'reject') {
            try {
                if (snapshot) {
                    const uri = vscode.Uri.file(snapshot.filePath);
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(snapshot.content, 'utf8'));
                    vscode.window.setStatusBarMessage("Lollms: Change reverted", 2000);
                } else if (filePath) {
                    const uri = vscode.Uri.file(filePath);
                    await vscode.workspace.fs.delete(uri);
                    vscode.window.setStatusBarMessage("Lollms: New file removed", 2000);
                }
            } catch (e: any) {
                vscode.window.showErrorMessage("Lollms: Failed to revert change - " + e.message);
            }
        }
        this._preApplySnapshots.delete(blockId);
    }

    public getActiveEditor(): vscode.TextEditor | undefined {
        if (this._lastActiveEditor && this._lastActiveEditor.document.isClosed) {
            this._lastActiveEditor = undefined;
            this.updateContextInfoFromEditor();
        }
        return this._lastActiveEditor;
    }

    public setActiveEditor(editor: vscode.TextEditor) {
        this._lastActiveEditor = editor;
        this.updateContextInfoFromEditor();
    }

    private toggleAttach() {
        this._isAttached = !this._isAttached;
        this._panel.webview.postMessage({ command: 'updateAttachState', isAttached: this._isAttached });
        
        if (!this._isAttached) {
            const active = vscode.window.activeTextEditor;
            if (active && active.document.uri.scheme === 'file') {
                this._lastActiveEditor = active;
            }
            this.updateContextInfoFromEditor();
        }
    }

    private updateContextInfoFromEditor() {
        if (!this._lastActiveEditor) {
             this.setContextInfo("No active editor");
             return;
        }
        const doc = this._lastActiveEditor.document;
        const sel = this._lastActiveEditor.selection;
        
        let info = "";
        let relPath: string | undefined;

        if (doc.uri.scheme === 'vscode-notebook-cell') {
            const notebook = vscode.window.visibleNotebookEditors.find(ne => ne.notebook.getCells().some(c => c.document === doc))?.notebook;
            relPath = notebook ? vscode.workspace.asRelativePath(notebook.uri) : undefined;
            const nbName = relPath || "Notebook Cell";
            let cellIndexStr = "";
            if (notebook) {
                const cell = notebook.getCells().find(c => c.document === doc);
                if (cell) cellIndexStr = ` (Cell ${cell.index + 1})`;
            }
            info = nbName + cellIndexStr;
        } else {
            relPath = vscode.workspace.asRelativePath(doc.uri);
            info = relPath;
        }

        if (!sel.isEmpty) {
            info += ` (Lines ${sel.start.line + 1}–${sel.end.line + 1} Selected)`;
        } else {
            info += ` (Ln ${sel.active.line + 1})`;
        }
        this.setContextInfo(info, relPath);
    }

    public async focusCodeInEditor(codeToFocus: string): Promise<boolean> {
        if (!codeToFocus || typeof codeToFocus !== 'string') return false;

        const doc = this._lastActiveEditor?.document || vscode.window.activeTextEditor?.document;
        if (!doc) {
            vscode.window.showWarningMessage("Lollms Companion: No active editor to focus code in.");
            return false;
        }

        const companionColumn = this._panel.viewColumn || vscode.ViewColumn.Two;
        let targetColumn = vscode.ViewColumn.One;
        if (companionColumn === vscode.ViewColumn.One) {
            targetColumn = vscode.ViewColumn.Two;
        }

        const editor = await vscode.window.showTextDocument(doc, {
            viewColumn: targetColumn,
            preserveFocus: false,
            preview: false
        });
        this._lastActiveEditor = editor;

        const fullText = doc.getText();
        const snippet = codeToFocus.trim();
        if (!snippet) return false;

        // 1. Exact match
        let matchIndex = fullText.indexOf(snippet);
        let matchLength = snippet.length;

        // 2. Normalized line endings match (\r\n vs \n)
        if (matchIndex === -1) {
            const normalizedDoc = fullText.replace(/\r\n/g, '\n');
            const normalizedSnippet = snippet.replace(/\r\n/g, '\n');
            const normIdx = normalizedDoc.indexOf(normalizedSnippet);
            if (normIdx !== -1) {
                const tempPos = doc.positionAt(normIdx);
                if (doc.lineAt(tempPos.line).text.includes(normalizedSnippet.split('\n')[0].trim())) {
                    matchIndex = doc.offsetAt(tempPos);
                    matchLength = normalizedSnippet.length;
                }
            }
        }

        // 3. Line-by-line trimmed match
        if (matchIndex === -1) {
            const docLines = fullText.split(/\r?\n/);
            const searchLines = snippet.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

            if (searchLines.length > 0) {
                for (let i = 0; i < docLines.length; i++) {
                    if (docLines[i].trim() === searchLines[0]) {
                        let matches = true;
                        let lineOffset = 0;
                        for (let j = 0; j < searchLines.length; j++) {
                            while (i + lineOffset < docLines.length && docLines[i + lineOffset].trim().length === 0) {
                                lineOffset++;
                            }
                            if (i + lineOffset >= docLines.length || docLines[i + lineOffset].trim() !== searchLines[j]) {
                                matches = false;
                                break;
                            }
                            lineOffset++;
                        }

                        if (matches) {
                            const startLine = i;
                            const endLine = Math.min(doc.lineCount - 1, i + Math.max(0, lineOffset - 1));
                            const startPos = doc.lineAt(startLine).range.start;
                            const endPos = doc.lineAt(endLine).range.end;
                            editor.selection = new vscode.Selection(startPos, endPos);
                            editor.revealRange(new vscode.Range(startPos, endPos), vscode.TextEditorRevealType.InCenter);
                            vscode.window.setStatusBarMessage(`Lollms: Focused on lines ${startLine + 1}–${endLine + 1} in ${path.basename(doc.uri.fsPath)}`, 3000);
                            return true;
                        }
                    }
                }
            }
        }

        if (matchIndex !== -1) {
            const startPos = doc.positionAt(matchIndex);
            const endPos = doc.positionAt(matchIndex + matchLength);
            editor.selection = new vscode.Selection(startPos, endPos);
            editor.revealRange(new vscode.Range(startPos, endPos), vscode.TextEditorRevealType.InCenter);
            vscode.window.setStatusBarMessage(`Lollms: Focused on code in ${path.basename(doc.uri.fsPath)} (Line ${startPos.line + 1})`, 3000);
            return true;
        }

        vscode.window.showInformationMessage(`Lollms Companion: Could not locate snippet to focus in ${path.basename(doc.uri.fsPath)}`);
        return false;
    }

    public async handleSaveAndAsk(messageId: string, newText: string) {
        if (!newText || typeof newText !== 'string') return;
        const cleanText = newText.trim();
        if (!cleanText) return;

        // Truncate chatHistory up to this message so the previous assistant turn is re-generated
        if (messageId && this.chatHistory && this.chatHistory.length > 0) {
            const idx = this.chatHistory.findIndex(m => m.id === messageId);
            if (idx !== -1) {
                this.chatHistory = this.chatHistory.slice(0, idx);
            } else {
                const userMatch = messageId.match(/^user_(\d+)$/);
                if (userMatch) {
                    const userIdx = parseInt(userMatch[1], 10);
                    let foundCount = 0;
                    let targetChatIdx = -1;
                    for (let i = 0; i < this.chatHistory.length; i++) {
                        if (this.chatHistory[i].role === 'user') {
                            if (foundCount === userIdx) {
                                targetChatIdx = i;
                                break;
                            }
                            foundCount++;
                        }
                    }
                    if (targetChatIdx !== -1) {
                        this.chatHistory = this.chatHistory.slice(0, targetChatIdx);
                    }
                }
            }
        }

        const payload = JSON.stringify({
            text: cleanText
        });
        this._onDidSubmit.fire(payload);
    }

    public setContextInfo(info: string, filePath?: string) {
        this._contextInfo = info;
        this._panel.webview.postMessage({ command: 'updateContextInfo', text: info, filePath });
    }

    public setLoading(isLoading: boolean) {
        this._panel.webview.postMessage({ command: 'setLoading', isLoading });
    }

    /**
     * Signals the webview that the current assistant turn has ended.
     * The orchestrator passes the assistant messages that belong to the
     * just-completed turn. The webview uses this to decide whether the
     * turn is a "multi-step turn" (>=2 messages with <file> tags) and, if
     * so, renders a single Apply-All-Steps bar at the very end of the turn.
     */
    public notifyTurnEnded(turnMessages: { text: string }[], turnId?: number) {
        this._panel.webview.postMessage({
            command: 'turnEnded',
            turnId: turnId ?? Date.now(),
            turnMessages: (turnMessages || []).map(m => ({ text: typeof m?.text === 'string' ? m.text : '' }))
        });
    }

    public updateHistoryList() {
        this._panel.webview.postMessage({ command: 'updateHistory', history: this._history });
    }

    public addHistory(prompt: string, response: string) {
        const newItem: HistoryItem = {
            id: Date.now().toString(),
            prompt,
            response,
            timestamp: Date.now()
        };
        this._history.unshift(newItem); 
        this.updateHistoryList();
    }

    public updateContent(content: string, prompt: string) {
        this._panel.webview.postMessage({ command: 'renderResponse', text: content, prompt: prompt });
    }

    public updateTitle(title: string) {
        this._panel.title = title;
    }

    private loadHistoryItem(id: string) {
        const index = this._history.findIndex(h => h.id === id);
        if (index !== -1) {
            this._currentHistoryIndex = index;
            const item = this._history[index];
            this.chatHistory = [
                { role: 'user', content: item.prompt },
                { role: 'assistant', content: item.response }
            ];
            this._panel.webview.postMessage({
                command: 'updateChat',
                history: this.chatHistory,
                streamingText: ''
            });
        }
    }

    public deleteMessage(messageId: string) {
        if (!messageId) return;
        let targetIndex = this.chatHistory.findIndex(m => m.id === messageId);
        if (targetIndex === -1) {
            const userMatch = messageId.match(/^user_(\d+)$/);
            if (userMatch) {
                const userIdx = parseInt(userMatch[1], 10);
                let foundCount = 0;
                for (let i = 0; i < this.chatHistory.length; i++) {
                    if (this.chatHistory[i].role === 'user') {
                        if (foundCount === userIdx) {
                            targetIndex = i;
                            break;
                        }
                        foundCount++;
                    }
                }
            }
            const asstMatch = messageId.match(/^assistant_companion_msg_(\d+)$/);
            if (asstMatch) {
                const asstIdx = parseInt(asstMatch[1], 10);
                let foundCount = 0;
                for (let i = 0; i < this.chatHistory.length; i++) {
                    if (this.chatHistory[i].role === 'assistant') {
                        if (foundCount === asstIdx) {
                            targetIndex = i;
                            break;
                        }
                        foundCount++;
                    }
                }
            }
            if ((messageId === 'assistant_companion_msg' || messageId === 'assistant_companion_msg_streaming') && targetIndex === -1) {
                targetIndex = this.chatHistory.findIndex(m => m.role === 'assistant');
            }
        }
        if (targetIndex !== -1) {
            this.chatHistory.splice(targetIndex, 1);
        }
        this._panel.webview.postMessage({
            command: 'updateChat',
            history: this.chatHistory,
            streamingText: ''
        });
    }

    private deleteHistoryItem(id: string) {
        this._history = this._history.filter(h => h.id !== id);
        this.updateHistoryList();
        if (this._history.length > 0) {
            this.loadHistoryItem(this._history[0].id);
        } else {
            this.chatHistory = [];
            this._panel.webview.postMessage({
                command: 'updateChat',
                history: [],
                streamingText: ''
            });
            this._panel.webview.postMessage({ command: 'clearResponse' });
        }
    }

    public dispose() {
        CompanionPanel.currentPanel = undefined;
        this._panel.dispose();
        this._onDidSubmit.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}
