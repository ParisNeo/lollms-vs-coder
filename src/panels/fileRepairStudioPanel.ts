import * as vscode from 'vscode';
import * as path from 'path';
import { LollmsServices } from '../lollmsContext';
import { stripThinkingTags, normalizeAiderContent } from '../utils';
import { Logger } from '../logger';
import { ChatPanel } from '../commands/chatPanel/chatPanel';

export type DiagnosticCriticality = 'critical' | 'type' | 'import' | 'warning' | 'cosmetic';

export interface FileDiagnosticItem {
    id: string;
    line: number;
    character: number;
    message: string;
    severity: vscode.DiagnosticSeverity;
    criticality: DiagnosticCriticality;
    criticalityScore: number;
    source?: string;
    code?: string;
    snippet?: string;
    selected: boolean;
    isTargeted?: boolean;
    isFixed?: boolean;
    filePath?: string;
}

export class FileRepairStudioPanel {
    public static panels = new Map<string, FileRepairStudioPanel>();
    private static _mutualizedScoutingCache = new Map<string, string>();
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _services: LollmsServices;
    private _fileUri: vscode.Uri;
    private _relPath: string;
    private _isWorkspaceScope: boolean = false;
    private _workspaceFiles: { path: string; uri: vscode.Uri; count: number }[] = [];
    private _disposables: vscode.Disposable[] = [];
    private _isDisposing = false;
    private _activeAbortController: AbortController | null = null;
    private _diagnostics: FileDiagnosticItem[] = [];
    private _selectedErrorIds: Set<string> = new Set<string>();
    private _sortOrder: 'critical_to_cosmetic' | 'cosmetic_to_critical' | 'group_by_file' | 'line_asc' | 'line_desc' | 'severity' | 'alpha' = 'critical_to_cosmetic';
    private _filterQuery = '';
    private _round = 0;
    private _initialErrorLines = new Set<number>();
    private _targetedDiagnostic: { line: number; character: number; message: string; source?: string; code?: string; snippet?: string } | null = null;
    private _isTargetedSingleErrorMode: boolean = false;
    private _activeProcessId: string | null = null;
    private _customMaxRounds: number | undefined;
    private get _maxRounds(): number {
        return this._customMaxRounds ?? (vscode.workspace.getConfiguration('lollmsVsCoder').get<number>('fileRepairStudioMaxRounds', 20) || 20);
    }
    private _isRunning = false;
    private _selectedModel = '';
    private _temperature: number | undefined = 0.2;
    private _reasoningEffort: 'none' | 'low' | 'medium' | 'high' | 'max' = 'none';

    public static async createOrShow(
        extensionUri: vscode.Uri,
        services: LollmsServices,
        fileTarget?: vscode.Uri | string,
        initialErrors?: any[]
    ): Promise<FileRepairStudioPanel> {
        let targetUri: vscode.Uri | undefined;
        let isExplicitTarget = false;

        if (fileTarget instanceof vscode.Uri) {
            targetUri = fileTarget;
            isExplicitTarget = true;
        } else if (typeof fileTarget === 'string' && fileTarget.trim()) {
            const resolution = await services.contextManager.resolveWorkspaceFromPath(fileTarget.trim());
            targetUri = resolution ? resolution.uri : vscode.Uri.file(fileTarget.trim());
            isExplicitTarget = true;
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

        // Gather all workspace files that currently have diagnostics
        const allDiags = vscode.languages.getDiagnostics();
        const filesWithErrors: { uri: vscode.Uri; relPath: string; count: number }[] = [];
        if (workspaceFolder) {
            for (const [uri, diags] of allDiags) {
                const errs = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning);
                if (errs.length > 0 && uri.fsPath.startsWith(workspaceFolder.uri.fsPath)) {
                    filesWithErrors.push({
                        uri,
                        relPath: vscode.workspace.asRelativePath(uri, false),
                        count: errs.length
                    });
                }
            }
            filesWithErrors.sort((a, b) => b.count - a.count);
        }

        let openInWorkspaceMode = false;
        let shouldAutoScan = false;

        let targetHasErrors = false;
        if (targetUri) {
            const tDiags = vscode.languages.getDiagnostics(targetUri);
            targetHasErrors = tDiags.some(d => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning);
        }

        // If target was not explicitly passed, or the current open file has NO errors:
        if (!isExplicitTarget || (!targetHasErrors && (!initialErrors || initialErrors.length === 0))) {
            const activeEditor = vscode.window.activeTextEditor;
            const activeUri = (activeEditor && activeEditor.document.uri.scheme === 'file') ? activeEditor.document.uri : undefined;
            const activeHasErrors = activeUri ? vscode.languages.getDiagnostics(activeUri).some(d => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning) : false;

            if (isExplicitTarget && targetUri && targetHasErrors) {
                // Keep explicitly targeted file
            } else if (activeUri && activeHasErrors) {
                targetUri = activeUri;
            } else if (filesWithErrors.length > 0) {
                // Open file has no errors, BUT other files in the workspace have errors!
                targetUri = filesWithErrors[0].uri;
                openInWorkspaceMode = true;
            } else if (targetUri) {
                shouldAutoScan = true;
            } else if (activeUri) {
                targetUri = activeUri;
                shouldAutoScan = true;
            } else if (workspaceFolder) {
                const found = await vscode.workspace.findFiles(
                    new vscode.RelativePattern(workspaceFolder, '**/*.{ts,js,py,vue,cs,cpp,go,rs,java,html,css}'),
                    '**/{node_modules,.git,venv,.venv,out,dist}/**',
                    1
                );
                targetUri = found && found.length > 0 ? found[0] : workspaceFolder.uri;
                openInWorkspaceMode = true;
                shouldAutoScan = true;
            }
        }

        if (!targetUri) {
            throw new Error("No target file or workspace folder found for Repair Studio.");
        }

        const key = targetUri.fsPath.toLowerCase();
        const existing = FileRepairStudioPanel.panels.get(key);
        if (existing) {
            existing._panel.reveal(vscode.ViewColumn.Active);
            if (initialErrors && initialErrors.length > 0) {
                existing.setTargetedDiagnostic(initialErrors);
            }
            if (openInWorkspaceMode) {
                existing._isWorkspaceScope = true;
                existing._sortOrder = 'group_by_file';
            }
            existing.refreshDiagnosticsFromHost();
            if (shouldAutoScan) {
                existing.scanWorkspaceDiagnostics().catch(() => {});
            }
            return existing;
        }

        const fileName = path.basename(targetUri.fsPath);
        const panel = vscode.window.createWebviewPanel(
            'lollmsFileRepairStudio',
            openInWorkspaceMode ? `🛠️ Repair: Workspace` : `🛠️ Repair: ${fileName}`,
            vscode.ViewColumn.Active,
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

        panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'lollms-icon.svg');

        const instance = new FileRepairStudioPanel(panel, extensionUri, services, targetUri, initialErrors);
        if (openInWorkspaceMode) {
            instance._isWorkspaceScope = true;
            instance._sortOrder = 'group_by_file';
        }
        FileRepairStudioPanel.panels.set(key, instance);

        if (shouldAutoScan) {
            instance.scanWorkspaceDiagnostics().catch(() => {});
        }

        return instance;
    }

