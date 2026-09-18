import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { minimatch } from 'minimatch';
import { Logger } from '../logger';

export type ContextState = 'included' | 'tree-only' | 'fully-excluded' | 'collapsed' | 'definitions-only';

export class ContextItem extends vscode.TreeItem {
    constructor(
        public readonly resourceUri: vscode.Uri,
        public readonly state: ContextState,
        public readonly isDirectory: boolean
    ) {
        // Force relative path display. If it's the root, show the folder name, not the path.
        const label = vscode.workspace.asRelativePath(resourceUri, false);
        const displayLabel = (label === resourceUri.fsPath || label === "") 
            ? path.basename(resourceUri.fsPath) 
            : label;

        super(
            displayLabel, 
            state === 'collapsed' 
                ? vscode.TreeItemCollapsibleState.None 
                : (isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)
        );
        this.id = resourceUri.toString();
        this.contextValue = `contextItem:${state}`;
        if (state === 'collapsed') {
            this.iconPath = new vscode.ThemeIcon('folder-opened', new vscode.ThemeColor('descriptionForeground'));
            this.description = " (Collapsed - Hidden)";
            this.tooltip = "Folder exists but content is hidden from AI context to save tokens.";
            this.label = `[H] ${this.label}`; // Changed from [C] to [H] (Hidden)
        } else if (state === 'definitions-only') {
            this.description = " (Definitions)";
            this.tooltip = "Only structure (classes, functions signatures) is sent to AI.";
            this.label = `[D] ${this.label}`; // Added [D] prefix
        } else if (state === 'included') {
            this.label = `[C] ${this.label}`; // Added [C] prefix for Content Loaded
        }
    }
}

export const DANGEROUS_BLOCKED_FOLDERS = new Set([
    '.git', '.github', '.lollms', 'node_modules',
    'venv', '.venv', 'env', '.env', 'virtualenv', 'conda-env',
    '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox',
    'dist', 'build', 'out', 'bin', 'obj', 'target',
    'data', 'data_workspace', '.idea', '.vscode',
    '.next', '.nuxt', '.turbo', '.svelte-kit', '.cache'
]);

export function isDangerousOrBlocked(fsPathOrRel: string): boolean {
    if (!fsPathOrRel) return false;
    const normalized = fsPathOrRel.replace(/\\/g, '/');
    const segments = normalized.split('/').filter(Boolean);
    for (const seg of segments) {
        const lower = seg.toLowerCase();
        if (DANGEROUS_BLOCKED_FOLDERS.has(lower)) {
            return true;
        }
        if (lower.startsWith('.') && lower !== '.' && lower !== '..' && lower !== '.gitignore' && lower !== '.env.example') {
            return true;
        }
    }
    return false;
}