    public static async createOrShowWorkspaceRepair(
        extensionUri: vscode.Uri,
        services: LollmsServices
    ): Promise<FileRepairStudioPanel | undefined> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage("No workspace folder open.");
            return undefined;
        }

        const allDiags = vscode.languages.getDiagnostics();
        const filesWithErrors: { uri: vscode.Uri; relPath: string; count: number }[] = [];

        for (const [uri, diags] of allDiags) {
            const errs = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning);
            if (errs.length > 0 && uri.fsPath.startsWith(workspaceFolder.uri.fsPath)) {
                filesWithErrors.push({
                    uri,
                    relPath: vscode.workspace.asRelativePath(uri, false),
                    count: errs.length
                });
            }
        }

        let primaryUri: vscode.Uri | undefined;
        let shouldAutoScan = false;

        if (filesWithErrors.length > 0) {
            filesWithErrors.sort((a, b) => b.count - a.count);
            primaryUri = filesWithErrors[0].uri;
        } else {
            // No file currently has diagnostics in VS Code memory (e.g. unopened files)
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor && activeEditor.document.uri.scheme === 'file') {
                primaryUri = activeEditor.document.uri;
            } else {
                const found = await vscode.workspace.findFiles(
                    new vscode.RelativePattern(workspaceFolder, '**/*.{ts,js,py,vue,cs,cpp,go,rs,java,html,css}'),
                    '**/{node_modules,.git,venv,.venv,out,dist}/**',
                    1
                );
                if (found && found.length > 0) {
                    primaryUri = found[0];
                } else {
                    primaryUri = workspaceFolder.uri;
                }
            }
            shouldAutoScan = true;
        }

        if (!primaryUri) {
            vscode.window.showWarningMessage("No code files found in the workspace to repair.");
            return undefined;
        }

        const panel = await FileRepairStudioPanel.createOrShow(extensionUri, services, primaryUri);
        panel._isWorkspaceScope = true;
        panel._sortOrder = 'group_by_file';
        const normalizedFiles = filesWithErrors.map(f => ({ path: f.relPath, uri: f.uri, count: f.count }));
        panel.setWorkspaceFiles(normalizedFiles);
        await panel.refreshDiagnosticsFromHost();

        if (shouldAutoScan) {
            panel.scanWorkspaceDiagnostics().catch(() => {});
        }

        return panel;
    }

    public setWorkspaceFiles(files: { path: string; uri: vscode.Uri; count: number }[]) {
        this._workspaceFiles = files;
        this._panel.webview.postMessage({
            command: 'syncWorkspaceFiles',
            files: files.map(f => ({ path: f.path, count: f.count })),
            currentPath: this._isWorkspaceScope ? '__ALL__' : this._relPath,
            isWorkspaceScope: this._isWorkspaceScope,
            scoutCount: FileRepairStudioPanel._mutualizedScoutingCache.size
        });
    }

    public async switchFile(newRelPath: string) {
        if (this._isRunning) return;

        if (newRelPath === '__ALL__') {
            this._isWorkspaceScope = true;
            this._sortOrder = 'group_by_file';
            this._isTargetedSingleErrorMode = false;
            this._targetedDiagnostic = null;
            this._diagnostics = [];
            this._selectedErrorIds.clear();
            const wsFolder = vscode.workspace.workspaceFolders?.[0];
            this._panel.title = `🛠️ Repair: Workspace (${wsFolder ? wsFolder.name : 'All'})`;
            await this.refreshDiagnosticsFromHost();
            this.setWorkspaceFiles(this._workspaceFiles);
            return;
        }

        const res = await this._services.contextManager.resolveWorkspaceFromPath(newRelPath);
        if (!res) return;

        this._isWorkspaceScope = false;
        this._fileUri = res.uri;
        this._relPath = res.relativePath;
        this._isTargetedSingleErrorMode = false;
        this._targetedDiagnostic = null;
        this._diagnostics = [];
        this._selectedErrorIds.clear();
        this._panel.title = `🛠️ Repair: ${path.basename(this._fileUri.fsPath)}`;

        await this.refreshDiagnosticsFromHost();
        this.setWorkspaceFiles(this._workspaceFiles);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        services: LollmsServices,
        fileUri: vscode.Uri,
        initialErrors?: any[]
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._services = services;
        this._fileUri = fileUri;
        this._relPath = vscode.workspace.asRelativePath(fileUri, false);

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._setWebviewMessageListener();
        this._panel.webview.html = this._getHtmlForWebview();

        if (initialErrors && initialErrors.length > 0) {
            this.setTargetedDiagnostic(initialErrors);
        }

        // Populate diagnostics ONCE on startup
        this.refreshDiagnosticsFromHost();
    }

    public dispose() {
        if (this._isDisposing) return;
        this._isDisposing = true;
        const key = this._fileUri.fsPath.toLowerCase();
        FileRepairStudioPanel.panels.delete(key);
        if (this._activeAbortController) {
            this._activeAbortController.abort();
            this._activeAbortController = null;
        }
        if (this._activeProcessId) {
            this._services.processManager.cancel(this._activeProcessId);
            this._services.processManager.unregister(this._activeProcessId);
            this._activeProcessId = null;
        }
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
        try {
            this._panel.dispose();
        } catch {}
    }

    private categorizeDiagnostic(d: vscode.Diagnostic): { criticality: DiagnosticCriticality; score: number } {
        const msg = (d.message || '').toLowerCase();
        const codeStr = typeof d.code === 'object' ? String(d.code.value || '') : (d.code !== undefined ? String(d.code) : '');
        const isError = d.severity === vscode.DiagnosticSeverity.Error;

        // Missing imports / external environment packages (e.g. reportMissingImports like 'pytest' or unresolved packages)
        if (/reportmissingimports|reportmissingmoduleresource|cannot find module|module not found|unresolved import|impossible de résoudre l'importation/i.test(msg) || /reportmissingimports/i.test(codeStr)) {
            return { criticality: 'import', score: 50 };
        }
        if (isError && /syntax|parse|expected|unterminated|unexpected token|cannot find name|is not defined|referenceerror|invalid/i.test(msg)) {
            return { criticality: 'critical', score: 100 };
        }
        if (isError && /type|assignable|property|does not exist on type|expected \d+ argument|incompatible|signature|mismatch/i.test(msg)) {
            return { criticality: 'type', score: 80 };
        }
        if (isError && /import|require|package/i.test(msg)) {
            return { criticality: 'import', score: 60 };
        }
        if (d.severity === vscode.DiagnosticSeverity.Warning) {
            return { criticality: 'warning', score: 30 };
        }
        return { criticality: 'cosmetic', score: 20 };
    }

    public setTargetedDiagnostic(rawErrors: any[]) {
        if (!rawErrors || rawErrors.length === 0) return;
        this._isTargetedSingleErrorMode = true;
        const first = rawErrors[0];

        let line = 1;
        let character = 1;
        if (typeof first.line === 'number') {
            line = first.line;
        } else if (first.range) {
            if (first.range.start && typeof first.range.start.line === 'number') {
                line = first.range.start.line + 1;
                character = (first.range.start.character || 0) + 1;
            } else if (Array.isArray(first.range) && first.range.length > 0 && first.range[0] && typeof first.range[0].line === 'number') {
                line = first.range[0].line + 1;
                character = (first.range[0].character || 0) + 1;
            }
        }
        if (typeof first.character === 'number') {
            character = first.character;
        }

        const msg = (first.message || (typeof first === 'string' ? first : '')).trim();
        const src = first.source || '';
        const code = typeof first.code === 'object' ? String(first.code.value || '') : (first.code !== undefined ? String(first.code) : '');
        const snippet = first.snippet || '';

        this._targetedDiagnostic = {
            line,
            character,
            message: msg,
            source: src,
            code,
            snippet
        };
        this._initialErrorLines.clear();
        this._initialErrorLines.add(line);
    }

    private _matchesDiagnostic(item: { line: number; character?: number; message: string; code?: string }, d: vscode.Diagnostic): boolean {
        const dLine = d.range.start.line + 1;
        const dCode = typeof d.code === 'object' ? String(d.code.value) : (d.code !== undefined ? String(d.code) : '');

        const normItemMsg = (item.message || '').trim().toLowerCase();
        const normDMsg = (d.message || '').trim().toLowerCase();

        const msgMatch = normItemMsg.length > 0 && normDMsg.length > 0 && (
            normItemMsg === normDMsg ||
            normItemMsg.includes(normDMsg) ||
            normDMsg.includes(normItemMsg)
        );

        const codeMatch = Boolean(item.code && dCode && item.code.trim().toLowerCase() === dCode.trim().toLowerCase());

        if (dLine === item.line && (msgMatch || codeMatch)) {
            return true;
        }
        if (msgMatch && Math.abs(dLine - item.line) <= 10) {
            return true;
        }
        if (codeMatch && msgMatch && Math.abs(dLine - item.line) <= 25) {
            return true;
        }
        if (normItemMsg.length > 15 && normItemMsg === normDMsg) {
            return true;
        }
        return false;
    }


    private _getDiagnosticsForUri(targetUri: vscode.Uri): vscode.Diagnostic[] {
        const targetPath = targetUri.fsPath.toLowerCase().replace(/\\/g, '/');
        const allDiags = vscode.languages.getDiagnostics();
        for (const [uri, dList] of allDiags) {
            if (uri.fsPath.toLowerCase().replace(/\\/g, '/') === targetPath) {
                return dList;
            }
        }
        return vscode.languages.getDiagnostics(targetUri);
    }

    public async refreshDiagnosticsFromHost() {
        const wsFolder = vscode.workspace.workspaceFolders?.[0];

        // 1. Refresh workspace broken files inventory with case-insensitive matching
        if (wsFolder) {
            const { isPathBlockedFromGraph } = require('../codeGraphManager');
            const allHostDiags = vscode.languages.getDiagnostics();
            const wsMap: { path: string; uri: vscode.Uri; count: number; errorCount: number; warningCount: number }[] = [];
            const wsPathNorm = wsFolder.uri.fsPath.toLowerCase().replace(/\\/g, '/');

            for (const [u, dList] of allHostDiags) {
                const uPathNorm = u.fsPath.toLowerCase().replace(/\\/g, '/');
                if (!uPathNorm.startsWith(wsPathNorm)) continue;
                const rel = vscode.workspace.asRelativePath(u, false).replace(/\\/g, '/');
                if (isPathBlockedFromGraph(rel)) continue;

                const errs = dList.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
                const warns = dList.filter(d => d.severity === vscode.DiagnosticSeverity.Warning).length;
                const total = errs + warns;
                if (total > 0) {
                    wsMap.push({ path: rel, uri: u, count: total, errorCount: errs, warningCount: warns });
                }
            }
            this._workspaceFiles = wsMap.sort((a, b) => b.count - a.count);
        }

        // 2. WORKSPACE-WIDE SCOPE: aggregate diagnostics across all workspace files
        if (this._isWorkspaceScope && wsFolder) {
            const hostDiags = vscode.languages.getDiagnostics();
            const allItems: FileDiagnosticItem[] = [];
            const { isPathBlockedFromGraph } = require('../codeGraphManager');
            const wsPathNorm = wsFolder.uri.fsPath.toLowerCase().replace(/\\/g, '/');

            // Build fresh per-file count map to keep scope dropdown perfectly in sync
            const wsMap: { path: string; uri: vscode.Uri; count: number; errorCount: number; warningCount: number }[] = [];

            for (const [uri, dList] of hostDiags) {
                const uPathNorm = uri.fsPath.toLowerCase().replace(/\\/g, '/');
                if (!uPathNorm.startsWith(wsPathNorm)) continue;
                const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
                if (isPathBlockedFromGraph(rel)) continue;

                const fileDoc = await Promise.resolve(vscode.workspace.openTextDocument(uri)).catch(() => null);
                let fileErrs = 0;
                let fileWarns = 0;

                for (let idx = 0; idx < dList.length; idx++) {
                    const d = dList[idx];
                    if (d.severity !== vscode.DiagnosticSeverity.Error && d.severity !== vscode.DiagnosticSeverity.Warning) continue;

                    if (d.severity === vscode.DiagnosticSeverity.Error) fileErrs++;
                    else fileWarns++;

                    const cat = this.categorizeDiagnostic(d);
                    const line = d.range.start.line + 1;
                    const character = d.range.start.character + 1;
                    const snippet = fileDoc && line <= fileDoc.lineCount ? fileDoc.lineAt(line - 1).text.trim() : '';
                    const id = `diag_${rel.replace(/[^a-zA-Z0-9_]/g, '_')}_${line}_${character}_${idx}`;

                    allItems.push({
                        id,
                        line,
                        character,
                        message: d.message,
                        severity: d.severity,
                        criticality: cat.criticality,
                        criticalityScore: cat.score,
                        source: d.source || '',
                        code: typeof d.code === 'object' ? String(d.code.value) : (d.code !== undefined ? String(d.code) : ''),
                        snippet,
                        selected: true,
                        isTargeted: false,
                        isFixed: false,
                        filePath: rel
                    });
                }

                const totalForFile = fileErrs + fileWarns;
                if (totalForFile > 0) {
                    wsMap.push({ path: rel, uri, count: totalForFile, errorCount: fileErrs, warningCount: fileWarns });
                }
            }

            this._workspaceFiles = wsMap.sort((a, b) => b.count - a.count);

            if (this._round > 0 && this._diagnostics.length > 0) {
                for (const tracked of this._diagnostics) {
                    const stillExists = allItems.some(i => i.filePath === tracked.filePath && this._matchesDiagnostic(tracked, {
                        range: new vscode.Range(new vscode.Position(i.line - 1, i.character - 1), new vscode.Position(i.line - 1, i.character)),
                        message: i.message,
                        severity: i.severity,
                        code: i.code
                    } as any));

                    if (!stillExists) {
                        tracked.isFixed = true;
                        tracked.selected = false;
                        this._selectedErrorIds.delete(tracked.id);
                    } else {
                        tracked.isFixed = false;
                    }
                }
            } else {
                this._diagnostics = allItems;
            }

            // Immediately broadcast synchronized workspace files along with diagnostic items
            this._panel.webview.postMessage({
                command: 'syncWorkspaceFiles',
                files: this._workspaceFiles.map(f => ({ path: f.path, count: f.count })),
                currentPath: '__ALL__',
                isWorkspaceScope: true,
                scoutCount: FileRepairStudioPanel._mutualizedScoutingCache.size
            });

            this.applyDiagnosticItems(this._diagnostics, false, allItems.length);
            return;
        }

        // 3. SINGLE FILE SCOPE: query target file using case-insensitive lookup
        const diags = this._getDiagnosticsForUri(this._fileUri);
        const doc = await Promise.resolve(vscode.workspace.openTextDocument(this._fileUri)).catch(() => null);

        // INITIAL LOAD FOR SINGLE FILE (or when round == 0):
        if (this._diagnostics.length === 0 || this._round === 0) {
            if (this._targetedDiagnostic) {
                let matchedDiag: FileDiagnosticItem | null = null;
                for (let idx = 0; idx < diags.length; idx++) {
                    const d = diags[idx];
                    if (this._matchesDiagnostic(this._targetedDiagnostic, d)) {
                        const cat = this.categorizeDiagnostic(d);
                        const dLine = d.range.start.line + 1;
                        const dChar = d.range.start.character + 1;
                        const snippet = doc && dLine <= doc.lineCount ? doc.lineAt(dLine - 1).text.trim() : '';
                        matchedDiag = {
                            id: `diag_${dLine}_${dChar}_target`,
                            line: dLine,
                            character: dChar,
                            message: d.message,
                            severity: d.severity,
                            criticality: cat.criticality,
                            criticalityScore: 99999,
                            source: d.source || this._targetedDiagnostic.source || '',
                            code: typeof d.code === 'object' ? String(d.code.value) : (d.code !== undefined ? String(d.code) : this._targetedDiagnostic.code || ''),
                            snippet: snippet || this._targetedDiagnostic.snippet || '',
                            selected: true,
                            isTargeted: true,
                            isFixed: false,
                            filePath: this._relPath
                        };
                        break;
                    }
                }

                if (!matchedDiag) {
                    const line = this._targetedDiagnostic.line;
                    const character = this._targetedDiagnostic.character;
                    const fakeDiag = {
                        message: this._targetedDiagnostic.message,
                        severity: vscode.DiagnosticSeverity.Error
                    } as vscode.Diagnostic;
                    const cat = this.categorizeDiagnostic(fakeDiag);
                    const snippet = this._targetedDiagnostic.snippet || (doc && line <= doc.lineCount ? doc.lineAt(line - 1).text.trim() : '');

                    matchedDiag = {
                        id: `diag_${line}_${character}_target`,
                        line,
                        character,
                        message: this._targetedDiagnostic.message,
                        severity: fakeDiag.severity,
                        criticality: cat.criticality,
                        criticalityScore: 99999,
                        source: this._targetedDiagnostic.source || '',
                        code: this._targetedDiagnostic.code || '',
                        snippet,
                        selected: true,
                        isTargeted: true,
                        isFixed: false,
                        filePath: this._relPath
                    };
                }

                if (this._isTargetedSingleErrorMode && matchedDiag) {
                    this._diagnostics = [matchedDiag];
                    this._selectedErrorIds = new Set([matchedDiag.id]);
                    this.applyDiagnosticItems([matchedDiag], true, diags.length);
                    return;
                }
            }

            const items: FileDiagnosticItem[] = diags.map((d, idx) => {
                const cat = this.categorizeDiagnostic(d);
                const line = d.range.start.line + 1;
                const character = d.range.start.character + 1;
                const snippet = doc && line <= doc.lineCount ? doc.lineAt(line - 1).text.trim() : '';
                const isTarget = this._targetedDiagnostic ? this._matchesDiagnostic(this._targetedDiagnostic, d) : false;

                return {
                    id: `diag_${line}_${character}_${idx}`,
                    line,
                    character,
                    message: d.message,
                    severity: d.severity,
                    criticality: cat.criticality,
                    criticalityScore: isTarget ? 99999 : cat.score,
                    source: d.source || '',
                    code: typeof d.code === 'object' ? String(d.code.value) : (d.code !== undefined ? String(d.code) : ''),
                    snippet,
                    selected: true,
                    isTargeted: isTarget,
                    isFixed: false,
                    filePath: this._relPath
                };
            });

            this._initialErrorLines.clear();
            this.applyDiagnosticItems(items, false, diags.length);
            return;
        }

        // SUBSEQUENT ROUNDS FOR SINGLE FILE (only executed after a fix pass, round > 0):
        for (const item of this._diagnostics) {
            let matchingD: vscode.Diagnostic | null = null;
            for (const d of diags) {
                if (this._matchesDiagnostic(item, d)) {
                    matchingD = d;
                    break;
                }
            }

            if (matchingD) {
                item.isFixed = false;
                item.line = matchingD.range.start.line + 1;
                item.character = matchingD.range.start.character + 1;
                if (doc && item.line <= doc.lineCount) {
                    item.snippet = doc.lineAt(item.line - 1).text.trim();
                }
            } else {
                item.isFixed = true;
                item.selected = false;
                this._selectedErrorIds.delete(item.id);
            }
        }

        if (!this._isTargetedSingleErrorMode) {
            diags.forEach((d, idx) => {
                const alreadyTracked = this._diagnostics.some(item => this._matchesDiagnostic(item, d));
                if (!alreadyTracked) {
                    const cat = this.categorizeDiagnostic(d);
                    const line = d.range.start.line + 1;
                    const character = d.range.start.character + 1;
                    const snippet = doc && line <= doc.lineCount ? doc.lineAt(line - 1).text.trim() : '';
                    const newId = `diag_${line}_${character}_new_${idx}_${Date.now()}`;
                    const newItem: FileDiagnosticItem = {
                        id: newId,
                        line,
                        character,
                        message: d.message,
                        severity: d.severity,
                        criticality: cat.criticality,
                        criticalityScore: cat.score,
                        source: d.source || '',
                        code: typeof d.code === 'object' ? String(d.code.value) : (d.code !== undefined ? String(d.code) : ''),
                        snippet,
                        selected: true,
                        isTargeted: false,
                        isFixed: false,
                        filePath: this._relPath
                    };
                    this._diagnostics.push(newItem);
                    this._selectedErrorIds.add(newId);
                }
            });
        }

        this.applyDiagnosticItems(this._diagnostics, this._isTargetedSingleErrorMode, diags.length);
    }

    private async applyDiagnosticItems(items: FileDiagnosticItem[], isSingleErrorMode = false, hostTotalErrorsCount = items.length) {
        this._diagnostics = items;
        this._selectedErrorIds = new Set(items.filter(i => i.selected && !i.isFixed).map(i => i.id));

        const doc = await Promise.resolve(vscode.workspace.openTextDocument(this._fileUri)).catch(() => null);
        const codeText = doc ? doc.getText() : '';

        this._panel.webview.postMessage({
            command: 'syncState',
            filePath: this._isWorkspaceScope ? '__ALL__' : this._relPath,
            workspaceFiles: this._workspaceFiles.map(f => ({ path: f.path, count: f.count })),
            diagnostics: this._getSortedDiagnostics(),
            selectedCount: this._selectedErrorIds.size,
            totalCount: this._diagnostics.length,
            remainingCount: this._diagnostics.filter(d => !d.isFixed).length,
            fixedCount: this._diagnostics.filter(d => d.isFixed).length,
            hostTotalErrorsCount,
            isSingleErrorMode,
            currentCode: codeText,
            sortOrder: this._sortOrder
        });
    }

    public async updateDiagnostics(rawErrors: any[]) {
        const doc = await Promise.resolve(vscode.workspace.openTextDocument(this._fileUri)).catch(() => null);

        const items: FileDiagnosticItem[] = rawErrors.map((e, idx) => {
            const line = typeof e.line === 'number' ? e.line : (e.range ? e.range.start.line + 1 : 1);
            const character = typeof e.character === 'number' ? e.character : (e.range ? e.range.start.character + 1 : 1);
            const msg = e.message || String(e);
            const fakeDiag = {
                message: msg,
                severity: e.severity !== undefined ? e.severity : vscode.DiagnosticSeverity.Error
            } as vscode.Diagnostic;
            const cat = this.categorizeDiagnostic(fakeDiag);
            const snippet = e.snippet || (doc && line <= doc.lineCount ? doc.lineAt(line - 1).text.trim() : '');

            return {
                id: `diag_${line}_${character}_${idx}`,
                line,
                character,
                message: msg,
                severity: fakeDiag.severity,
                criticality: cat.criticality,
                criticalityScore: cat.score,
                source: e.source || '',
                code: e.code ? String(e.code) : '',
                snippet,
                selected: true,
                isFixed: false
            };
        });

        this.applyDiagnosticItems(items);
    }

    private _getSortedDiagnostics(): FileDiagnosticItem[] {
        const list = [...this._diagnostics].map(d => ({
            ...d,
            selected: this._selectedErrorIds.has(d.id) && !d.isFixed
        }));

        const q = this._filterQuery.toLowerCase().trim();
        const filtered = q
            ? list.filter(d => d.message.toLowerCase().includes(q) || (d.snippet && d.snippet.toLowerCase().includes(q)) || String(d.line).includes(q) || (d.filePath && d.filePath.toLowerCase().includes(q)))
            : list;

        return filtered.sort((a, b) => {
            if (!a.isFixed && b.isFixed) return -1;
            if (a.isFixed && !b.isFixed) return 1;

            if (this._sortOrder === 'group_by_file') {
                const fA = a.filePath || this._relPath;
                const fB = b.filePath || this._relPath;
                const fileCmp = fA.localeCompare(fB);
                if (fileCmp !== 0) return fileCmp;
                return (b.criticalityScore - a.criticalityScore) || (a.line - b.line);
            }

            if (a.isTargeted && !b.isTargeted) return -1;
            if (!a.isTargeted && b.isTargeted) return 1;

            switch (this._sortOrder) {
                case 'critical_to_cosmetic':
                    return (b.criticalityScore - a.criticalityScore) || (a.line - b.line);
                case 'cosmetic_to_critical':
                    return (a.criticalityScore - b.criticalityScore) || (a.line - b.line);
                case 'line_asc':
                    return a.line - b.line;
                case 'line_desc':
                    return b.line - a.line;
                case 'severity':
                    return a.severity - b.severity || a.line - b.line;
                case 'alpha':
                    return a.message.localeCompare(b.message);
                default:
                    return (b.criticalityScore - a.criticalityScore) || (a.line - b.line);
            }
        });
    }

    private _setWebviewMessageListener() {
        this._panel.webview.onDidReceiveMessage(async message => {
            console.log(`[FileRepairStudio:Host] Received command from webview: ${message.command}`, message);

            switch (message.command) {
                case 'diagnosticLog': {
                    console.error(`[FileRepairStudio:WebviewDiagnostic] ${message.level || 'ERROR'}: ${message.message}`, message.details || '');
                    Logger.error(`[FileRepairStudio:WebviewDiagnostic] ${message.message}`);
                    break;
                }
                case 'ready': {
                    console.log(`[FileRepairStudio:Host] 'ready' received for file: ${this._relPath}`);
                    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
                    let defaultModel = (this._selectedModel || '').trim()
                        || ChatPanel.currentPanel?.getCurrentDiscussion()?.model
                        || config.get<string>('surgicalModelName')
                        || this._services.lollmsAPI.getModelName()
                        || config.get<string>('modelName')
                        || '';

                    let models: any[] = [];
                    try {
                        console.log(`[FileRepairStudio:Host] Fetching models...`);
                        models = await this._services.lollmsAPI.getModels(false);
                        if (!models || models.length === 0) {
                            models = await this._services.lollmsAPI.getModels(true);
                        }
                        console.log(`[FileRepairStudio:Host] Found ${models?.length || 0} models.`);
                    } catch (err: any) {
                        Logger.warn(`[FileRepairStudioPanel] getModels failed: ${err.message}`);
                    }

                    const knownCandidates = new Set<string>();
                    if (defaultModel) knownCandidates.add(defaultModel);
                    const cfgModel = config.get<string>('modelName');
                    if (cfgModel) knownCandidates.add(cfgModel);
                    const surgModel = config.get<string>('surgicalModelName');
                    if (surgModel) knownCandidates.add(surgModel);

                    const modelPool = config.get<any[]>('herdDynamicModelPool') || [];
                    modelPool.forEach((m: any) => {
                        const id = typeof m === 'string' ? m : m?.model;
                        if (id) knownCandidates.add(id);
                    });

                    if (!models) models = [];
                    for (const candidate of knownCandidates) {
                        if (candidate && !models.some(m => m.id === candidate || m.name === candidate)) {
                            models.push({ id: candidate, name: candidate });
                        }
                    }

                    if (!defaultModel && models.length > 0) {
                        defaultModel = models[0].id;
                    }
                    this._selectedModel = defaultModel;

                    console.log(`[FileRepairStudio:Host] Sending initData with filePath="${this._relPath}", ${this._workspaceFiles.length} workspace files...`);
                    this._panel.webview.postMessage({
                        command: 'initData',
                        filePath: this._isWorkspaceScope ? '__ALL__' : this._relPath,
                        workspaceFiles: this._workspaceFiles.map(f => ({ path: f.path, count: f.count })),
                        scoutCount: FileRepairStudioPanel._mutualizedScoutingCache.size,
                        models,
                        selectedModel: defaultModel,
                        temperature: this._temperature,
                        reasoningEffort: this._reasoningEffort,
                        maxRounds: this._maxRounds
                    });
                    console.log(`[FileRepairStudio:Host] Dispatched initData. Now calling refreshDiagnosticsFromHost()...`);
                    this.refreshDiagnosticsFromHost().catch(err => {
                        console.error(`[FileRepairStudio:Host] refreshDiagnosticsFromHost failed:`, err);
                    });
                    break;
                }
                case 'switchFile': {
                    if (message.filePath) {
                        await this.switchFile(message.filePath);
                    }
                    break;
                }
                case 'clearMutualizedScouting': {
                    FileRepairStudioPanel._mutualizedScoutingCache.clear();
                    this._panel.webview.postMessage({
                        command: 'syncWorkspaceFiles',
                        files: this._workspaceFiles.map(f => ({ path: f.path, count: f.count })),
                        currentPath: this._relPath,
                        scoutCount: 0
                    });
                    vscode.window.showInformationMessage("🧹 Mutualized scouting pool cleared.");
                    break;
                }
                case 'runWorkspaceRepair': {
                    if (message.model) this._selectedModel = message.model;
                    if (message.temperature !== undefined) this._temperature = message.temperature;
                    if (message.reasoningEffort) this._reasoningEffort = message.reasoningEffort;
                    await this.runWorkspaceRepair();
                    break;
                }
                case 'refreshModels': {
                    try {
                        const freshModels = await this._services.lollmsAPI.getModels(true);
                        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
                        const defaultModel = this._selectedModel || this._services.lollmsAPI.getModelName() || config.get<string>('modelName') || '';
                        this._panel.webview.postMessage({
                            command: 'updateModels',
                            models: freshModels,
                            selectedModel: defaultModel
                        });
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to refresh models: ${e.message}`);
                    }
                    break;
                }
                case 'toggleErrorSelection': {
                    const id = message.id;
                    if (message.forceState !== undefined) {
                        if (message.forceState) this._selectedErrorIds.add(id);
                        else this._selectedErrorIds.delete(id);
                    } else {
                        if (this._selectedErrorIds.has(id)) {
                            this._selectedErrorIds.delete(id);
                        } else {
                            this._selectedErrorIds.add(id);
                        }
                    }
                    this._panel.webview.postMessage({
                        command: 'updateDiagnosticsList',
                        diagnostics: this._getSortedDiagnostics(),
                        selectedCount: this._selectedErrorIds.size,
                        totalCount: this._diagnostics.length
                    });
                    break;
                }
                case 'selectAllErrors': {
                    this._selectedErrorIds = new Set(this._diagnostics.filter(d => !d.isFixed).map(d => d.id));
                    this._panel.webview.postMessage({
                        command: 'updateDiagnosticsList',
                        diagnostics: this._getSortedDiagnostics(),
                        selectedCount: this._selectedErrorIds.size,
                        totalCount: this._diagnostics.length
                    });
                    break;
                }
                case 'deselectAllErrors': {
                    this._selectedErrorIds.clear();
                    this._panel.webview.postMessage({
                        command: 'updateDiagnosticsList',
                        diagnostics: this._getSortedDiagnostics(),
                        selectedCount: this._selectedErrorIds.size,
                        totalCount: this._diagnostics.length
                    });
                    break;
                }
                case 'invertErrorSelection': {
                    const next = new Set<string>();
                    for (const d of this._diagnostics) {
                        if (!d.isFixed && !this._selectedErrorIds.has(d.id)) next.add(d.id);
                    }
                    this._selectedErrorIds = next;
                    this._panel.webview.postMessage({
                        command: 'updateDiagnosticsList',
                        diagnostics: this._getSortedDiagnostics(),
                        selectedCount: this._selectedErrorIds.size,
                        totalCount: this._diagnostics.length
                    });
                    break;
                }
                case 'selectOnlyCritical': {
                    this._selectedErrorIds = new Set(
                        this._diagnostics.filter(d => !d.isFixed && d.criticality === 'critical').map(d => d.id)
                    );
                    this._panel.webview.postMessage({
                        command: 'updateDiagnosticsList',
                        diagnostics: this._getSortedDiagnostics(),
                        selectedCount: this._selectedErrorIds.size,
                        totalCount: this._diagnostics.length
                    });
                    break;
                }
                case 'selectOnlyTypes': {
                    this._selectedErrorIds = new Set(
                        this._diagnostics.filter(d => !d.isFixed && d.criticality === 'type').map(d => d.id)
                    );
                    this._panel.webview.postMessage({
                        command: 'updateDiagnosticsList',
                        diagnostics: this._getSortedDiagnostics(),
                        selectedCount: this._selectedErrorIds.size,
                        totalCount: this._diagnostics.length
                    });
                    break;
                }
                case 'selectOnlyImports': {
                    this._selectedErrorIds = new Set(
                        this._diagnostics.filter(d => !d.isFixed && d.criticality === 'import').map(d => d.id)
                    );
                    this._panel.webview.postMessage({
                        command: 'updateDiagnosticsList',
                        diagnostics: this._getSortedDiagnostics(),
                        selectedCount: this._selectedErrorIds.size,
                        totalCount: this._diagnostics.length
                    });
                    break;
                }
                case 'selectOnlyWarnings': {
                    this._selectedErrorIds = new Set(
                        this._diagnostics.filter(d => !d.isFixed && (d.criticality === 'warning' || d.severity === vscode.DiagnosticSeverity.Warning)).map(d => d.id)
                    );
                    this._panel.webview.postMessage({
                        command: 'updateDiagnosticsList',
                        diagnostics: this._getSortedDiagnostics(),
                        selectedCount: this._selectedErrorIds.size,
                        totalCount: this._diagnostics.length
                    });
                    break;
                }
                case 'changeSortOrder': {
                    this._sortOrder = message.sortOrder;
                    this._panel.webview.postMessage({
                        command: 'updateDiagnosticsList',
                        diagnostics: this._getSortedDiagnostics(),
                        selectedCount: this._selectedErrorIds.size,
                        totalCount: this._diagnostics.length,
                        sortOrder: this._sortOrder
                    });
                    break;
                }
                case 'filterErrors': {
                    this._filterQuery = message.query || '';
                    this._panel.webview.postMessage({
                        command: 'updateDiagnosticsList',
                        diagnostics: this._getSortedDiagnostics(),
                        selectedCount: this._selectedErrorIds.size,
                        totalCount: this._diagnostics.length
                    });
                    break;
                }
                case 'updateSettings': {
                    if (message.model) this._selectedModel = message.model;
                    if (message.temperature !== undefined) this._temperature = message.temperature;
                    if (message.reasoningEffort) this._reasoningEffort = message.reasoningEffort;
                    if (message.maxRounds !== undefined) {
                        const val = parseInt(message.maxRounds, 10);
                        if (!isNaN(val) && val > 0) this._customMaxRounds = val;
                    }
                    break;
                }
                case 'updateSelectedIds': {
                    if (Array.isArray(message.ids)) {
                        this._selectedErrorIds = new Set(message.ids);
                    }
                    break;
                }
                case 'runRepair': {
                    if (message.model) this._selectedModel = message.model;
                    if (message.temperature !== undefined) this._temperature = message.temperature;
                    if (message.reasoningEffort) this._reasoningEffort = message.reasoningEffort;
                    if (message.maxRounds !== undefined) {
                        const val = parseInt(message.maxRounds, 10);
                        if (!isNaN(val) && val > 0) this._customMaxRounds = val;
                    }
                    if (message.selectedIds && Array.isArray(message.selectedIds) && message.selectedIds.length > 0) {
                        this._selectedErrorIds = new Set(message.selectedIds);
                    }
                    await this.runRepairPass(message.prompt);
                    break;
                }
                case 'stopRepair': {
                    this._isRunning = false;
                    if (this._activeAbortController) {
                        this._activeAbortController.abort();
                        this._activeAbortController = null;
                    }
                    if (this._activeProcessId) {
                        this._services.processManager.cancel(this._activeProcessId);
                        this._services.processManager.unregister(this._activeProcessId);
                        this._activeProcessId = null;
                    }
                    this._panel.webview.postMessage({ command: 'repairStopped' });
                    break;
                }
                case 'showAllFileErrors': {
                    this._isTargetedSingleErrorMode = false;
                    await this.refreshDiagnosticsFromHost();
                    break;
                }
                case 'showOnlyTargetedError': {
                    if (this._targetedDiagnostic) {
                        this._isTargetedSingleErrorMode = true;
                        await this.refreshDiagnosticsFromHost();
                    }
                    break;
                }
                case 'copyToClipboard': {
                    if (message.text) {
                        await vscode.env.clipboard.writeText(message.text);
                        vscode.window.setStatusBarMessage("Lollms: Error copied to clipboard", 2500);
                    }
                    break;
                }
                case 'scanWorkspace': {
                    await this.scanWorkspaceDiagnostics();
                    break;
                }
                case 'rescan': {
                    await this.refreshDiagnosticsFromHost();
                    const rem = this._diagnostics.filter(d => !d.isFixed).length;
                    const fix = this._diagnostics.filter(d => d.isFixed).length;
                    vscode.window.showInformationMessage(`Diagnostics re-scanned: ${rem} error(s) remaining, ${fix} fixed.`);
                    break;
                }
                case 'requestWorkspaceGroupedErrors': {
                    const wsFolder = vscode.workspace.workspaceFolders?.[0];
                    const groups: { file: string; diagnostics: FileDiagnosticItem[] }[] = [];
                    if (wsFolder) {
                        const { isPathBlockedFromGraph } = require('../codeGraphManager');
                        const hostDiags = vscode.languages.getDiagnostics();
                        for (const [uri, dList] of hostDiags) {
                            const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
                            if (isPathBlockedFromGraph(rel) || !uri.fsPath.startsWith(wsFolder.uri.fsPath)) continue;

                            const errs = dList
                                .filter(d => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning)
                                .map((d, idx) => {
                                    const cat = this.categorizeDiagnostic(d);
                                    const line = d.range.start.line + 1;
                                    const character = d.range.start.character + 1;
                                    return {
                                        id: `diag_${rel.replace(/[^a-zA-Z0-9_]/g, '_')}_${line}_${character}_${idx}`,
                                        line,
                                        character,
                                        message: d.message,
                                        severity: d.severity,
                                        criticality: cat.criticality,
                                        criticalityScore: cat.score,
                                        source: d.source || '',
                                        code: typeof d.code === 'object' ? String(d.code.value) : (d.code !== undefined ? String(d.code) : ''),
                                        selected: true,
                                        isTargeted: false,
                                        isFixed: false
                                    };
                                });

                            if (errs.length > 0) {
                                groups.push({ file: rel, diagnostics: errs });
                            }
                        }
                    }
                    this._panel.webview.postMessage({
                        command: 'workspaceGroupedErrorsResult',
                        groups
                    });
                    break;
                }
                case 'acceptAndClose': {
                    const remainingCount = this._diagnostics.filter(d => !d.isFixed).length;
                    const fixedCount = this._diagnostics.filter(d => d.isFixed).length;
                    const summaryMsg = fixedCount > 0 
                        ? `✅ Accepted current file state for ${path.basename(this._fileUri.fsPath)} (${fixedCount} error(s) fixed, ${remainingCount} remaining).`
                        : `✅ Accepted current file state for ${path.basename(this._fileUri.fsPath)} (${remainingCount} errors remaining).`;
                    vscode.window.showInformationMessage(summaryMsg);

                    this.dispose();

                    try {
                        const doc = await vscode.workspace.openTextDocument(this._fileUri);
                        await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
                    } catch (e: any) {
                        Logger.warn(`Failed to open updated file on accept: ${e.message}`);
                    }
                    break;
                }
                case 'revealLineInEditor': {
                    const line = parseInt(message.line, 10);
                    if (!isNaN(line) && line > 0) {
                        const doc = await vscode.workspace.openTextDocument(this._fileUri);
                        const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
                        const pos = new vscode.Position(line - 1, 0);
                        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                    }
                    break;
                }
            }
        }, null, this._disposables);
    }

    private async runRepairPass(userPromptHint?: string) {
        if (this._isRunning) return;

        let targetErrors = this._diagnostics.filter(d => !d.isFixed && this._selectedErrorIds.has(d.id));
        if (targetErrors.length === 0 && this._diagnostics.some(d => !d.isFixed)) {
            const unfixed = this._diagnostics.filter(d => !d.isFixed);
            this._selectedErrorIds = new Set(unfixed.map(d => d.id));
            targetErrors = [...unfixed];
        }

        if (targetErrors.length === 0) {
            const fixedCount = this._diagnostics.filter(d => d.isFixed).length;
            const message = fixedCount > 0 
                ? `All spotted errors are already fixed (${fixedCount} resolved). File is clean!` 
                : "No diagnostic errors detected in this file. File is clean!";
            vscode.window.showInformationMessage(message);
            this._isRunning = false;
            this._panel.webview.postMessage({ command: 'repairStopped' });
            return;
        }

        // Prioritize highest criticality errors first (critical > type > import > warning > cosmetic)
        targetErrors.sort((a, b) => (b.criticalityScore - a.criticalityScore) || (a.line - b.line));

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const activeModel = (this._selectedModel || '').trim() 
            || ChatPanel.currentPanel?.getCurrentDiscussion()?.model 
            || config.get<string>('surgicalModelName')
            || this._services.lollmsAPI.getModelName()
            || config.get<string>('modelName')
            || 'default';

        this._isRunning = true;
        this._round++;
        this._activeAbortController = new AbortController();
        const signal = this._activeAbortController.signal;

        // Register with ProcessManager so active pass appears in the Active Processes view
        const fileName = path.basename(this._fileUri.fsPath);
        const proc = this._services.processManager.register(
            this._relPath,
            `Repairing ${fileName} (Round ${this._round}/${this._maxRounds}): ${targetErrors.length} error(s)...`
        );
        const processId = proc.id;
        this._activeProcessId = processId;
        proc.controller.signal.addEventListener('abort', () => {
            if (this._activeAbortController) {
                this._activeAbortController.abort();
            }
            this._isRunning = false;
            this._panel.webview.postMessage({ command: 'repairStopped' });
        });

        this._panel.webview.postMessage({
            command: 'repairStarted',
            round: this._round,
            maxRounds: this._maxRounds,
            targetCount: targetErrors.length,
            model: activeModel
        });

        try {
            this._services.processManager.updateDescription(processId, `Checking server connection for ${activeModel}...`);

            // Probe connection with 3.5s timeout before long prompt evaluation
            const probe = await this._services.lollmsAPI.pingServer(3500, activeModel);
            if (!probe.online && !signal.aborted) {
                const serverUrl = this._services.lollmsAPI.resolveBindingForModel(activeModel).binding.apiUrl;
                throw new Error(`Cannot reach AI server at ${serverUrl} (${probe.error || 'Connection refused'}). Please verify your backend server is online.`);
            }

            // Read ground-truth current file content directly from disk
            const doc = await vscode.workspace.openTextDocument(this._fileUri);
            const currentContent = doc.getText();
            const docLang = doc.languageId;

            const isPy = docLang === 'python';
            const langRule = isPy
                ? "This is Python code. Ensure exact indentation (spaces vs tabs) strictly matches the file nesting."
                : `Target language is ${docLang}. Ensure valid syntax, brackets, and complete imports.`;

            const systemPrompt = `You are the Senior Linter & Diagnostic Repair Architect (Guardian Protocol).
Your task is to fix the SELECTED compiler/linter errors in the target file \`${this._relPath}\`.

You are provided with:
1. The error details and a surrounding code context window (lines before and after each error with a \`->\` pointer).
2. The complete, ground-truth code of \`${this._relPath}\` currently on disk.

### 🛡️ STRICT REPAIR CONSTITUTION:
1. **SINGLE-FILE EDITING BOUNDARY (MANDATORY)**:
   - You can ONLY modify the target file: \`${this._relPath}\`.
   - You are **STRICTLY FORBIDDEN** from modifying or outputting patches for any other file.
   - All code patches must apply directly to \`${this._relPath}\` to make it clean and functional.
2. ${langRule}
3. **DO NOT COUNT LINES**:
   - The error reports provide the exact code context window around the issue. Use those lines and the full file content below directly.
   - Never waste tokens counting lines from 1 to N.
4. **READ-ONLY SCOUTING OF OTHER FILES**:
   You can scout other files to inspect signatures, imports, types, or contracts:
   - \`<peek_files path="path/to/other.ts" lines="30" from="top" />\`
   - \`<grep pattern="symbolName" path="src" />\`
   - \`<show_symbol target="path/to/other.ts:SymbolName" />\`
   - \`<read_full_file path="path/to/other.ts" />\`
   All scouting operations are strictly read-only.
5. **EXTERNAL ROOT-CAUSE PROTOCOL**:
   If an error fundamentally stems from another file (e.g. a missing export, wrong return type, or missing definition in another module that cannot or should not be solved in \`${this._relPath}\`):
   - First, make \`${this._relPath}\` as safe and clean as possible locally (e.g., safe fallback, type cast, or defensive guard).
   - Then, clearly explain that the root cause belongs to the external file.
   - Provide a complete, ready-to-copy prompt formatted in a dedicated section that the user can paste directly into a regular Lollms Discussion to fix the external file:
     ### 📋 PROPOSED PROMPT FOR MAIN DISCUSSION:
     \`\`\`markdown
     [Clear prompt specifying the external file path, the exact error caused here, and the needed fix]
     \`\`\`
6. **SURGICAL CODE DELIVERY**:
   Deliver your fixes to \`${this._relPath}\` using very short, focused AIDER SEARCH/REPLACE blocks (1-5 lines of change):
   \`\`\`${docLang}:${this._relPath}
   <<<<<<< SEARCH
   [exact lines currently on disk]
   =======
   [corrected lines]
   >>>>>>> REPLACE
   \`\`\`
   Or wrap in \`<file path="${this._relPath}" action="patch">...</file>\`.
7. Conclude with a brief 1-2 sentence explanation of your solution.`;

            // Helper to extract surrounding code lines around an error line
            const getContextWindow = (document: vscode.TextDocument, errorLine: number, windowSize: number = 6): string => {
                const totalLines = document.lineCount;
                const startLine = Math.max(1, errorLine - windowSize);
                const endLine = Math.min(totalLines, errorLine + windowSize);
                const lines: string[] = [];

                for (let l = startLine; l <= endLine; l++) {
                    const text = document.lineAt(l - 1).text;
                    const isErrorLine = (l === errorLine);
                    const prefix = isErrorLine ? '-> ' : '   ';
                    const lineNumStr = String(l).padStart(4, ' ');
                    lines.push(`${prefix}${lineNumStr} | ${text}`);
                }
                return lines.join('\n');
            };

            const MAX_ERRORS_PER_ROUND = 25;
            const currentBatchErrors = targetErrors.slice(0, MAX_ERRORS_PER_ROUND);
            const remainingCount = targetErrors.length - currentBatchErrors.length;

            const errorReportLines = currentBatchErrors.map((e, idx) => {
                const src = e.source ? ` [${e.source}]` : '';
                const windowText = getContextWindow(doc, e.line, 5);
                const startL = Math.max(1, e.line - 5);
                const endL = Math.min(doc.lineCount, e.line + 5);

                return `${idx + 1}. [Line ${e.line}:${e.character}]${src} (${e.criticality.toUpperCase()}) ${e.message}\n   Context around issue (lines ${startL}–${endL}):\n   \`\`\`${docLang}\n${windowText}\n   \`\`\``;
            }).join('\n\n') + (remainingCount > 0 ? `\n\n*(Focusing on top ${currentBatchErrors.length} most critical errors in this pass; remaining ${remainingCount} will be resolved next round)*` : '');

            let mutualizedScoutingText = "";
            if (FileRepairStudioPanel._mutualizedScoutingCache.size > 0) {
                const entries = Array.from(FileRepairStudioPanel._mutualizedScoutingCache.entries()).slice(0, 8);
                mutualizedScoutingText = `\n### 🌐 MUTUALIZED SCOUTING POOL (SHARED KNOWLEDGE FROM WORKSPACE):\n` +
                    entries.map(([k, v]) => `#### \`${k}\`:\n\`\`\`\n${v.substring(0, 1500)}\n\`\`\``).join('\n\n') + '\n';
            }

            const userPrompt = `### 🔍 COMPILER / LINTER ERRORS & CONTEXT IN \`${this._relPath}\` (Round ${this._round}):
${errorReportLines}

${userPromptHint ? `### 👤 USER INSTRUCTIONS / HINTS:\n"${userPromptHint}"\n` : ''}
${mutualizedScoutingText}
> 🎯 **TARGET FILE ONLY**: You must only generate code modifications for \`${this._relPath}\`. If another file needs modification, propose it as a discussion prompt.

### 📄 FULL GROUND-TRUTH CONTENT ON DISK (\`${this._relPath}\`):
\`\`\`${docLang}
${currentContent}
\`\`\`

Generate the surgical fix for \`${this._relPath}\`.`;

            const conversation: any[] = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ];

            let turnStreamBuffer = "";
            let maxInternalTurns = 4;
            let finalCleanResponse = "";
            let lastPostTime = 0;
            const THROTTLE_MS = 80;

            while (maxInternalTurns > 0) {
                if (signal.aborted || !this._isRunning) {
                    this._isRunning = false;
                    this._panel.webview.postMessage({ command: 'repairStopped' });
                    return;
                }
                maxInternalTurns--;
                turnStreamBuffer = "";
                lastPostTime = 0;

                this._services.processManager.updateDescription(processId, `Drafting surgical patch for ${fileName} (${activeModel})...`);

                const response = await this._services.lollmsAPI.sendChat(
                    conversation,
                    chunk => {
                        if (signal.aborted || !this._isRunning) return;
                        turnStreamBuffer += chunk;
                        const now = Date.now();
                        if (now - lastPostTime >= THROTTLE_MS) {
                            lastPostTime = now;
                            this._panel.webview.postMessage({
                                command: 'repairStreamChunk',
                                chunk,
                                fullText: turnStreamBuffer,
                                round: this._round
                            });
                        }
                    },
                    signal,
                    activeModel,
                    {
                        thinking: this._reasoningEffort !== 'none',
                        reasoningEffort: this._reasoningEffort,
                        temperature: this._temperature
                    }
                );

                // Flush final complete buffer of this turn
                this._panel.webview.postMessage({
                    command: 'repairStreamChunk',
                    chunk: '',
                    fullText: turnStreamBuffer,
                    round: this._round
                });

                if (signal.aborted || !this._isRunning) {
                    this._isRunning = false;
                    this._panel.webview.postMessage({ command: 'repairStopped' });
                    return;
                }

                finalCleanResponse = stripThinkingTags(response).trim();

                // Check for discovery tool execution on other files
                const peekMatch = finalCleanResponse.match(/<peek_files\b([^>]*?)>([\s\S]*?)<\/peek_files>/i) ||
                                  finalCleanResponse.match(/<peek_files\s+([^>]*?)\/>/i);
                const grepMatch = finalCleanResponse.match(/<grep\b([^>]*?)(?:\/>|>([\s\S]*?)<\/grep>)/i);
                const symMatch = finalCleanResponse.match(/<(?:show_symbol|get_symbol_code|read_symbol)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:show_symbol|get_symbol_code|read_symbol)>)/i);
                const readMatch = finalCleanResponse.match(/<(?:read_full_file|read_file)\b[^>]*path=["']([^"']+)["'][^>]*\/>/i);

                if (symMatch) {
                    const attrStr = symMatch[1] || "";
                    const targetMatch = attrStr.match(/target=["']([^"']+)["']/i);
                    const pathMatch = attrStr.match(/path=["']([^"']+)["']/i);
                    const symParam = attrStr.match(/symbol=["']([^"']+)["']/i);
                    const rawTarget = targetMatch ? targetMatch[1].trim() : (pathMatch ? pathMatch[1].trim() : "");
                    const rawSym = symParam ? symParam[1].trim() : "";

                    const { showSymbolTool } = require('../tools/builtins/showSymbol');
                    const toolRes = await showSymbolTool.execute(
                        { target: rawTarget, symbol: rawSym },
                        { contextManager: this._services.contextManager, lollmsApi: this._services.lollmsAPI, workspaceRoot: vscode.workspace.workspaceFolders?.[0], currentPlan: null },
                        signal
                    );

                    FileRepairStudioPanel._mutualizedScoutingCache.set(`${rawTarget}:${rawSym}`, toolRes.output);

                    this._panel.webview.postMessage({
                        command: 'toolExecuted',
                        tool: 'show_symbol',
                        output: toolRes.output
                    });

                    conversation.push({ role: 'assistant', content: finalCleanResponse });
                    conversation.push({ role: 'user', content: `Tool Observation:\n${toolRes.output}\n\nNow deliver your surgical patch for ${this._relPath}.` });
                    continue;
                }

                if (readMatch) {
                    const reqPath = readMatch[1].trim();
                    const res = await this._services.contextManager.resolveWorkspaceFromPath(reqPath);
                    let readOutput = `(Could not read ${reqPath})`;
                    if (res) {
                        try {
                            const bytes = await vscode.workspace.fs.readFile(res.uri);
                            readOutput = Buffer.from(bytes).toString('utf8');
                            FileRepairStudioPanel._mutualizedScoutingCache.set(reqPath, readOutput);
                        } catch (e: any) {
                            readOutput = `Error: ${e.message}`;
                        }
                    }

                    this._panel.webview.postMessage({
                        command: 'toolExecuted',
                        tool: 'read_full_file',
                        output: readOutput.slice(0, 500)
                    });

                    conversation.push({ role: 'assistant', content: finalCleanResponse });
                    conversation.push({ role: 'user', content: `Tool Observation for ${reqPath}:\n\`\`\`\n${readOutput.slice(0, 10000)}\n\`\`\`\n\nDeliver the surgical patch for ${this._relPath}.` });
                    continue;
                }

                if (peekMatch) {
                    const attrStr = peekMatch[1] || "";
                    const inner = (peekMatch[2] || "").trim();
                    const pMatch = attrStr.match(/path=["']([^"']+)["']/i);
                    const targetPath = pMatch ? pMatch[1].trim() : inner.split(/\s+/)[0];

                    const peekRes = await this._services.contextManager.peekFiles([{ path: targetPath, lines: 30 }]);
                    const snippet = peekRes.map(r => r.error ? `Error: ${r.error}` : r.content).join('\n');
                    FileRepairStudioPanel._mutualizedScoutingCache.set(targetPath, snippet);

                    this._panel.webview.postMessage({
                        command: 'toolExecuted',
                        tool: 'peek_files',
                        output: snippet
                    });

                    conversation.push({ role: 'assistant', content: finalCleanResponse });
                    conversation.push({ role: 'user', content: `Tool Observation for ${targetPath}:\n\`\`\`\n${snippet}\n\`\`\`\n\nDeliver the surgical patch for ${this._relPath}.` });
                    continue;
                }

                if (grepMatch) {
                    const attrStr = grepMatch[1] || "";
                    const pMatch = attrStr.match(/(?:pattern|query)=["']([^"']+)["']/i);
                    const pattern = pMatch ? pMatch[1].trim() : (grepMatch[2] || "").trim();
                    const searchRes = await this._services.contextManager.searchWorkspaceContent(pattern, { matchCase: false, wholeWord: false }, signal);
                    const snippet = searchRes.slice(0, 8).map(r => `${r.path}:${r.line} - ${r.snippet}`).join('\n') || "No matches found.";
                    FileRepairStudioPanel._mutualizedScoutingCache.set(`grep:${pattern}`, snippet);

                    this._panel.webview.postMessage({
                        command: 'toolExecuted',
                        tool: 'grep',
                        output: snippet
                    });

                    conversation.push({ role: 'assistant', content: finalCleanResponse });
                    conversation.push({ role: 'user', content: `Grep Results:\n${snippet}\n\nDeliver the surgical patch for ${this._relPath}.` });
                    continue;
                }

                // If no tools requested, we have the code patch
                break;
            }

            if (signal.aborted || !this._isRunning) {
                this._isRunning = false;
                this._panel.webview.postMessage({ command: 'repairStopped' });
                return;
            }

            // Apply patch to disk
            this._services.processManager.updateDescription(processId, `Applying patch to ${fileName} on disk...`);
            const normalizedPatch = normalizeAiderContent(finalCleanResponse);
            let patchRes: any = await vscode.commands.executeCommand(
                'lollms-vs-coder.replaceCode',
                this._relPath,
                normalizedPatch,
                undefined,
                undefined,
                { silent: true, autoSave: true }
            );

            // Resilient Fallback: If standard Search/Replace didn't match, check for <file> blocks
            if (!patchRes?.success) {
                const { extractFileBlocks, parseFileTagAttributes } = require('../utils');
                const fileBlocks = extractFileBlocks(finalCleanResponse);
                if (fileBlocks.length > 0) {
                    for (const fb of fileBlocks) {
                        const attrs = parseFileTagAttributes(fb.attrStr, fb.rawContent);
                        if (attrs && attrs.path) {
                            if (attrs.action === 'write') {
                                patchRes = await vscode.commands.executeCommand(
                                    'lollms-vs-coder.applyFileContent',
                                    attrs.path,
                                    fb.rawContent,
                                    { silent: true, autoSave: true }
                                );
                            } else {
                                patchRes = await vscode.commands.executeCommand(
                                    'lollms-vs-coder.replaceCode',
                                    attrs.path,
                                    normalizeAiderContent(fb.rawContent),
                                    undefined,
                                    undefined,
                                    { silent: true, autoSave: true }
                                );
                            }
                        }
                    }
                }
            }

            // Re-read current disk state
            await new Promise(r => setTimeout(r, 800));
            const freshDoc = await vscode.workspace.openTextDocument(this._fileUri);
            const newDiskContent = freshDoc.getText();
            this._services.contextManager.refreshFileInCache(this._fileUri);

            // Re-scan diagnostics
            this._services.processManager.updateDescription(processId, `Verifying language server diagnostics for ${fileName}...`);
            await this.refreshDiagnosticsFromHost();

            this._panel.webview.postMessage({
                command: 'repairPassCompleted',
                round: this._round,
                maxRounds: this._maxRounds,
                patchApplied: patchRes?.success ?? true,
                currentCode: newDiskContent,
                explanation: finalCleanResponse.replace(/```[\s\S]*?```/g, '').trim(),
                patch: normalizedPatch
            });

        } catch (err: any) {
            if (signal.aborted || !this._isRunning || err.name === 'AbortError' || err.message === 'AbortError') {
                this._isRunning = false;
                this._panel.webview.postMessage({ command: 'repairStopped' });
                return;
            }
            Logger.error("Repair pass error:", err);
            vscode.window.showErrorMessage(`File Repair Studio error: ${err.message}`);
            this._panel.webview.postMessage({
                command: 'repairError',
                error: err.message
            });
        } finally {
            if (this._activeProcessId) {
                this._services.processManager.unregister(this._activeProcessId);
                this._activeProcessId = null;
            }
            this._isRunning = false;
            this._activeAbortController = null;
        }
    }

    public async scanWorkspaceDiagnostics(): Promise<void> {
        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        if (!wsFolder) {
            vscode.window.showErrorMessage("No workspace folder open.");
            return;
        }

        const fs = require('fs');
        const { isPathBlockedFromGraph } = require('../codeGraphManager');
        const targetExts = new Set(['.py', '.ts', '.js', '.vue', '.tsx', '.jsx', '.rs', '.go', '.cs', '.cpp', '.c', '.h', '.hpp', '.java', '.php', '.rb', '.sh', '.html', '.css']);

        const proc = this._services.processManager.register(
            "workspace-scan",
            `Scanning workspace code files for errors...`
        );

        this._panel.webview.postMessage({
            command: 'scanStarted',
            status: 'Crawling workspace directory tree...'
        });

        try {
            const validUris: vscode.Uri[] = [];

            const walkDirectory = (dirPath: string): void => {
                if (proc.controller.signal.aborted) return;
                try {
                    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
                    for (const entry of entries) {
                        const fullPath = path.join(dirPath, entry.name);
                        const rel = path.relative(wsFolder.uri.fsPath, fullPath).replace(/\\/g, '/');

                        if (isPathBlockedFromGraph(rel)) continue;

                        if (entry.isDirectory()) {
                            walkDirectory(fullPath);
                        } else if (entry.isFile()) {
                            const ext = path.extname(entry.name).toLowerCase();
                            if (targetExts.has(ext)) {
                                validUris.push(vscode.Uri.file(fullPath));
                            }
                        }
                    }
                } catch {}
            };

            walkDirectory(wsFolder.uri.fsPath);

            const total = validUris.length;
            this._panel.webview.postMessage({
                command: 'scanProgress',
                current: 0,
                total,
                percentage: 0,
                status: `Opening and triggering linter passes on ${total} code files...`
            });

            const BATCH_SIZE = 8;
            for (let i = 0; i < total; i += BATCH_SIZE) {
                if (proc.controller.signal.aborted) break;

                const batch = validUris.slice(i, i + BATCH_SIZE);
                await Promise.all(batch.map(async (u) => {
                    try {
                        await vscode.workspace.openTextDocument(u);
                    } catch {}
                }));

                const current = Math.min(i + BATCH_SIZE, total);
                const pct = Math.round((current / total) * 100);
                const currentRel = vscode.workspace.asRelativePath(validUris[current - 1], false);

                this._services.processManager.updateDescription(
                    proc.id,
                    `Analyzing (${current}/${total}): ${path.basename(currentRel)}`
                );

                this._panel.webview.postMessage({
                    command: 'scanProgress',
                    current,
                    total,
                    percentage: pct,
                    status: `Analyzing ${current}/${total}: ${currentRel}`
                });

                await new Promise(r => setTimeout(r, 35));
            }

            this._panel.webview.postMessage({
                command: 'scanProgress',
                current: total,
                total,
                percentage: 100,
                status: `Collecting language server diagnostics...`
            });
            // Give language servers time to compile and settle diagnostic buffers
            await new Promise(r => setTimeout(r, 1000));

            this._isWorkspaceScope = true;
            this._sortOrder = 'group_by_file';
            await this.refreshDiagnosticsFromHost();

            const totalErrCount = this._workspaceFiles.reduce((sum, f) => sum + f.count, 0);
            this._panel.webview.postMessage({
                command: 'scanCompleted',
                totalFilesWithErrors: this._workspaceFiles.length,
                totalErrors: totalErrCount
            });

            vscode.window.showInformationMessage(`✅ Workspace scan complete: ${totalErrCount} error(s) detected across ${this._workspaceFiles.length} file(s).`);

        } catch (err: any) {
            vscode.window.showErrorMessage(`Workspace scan error: ${err.message}`);
            this._panel.webview.postMessage({
                command: 'scanFailed',
                error: err.message
            });
        } finally {
            this._services.processManager.unregister(proc.id);
        }
    }

    public async runWorkspaceRepair() {
        if (this._isRunning) return;
        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        if (!wsFolder) return;

        const allDiags = vscode.languages.getDiagnostics();
        const targets: { uri: vscode.Uri; relPath: string; count: number }[] = [];
        for (const [uri, dList] of allDiags) {
            const errs = dList.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
            if (errs.length > 0 && uri.fsPath.startsWith(wsFolder.uri.fsPath)) {
                targets.push({
                    uri,
                    relPath: vscode.workspace.asRelativePath(uri, false),
                    count: errs.length
                });
            }
        }

        if (targets.length === 0) {
            // Re-scan workspace once before declaring clean
            await this.scanWorkspaceDiagnostics();
            const recheckDiags = vscode.languages.getDiagnostics();
            for (const [uri, dList] of recheckDiags) {
                const errs = dList.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
                if (errs.length > 0 && uri.fsPath.startsWith(wsFolder.uri.fsPath)) {
                    targets.push({
                        uri,
                        relPath: vscode.workspace.asRelativePath(uri, false),
                        count: errs.length
                    });
                }
            }
            if (targets.length === 0) {
                await this.scanWorkspaceDiagnostics();
                const recheckDiags = vscode.languages.getDiagnostics();
                for (const [uri, dList] of recheckDiags) {
                    const errs = dList.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
                    if (errs.length > 0 && uri.fsPath.startsWith(wsFolder.uri.fsPath)) {
                        targets.push({
                            uri,
                            relPath: vscode.workspace.asRelativePath(uri, false),
                            count: errs.length
                        });
                    }
                }
                if (targets.length === 0) {
                    vscode.window.showInformationMessage("🎉 All workspace files are clean of errors!");
                    return;
                }
            }
        }

        this.setWorkspaceFiles(targets.map(t => ({ path: t.relPath, uri: t.uri, count: t.count })));
        let resolvedTotal = 0;

        for (let idx = 0; idx < targets.length; idx++) {
            const target = targets[idx];
            await this.switchFile(target.relPath);
            await this.runRepairPass(`Workspace pass (${idx + 1}/${targets.length}): fix errors in ${target.relPath}`);
            const fixedInFile = this._diagnostics.filter(d => d.isFixed).length;
            resolvedTotal += fixedInFile;
        }

        vscode.window.showInformationMessage(`✅ Workspace repair finished across ${targets.length} files (${resolvedTotal} errors resolved with mutualized scouting).`);
    }

    private _getHtmlForWebview(): string {
        const codiconsUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'));
        const cspSource = this._panel.webview.cspSource;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; font-src ${cspSource}; script-src 'unsafe-inline' https://cdn.jsdelivr.net; connect-src *;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>File Repair Studio</title>
    <link href="${codiconsUri}" rel="stylesheet" />
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <style>
        body {
            font-family: var(--vscode-font-family);
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
            padding: 10px 18px;
            background: var(--vscode-editorWidget-background);
            border-bottom: 1px solid var(--vscode-widget-border);
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            flex-shrink: 0;
        }
        .header-title-group {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .header-icon {
            width: 30px;
            height: 30px;
            border-radius: 6px;
            background: rgba(231, 76, 60, 0.15);
            color: var(--vscode-charts-red);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 16px;
        }
        .header-title {
            font-size: 13.5px;
            font-weight: 800;
            letter-spacing: 0.5px;
            color: var(--vscode-foreground);
        }
        .header-subtitle {
            font-size: 10px;
            opacity: 0.7;
            font-family: var(--vscode-editor-font-family, monospace);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            max-width: 500px;
        }
        .btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 5px 10px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: bold;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            white-space: nowrap !important;
            flex-shrink: 0 !important;
            transition: all 0.15s;
        }
        .btn:hover { filter: brightness(1.15); }
        .btn.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-widget-border);
        }
        .btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
        .btn.green {
            background: var(--vscode-charts-green, #2ecc71) !important;
            color: white !important;
        }
        .btn.purple {
            background: var(--vscode-charts-purple, #9b59b6) !important;
            color: white !important;
        }
        .btn.red {
            background: var(--vscode-charts-red, #e74c3c) !important;
            color: white !important;
        }
        .toolbar-bar {
            padding: 6px 16px;
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-widget-border);
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            font-size: 11px;
            flex-wrap: wrap;
        }
        .main-layout {
            flex: 1;
            display: flex;
            overflow: hidden;
            width: 100%;
        }
        .left-stream-col {
            flex: 1.15;
            display: flex;
            flex-direction: column;
            border-right: 1px solid var(--vscode-widget-border);
            background: var(--vscode-editor-background);
            overflow: hidden;
        }
        .right-inspect-col {
            flex: 1;
            display: flex;
            flex-direction: column;
            background: var(--vscode-sideBar-background);
            overflow: hidden;
        }
        .chat-stream-box {
            flex: 1;
            overflow-y: auto;
            padding: 14px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        .bubble {
            padding: 10px 14px;
            border-radius: 8px;
            font-size: 11.5px;
            line-height: 1.45;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-widget-border);
        }
        .bubble.user {
            border-left: 3px solid var(--vscode-charts-blue);
            align-self: flex-end;
            width: 85%;
        }
        .bubble.assistant {
            border-left: 3px solid var(--vscode-charts-purple);
            align-self: flex-start;
            width: 95%;
        }
        .bubble.tool {
            border-left: 3px solid var(--vscode-charts-orange);
            background: rgba(214, 122, 13, 0.08);
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 10.5px;
        }
        .input-row-box {
            padding: 10px 14px;
            border-top: 1px solid var(--vscode-widget-border);
            background: var(--vscode-sideBar-background);
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        .textarea-box {
            flex: 1;
            height: 48px;
            resize: none;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            padding: 8px;
            font-family: inherit;
            font-size: 11.5px;
            outline: none;
        }
        .textarea-box:focus { border-color: var(--vscode-focusBorder); }
        .tab-btn-row {
            padding: 6px 12px;
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-bottom: 1px solid var(--vscode-widget-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .tab-btn {
            background: transparent;
            border: 1px solid transparent;
            color: var(--vscode-foreground);
            padding: 3px 8px;
            font-size: 10.5px;
            font-weight: 600;
            cursor: pointer;
            border-radius: 4px;
        }
        .tab-btn.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            font-weight: 700;
        }
        .filter-controls-row {
            padding: 6px 12px;
            background: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-widget-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
        }
        .error-card {
            padding: 8px 10px;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 6px;
            display: flex;
            flex-direction: column;
            gap: 4px;
            cursor: pointer;
            transition: border-color 0.15s, opacity 0.15s;
        }
        .error-card.targeted-primary {
            border: 1.5px solid var(--vscode-charts-orange) !important;
            background: rgba(214, 122, 13, 0.08) !important;
            box-shadow: 0 0 10px rgba(214, 122, 13, 0.25);
        }
        .error-card.fixed {
            border-left: 3.5px solid var(--vscode-charts-green) !important;
            background: rgba(46, 204, 113, 0.08) !important;
            border-color: rgba(46, 204, 113, 0.35) !important;
        }
        .error-card.fixed:hover {
            border-color: var(--vscode-charts-green) !important;
        }
        .crit-badge.fixed {
            background: rgba(46, 204, 113, 0.25) !important;
            color: var(--vscode-charts-green) !important;
            border: 1px solid var(--vscode-charts-green) !important;
        }
        .fixed-check-icon {
            color: white;
            background: var(--vscode-charts-green);
            border-radius: 3px;
            width: 16px;
            height: 16px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-size: 11px;
            font-weight: bold;
            flex-shrink: 0;
        }
        .error-card:hover { border-color: var(--vscode-focusBorder); }
        .error-card.unselected { opacity: 0.55; }
        .error-card.critical { border-left: 3px solid var(--vscode-charts-red); }
        .error-card.type { border-left: 3px solid var(--vscode-charts-orange); }
        .error-card.import { border-left: 3px solid var(--vscode-charts-purple); }
        .error-card.warning { border-left: 3px solid var(--vscode-charts-yellow); }
        .error-card.cosmetic { border-left: 3px solid var(--vscode-charts-blue); }
        .crit-badge {
            font-size: 8.5px;
            font-weight: 800;
            padding: 1px 5px;
            border-radius: 3px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            white-space: nowrap !important;
            flex-shrink: 0 !important;
            display: inline-flex;
            align-items: center;
            gap: 3px;
        }
        .accordion-badge {
            font-size: 9.5px;
            font-weight: 800;
            padding: 1px 7px;
            border-radius: 10px;
            white-space: nowrap !important;
            flex-shrink: 0 !important;
            margin-left: auto;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        .accordion-badge.badge-all-fixed {
            background: rgba(46, 204, 113, 0.25) !important;
            color: var(--vscode-charts-green) !important;
            border: 1px solid var(--vscode-charts-green);
        }
        .accordion-header {
            padding: 6px 10px;
            cursor: pointer;
            font-weight: 700;
            font-size: 11px;
            display: flex;
            align-items: center;
            gap: 6px;
            user-select: none;
            border-radius: 4px;
        }
        .folder-header {
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-bottom: 1px solid var(--vscode-widget-border);
        }
        .file-header {
            background: rgba(0,0,0,0.15);
            border-bottom: 1px solid var(--vscode-widget-border);
        }
        .accordion-item {
            margin-bottom: 8px;
            border: 1px solid var(--vscode-widget-border);
            border-radius: 6px;
            overflow: hidden;
            background: rgba(0,0,0,0.08);
        }
        .folder-accordion-body {
            padding: 6px 8px;
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        .file-accordion-body {
            padding: 6px;
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        .crit-badge.critical { background: rgba(231, 76, 60, 0.2); color: var(--vscode-charts-red); }
        .crit-badge.type { background: rgba(230, 126, 34, 0.2); color: var(--vscode-charts-orange); }
        .crit-badge.import { background: rgba(155, 89, 182, 0.2); color: var(--vscode-charts-purple); }
        .crit-badge.warning { background: rgba(241, 196, 15, 0.2); color: var(--vscode-charts-yellow); }
        .crit-badge.cosmetic { background: rgba(52, 152, 219, 0.2); color: var(--vscode-charts-blue); }
        .footer-bar {
            padding: 8px 18px;
            background: var(--vscode-editorWidget-background);
            border-top: 1px solid var(--vscode-widget-border);
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 11px;
            flex-shrink: 0;
        }
        .spinner {
            width: 12px;
            height: 12px;
            border: 2px solid currentColor;
            border-bottom-color: transparent;
            border-radius: 50%;
            display: inline-block;
            animation: spin 0.75s linear infinite;
        }
        @keyframes spin { 100% { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="header">
        <div class="header-title-group">
            <div class="header-icon"><i class="codicon codicon-tools"></i></div>
            <div>
                <div class="header-title">File Repair Studio (Guardian)</div>
                <div class="header-subtitle" id="targetFileSubtitle">Target: loading...</div>
            </div>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
            <span id="headerErrBadge" class="btn secondary" style="cursor:default; height:24px; font-size:10px;">0 Errors</span>
            <button id="btnTopAccept" class="btn green" style="height:24px; font-size:10px;"><i class="codicon codicon-check"></i> Accept at Any Time</button>
        </div>
    </div>

    <div class="toolbar-bar">
        <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap; flex:1;">
            <div style="display:flex; align-items:center; gap:6px;">
                <span style="font-weight:700;"><i class="codicon codicon-files"></i> Scope:</span>
                <select id="workspaceFileSelect" style="background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); border:1px solid var(--vscode-dropdown-border); border-radius:4px; font-size:11px; height:22px; max-width:220px;"></select>
                <button id="btnScanWorkspace" class="btn secondary" style="height:22px; font-size:10px; padding:0 8px;" title="Scan workspace source files for errors (excluding venv, git, .lollms, data, and cache folders)">
                    <i class="codicon codicon-search"></i> Scan Workspace
                </button>
                <button id="btnFixAllWorkspace" class="btn green" style="height:22px; font-size:10px; padding:0 8px;" title="Sequentially repair all broken files in the workspace with mutualized scouting cache">
                    <i class="codicon codicon-zap"></i> Fix Workspace (<span id="workspaceBrokenFilesCount">0</span>)
                </button>
            </div>
            <div style="display:flex; align-items:center; gap:6px;">
                <span id="mutualizedScoutBadge" class="btn secondary" style="height:22px; font-size:10px; padding:0 6px; cursor:pointer;" title="Click to clear mutualized scouting cache"><i class="codicon codicon-circuit-board"></i> Mutualized: <span id="mutualizedScoutCount">0</span></span>
            </div>
            <div style="display:flex; align-items:center; gap:6px;">
                <span style="font-weight:700;"><i class="codicon codicon-hubot"></i> Model:</span>
                <select id="modelSelect" style="background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); border:1px solid var(--vscode-dropdown-border); border-radius:4px; font-size:11px; height:22px; max-width:240px;"></select>
                <button id="btnRefreshModels" class="btn secondary" style="height:22px; width:22px; padding:0; display:inline-flex; align-items:center; justify-content:center;" title="Refresh models from server"><i class="codicon codicon-refresh"></i></button>
            </div>
            <div style="display:flex; align-items:center; gap:6px;">
                <span style="font-weight:700;"><i class="codicon codicon-thermometer"></i> Temp:</span>
                <select id="tempSelect" style="background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); border:1px solid var(--vscode-dropdown-border); border-radius:4px; font-size:11px; height:22px;">
                    <option value="auto">Auto</option>
                    <option value="0.0">0.0 (Deterministic)</option>
                    <option value="0.2" selected>0.2 (Precise Fix)</option>
                    <option value="0.5">0.5 (Balanced)</option>
                </select>
            </div>
            <div style="display:flex; align-items:center; gap:6px;">
                <span style="font-weight:700;"><i class="codicon codicon-circuit-board"></i> Effort:</span>
                <select id="effortSelect" style="background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); border:1px solid var(--vscode-dropdown-border); border-radius:4px; font-size:11px; height:22px;">
                    <option value="none" selected>None (Fast)</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="max">Max</option>
                </select>
            </div>
            <div style="display:flex; align-items:center; gap:6px;">
                <span style="font-weight:700;"><i class="codicon codicon-history"></i> Rounds:</span>
                <input type="number" id="maxRoundsInput" min="1" max="100" value="20" style="background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border); border-radius:4px; font-size:11px; height:20px; width:52px; text-align:center; padding:1px 4px;" title="Maximum number of repair rounds to execute">
            </div>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
            <span id="roundCounterBadge" style="opacity:0.8; font-family:monospace;">Round 0/20</span>
        </div>
    </div>

    <!-- 📊 SCAN PROGRESS BAR OVERLAY (WITH ACTIVE PROCESS TRACKING) -->
    <div id="scanProgressBarContainer" style="display:none; padding:8px 18px; background:var(--vscode-sideBarSectionHeader-background); border-bottom:1px solid var(--vscode-widget-border);">
        <div style="display:flex; justify-content:space-between; align-items:center; font-size:11px; margin-bottom:4px;">
            <span id="scanProgressStatus"><span class="spinner"></span> Scanning workspace code files...</span>
            <span id="scanProgressPercent" style="font-weight:bold; font-family:monospace;">0%</span>
        </div>
        <div class="progress-bar-container" style="height:6px; width:100%; background:rgba(0,0,0,0.25); border-radius:3px; overflow:hidden;">
            <div id="scanProgressBarFill" style="height:100%; width:0%; background:var(--vscode-charts-blue); transition:width 0.15s ease;"></div>
        </div>
    </div>

    <div class="main-layout">
        <!-- LEFT COLUMN: Repair Chat Stream & Instructions -->
        <div class="left-stream-col">
            <div style="padding:6px 12px; background:var(--vscode-sideBarSectionHeader-background); border-bottom:1px solid var(--vscode-widget-border); display:flex; justify-content:space-between; align-items:center; font-size:10.5px; font-weight:700; text-transform:uppercase;">
                <span><i class="codicon codicon-comment-discussion"></i> Repair Stream &amp; Tool Inspection</span>
                <span id="statusIndicatorText" style="opacity:0.7;">Ready</span>
            </div>

            <div class="chat-stream-box" id="chatStreamBox">
                <div class="bubble assistant">
                    <strong>🛡️ Guardian Repair Assistant Ready</strong><br>
                    I inspect the current code on disk, select target errors, and can scout other files using <code>&lt;peek_files&gt;</code>, <code>&lt;grep&gt;</code>, or <code>&lt;show_symbol&gt;</code> before generating surgical fixes.
                </div>
            </div>

            <div id="liveStreamingIndicator" style="display:none; padding:6px 12px; background:rgba(155,89,182,0.1); border-top:1px solid var(--vscode-widget-border); font-size:10.5px; color:var(--vscode-charts-purple); align-items:center; justify-content:space-between;">
                <div style="display:flex; align-items:center; gap:8px;">
                    <div class="spinner"></div>
                    <span id="streamingStatusMessage">Repairing selected errors...</span>
                </div>
            </div>

            <div class="input-row-box">
                <div style="display:flex; gap:8px; align-items:flex-end;">
                    <textarea id="promptInput" class="textarea-box" placeholder="Optional instructions (e.g. 'Ensure type safety', 'Import LollmsServices from ../lollmsContext')..."></textarea>
                    <button id="btnRunFix" class="btn purple" style="height:48px; width:65px; flex-direction:column; gap:2px;"><i class="codicon codicon-sparkle"></i> <span>Fix</span></button>
                </div>
                <div style="display:flex; justify-content:space-between; font-size:9.5px; opacity:0.65;">
                    <span>Press <kbd>Enter</kbd> to fix &middot; <kbd>Shift+Enter</kbd> for newline</span>
                    <span id="selectedErrorsHint">0 errors selected</span>
                </div>
            </div>
        </div>

        <!-- RIGHT COLUMN: Spotted Errors, Code Viewer, Diff -->
        <div class="right-inspect-col">
            <div class="tab-btn-row">
                <span style="font-weight:700; font-size:11px; text-transform:uppercase;"><i class="codicon codicon-warning" style="color:var(--vscode-charts-red)"></i> Spotted Errors (<span id="totalErrorsCount">0</span>)</span>
                <div style="display:flex; gap:4px;">
                    <button class="tab-btn active" id="tabBtnErrors">Errors</button>
                    <button class="tab-btn" id="tabBtnCode">Current Code</button>
                    <button class="tab-btn" id="tabBtnDiff">Last Diff</button>
                </div>
            </div>

            <!-- TAB 1: ERRORS LIST WITH ORDERING & SELECTION -->
            <div id="paneErrors" style="flex:1; display:flex; flex-direction:column; overflow:hidden;">
                <div class="filter-controls-row">
                    <!-- Ordering Dropdown (Critical to Cosmetic) -->
                    <div style="display:flex; align-items:center; gap:6px;">
                        <span style="font-weight:700; font-size:10.5px;"><i class="codicon codicon-sort-precedence"></i> Order:</span>
                        <select id="orderSelect" style="font-size:10.5px; padding:2px 4px; background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); border:1px solid var(--vscode-dropdown-border); border-radius:4px; height:22px;">
                            <option value="group_by_file" selected>📁 Group by Folder &amp; File (Accordion)</option>
                            <option value="critical_to_cosmetic">🔥 Critical to Cosmetic</option>
                            <option value="cosmetic_to_critical">❄️ Cosmetic to Critical</option>
                            <option value="line_asc">⬆️ Line Number (Asc)</option>
                            <option value="line_desc">⬇️ Line Number (Desc)</option>
                            <option value="severity">⚠️ Severity (Errors &gt; Warnings)</option>
                            <option value="alpha">🔤 Message (A - Z)</option>
                        </select>
                    </div>

                    <!-- Search Filter -->
                    <div style="display:flex; align-items:center; gap:4px; background:var(--vscode-input-background); border:1px solid var(--vscode-input-border); border-radius:4px; padding:2px 6px; flex:1; max-width:180px;">
                        <i class="codicon codicon-search" style="font-size:10px; opacity:0.6;"></i>
                        <input type="text" id="filterInput" placeholder="Filter errors..." style="background:transparent; border:none; outline:none; font-size:10.5px; color:var(--vscode-input-foreground); width:100%;">
                    </div>

                    <!-- Bulk Selection Actions -->
                    <div style="display:flex; align-items:center; gap:4px; flex-wrap:wrap;">
                        <span style="font-weight:700; font-size:10.5px; opacity:0.8;">Select:</span>
                        <button class="btn secondary" id="btnSelectAll" style="height:22px; font-size:10px; padding:0 6px;" title="Select all errors and warnings">All</button>
                        <button class="btn secondary" id="btnSelectNone" style="height:22px; font-size:10px; padding:0 6px;" title="Deselect all">None</button>
                        <button class="btn secondary" id="btnSelectInvert" style="height:22px; font-size:10px; padding:0 6px;" title="Invert selection">Invert</button>
                        <span style="opacity:0.3; margin:0 2px;">|</span>
                        <button class="btn secondary" id="btnSelectCritical" style="height:22px; font-size:10px; padding:0 6px; color:var(--vscode-charts-red); border-color:rgba(231,76,60,0.4);" title="Select only critical syntax and runtime errors">🔥 Critical</button>
                        <button class="btn secondary" id="btnSelectTypes" style="height:22px; font-size:10px; padding:0 6px; color:var(--vscode-charts-orange); border-color:rgba(230,126,34,0.4);" title="Select only type mismatch and property errors">⚡ Types</button>
                        <button class="btn secondary" id="btnSelectImports" style="height:22px; font-size:10px; padding:0 6px; color:var(--vscode-charts-purple); border-color:rgba(155,89,182,0.4);" title="Select only unresolved import and module errors">📦 Imports</button>
                        <button class="btn secondary" id="btnSelectWarnings" style="height:22px; font-size:10px; padding:0 6px; color:var(--vscode-charts-yellow); border-color:rgba(241,196,15,0.4);" title="Select only warnings">⚠️ Warnings</button>
                        <button class="btn secondary" id="btnToggleAllOrTargeted" style="display:none; height:22px; font-size:10px; padding:0 8px; margin-left:4px; font-weight:700; color:var(--vscode-textLink-foreground); border-color:var(--vscode-charts-blue);"></button>
                    </div>
                </div>

                <div id="errorsListContainer" style="flex:1; overflow-y:auto; padding:8px; display:flex; flex-direction:column; gap:6px;"></div>
            </div>

            <!-- TAB 2: CURRENT CODE ON DISK -->
            <div id="paneCode" style="flex:1; display:none; overflow:auto; padding:10px; background:var(--vscode-editor-background);">
                <pre id="currentCodeView" style="margin:0; font-family:var(--vscode-editor-font-family, monospace); font-size:11.5px; line-height:1.45; white-space:pre;"></pre>
            </div>

            <!-- TAB 3: LAST PATCH DIFF -->
            <div id="paneDiff" style="flex:1; display:none; overflow:auto; padding:10px; background:var(--vscode-editor-background);">
                <pre id="lastPatchView" style="margin:0; font-family:var(--vscode-editor-font-family, monospace); font-size:11px; line-height:1.4; white-space:pre; opacity:0.9;">(No patch applied yet)</pre>
            </div>
        </div>
    </div>

    <div class="footer-bar">
        <span id="footerStatusSummary">Ready</span>
        <div style="display:flex; gap:8px;">
            <button id="btnFooterRescan" class="btn secondary" style="height:26px;"><i class="codicon codicon-refresh"></i> Re-scan</button>
            <button id="btnFooterAccept" class="btn green" style="height:26px;"><i class="codicon codicon-check"></i> Accept &amp; Keep File</button>
        </div>
    </div>

    <!-- FIRST SCRIPT: Safe global error logger and crash shield -->
    <script>
        window.onerror = function(msg, url, lineNo, colNo, error) {
            console.error('[FileRepairStudio Syntax/Runtime Error]:', msg, 'line:', lineNo, 'col:', colNo, error);
            try {
                if (window.vscode) {
                    window.vscode.postMessage({
                        command: 'diagnosticLog',
                        level: 'FATAL_SCRIPT_ERROR',
                        message: String(msg) + ' at line ' + lineNo + ':' + colNo
                    });
                }
            } catch(e) {}
            var banner = document.getElementById('debugErrorBanner');
            if (!banner) {
                banner = document.createElement('div');
                banner.id = 'debugErrorBanner';
                banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#c0392b;color:#fff;padding:8px 14px;font-family:monospace;font-size:11px;z-index:999999;border-top:2px solid #e74c3c;';
                document.body.appendChild(banner);
            }
            banner.textContent = '[Webview Script Error: line ' + lineNo + ':' + colNo + '] ' + String(msg);
            return false;
        };

        window.addEventListener('unhandledrejection', function(event) {
            console.error('[FileRepairStudio Unhandled Rejection]:', event.reason);
        });
    </script>

    <!-- MAIN STUDIO SCRIPT: Zero raw backtick interpolations to guarantee 100% parse safety -->
    <!-- FIRST SCRIPT: Safe global error logger and crash shield -->
    <script>
        window.onerror = function(msg, url, lineNo, colNo, error) {
            console.error('[FileRepairStudio Syntax/Runtime Error]:', msg, 'line:', lineNo, 'col:', colNo, error);
            try {
                if (window.vscode) {
                    window.vscode.postMessage({
                        command: 'diagnosticLog',
                        level: 'FATAL_SCRIPT_ERROR',
                        message: String(msg) + ' at line ' + lineNo + ':' + colNo
                    });
                }
            } catch(e) {}
            var banner = document.getElementById('debugErrorBanner');
            if (!banner) {
                banner = document.createElement('div');
                banner.id = 'debugErrorBanner';
                banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#c0392b;color:#fff;padding:8px 14px;font-family:monospace;font-size:11px;z-index:999999;border-top:2px solid #e74c3c;';
                document.body.appendChild(banner);
            }
            banner.textContent = '[Webview Script Error: line ' + lineNo + ':' + colNo + '] ' + String(msg);
            return false;
        };

        window.addEventListener('unhandledrejection', function(event) {
            console.error('[FileRepairStudio Unhandled Rejection]:', event.reason);
        });
    </script>

    <!-- MAIN STUDIO SCRIPT: Zero raw backtick interpolations to guarantee 100% parse safety -->
    <script>
        console.log('[FileRepairStudio:Script] Booting main webview script...');

        var vscode = null;
        try {
            vscode = acquireVsCodeApi();
            window.vscode = vscode;
            console.log('[FileRepairStudio:Script] acquireVsCodeApi succeeded.');
        } catch(e) {
            console.error('[FileRepairStudio:Script] acquireVsCodeApi failed:', e);
        }

        var targetFilePath = '';
        var diagnosticsList = [];
        var isFixing = false;
        var activeTab = 'errors';

        function escapeHtml(str) {
            return String(str || '')
                .split('&').join('&amp;')
                .split('<').join('&lt;')
                .split('>').join('&gt;')
                .split('"').join('&quot;')
                .split("'").join('&#39;');
        }

        function safeMarked(text) {
            if (window.marked && typeof window.marked.parse === 'function') {
                try {
                    return window.marked.parse(text);
                } catch(e) {
                    return '<pre>' + escapeHtml(text) + '</pre>';
                }
            }
            return '<pre style="white-space:pre-wrap;">' + escapeHtml(text) + '</pre>';
        }

        // Notify extension host that webview is ready to receive data
        console.log('[FileRepairStudio:Script] Sending ready command to extension host...');
        if (vscode) {
            vscode.postMessage({ command: 'ready' });
        }

        // Tab Switching
        var tabBtnErrors = document.getElementById('tabBtnErrors');
        var tabBtnCode = document.getElementById('tabBtnCode');
        var tabBtnDiff = document.getElementById('tabBtnDiff');
        var paneErrors = document.getElementById('paneErrors');
        var paneCode = document.getElementById('paneCode');
        var paneDiff = document.getElementById('paneDiff');

        function switchTab(tab) {
            activeTab = tab;
            tabBtnErrors.classList.toggle('active', tab === 'errors');
            tabBtnCode.classList.toggle('active', tab === 'code');
            tabBtnDiff.classList.toggle('active', tab === 'diff');

            paneErrors.style.display = tab === 'errors' ? 'flex' : 'none';
            paneCode.style.display = tab === 'code' ? 'block' : 'none';
            paneDiff.style.display = tab === 'diff' ? 'block' : 'none';
        }

        tabBtnErrors.onclick = function() { switchTab('errors'); };
        tabBtnCode.onclick = function() { switchTab('code'); };
        tabBtnDiff.onclick = function() { switchTab('diff'); };

        // Selection Handlers
        document.getElementById('btnSelectAll').onclick = function() { vscode.postMessage({ command: 'selectAllErrors' }); };
        document.getElementById('btnSelectNone').onclick = function() { vscode.postMessage({ command: 'deselectAllErrors' }); };
        document.getElementById('btnSelectInvert').onclick = function() { vscode.postMessage({ command: 'invertErrorSelection' }); };
        document.getElementById('btnSelectCritical').onclick = function() { vscode.postMessage({ command: 'selectOnlyCritical' }); };
        document.getElementById('btnSelectTypes').onclick = function() { vscode.postMessage({ command: 'selectOnlyTypes' }); };
        document.getElementById('btnSelectImports').onclick = function() { vscode.postMessage({ command: 'selectOnlyImports' }); };
        document.getElementById('btnSelectWarnings').onclick = function() { vscode.postMessage({ command: 'selectOnlyWarnings' }); };

        // Sorting & Filter Handlers
        document.getElementById('orderSelect').onchange = function(e) {
            vscode.postMessage({ command: 'changeSortOrder', sortOrder: e.target.value });
        };

        var filterDebounce = null;
        document.getElementById('filterInput').oninput = function(e) {
            clearTimeout(filterDebounce);
            var val = e.target.value;
            filterDebounce = setTimeout(function() {
                vscode.postMessage({ command: 'filterErrors', query: val });
            }, 150);
        };

        function populateModelSelect(models, selectedModel) {
            var modelSelect = document.getElementById('modelSelect');
            if (!modelSelect) return;
            var targetSel = (selectedModel || modelSelect.value || '').trim();
            var validModels = (models || []).filter(function(m) { return m && (m.id || m.name); });

            if (validModels.length > 0) {
                var serverGroups = new Map();
                validModels.forEach(function(m) {
                    var sName = m.server || 'Available Models';
                    if (!serverGroups.has(sName)) serverGroups.set(sName, []);
                    serverGroups.get(sName).push(m);
                });

                var html = '';
                var hasMatch = false;

                if (serverGroups.size > 1) {
                    serverGroups.forEach(function(modelsInServer, sName) {
                        html += '<optgroup label="🖥️ ' + escapeHtml(sName) + '">';
                        modelsInServer.forEach(function(m) {
                            var isMatch = !hasMatch && (m.id === targetSel || (targetSel && (m.id.indexOf('::' + targetSel) !== -1 || targetSel.indexOf('::' + m.id) !== -1 || m.name === targetSel)));
                            if (isMatch) hasMatch = true;
                            var label = m.name || m.id;
                            html += '<option value="' + escapeHtml(m.id) + '" ' + (isMatch ? 'selected' : '') + '>' + escapeHtml(label) + '</option>';
                        });
                        html += '</optgroup>';
                    });
                } else {
                    html = validModels.map(function(m) {
                        var isMatch = !hasMatch && (m.id === targetSel || (targetSel && (m.id.indexOf('::' + targetSel) !== -1 || targetSel.indexOf('::' + m.id) !== -1 || m.name === targetSel)));
                        if (isMatch) hasMatch = true;
                        var label = m.name || m.id;
                        return '<option value="' + escapeHtml(m.id) + '" ' + (isMatch ? 'selected' : '') + '>' + escapeHtml(label) + '</option>';
                    }).join('');
                }
                modelSelect.innerHTML = html;
                if (targetSel && modelSelect.value !== targetSel) {
                    modelSelect.value = targetSel;
                }
                if (!modelSelect.value && modelSelect.options.length > 0) {
                    modelSelect.selectedIndex = 0;
                }
            } else if (targetSel) {
                modelSelect.innerHTML = '<option value="' + escapeHtml(targetSel) + '" selected>' + escapeHtml(targetSel) + '</option>';
            } else {
                modelSelect.innerHTML = '<option value="default" selected>Default Model</option>';
            }
        }

        function postSettingsUpdate() {
            var model = document.getElementById('modelSelect').value;
            var tempVal = document.getElementById('tempSelect').value;
            var temp = tempVal === 'auto' ? undefined : parseFloat(tempVal);
            var effort = document.getElementById('effortSelect').value;
            var roundsVal = parseInt(document.getElementById('maxRoundsInput').value, 10);
            var maxRounds = (!isNaN(roundsVal) && roundsVal > 0) ? roundsVal : 20;
            vscode.postMessage({ command: 'updateSettings', model: model, temperature: temp, reasoningEffort: effort, maxRounds: maxRounds });
        }

        document.getElementById('modelSelect').onchange = postSettingsUpdate;
        document.getElementById('tempSelect').onchange = postSettingsUpdate;
        document.getElementById('effortSelect').onchange = postSettingsUpdate;

        var maxRoundsInput = document.getElementById('maxRoundsInput');
        if (maxRoundsInput) {
            maxRoundsInput.oninput = function() {
                var val = parseInt(maxRoundsInput.value, 10);
                if (!isNaN(val) && val > 0) {
                    var currentRoundText = document.getElementById('roundCounterBadge').textContent || '';
                    var parts = currentRoundText.split(' ')[1] ? currentRoundText.split(' ')[1].split('/') : ['0'];
                    var curRound = parseInt(parts[0], 10) || 0;
                    document.getElementById('roundCounterBadge').textContent = 'Round ' + curRound + '/' + val;
                    postSettingsUpdate();
                }
            };
        }

        var btnRefreshModels = document.getElementById('btnRefreshModels');
        if (btnRefreshModels) {
            btnRefreshModels.onclick = function() {
                var icon = btnRefreshModels.querySelector('i');
                if (icon) icon.className = 'codicon codicon-sync spin';
                vscode.postMessage({ command: 'refreshModels' });
                setTimeout(function() {
                    if (icon) icon.className = 'codicon codicon-refresh';
                }, 2500);
            };
        }

        // Run Fix / Stop Action
        var btnRunFix = document.getElementById('btnRunFix');
        var promptInput = document.getElementById('promptInput');

        function triggerFixOrStop() {
            if (isFixing) {
                isFixing = false;
                btnRunFix.classList.remove('red');
                btnRunFix.classList.add('purple');
                btnRunFix.innerHTML = '<i class="codicon codicon-sparkle"></i> <span>Fix</span>';
                document.getElementById('liveStreamingIndicator').style.display = 'none';
                document.getElementById('statusIndicatorText').textContent = 'Stopped by user';
                var streamEl = document.getElementById('activeStreamBubble');
                if (streamEl) {
                    streamEl.id = '';
                    streamEl.innerHTML += '<br><em style="color:var(--vscode-charts-orange); font-size:10px;">*(Repair stopped by user)*</em>';
                }
                vscode.postMessage({ command: 'stopRepair' });
            } else {
                var checkedCbs = Array.from(document.querySelectorAll('.err-check:checked'));
                var selectedIds = checkedCbs.map(function(cb) { return cb.dataset.id; }).filter(Boolean);
                var targetCount = selectedIds.length;

                var prompt = promptInput.value.trim();
                promptInput.value = '';
                var modelSelectEl = document.getElementById('modelSelect');
                var model = modelSelectEl.value || (modelSelectEl.options[0] ? modelSelectEl.options[0].value : '');
                var roundsVal = parseInt(document.getElementById('maxRoundsInput').value, 10);
                var maxRounds = (!isNaN(roundsVal) && roundsVal > 0) ? roundsVal : 20;
                var tempVal = document.getElementById('tempSelect').value;
                var temp = tempVal === 'auto' ? undefined : parseFloat(tempVal);
                var effort = document.getElementById('effortSelect').value;

                isFixing = true;
                btnRunFix.classList.remove('purple');
                btnRunFix.classList.add('red');
                btnRunFix.innerHTML = '<i class="codicon codicon-primitive-square"></i> <span>Stop</span>';
                document.getElementById('liveStreamingIndicator').style.display = 'flex';
                document.getElementById('statusIndicatorText').textContent = 'Fixing (' + (targetCount || 'all') + ' selected errors)...';

                if (prompt) {
                    var userMsg = document.createElement('div');
                    userMsg.className = 'bubble user';
                    userMsg.innerHTML = '<strong>You:</strong><br>' + escapeHtml(prompt);
                    document.getElementById('chatStreamBox').appendChild(userMsg);
                }

                var streamBubble = document.getElementById('activeStreamBubble');
                if (streamBubble) streamBubble.id = '';
                streamBubble = document.createElement('div');
                streamBubble.id = 'activeStreamBubble';
                streamBubble.className = 'bubble assistant';
                var currentBadge = document.getElementById('roundCounterBadge').textContent || 'Round 0/20';
                var parts = currentBadge.split(' ')[1] ? currentBadge.split(' ')[1].split('/') : ['0'];
                var curRound = parseInt(parts[0], 10) || 0;
                var nextRound = curRound + 1;
                streamBubble.innerHTML = '<strong>Repair Agent (Round ' + nextRound + '/' + maxRounds + '):</strong><br><span class="spinner"></span> <em>Analyzing code and drafting fix...</em>';
                document.getElementById('chatStreamBox').appendChild(streamBubble);
                document.getElementById('chatStreamBox').scrollTop = document.getElementById('chatStreamBox').scrollHeight;

                vscode.postMessage({ command: 'runRepair', prompt: prompt, model: model, temperature: temp, reasoningEffort: effort, maxRounds: maxRounds, selectedIds: selectedIds });
            }
        }

        btnRunFix.onclick = triggerFixOrStop;

        promptInput.onkeydown = function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                triggerFixOrStop();
            }
        };

        window.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && isFixing) {
                triggerFixOrStop();
            }
        });

        // Footer Actions
        document.getElementById('btnFooterRescan').onclick = function() { vscode.postMessage({ command: 'rescan' }); };
        document.getElementById('btnScanWorkspace').onclick = function() { vscode.postMessage({ command: 'scanWorkspace' }); };
        document.getElementById('btnFooterAccept').onclick = function() { vscode.postMessage({ command: 'acceptAndClose' }); };
        document.getElementById('btnTopAccept').onclick = function() { vscode.postMessage({ command: 'acceptAndClose' }); };

        function renderErrorCards(diagnostics, selectedCount, totalCount, isSingleMode, hostTotal) {
            var container = document.getElementById('errorsListContainer');
            var totalCountEl = document.getElementById('totalErrorsCount');
            var selectedHint = document.getElementById('selectedErrorsHint');
            var headerErrBadge = document.getElementById('headerErrBadge');
            var footerStatus = document.getElementById('footerStatusSummary');
            var toggleModeBtn = document.getElementById('btnToggleAllOrTargeted');

            var fixedCount = diagnostics.filter(function(d) { return d.isFixed; }).length;
            var remainingItems = diagnostics.filter(function(d) { return !d.isFixed; });
            var remainingCount = remainingItems.length;

            var criticalErrors = remainingItems.filter(function(d) { return d.severity === 0 || d.severity === 'Error'; });
            var warnings = remainingItems.filter(function(d) { return d.severity === 1 || d.severity === 'Warning'; });

            var criticalCount = criticalErrors.length;
            var warningCount = warnings.length;

            if (isSingleMode && hostTotal && hostTotal > 1) {
                if (remainingCount === 0 && fixedCount > 0) {
                    totalCountEl.textContent = '0 (' + fixedCount + ' fixed)';
                    selectedHint.textContent = 'Targeted issue fixed on disk! (' + (hostTotal - 1) + ' other diagnostics in background)';
                    headerErrBadge.textContent = 'Clean (' + fixedCount + ' Fixed ✓)';
                    headerErrBadge.style.color = 'var(--vscode-charts-green)';
                    headerErrBadge.style.borderColor = 'var(--vscode-charts-green)';
                    footerStatus.innerHTML = '🎉 <strong style="color:var(--vscode-charts-green)">Targeted issue fixed!</strong> Click <strong>Accept &amp; Keep File</strong> to close and show the updated file.';
                } else {
                    totalCountEl.textContent = '1 (Targeted)';
                    selectedHint.textContent = 'Targeted fix: 1 issue selected (out of ' + hostTotal + ' in file)';
                    headerErrBadge.textContent = criticalCount > 0 ? '1 Targeted Error' : '1 Targeted Warning';
                    headerErrBadge.style.color = criticalCount > 0 ? 'var(--vscode-charts-red)' : 'var(--vscode-charts-yellow, #cca700)';
                    headerErrBadge.style.borderColor = criticalCount > 0 ? 'var(--vscode-charts-red)' : 'rgba(204, 167, 0, 0.5)';
                    footerStatus.textContent = 'Targeted issue ready for fix. (' + (hostTotal - 1) + ' other diagnostics hidden to stay focused).';
                }

                if (toggleModeBtn) {
                    toggleModeBtn.style.display = 'inline-flex';
                    toggleModeBtn.innerHTML = '<i class="codicon codicon-eye"></i> Show All File Diagnostics (' + hostTotal + ')';
                    toggleModeBtn.onclick = function() { vscode.postMessage({ command: 'showAllFileErrors' }); };
                }
            } else {
                if (remainingCount === 0 && fixedCount > 0) {
                    totalCountEl.textContent = '0 (' + fixedCount + ' fixed)';
                    selectedHint.textContent = 'All issues fixed on disk! (' + fixedCount + ' resolved)';
                    headerErrBadge.textContent = '0 Errors (' + fixedCount + ' Fixed ✓)';
                    headerErrBadge.style.color = 'var(--vscode-charts-green)';
                    headerErrBadge.style.borderColor = 'var(--vscode-charts-green)';
                    footerStatus.innerHTML = '🎉 <strong style="color:var(--vscode-charts-green)">All issues fixed!</strong> (' + fixedCount + ' resolved). Click <strong>Accept &amp; Keep File</strong> to close and show the updated file.';
                } else {
                    if (criticalCount > 0 && warningCount > 0) {
                        totalCountEl.textContent = criticalCount + ' Err, ' + warningCount + ' Warn';
                        headerErrBadge.textContent = criticalCount + ' Error' + (criticalCount === 1 ? '' : 's') + ', ' + warningCount + ' Warn';
                        headerErrBadge.style.color = 'var(--vscode-charts-red)';
                        headerErrBadge.style.borderColor = 'var(--vscode-charts-red)';
                        selectedHint.textContent = selectedCount + ' selected for fix (' + criticalCount + ' errors, ' + warningCount + ' warnings)';
                        footerStatus.textContent = criticalCount + ' error(s) and ' + warningCount + ' warning(s) remaining (' + selectedCount + ' selected for next pass).';
                    } else if (criticalCount > 0) {
                        totalCountEl.textContent = criticalCount + ' Error' + (criticalCount === 1 ? '' : 's');
                        headerErrBadge.textContent = criticalCount + ' Error' + (criticalCount === 1 ? '' : 's');
                        headerErrBadge.style.color = 'var(--vscode-charts-red)';
                        headerErrBadge.style.borderColor = 'var(--vscode-charts-red)';
                        selectedHint.textContent = selectedCount + ' of ' + criticalCount + ' error(s) selected for fix';
                        footerStatus.textContent = criticalCount + ' error(s) remaining (' + selectedCount + ' selected for next pass).';
                    } else {
                        totalCountEl.textContent = warningCount + ' Warning' + (warningCount === 1 ? '' : 's');
                        headerErrBadge.textContent = warningCount + ' Warning' + (warningCount === 1 ? '' : 's') + ' (0 Errors)';
                        headerErrBadge.style.color = 'var(--vscode-charts-yellow, #cca700)';
                        headerErrBadge.style.borderColor = 'rgba(204, 167, 0, 0.5)';
                        selectedHint.textContent = selectedCount + ' of ' + warningCount + ' warning(s) selected for cleanup (0 critical errors)';
                        footerStatus.textContent = warningCount + ' warning(s) remaining (no critical errors). You can accept at any time.';
                    }
                }

                if (toggleModeBtn) {
                    toggleModeBtn.style.display = 'none';
                }
            }

            if (diagnostics.length === 0) {
                container.innerHTML = '<div style="padding:30px; text-align:center; color:var(--vscode-charts-green); display:flex; flex-direction:column; align-items:center; gap:8px;"><i class="codicon codicon-pass-filled" style="font-size:32px;"></i><span style="font-weight:700; font-size:13px;">No Diagnostics Errors Detected!</span><span style="font-size:11px; opacity:0.8;">The workspace is clean. Click Accept &amp; Keep File to finish.</span></div>';
                return;
            }

            var orderMode = document.getElementById('orderSelect').value;

            // FOLDER & FILE ACCORDION GROUPING
            if (orderMode === 'group_by_file') {
                var folderTree = new Map();
                var bslash = String.fromCharCode(92);

                diagnostics.forEach(function(d) {
                    var rawP = (d.filePath || targetFilePath).split(bslash).join('/');
                    var lastSlash = rawP.lastIndexOf('/');
                    var folderP = lastSlash !== -1 ? rawP.substring(0, lastSlash) : './';

                    if (!folderTree.has(folderP)) folderTree.set(folderP, new Map());
                    var fileMap = folderTree.get(folderP);
                    if (!fileMap.has(rawP)) fileMap.set(rawP, []);
                    fileMap.get(rawP).push(d);
                });

                var accordionHtml = '';
                folderTree.forEach(function(fileMap, folderPath) {
                    var folderItems = [];
                    fileMap.forEach(function(arr) { folderItems.push.apply(folderItems, arr); });

                    var folderFixed = folderItems.filter(function(i) { return i.isFixed; }).length;
                    var folderRemaining = folderItems.length - folderFixed;
                    var folderSelected = folderItems.filter(function(i) { return i.selected && !i.isFixed; }).length;
                    var isFolderAllChecked = folderRemaining > 0 && folderSelected === folderRemaining;
                    var isFolderIndet = folderSelected > 0 && folderSelected < folderRemaining;

                    var filesHtml = '';
                    fileMap.forEach(function(fItems, fPath) {
                        var fileName = fPath.split('/').pop() || fPath;
                        var fFixed = fItems.filter(function(i) { return i.isFixed; }).length;
                        var fRemaining = fItems.length - fFixed;
                        var fSelected = fItems.filter(function(i) { return i.selected && !i.isFixed; }).length;
                        var isFileAllChecked = fRemaining > 0 && fSelected === fRemaining;
                        var isFileIndet = fSelected > 0 && fSelected < fRemaining;

                        filesHtml += '<details open class="accordion-item file-accordion" data-file="' + escapeHtml(fPath) + '">' +
                            '<summary class="accordion-header file-header">' +
                                '<input type="checkbox" class="file-group-check" data-file="' + escapeHtml(fPath) + '" data-folder="' + escapeHtml(folderPath) + '" ' + (isFileAllChecked ? 'checked' : '') + ' ' + (isFileIndet ? 'data-indeterminate="true"' : '') + ' style="cursor:pointer; margin:0 4px 0 0;">' +
                                '<i class="codicon codicon-file-code" style="color:var(--vscode-textLink-foreground)"></i>' +
                                '<span class="accordion-title" title="' + escapeHtml(fPath) + '">' + escapeHtml(fileName) + '</span>' +
                                '<button type="button" class="btn secondary switch-to-file-btn" data-file="' + escapeHtml(fPath) + '" style="height:18px; font-size:9px; padding:0 6px;" title="Focus file">' +
                                    '<i class="codicon codicon-arrow-right"></i> Focus' +
                                '</button>' +
                                '<span class="accordion-badge ' + (fRemaining === 0 ? 'badge-all-fixed' : '') + '">' + (fRemaining === 0 ? ('✓ ALL FIXED (' + fFixed + ')') : (fRemaining + ' remaining')) + '</span>' +
                            '</summary>' +
                            '<div class="file-accordion-body">' +
                                renderSingleCardList(fItems) +
                            '</div>' +
                        '</details>';
                    });

                    accordionHtml += '<details open class="accordion-item folder-accordion" data-folder="' + escapeHtml(folderPath) + '">' +
                        '<summary class="accordion-header folder-header">' +
                            '<input type="checkbox" class="folder-group-check" data-folder="' + escapeHtml(folderPath) + '" ' + (isFolderAllChecked ? 'checked' : '') + ' ' + (isFolderIndet ? 'data-indeterminate="true"' : '') + ' style="cursor:pointer; margin:0 4px 0 0;">' +
                            '<i class="codicon codicon-folder" style="color:var(--vscode-charts-blue)"></i>' +
                            '<span class="accordion-title" title="' + escapeHtml(folderPath) + '">' + escapeHtml(folderPath) + '/</span>' +
                            '<span class="accordion-badge">' + folderRemaining + ' error' + (folderRemaining === 1 ? '' : 's') + ' (' + fileMap.size + ' file' + (fileMap.size === 1 ? '' : 's') + ')</span>' +
                        '</summary>' +
                        '<div class="folder-accordion-body">' +
                            filesHtml +
                        '</div>' +
                    '</details>';
                });

                container.innerHTML = accordionHtml;
                wireAccordionCheckboxes();
                wireCardListeners();
                return;
            }

            container.innerHTML = renderSingleCardList(diagnostics);
            wireCardListeners();
        }

        function renderSingleCardList(list) {
            var out = '';
            var NL = String.fromCharCode(10);

            for (var idx = 0; idx < list.length; idx++) {
                var d = list[idx];
                var critClass = d.criticality || 'critical';
                var isChecked = d.selected;
                var isTargeted = d.isTargeted === true;
                var isFixed = d.isFixed === true;

                var targetFile = d.filePath || targetFilePath;
                var copyPayload = [
                    'File: ' + targetFile,
                    'Line ' + d.line + ':' + d.character,
                    'Error: ' + d.message,
                    (d.source || d.code ? ('Source: ' + (d.source || '') + (d.code ? ' (' + d.code + ')' : '')) : ''),
                    (d.snippet ? ('Code snippet:' + NL + d.snippet) : '')
                ].filter(Boolean).join(NL);
                var encodedPayload = encodeURIComponent(copyPayload);

                if (isFixed) {
                    out += '<div class="error-card fixed ' + (isTargeted ? 'targeted-primary' : '') + '" data-id="' + escapeHtml(d.id) + '" data-line="' + d.line + '">' +
                        '<div style="display:flex; justify-content:space-between; align-items:center;">' +
                            '<div style="display:flex; align-items:center; gap:6px;">' +
                                '<span class="fixed-check-icon" title="Fixed on disk">' +
                                    '<i class="codicon codicon-check"></i>' +
                                '</span>' +
                                '<span class="crit-badge fixed">' +
                                    '<i class="codicon codicon-pass-filled"></i> FIXED' +
                                '</span>' +
                                (isTargeted ? '<span class="target-badge" style="background:var(--vscode-charts-orange); color:white; font-size:9px; font-weight:800; padding:1px 6px; border-radius:3px; letter-spacing:0.5px;">🎯 TARGETED</span>' : '') +
                                '<span style="font-weight:700; font-size:10px; color:var(--vscode-charts-green);">Line ' + d.line + ':' + d.character + '</span>' +
                                '<button type="button" class="btn secondary goto-error-btn" data-line="' + d.line + '" data-character="' + d.character + '" style="height:18px; font-size:9px; padding:0 6px;" title="Go to Line in Editor">' +
                                    '<i class="codicon codicon-go-to-file"></i> Goto' +
                                '</button>' +
                                '<button type="button" class="btn secondary copy-error-btn" data-copy-text="' + encodedPayload + '" style="height:18px; font-size:9px; padding:0 6px;" title="Copy error content for external LLM">' +
                                    '<i class="codicon codicon-copy"></i> Copy' +
                                '</button>' +
                            '</div>' +
                            '<span style="font-size:9.5px; opacity:0.85; font-family:monospace; color:var(--vscode-charts-green); font-weight:bold; white-space:nowrap; flex-shrink:0;">' +
                                '<i class="codicon codicon-check"></i> Resolved on disk' +
                            '</span>' +
                        '</div>' +
                        '<div style="font-size:11px; margin-top:2px;">' +
                            '<span style="text-decoration:line-through; opacity:0.65;">' + escapeHtml(d.message) + '</span>' +
                            '<span style="color:var(--vscode-charts-green); font-weight:bold; font-size:10.5px; margin-left:6px;">✓ Clean</span>' +
                        '</div>' +
                        (d.snippet ? ('<div style="font-family:monospace; font-size:10px; opacity:0.85; background:rgba(0,0,0,0.25); border:1px solid rgba(46, 204, 113, 0.25); padding:3px 6px; border-radius:3px; margin-top:2px; overflow-x:auto;"><code>' + escapeHtml(d.snippet) + '</code></div>') : '') +
                    '</div>';
                } else {
                    out += '<div class="error-card ' + critClass + ' ' + (isTargeted ? 'targeted-primary' : '') + ' ' + (isChecked ? '' : 'unselected') + '" data-id="' + escapeHtml(d.id) + '" data-line="' + d.line + '">' +
                        '<div style="display:flex; justify-content:space-between; align-items:center;">' +
                            '<div style="display:flex; align-items:center; gap:6px;">' +
                                '<input type="checkbox" class="err-check" data-id="' + escapeHtml(d.id) + '" data-file="' + escapeHtml(d.filePath || targetFilePath) + '" ' + (isChecked ? 'checked' : '') + ' style="margin:0; cursor:pointer;">' +
                                '<span class="crit-badge ' + critClass + '">' + critClass.toUpperCase() + '</span>' +
                                (isTargeted ? '<span class="target-badge" style="background:var(--vscode-charts-orange); color:white; font-size:9px; font-weight:800; padding:1px 6px; border-radius:3px; letter-spacing:0.5px;">🎯 TARGETED</span>' : '') +
                                '<span style="font-weight:700; font-size:10px;">Line ' + d.line + ':' + d.character + '</span>' +
                                '<button type="button" class="btn secondary goto-error-btn" data-line="' + d.line + '" data-character="' + d.character + '" style="height:18px; font-size:9px; padding:0 6px;" title="Go to Line in Editor">' +
                                    '<i class="codicon codicon-go-to-file"></i> Goto' +
                                '</button>' +
                                '<button type="button" class="btn secondary copy-error-btn" data-copy-text="' + encodedPayload + '" style="height:18px; font-size:9px; padding:0 6px;" title="Copy error content for external LLM">' +
                                    '<i class="codicon codicon-copy"></i> Copy' +
                                '</button>' +
                            '</div>' +
                            '<span style="font-size:9.5px; opacity:0.65; font-family:monospace; white-space:nowrap; flex-shrink:0;">' + escapeHtml(d.source || '') + (d.code ? (' (' + escapeHtml(d.code) + ')') : '') + '</span>' +
                        '</div>' +
                        '<div style="font-size:11px; margin-top:2px; font-weight:' + (isTargeted ? '600' : 'normal') + ';">' + escapeHtml(d.message) + '</div>' +
                        (d.snippet ? ('<div style="font-family:monospace; font-size:10px; opacity:0.85; background:rgba(0,0,0,0.25); border:1px solid rgba(255,255,255,0.06); padding:3px 6px; border-radius:3px; margin-top:2px; overflow-x:auto;"><code>' + escapeHtml(d.snippet) + '</code></div>') : '') +
                    '</div>';
                }
            }
            return out;
        }

        function wireAccordionCheckboxes() {
            var container = document.getElementById('errorsListContainer');

            container.querySelectorAll('input[data-indeterminate="true"]').forEach(function(cb) {
                cb.indeterminate = true;
            });

            container.querySelectorAll('.folder-group-check').forEach(function(folderCb) {
                folderCb.onchange = function(e) {
                    e.stopPropagation();
                    var folderEl = folderCb.closest('.folder-accordion');
                    if (!folderEl) return;
                    var isChecked = folderCb.checked;
                    folderCb.indeterminate = false;

                    folderEl.querySelectorAll('.file-group-check').forEach(function(fcb) {
                        fcb.checked = isChecked;
                        fcb.indeterminate = false;
                    });

                    folderEl.querySelectorAll('.err-check').forEach(function(cb) {
                        cb.checked = isChecked;
                        var id = cb.dataset.id;
                        var item = diagnosticsList.find(function(d) { return d.id === id; });
                        if (item) item.selected = isChecked;
                    });

                    syncSelectionState();
                };
            });

            container.querySelectorAll('.file-group-check').forEach(function(fileCb) {
                fileCb.onchange = function(e) {
                    e.stopPropagation();
                    var fileEl = fileCb.closest('.file-accordion');
                    if (!fileEl) return;
                    var isChecked = fileCb.checked;
                    fileCb.indeterminate = false;

                    fileEl.querySelectorAll('.err-check').forEach(function(cb) {
                        cb.checked = isChecked;
                        var id = cb.dataset.id;
                        var item = diagnosticsList.find(function(d) { return d.id === id; });
                        if (item) item.selected = isChecked;
                    });

                    var folderEl = fileCb.closest('.folder-accordion');
                    if (folderEl) {
                        updateParentCheckState(folderEl, '.file-group-check', '.folder-group-check');
                    }

                    syncSelectionState();
                };
            });

            container.querySelectorAll('.switch-to-file-btn').forEach(function(btn) {
                btn.onclick = function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    var targetFile = btn.dataset.file;
                    if (targetFile) {
                        vscode.postMessage({ command: 'switchFile', filePath: targetFile });
                    }
                };
            });
        }

        function updateParentCheckState(container, childSelector, parentSelector) {
            var childChecks = Array.from(container.querySelectorAll(childSelector));
            var parentCheck = container.querySelector(parentSelector);
            if (!parentCheck || childChecks.length === 0) return;

            var checkedCount = childChecks.filter(function(c) { return c.checked; }).length;
            var indetCount = childChecks.filter(function(c) { return c.indeterminate; }).length;

            if (checkedCount === childChecks.length) {
                parentCheck.checked = true;
                parentCheck.indeterminate = false;
            } else if (checkedCount > 0 || indetCount > 0) {
                parentCheck.checked = false;
                parentCheck.indeterminate = true;
            } else {
                parentCheck.checked = false;
                parentCheck.indeterminate = false;
            }
        }

        function syncSelectionState() {
            var selectedIds = diagnosticsList.filter(function(d) { return d.selected && !d.isFixed; }).map(function(d) { return d.id; });
            vscode.postMessage({ command: 'updateSelectedIds', ids: selectedIds });

            var remainingCount = diagnosticsList.filter(function(d) { return !d.isFixed; }).length;
            var fixedCount = diagnosticsList.filter(function(d) { return d.isFixed; }).length;
            var selectedHint = document.getElementById('selectedErrorsHint');
            if (selectedHint) {
                selectedHint.textContent = selectedIds.length + ' of ' + remainingCount + ' errors selected for fix' + (fixedCount > 0 ? ' (' + fixedCount + ' fixed)' : '');
            }
        }

        function wireCardListeners() {
            var container = document.getElementById('errorsListContainer');

            container.querySelectorAll('.copy-error-btn').forEach(function(copyBtn) {
                copyBtn.onclick = function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    var text = decodeURIComponent(copyBtn.dataset.copyText || '');
                    vscode.postMessage({ command: 'copyToClipboard', text: text });
                    try { navigator.clipboard.writeText(text); } catch(err) {}
                    var originalHtml = copyBtn.innerHTML;
                    copyBtn.innerHTML = '<i class="codicon codicon-check"></i> Copied!';
                    copyBtn.style.color = 'var(--vscode-charts-green)';
                    setTimeout(function() {
                        copyBtn.innerHTML = originalHtml;
                        copyBtn.style.color = '';
                    }, 1500);
                };
            });

            container.querySelectorAll('.error-card').forEach(function(card) {
                var id = card.dataset.id;
                var line = card.dataset.line;
                var cb = card.querySelector('.err-check');
                var gotoBtn = card.querySelector('.goto-error-btn');

                card.onclick = function(e) {
                    if (e.target.tagName === 'INPUT' || e.target.closest('button')) return;
                    if (card.classList.contains('fixed')) {
                        vscode.postMessage({ command: 'revealLineInEditor', line: line });
                        return;
                    }
                    if (cb) {
                        cb.checked = !cb.checked;
                        cb.dispatchEvent(new Event('change'));
                    }
                    vscode.postMessage({ command: 'revealLineInEditor', line: line });
                };

                if (gotoBtn) {
                    gotoBtn.onclick = function(e) {
                        e.preventDefault();
                        e.stopPropagation();
                        vscode.postMessage({ command: 'revealLineInEditor', line: gotoBtn.dataset.line, character: gotoBtn.dataset.character });
                    };
                }

                if (cb) {
                    cb.onchange = function(e) {
                        e.stopPropagation();
                        var item = diagnosticsList.find(function(d) { return d.id === id; });
                        if (item) item.selected = cb.checked;

                        var fileEl = cb.closest('.file-accordion');
                        if (fileEl) {
                            updateParentCheckState(fileEl, '.err-check', '.file-group-check');
                        }
                        var folderEl = cb.closest('.folder-accordion');
                        if (folderEl) {
                            updateParentCheckState(folderEl, '.err-check', '.folder-group-check');
                        }

                        syncSelectionState();
                    };
                }
            });
        }

        // Webview Inbound Handlers
        window.addEventListener('message', function(event) {
            var msg = event.data;
            switch (msg.command) {
                case 'syncWorkspaceFiles': {
                    var sel = document.getElementById('workspaceFileSelect');
                    var badge = document.getElementById('workspaceBrokenFilesCount');
                    var scoutEl = document.getElementById('mutualizedScoutCount');
                    if (scoutEl && msg.scoutCount !== undefined) scoutEl.textContent = String(msg.scoutCount);
                    var files = msg.files || [];
                    if (badge) badge.textContent = String(files.length);

                    if (sel) {
                        var totalErr = files.reduce(function(sum, f) { return sum + f.count; }, 0);
                        var opts = '<option value="__ALL__" ' + (msg.currentPath === '__ALL__' ? 'selected' : '') + '>🌐 All Files (' + totalErr + ' err across ' + files.length + ' files)</option>';
                        opts += files.map(function(f) {
                            return '<option value="' + escapeHtml(f.path) + '" ' + (f.path === msg.currentPath ? 'selected' : '') + '>' + escapeHtml(f.path) + ' (' + f.count + ' err)</option>';
                        }).join('');
                        sel.innerHTML = opts;
                    }
                    break;
                }
                case 'initData':
                    targetFilePath = msg.filePath;
                    document.getElementById('targetFileSubtitle').textContent = 'Target: ' + msg.filePath;
                    populateModelSelect(msg.models, msg.selectedModel);
                    if (msg.workspaceFiles) {
                        var sel = document.getElementById('workspaceFileSelect');
                        var badge = document.getElementById('workspaceBrokenFilesCount');
                        var scoutEl = document.getElementById('mutualizedScoutCount');
                        if (scoutEl && msg.scoutCount !== undefined) scoutEl.textContent = String(msg.scoutCount);
                        if (badge) badge.textContent = String(msg.workspaceFiles.length);
                        if (sel) {
                            var files = msg.workspaceFiles;
                            var totalErr = files.reduce(function(sum, f) { return sum + f.count; }, 0);
                            var opts = '<option value="__ALL__">🌐 All Files (' + totalErr + ' err across ' + files.length + ' files)</option>';
                            opts += files.map(function(f) {
                                return '<option value="' + escapeHtml(f.path) + '" ' + (f.path === msg.filePath ? 'selected' : '') + '>' + escapeHtml(f.path) + ' (' + f.count + ' err)</option>';
                            }).join('');
                            sel.innerHTML = opts;
                            sel.onchange = function(e) {
                                vscode.postMessage({ command: 'switchFile', filePath: e.target.value });
                            };
                        }
                    }
                    var btnFixAllWs = document.getElementById('btnFixAllWorkspace');
                    if (btnFixAllWs) {
                        btnFixAllWs.onclick = function() {
                            vscode.postMessage({ command: 'runWorkspaceRepair' });
                        };
                    }
                    var scoutBadge = document.getElementById('mutualizedScoutBadge');
                    if (scoutBadge) {
                        scoutBadge.onclick = function() {
                            vscode.postMessage({ command: 'clearMutualizedScouting' });
                        };
                    }
                    if (msg.temperature !== undefined) {
                        document.getElementById('tempSelect').value = String(msg.temperature);
                    }
                    if (msg.reasoningEffort) {
                        document.getElementById('effortSelect').value = msg.reasoningEffort;
                    }
                    if (msg.maxRounds) {
                        var rInp = document.getElementById('maxRoundsInput');
                        if (rInp) rInp.value = String(msg.maxRounds);
                        document.getElementById('roundCounterBadge').textContent = 'Round 0/' + msg.maxRounds;
                    }
                    postSettingsUpdate();
                    break;
                case 'updateModels':
                    populateModelSelect(msg.models, msg.selectedModel);
                    postSettingsUpdate();
                    break;
                case 'scanStarted': {
                    var barContainer = document.getElementById('scanProgressBarContainer');
                    if (barContainer) barContainer.style.display = 'block';
                    var fill = document.getElementById('scanProgressBarFill');
                    if (fill) fill.style.width = '0%';
                    var status = document.getElementById('scanProgressStatus');
                    if (status) status.innerHTML = '<span class="spinner"></span> ' + escapeHtml(msg.status || 'Starting workspace scan...');
                    var pct = document.getElementById('scanProgressPercent');
                    if (pct) pct.textContent = '0%';
                    break;
                }
                case 'scanProgress': {
                    var barContainer = document.getElementById('scanProgressBarContainer');
                    if (barContainer) barContainer.style.display = 'block';
                    var fill = document.getElementById('scanProgressBarFill');
                    if (fill) fill.style.width = msg.percentage + '%';
                    var status = document.getElementById('scanProgressStatus');
                    if (status) status.innerHTML = '<span class="spinner"></span> ' + escapeHtml(msg.status || 'Scanning...');
                    var pct = document.getElementById('scanProgressPercent');
                    if (pct) pct.textContent = msg.percentage + '%';
                    break;
                }
                case 'scanCompleted': {
                    var fill = document.getElementById('scanProgressBarFill');
                    if (fill) fill.style.width = '100%';
                    var status = document.getElementById('scanProgressStatus');
                    if (status) status.innerHTML = '<i class="codicon codicon-check" style="color:var(--vscode-charts-green)"></i> Scan complete: ' + msg.totalErrors + ' error(s) found across ' + msg.totalFilesWithErrors + ' file(s).';
                    var pct = document.getElementById('scanProgressPercent');
                    if (pct) pct.textContent = '100%';
                    setTimeout(function() {
                        var barContainer = document.getElementById('scanProgressBarContainer');
                        if (barContainer) barContainer.style.display = 'none';
                    }, 2200);
                    break;
                }
                case 'scanFailed': {
                    var barContainer = document.getElementById('scanProgressBarContainer');
                    if (barContainer) barContainer.style.display = 'none';
                    break;
                }
                case 'syncState':
                    targetFilePath = msg.filePath;
                    diagnosticsList = msg.diagnostics || [];
                    document.getElementById('targetFileSubtitle').textContent = msg.filePath === '__ALL__' ? 'Target: Workspace (All Broken Files)' : ('Target: ' + msg.filePath);
                    renderErrorCards(msg.diagnostics, msg.selectedCount, msg.totalCount, msg.isSingleErrorMode, msg.hostTotalErrorsCount);
                    if (msg.currentCode) {
                        document.getElementById('currentCodeView').textContent = msg.currentCode;
                    }
                    if (msg.sortOrder) {
                        document.getElementById('orderSelect').value = msg.sortOrder;
                    }
                    break;
                case 'updateDiagnosticsList':
                    renderErrorCards(msg.diagnostics, msg.selectedCount, msg.totalCount);
                    if (msg.sortOrder) {
                        document.getElementById('orderSelect').value = msg.sortOrder;
                    }
                    break;
                case 'repairStarted':
                    isFixing = true;
                    btnRunFix.classList.remove('purple');
                    btnRunFix.classList.add('red');
                    btnRunFix.innerHTML = '<i class="codicon codicon-primitive-square"></i> <span>Stop</span>';
                    document.getElementById('liveStreamingIndicator').style.display = 'flex';
                    document.getElementById('statusIndicatorText').textContent = 'Fixing (' + msg.targetCount + ' selected errors)...';
                    document.getElementById('roundCounterBadge').textContent = 'Round ' + msg.round + '/' + msg.maxRounds;
                    var activeBubble = document.getElementById('activeStreamBubble');
                    if (activeBubble) {
                        activeBubble.innerHTML = '<strong>Repair Agent (Round ' + msg.round + '/' + msg.maxRounds + '):</strong><br><span class="spinner"></span> <em>Connecting to ' + escapeHtml(msg.model || 'model') + ' and drafting fix...</em>';
                    }
                    break;
                case 'repairStreamChunk':
                    if (!isFixing) return;
                    var streamBubble = document.getElementById('activeStreamBubble');
                    if (!streamBubble) {
                        streamBubble = document.createElement('div');
                        streamBubble.id = 'activeStreamBubble';
                        streamBubble.className = 'bubble assistant';
                        document.getElementById('chatStreamBox').appendChild(streamBubble);
                    }
                    streamBubble.innerHTML = '<strong>Repair Agent (Round ' + msg.round + '):</strong><br>' + safeMarked(msg.fullText);
                    document.getElementById('chatStreamBox').scrollTop = document.getElementById('chatStreamBox').scrollHeight;
                    break;
                case 'toolExecuted':
                    var toolBubble = document.createElement('div');
                    toolBubble.className = 'bubble tool';
                    toolBubble.innerHTML = '<strong><i class="codicon codicon-tools"></i> ' + escapeHtml(msg.tool) + ':</strong><br><pre style="margin:2px 0; overflow-x:auto;">' + escapeHtml(msg.output) + '</pre>';
                    document.getElementById('chatStreamBox').appendChild(toolBubble);
                    document.getElementById('chatStreamBox').scrollTop = document.getElementById('chatStreamBox').scrollHeight;
                    break;
                case 'repairPassCompleted':
                    isFixing = false;
                    btnRunFix.classList.remove('red');
                    btnRunFix.classList.add('purple');
                    btnRunFix.innerHTML = '<i class="codicon codicon-sparkle"></i> <span>Fix</span>';
                    document.getElementById('liveStreamingIndicator').style.display = 'none';
                    document.getElementById('statusIndicatorText').textContent = 'Patch Applied to Disk';

                    var streamEl = document.getElementById('activeStreamBubble');
                    if (streamEl) {
                        streamEl.id = '';
                        streamEl.innerHTML = '<strong>✅ Applied Surgical Patch to Disk (Round ' + msg.round + '):</strong><br>' + safeMarked(msg.explanation || 'Patch applied successfully.');
                    } else {
                        var doneBubble = document.createElement('div');
                        doneBubble.className = 'bubble assistant';
                        doneBubble.innerHTML = '<strong>✅ Applied Surgical Patch to Disk (Round ' + msg.round + '):</strong><br>' + safeMarked(msg.explanation || 'Patch applied successfully.');
                        document.getElementById('chatStreamBox').appendChild(doneBubble);
                    }
                    document.getElementById('chatStreamBox').scrollTop = document.getElementById('chatStreamBox').scrollHeight;

                    if (msg.currentCode) {
                        document.getElementById('currentCodeView').textContent = msg.currentCode;
                    }
                    if (msg.patch) {
                        document.getElementById('lastPatchView').textContent = msg.patch;
                    }
                    break;
                case 'repairStopped':
                    isFixing = false;
                    btnRunFix.classList.remove('red');
                    btnRunFix.classList.add('purple');
                    btnRunFix.innerHTML = '<i class="codicon codicon-sparkle"></i> <span>Fix</span>';
                    document.getElementById('liveStreamingIndicator').style.display = 'none';
                    document.getElementById('statusIndicatorText').textContent = 'Stopped by user';
                    break;
                case 'repairError':
                    isFixing = false;
                    btnRunFix.classList.remove('red');
                    btnRunFix.classList.add('purple');
                    btnRunFix.innerHTML = '<i class="codicon codicon-sparkle"></i> <span>Fix</span>';
                    document.getElementById('liveStreamingIndicator').style.display = 'none';
                    document.getElementById('statusIndicatorText').textContent = 'Error during repair';
                    var activeStream = document.getElementById('activeStreamBubble');
                    if (activeStream) {
                        activeStream.id = '';
                        activeStream.style.borderColor = 'var(--vscode-charts-red)';
                        activeStream.innerHTML = '<strong><i class="codicon codicon-error" style="color:var(--vscode-charts-red)"></i> Repair Error:</strong><br><span style="color:var(--vscode-charts-red);">' + escapeHtml(msg.error) + '</span>';
                    } else {
                        var errBox = document.createElement('div');
                        errBox.className = 'bubble';
                        errBox.style.cssText = 'border-left: 3px solid var(--vscode-charts-red); background: rgba(231,76,60,0.1); color: var(--vscode-charts-red);';
                        errBox.innerHTML = '<strong><i class="codicon codicon-error"></i> Repair Error:</strong><br>' + escapeHtml(msg.error);
                        document.getElementById('chatStreamBox').appendChild(errBox);
                    }
                    document.getElementById('chatStreamBox').scrollTop = document.getElementById('chatStreamBox').scrollHeight;
                    break;
            }
        });
    </script>
</body>
</html>`;
    }
}