export class ContextStateProvider implements vscode.TreeDataProvider<ContextItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ContextItem | undefined | null | void> = new vscode.EventEmitter<ContextItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ContextItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private workspaceFolder?: vscode.WorkspaceFolder;
    private static readonly DEPTH_THRESHOLD = 5;
    private static readonly MUTE_DEEP_WARNING_KEY = 'lollms.muteDeepFolderWarning';
    private static readonly BUILD_DEBUG_PATTERNS = ['dist', 'build', 'out', 'bin', 'obj', 'target'];
    private static readonly VENV_PATTERNS = ['venv', '.venv', 'env', '.env'];

    private _onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[]> = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
    readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[]> = this._onDidChangeFileDecorations.event;

    public context: vscode.ExtensionContext;
    private readonly stateKey: string = 'lollms-context-selection-unified';

    // --- NATIVE DISCOVERY CACHE ---
    private _cachedVisibleFiles: string[] | null = null;
    private _isTreeDirty: boolean = true;
    private activeScanPromise: Promise<string[]> | null = null;

    // Fast-path lookup sets to prevent O(N * M) scans
    private _activeParentPrefixes: Set<string> = new Set();
    private _cachedStateKeys: { [key: string]: ContextState } | null = null;

    private defaultCollapsedFolders = new Set([
        'node_modules', 'dist', 'build', 'out', 'bin', 'obj', 'target',
        'venv', '.venv', 'env', '.env', 'data', 'data_workspace',
        '.git', '.idea', '.vscode', '.ruff_cache', '__pycache__'
    ]);

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('lollmsVsCoder.contextFileExceptions')) {
                this.refresh();
            }
        });

        vscode.workspace.onDidDeleteFiles(e => this.handleFileDeletions(e.files));
        
        // Perform cleanup and migration on init
        this.cleanNonExistentFiles()
            .then(() => this.migrateDefaultCollapsedFolders())
            .then(() => this.refresh());
    }

    private getUnifiedWorkspaceState(): { [key: string]: ContextState } {
        if (this._cachedStateKeys) {
            return this._cachedStateKeys;
        }

        let unified = this.context.workspaceState.get<{ [key: string]: ContextState }>(this.stateKey);
        if (!unified || Object.keys(unified).length === 0) {
            if (this.workspaceFolder) {
                const legacyKey = `context-state-${this.workspaceFolder.uri.fsPath}`;
                const legacy = this.context.workspaceState.get<{ [key: string]: ContextState }>(legacyKey);
                if (legacy && Object.keys(legacy).length > 0) {
                    this.context.workspaceState.update(this.stateKey, legacy);
                    unified = legacy;
                }
            }
        }

        this._cachedStateKeys = unified || {};
        this.rebuildActivePrefixCache(this._cachedStateKeys);
        return this._cachedStateKeys;
    }

    private rebuildActivePrefixCache(workspaceState: { [key: string]: ContextState }) {
        this._activeParentPrefixes.clear();
        for (const [key, st] of Object.entries(workspaceState)) {
            if (st === 'included' || st === 'definitions-only' || st === 'tree-only') {
                const normalized = this.normalize(key);
                const parts = normalized.split('/');
                let accum = '';
                for (let i = 0; i < parts.length - 1; i++) {
                    accum += (i === 0 ? '' : '/') + parts[i];
                    this._activeParentPrefixes.add(accum);
                }
            }
        }
    }

    public async switchWorkspace(newWorkspaceFolder: vscode.WorkspaceFolder) {
        if (!newWorkspaceFolder || !newWorkspaceFolder.uri) return;

        const isSameWorkspace = this.workspaceFolder && 
                                this.workspaceFolder.uri && 
                                this.workspaceFolder.uri.toString() === newWorkspaceFolder.uri.toString();

        this.workspaceFolder = newWorkspaceFolder;

        if (!isSameWorkspace) {
            this._isTreeDirty = true;
            this._cachedVisibleFiles = null;
            await this.cleanNonExistentFiles();
            await this.migrateDefaultCollapsedFolders();
            this.refresh();
        } else {
            this._onDidChangeFileDecorations.fire(undefined);
        }
    }

    refresh(invalidateFiles: boolean = false): void {
        this._cachedStateKeys = null;
        if (invalidateFiles) {
            this._isTreeDirty = true;
            this._cachedVisibleFiles = null;
        }
        this.getUnifiedWorkspaceState();
        this._onDidChangeTreeData.fire();
        this._onDidChangeFileDecorations.fire();
    }

    private normalize(p: string): string {
        return p.replace(/\\/g, '/');
    }


    private async migrateDefaultCollapsedFolders(): Promise<void> {
        const workspaceState = this.getUnifiedWorkspaceState();
        let modified = false;

        for (const key of Object.keys(workspaceState)) {
            const basename = path.basename(key);
            if (this.defaultCollapsedFolders.has(basename) && workspaceState[key] === 'tree-only') {
                delete workspaceState[key];
                modified = true;
            }
        }

        if (modified) {
            await this.context.workspaceState.update(this.stateKey, workspaceState);
        }
    }

    private async cleanNonExistentFiles(): Promise<void> {
        const folders = vscode.workspace.workspaceFolders || [];
        if (folders.length === 0) return;

        const workspaceState = this.getUnifiedWorkspaceState();
        const allFileKeys = Object.keys(workspaceState);
        if (allFileKeys.length === 0) return;

        const keysToRemove: string[] = [];
        const BATCH_SIZE = 25;

        for (let i = 0; i < allFileKeys.length; i += BATCH_SIZE) {
            const batch = allFileKeys.slice(i, i + BATCH_SIZE);
            const batchResults = await Promise.all(batch.map(async (key) => {
                const normalizedKey = this.normalize(key).trim().replace(/^\.?\/+/, '');
                if (isDangerousOrBlocked(normalizedKey)) return key; // Prune blocked files automatically

                for (const folder of folders) {
                    const candidate = vscode.Uri.joinPath(folder.uri, normalizedKey);
                    try {
                        await vscode.workspace.fs.stat(candidate);
                        return null; // Exists
                    } catch {}
                }
                return key;
            }));

            for (const res of batchResults) {
                if (res) keysToRemove.push(res);
            }

            // Yield control back to the event loop between batches
            await new Promise(resolve => setImmediate(resolve));
        }

        if (keysToRemove.length > 0) {
            keysToRemove.forEach(key => {
                delete workspaceState[key];
            });
            this._cachedStateKeys = workspaceState;
            this.rebuildActivePrefixCache(workspaceState);
            await this.context.workspaceState.update(this.stateKey, workspaceState);
        }
    }

    private async handleFileDeletions(deletedFiles: readonly vscode.Uri[]): Promise<void> {
        const workspaceState = this.context.workspaceState.get<{ [key: string]: ContextState }>(this.stateKey, {});
        let stateWasModified = false;
        
        for (const uri of deletedFiles) {
            const relativePath = this.normalize(vscode.workspace.asRelativePath(uri, false));
            if (workspaceState[relativePath]) {
                delete workspaceState[relativePath];
                stateWasModified = true;
            }
        }

        if (stateWasModified) {
            await this.context.workspaceState.update(this.stateKey, workspaceState);
            this.refresh(false);
        }
    }

    getTreeItem(element: ContextItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ContextItem): Promise<ContextItem[]> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) return [];

        if (element && element.state === 'collapsed') {
            return [];
        }

        // Root level: show all workspace folders
        if (!element) {
            return folders.map(f => new ContextItem(f.uri, this.getStateForUri(f.uri), true));
        }

        if (element.isDirectory) {
            this.scoutFolderForCollapsing(element);
        }

        const parentUri = element.resourceUri;
        let entries;
        try {
            entries = await vscode.workspace.fs.readDirectory(parentUri);
        } catch (error) {
            import('../logger').then(m => m.Logger.warn(`Failed to read directory: ${parentUri.toString()}`));
            return [];
        }
        
        const items: ContextItem[] = [];
        for (const [name, type] of entries) {
            const uri = vscode.Uri.joinPath(parentUri, name);
            if (this.isExcluded(uri)) {
                continue;
            }
            
            const isDirectory = type === vscode.FileType.Directory;
            let state = this.getStateForUri(uri);
            
            if (!isDirectory && state === 'collapsed') {
                state = 'tree-only';
            }

            items.push(new ContextItem(uri, state, isDirectory));
        }

        items.sort((a, b) => {
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            return (a.label || '').toString().localeCompare((b.label || '').toString());
        });

        return items;
    }

    private isExcluded(uri: vscode.Uri): boolean {
        if (uri.scheme !== 'file') return true;
        if (isDangerousOrBlocked(uri.fsPath)) return true;

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (!workspaceFolder) return false;

        const relativePath = this.normalize(path.relative(workspaceFolder.uri.fsPath, uri.fsPath));
        if (relativePath === '' || relativePath === '.') return false;

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const exceptions = config.get<string[]>('contextFileExceptions') || [];
        return exceptions.some(pattern => minimatch(relativePath, pattern, { dot: true }));
    }

    public isStrictlyIgnored(uri: vscode.Uri): boolean {
        if (uri.scheme !== 'file') return true;
        if (isDangerousOrBlocked(uri.fsPath)) return true;

        const folder = vscode.workspace.getWorkspaceFolder(uri);
        const rel = folder ? path.relative(folder.uri.fsPath, uri.fsPath) : vscode.workspace.asRelativePath(uri, false);
        const relativePath = this.normalize(rel);

        const workspaceState = this.getUnifiedWorkspaceState();
        if (workspaceState[relativePath] === 'fully-excluded') return true;

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const exceptions = config.get<string[]>('contextFileExceptions') || [];
        return exceptions.some(pattern => minimatch(relativePath, pattern, { dot: true }));
    }

    public getStateForUri(uri: vscode.Uri): ContextState {
        if (uri.scheme !== 'file') return 'tree-only';
        if (isDangerousOrBlocked(uri.fsPath)) return 'fully-excluded';

        const relativePath = this.normalize(vscode.workspace.asRelativePath(uri, false));
        const workspaceState = this.getUnifiedWorkspaceState();

        // 1. O(1) exact match lookup
        if (workspaceState[relativePath]) {
            return workspaceState[relativePath];
        }

        // 2. O(1) lookup: check if this folder prefix contains active children
        if (this._activeParentPrefixes.has(relativePath)) {
            return 'tree-only';
        }

        // 3. Fast ancestor check without scanning workspaceState keys
        let currentPath = relativePath;
        while (currentPath.includes('/')) {
            const lastSlash = currentPath.lastIndexOf('/');
            currentPath = currentPath.substring(0, lastSlash);

            const parentState = workspaceState[currentPath];
            if (parentState === 'fully-excluded') return 'fully-excluded';
            if (parentState === 'collapsed') return 'collapsed';

            const parentBasename = path.basename(currentPath);
            if (this.defaultCollapsedFolders.has(parentBasename) || isDangerousOrBlocked(parentBasename)) {
                return 'collapsed';
            }
        }

        const basename = path.basename(uri.fsPath);
        if (this.defaultCollapsedFolders.has(basename) || isDangerousOrBlocked(basename)) {
            return 'collapsed';
        }

        return 'tree-only';
    }

    public async setStateForUris(uris: vscode.Uri[], state: ContextState) {
        if (uris.length === 0) return;

        const workspaceState = this.getUnifiedWorkspaceState();
        const modifiedUris: vscode.Uri[] = [];

        for (const uri of uris) {
            if (uri.scheme !== 'file') continue;
            if (isDangerousOrBlocked(uri.fsPath)) continue;

            const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
            if (!workspaceFolder) continue;

            const relativePath = this.normalize(vscode.workspace.asRelativePath(uri, false));
            modifiedUris.push(uri);

            let isDirectory = false;
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                isDirectory = stat.type === vscode.FileType.Directory;
            } catch (e) {
                // Treated as single file path if stat fails
            }

            if (isDirectory) {
                // O(1) in-memory state pruning for folder children: no recursive disk walks needed
                const prefix = relativePath + '/';
                for (const key of Object.keys(workspaceState)) {
                    const normKey = this.normalize(key);
                    if (normKey === relativePath || normKey.startsWith(prefix)) {
                        delete workspaceState[key];
                    }
                }

                if (state === 'included' || state === 'definitions-only') {
                    // Lightweight bounded crawl for text inclusion only
                    await this.updateChildrenState(uri, state, workspaceState);
                } else {
                    // For 'fully-excluded', 'collapsed', 'tree-only': set folder directly
                    workspaceState[relativePath] = state;
                }
            } else {
                if (state === 'collapsed') {
                    workspaceState[relativePath] = 'tree-only';
                } else {
                    workspaceState[relativePath] = state;
                }
            }
        }

        this._cachedStateKeys = workspaceState;
        this.rebuildActivePrefixCache(workspaceState);
        await this.context.workspaceState.update(this.stateKey, workspaceState);

        // Instant refresh: notify tree provider and refresh visible decorations in viewport
        this._onDidChangeTreeData.fire();
        this._onDidChangeFileDecorations.fire(undefined);
    }
    
    public async setStateForUri(uri: vscode.Uri, state: ContextState) {
        await this.setStateForUris([uri], state);
    }

    /**
     * Checks if a file is suitable for direct inclusion in the LLM text context.
     * Excludes binaries, images, and complex docs (PDF/Office).
     */
    private isLightweightTextFile(uri: vscode.Uri): boolean {
        const ext = path.extname(uri.fsPath).toLowerCase();
        const commonBinaries = new Set([
            '.exe', '.dll', '.so', '.dylib', '.pyc', '.o', '.obj', '.bin', '.dat', 
            '.zip', '.tar', '.gz', '.7z', '.rar', '.iso', '.img', '.db', '.sqlite',
            '.pth', '.pt', '.onnx', '.tflite', '.pb', '.h5', '.hdf5', '.pkl', '.pickle'
        ]);

        if (commonBinaries.has(ext)) {
            return false;
        }

        // Text files, rich documents (.pdf, .docx, .xlsx, .pptx), and images (which load into multimodal vision) are allowed
        return true;
    }

    private async updateChildrenState(dirUri: vscode.Uri, state: ContextState, workspaceState: { [key: string]: ContextState }): Promise<void> {
        let filesIncludedCount = 0;
        let filesSkippedCount = 0;
        const MAX_DEPTH = 4;
        const MAX_FILES = 500;

        const processDirectory = async (currentDirUri: vscode.Uri, depth: number) => {
            if (depth > MAX_DEPTH || filesIncludedCount >= MAX_FILES) return;
            if (isDangerousOrBlocked(currentDirUri.fsPath) || this.isExcluded(currentDirUri)) return;

            let entries;
            try {
                entries = await vscode.workspace.fs.readDirectory(currentDirUri);
            } catch (error) {
                return;
            }

            for (const [name, type] of entries) {
                if (filesIncludedCount >= MAX_FILES) break;
                if (isDangerousOrBlocked(name)) continue;

                const entryUri = vscode.Uri.joinPath(currentDirUri, name);
                if (this.isExcluded(entryUri)) continue;

                if (type === vscode.FileType.Directory) {
                    await processDirectory(entryUri, depth + 1);
                } else if (type === vscode.FileType.File) {
                    if (state === 'included' && !this.isLightweightTextFile(entryUri)) {
                        filesSkippedCount++;
                        continue; 
                    }

                    const relativePath = this.normalize(vscode.workspace.asRelativePath(entryUri, false));
                    workspaceState[relativePath] = state;
                    filesIncludedCount++;
                }
            }
        };

        await processDirectory(dirUri, 0);

        if (state === 'included' && filesSkippedCount > 0) {
            vscode.window.showInformationMessage(
                `Lollms: Included ${filesIncludedCount} text files. Skipped ${filesSkippedCount} non-text/binary files.`
            );
        }
    }

    private async getAllDescendantUris(dirUri: vscode.Uri): Promise<vscode.Uri[]> {
        const descendants: vscode.Uri[] = [];
        try {
            const processDirectory = async (currentDirUri: vscode.Uri) => {
                let entries;
                try {
                    entries = await vscode.workspace.fs.readDirectory(currentDirUri);
                } catch (error) {
                    return;
                }
        
                for (const [name, type] of entries) {
                    const entryUri = vscode.Uri.joinPath(currentDirUri, name);
                    descendants.push(entryUri);
                    if (type === vscode.FileType.Directory) {
                        await processDirectory(entryUri);
                    }
                }
            };
            await processDirectory(dirUri);
        } catch (e) {}
        return descendants;
    }

    public async triggerFullScan(onProgress?: (pct: number, status: string) => void): Promise<string[]> {
        if (this.activeScanPromise) {
            return this.activeScanPromise;
        }

        this.activeScanPromise = (async () => {
            const folder = this.workspaceFolder || (vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0] : undefined);
            if (!folder) return [];

            this._isTreeDirty = true;
            this._cachedVisibleFiles = null;

            if (onProgress) onProgress(10, "Librarian: Compiling ignore-patterns...");

            const config = vscode.workspace.getConfiguration('lollmsVsCoder');
            const exceptions = config.get<string[]>('contextFileExceptions') || [];

            const standardExcludes = [
                '**/.*/**', '**/__pycache__/**', '**/*.pyc', '**/*.pyo', '**/*.pyd',
                '**/*.obj', '**/*.bin', '**/.DS_Store', '**/node_modules/**', 
                '**/venv/**', '**/.venv/**', '**/env/**', '**/.env/**', '**/virtualenv/**', '**/conda-env/**',
                '**/.git/**', '**/.github/**', '**/.lollms/**',
                '**/bin/**', '**/obj/**', '**/dist/**', '**/build/**', '**/out/**', '**/target/**',
                '**/data/**', '**/data_workspace/**', '**/.idea/**', '**/.vscode/**',
                '**/.pytest_cache/**', '**/.mypy_cache/**', '**/.ruff_cache/**', '**/.cache/**',
                '**/.next/**', '**/.nuxt/**', '**/.turbo/**'
            ];

            const combinedExcludes = Array.from(new Set([...exceptions, ...standardExcludes]));
            const excludePattern = `{${combinedExcludes.join(',')}}`;

            if (onProgress) onProgress(30, "Librarian: Indexing files (ripgrep scan)...");

            let files: vscode.Uri[] = [];
            try {
                files = await vscode.workspace.findFiles(
                    new vscode.RelativePattern(folder, '**/*'),
                    excludePattern,
                    8000
                );
            } catch (e: any) {
                Logger.error(`Native findFiles failed: ${e}`);
            }

            if (files.length === 0) {
                if (onProgress) onProgress(50, "Librarian: Scanning folders manually...");
                const fallbackFiles: vscode.Uri[] = [];
                const walk = async (uri: vscode.Uri, depth: number) => {
                    if (depth > 4) return;
                    if (this.isExcluded(uri) || isDangerousOrBlocked(uri.fsPath)) return;

                    try {
                        const entries = await vscode.workspace.fs.readDirectory(uri);
                        for (const [name, type] of entries) {
                            const entryUri = vscode.Uri.joinPath(uri, name);
                            if (isDangerousOrBlocked(name) || this.isExcluded(entryUri)) continue;
                            if (type === vscode.FileType.File) {
                                fallbackFiles.push(entryUri);
                            } else if (type === vscode.FileType.Directory) {
                                await walk(entryUri, depth + 1);
                            }
                        }
                    } catch (e) {}
                };
                await walk(folder.uri, 0);
                files = fallbackFiles;
            }

            if (onProgress) onProgress(75, "Librarian: Constructing semantic model...");

            const visibleFiles: string[] = [];
            const BATCH_SIZE = 150;

            for (let i = 0; i < files.length; i++) {
                if (i > 0 && i % BATCH_SIZE === 0) {
                    await new Promise(resolve => setImmediate(resolve));
                }

                const file = files[i];
                if (isDangerousOrBlocked(file.fsPath) || this.isExcluded(file)) continue;

                const state = this.getStateForUri(file);
                if (state !== 'fully-excluded') {
                    visibleFiles.push(this.normalize(vscode.workspace.asRelativePath(file, false)));
                }
            }

            this._cachedVisibleFiles = visibleFiles;
            this._isTreeDirty = false;

            if (onProgress) onProgress(100, "Librarian: Indexing complete.");

            return visibleFiles;
        })().finally(() => {
            this.activeScanPromise = null;
        });

        return this.activeScanPromise;
    }

    public async getAllVisibleFiles(signal?: AbortSignal, onProgress?: (pct: number, status: string) => void): Promise<string[]> {
        if (this._cachedVisibleFiles && this._cachedVisibleFiles.length > 0 && !this._isTreeDirty) {
            return this._cachedVisibleFiles;
        }
        return this.triggerFullScan(onProgress);
    }

    public addFileToCache(relativeFilePath: string) {
        if (!this._cachedVisibleFiles) return;
        const normalized = this.normalize(relativeFilePath);
        if (!this._cachedVisibleFiles.includes(normalized)) {
            this._cachedVisibleFiles.push(normalized);
            this._cachedVisibleFiles.sort();
            this._onDidChangeTreeData.fire();
        }
    }

    public removeFileFromCache(relativeFilePath: string) {
        if (!this._cachedVisibleFiles) return;
        const normalized = this.normalize(relativeFilePath);
        this._cachedVisibleFiles = this._cachedVisibleFiles.filter(f => f !== normalized);
        this._onDidChangeTreeData.fire();
    }
    
    public getIncludedFiles(): { path: string, state: ContextState, bytes?: number, tokens?: number }[] {
        const workspaceState = this.getUnifiedWorkspaceState();
        if (!workspaceState) return [];

        const folders = vscode.workspace.workspaceFolders || [];
        if (folders.length === 0) return [];

        const resultsMap = new Map<string, { path: string, state: ContextState, bytes: number, tokens: number }>();

        for (const [key, state] of Object.entries(workspaceState)) {
            if (!key || typeof key !== 'string') continue;
            if (state !== 'included' && state !== 'definitions-only') continue;

            const normalizedKey = this.normalize(key).trim().replace(/^\.?\/+/, '');
            if (isDangerousOrBlocked(normalizedKey)) continue;

            // Check if any ancestor folder is explicitly fully-excluded
            let currentPath = normalizedKey;
            let isParentExcluded = false;
            while (currentPath.includes('/')) {
                const lastSlash = currentPath.lastIndexOf('/');
                currentPath = currentPath.substring(0, lastSlash);
                const parentState = workspaceState[currentPath];
                if (parentState === 'fully-excluded' || parentState === 'collapsed') {
                    isParentExcluded = true;
                    break;
                }
            }
            if (isParentExcluded) continue;

            // Use fast cached sizes if available
            resultsMap.set(normalizedKey, { path: key, state, bytes: 0, tokens: 0 });
        }

        return Array.from(resultsMap.values());
    }

    public async addFilesToContext(files: string[]): Promise<string[]> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) return [];

        const workspaceState = this.getUnifiedWorkspaceState();
        const urisToFire: vscode.Uri[] = [];
        const addedPaths: string[] = [];

        for (const file of files) {
            let targetUri: vscode.Uri | undefined;
            // Clean paths aggressively by stripping both leading AND trailing slashes
            const normalizedPath = this.normalize(file).trim().replace(/^\/+/, '').replace(/\/+$/, '');
            if (!normalizedPath) continue;

            const segments = normalizedPath.split('/');
            const fileName = segments[segments.length - 1];

            // 1. DIRECT CHECK: Check across all roots for direct relative path existence
            for (const folder of folders) {
                const testUri = vscode.Uri.joinPath(folder.uri, normalizedPath);
                try {
                    await vscode.workspace.fs.stat(testUri);
                    targetUri = testUri;
                    break;
                } catch {}
            }

            // 2. SOVEREIGN NAMESPACE CHECK: If direct path not found, check if first segment matches folder name
            if (!targetUri && segments.length > 1) {
                const projectFolder = folders.find(f => f.name.toLowerCase() === segments[0].toLowerCase());
                if (projectFolder) {
                    const subPath = segments.slice(1).join('/');
                    const namespacedUri = vscode.Uri.joinPath(projectFolder.uri, subPath);
                    try { 
                        await vscode.workspace.fs.stat(namespacedUri); 
                        targetUri = namespacedUri;
                    } catch {}
                }
            }

            // 3. HEURISTIC FALLBACK: Try partial segment matching (only if filename is valid)
            if (!targetUri && fileName && fileName.trim().length > 0 && fileName !== '.' && fileName !== '..') {
                const foundFiles = await vscode.workspace.findFiles(`**/${fileName}`, '**/node_modules/**', 10);
                if (foundFiles.length > 0) {
                    // Score them by how many segments from the end match
                    let bestMatch = foundFiles[0];
                    let bestScore = 0;
                    for (const f of foundFiles) {
                        const fPath = this.normalize(f.fsPath);
                        let score = 0;
                        for (let i = 1; i <= segments.length; i++) {
                            if (fPath.endsWith(segments.slice(-i).join('/'))) score = i;
                            else break;
                        }
                        if (score > bestScore) {
                            bestScore = score;
                            bestMatch = f;
                        }
                    }
                    targetUri = bestMatch;
                }
            }

            // If we found a valid URI, record the state using the canonical VS Code key
            if (targetUri) {
                const stat = await vscode.workspace.fs.stat(targetUri).catch(() => null);
                if (stat && stat.type === vscode.FileType.Directory) {
                    // Recursively include all text files inside the directory
                    await this.updateChildrenState(targetUri, 'included', workspaceState);
                    urisToFire.push(targetUri);
                    addedPaths.push(file);
                    Logger.info(`[Librarian] Successfully resolved and expanded directory: ${targetUri.fsPath}`);
                } else {
                    const key = this.normalize(vscode.workspace.asRelativePath(targetUri, false));
                    workspaceState[key] = 'included';
                    urisToFire.push(targetUri);
                    addedPaths.push(file); // Return the original string so the webview can map it back
                    Logger.info(`[Librarian] Successfully resolved and added: ${key}`);

                    // INCREMENTAL CACHE UPDATE: Do not invalidate the entire visible files cache.
                    if (this._cachedVisibleFiles && !this._cachedVisibleFiles.includes(key)) {
                        this._cachedVisibleFiles.push(key);
                    }
                }
            } else {
                Logger.warn(`[Librarian] Failed to resolve path: ${file}`);
            }
        }

        await this.context.workspaceState.update(this.stateKey, workspaceState);

        // Fire incremental decoration updates and tree data changes without calling a full refresh()
        this._isTreeDirty = false; // Preserve cache
        this._onDidChangeTreeData.fire();
        this._onDidChangeFileDecorations.fire(urisToFire);
        return addedPaths;
    }

    public async fullReset(): Promise<void> {
        this._cachedStateKeys = null;
        this._activeParentPrefixes.clear();
        this._isTreeDirty = true;
        this._cachedVisibleFiles = null;
        await this.context.workspaceState.update(this.stateKey, {});
        this.refresh(true);
        this._onDidChangeFileDecorations.fire(undefined); 
    }

    public async softReset(): Promise<void> {
        const workspaceState = this.getUnifiedWorkspaceState();
        const newState: { [key: string]: ContextState } = {};

        for (const [key, state] of Object.entries(workspaceState)) {
            // Keep exclusions and collapsed folders.
            // Revert 'included' and 'definitions-only' to default (tree-only).
            if (state === 'fully-excluded' || state === 'collapsed') {
                newState[key] = state;
            }
        }

        this._cachedStateKeys = null;
        this._activeParentPrefixes.clear();
        this._isTreeDirty = true;
        this._cachedVisibleFiles = null;
        await this.context.workspaceState.update(this.stateKey, newState);
        this.refresh(true);
        this._onDidChangeFileDecorations.fire(undefined);
    }

    /**
     * Scouts a folder during expansion to see if it should be suggested for collapsing.
     */
    private async scoutFolderForCollapsing(_item: ContextItem) {
        // Fast no-op to eliminate background popups and stat calls on big trees
    }
}
