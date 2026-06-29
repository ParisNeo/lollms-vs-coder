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

export class ContextStateProvider implements vscode.TreeDataProvider<ContextItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ContextItem | undefined | null | void> = new vscode.EventEmitter<ContextItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ContextItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private workspaceFolder?: vscode.WorkspaceFolder;
    private static readonly DEPTH_THRESHOLD = 5;
    private static readonly MUTE_DEEP_WARNING_KEY = 'lollms.muteDeepFolderWarning';

    private _onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[]> = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
    readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[]> = this._onDidChangeFileDecorations.event;

    public context: vscode.ExtensionContext;
    private readonly stateKey: string = 'lollms-context-selection-unified';

    // --- NATIVE DISCOVERY CACHE ---
    private _cachedVisibleFiles: string[] | null = null;
    private _isTreeDirty: boolean = true;
    private activeScanPromise: Promise<string[]> | null = null;

    private defaultCollapsedFolders = new Set([
        'node_modules', 'dist', 'build', 'out', 'bin', 'obj', 'target',
        'venv', '.venv', 'env', '.env', 
        '.git', '.idea', '.vscode', '.ruff_cache'
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

    public async switchWorkspace(newWorkspaceFolder: vscode.WorkspaceFolder) {
        this.workspaceFolder = newWorkspaceFolder;
        this.stateKey = `context-state-${newWorkspaceFolder.uri.fsPath}`;
        this._isTreeDirty = true;
        this._cachedVisibleFiles = null;
        await this.cleanNonExistentFiles();
        await this.migrateDefaultCollapsedFolders();
        this.refresh();
    }

    refresh(): void {
        this._isTreeDirty = true;
        this._cachedVisibleFiles = null;
        this._onDidChangeTreeData.fire();
        this._onDidChangeFileDecorations.fire();
    }

    private normalize(p: string): string {
        return p.replace(/\\/g, '/');
    }


    private async migrateDefaultCollapsedFolders(): Promise<void> {
        const workspaceState = this.context.workspaceState.get<{ [key: string]: ContextState }>(this.stateKey, {});
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
        const workspaceFolder = this.workspaceFolder;
        if (!workspaceFolder) return;
    
        const workspaceState = this.context.workspaceState.get<{ [key: string]: ContextState }>(this.stateKey, {});
        const allFileKeys = Object.keys(workspaceState);
    
        const checkPromises = allFileKeys.map(async (key) => {
            const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, key);
            try {
                await vscode.workspace.fs.stat(fileUri);
            } catch (error) {
                return key;
            }
            return null;
        });
    
        const keysToRemove = (await Promise.all(checkPromises)).filter(key => key !== null);
    
        if (keysToRemove.length > 0) {
            keysToRemove.forEach(key => {
                if (key) delete workspaceState[key];
            });
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
            this.refresh();
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
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (!workspaceFolder) {
            return false;
        }

        const relativePath = this.normalize(path.relative(workspaceFolder.uri.fsPath, uri.fsPath));
        const segments = relativePath.split('/').map(s => s.toLowerCase());

        // Unconditionally exclude internal system directories and python caches
        if (segments.includes('__pycache__') || segments.includes('.lollms')) {
            return true;
        }

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const exceptions = config.get<string[]>('contextFileExceptions') || [];

        if (relativePath === '') {
            return false;
        }

        return exceptions.some(pattern => minimatch(relativePath, pattern, { dot: true }));
    }

    public getStateForUri(uri: vscode.Uri): ContextState {
        // Overrule with strict ignore rules (heavy folders, globs, etc.)
        if (this.isStrictlyIgnored(uri)) {
            return 'fully-excluded';
        }

        const workspaceState = this.context.workspaceState.get<{ [key: string]: ContextState }>(this.stateKey, {});
        const relativePath = this.normalize(vscode.workspace.asRelativePath(uri, false));

        // 1. Check exact match
        if (workspaceState[relativePath]) {
            return workspaceState[relativePath];
        }

        // 2. Check if this folder currently contains any active/included files or subfolders
        // If it does, we must force it to remain uncollapsed to maintain UI synchronization.
        const hasActiveChildren = Object.keys(workspaceState).some(key => {
            const normKey = this.normalize(key);
            return normKey.startsWith(relativePath + '/') && 
                   (workspaceState[key] === 'included' || workspaceState[key] === 'definitions-only' || workspaceState[key] === 'tree-only');
        });

        if (hasActiveChildren) {
            return 'tree-only';
        }

        // 3. Check for ancestor state (inheritance for exclusion/collapsed)
        let currentPath = relativePath;
        while (currentPath.includes('/')) {
            const lastSlash = currentPath.lastIndexOf('/');
            currentPath = currentPath.substring(0, lastSlash);

            const parentState = workspaceState[currentPath];
            if (parentState === 'fully-excluded') return 'fully-excluded';
            if (parentState === 'collapsed') return 'collapsed';

            // Also check default collapsed folders and dot-folders for parents
            const parentBasename = path.basename(currentPath);
            if (this.defaultCollapsedFolders.has(parentBasename) || parentBasename.startsWith('.')) {
                return 'collapsed';
            }
        }

        const basename = path.basename(uri.fsPath);
        if (this.defaultCollapsedFolders.has(basename) || basename.startsWith('.')) {
            return 'collapsed';
        }

        // DEFAULT BEHAVIOR: If it's not ignored or collapsed, it's visible in the tree.
        return 'tree-only';
    }

        /**
        * Checks if a URI should be strictly hidden from the tree (e.g. build artifacts, internal caches)
        */
        public isStrictlyIgnored(uri: vscode.Uri): boolean {
            const relativePath = this.normalize(vscode.workspace.asRelativePath(uri, false));
            const basename = path.basename(uri.fsPath).toLowerCase();
            const segments = relativePath.split('/').map(s => s.toLowerCase());

            // Unconditionally block .lollms from entering any visible indexing state
            if (segments.includes('.lollms') || basename === '.lollms') {
                return true;
            }

            // Standard heavy folders
            if (['node_modules', '.git', '__pycache__', 'venv', '.venv', 'dist', 'build', 'bin', 'obj'].includes(basename)) {
                return true;
            }

            const config = vscode.workspace.getConfiguration('lollmsVsCoder');
            const exceptions = config.get<string[]>('contextFileExceptions') || [];

            // Block if matches glob
            const isGlobIgnored = exceptions.some(pattern => minimatch(relativePath, pattern, { dot: true }));

            // Direct workspaceState check to prevent recursive infinite loops
            const workspaceState = this.context.workspaceState.get<{ [key: string]: ContextState }>(this.stateKey, {});
            const isManuallyExcluded = workspaceState[relativePath] === 'fully-excluded';

            return isGlobIgnored || isManuallyExcluded;
        }

    public async setStateForUris(uris: vscode.Uri[], state: ContextState) {
        if (uris.length === 0) {
            Logger.warn("ContextStateProvider: setStateForUris called with empty list.");
            return;
        }
        
        Logger.info(`ContextStateProvider: Setting state '${state}' for ${uris.length} files.`);

        const workspaceState = this.context.workspaceState.get<{ [key: string]: ContextState }>(this.stateKey, {});
        const allUrisToFire = new Set<string>();

        for (const uri of uris) {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
            if (!workspaceFolder) {
                Logger.warn(`ContextStateProvider: Skipping ${uri.fsPath} (not in workspace)`);
                continue;
            }

            const relativePath = this.normalize(vscode.workspace.asRelativePath(uri, false));
            Logger.info(`ContextStateProvider: Updating ${relativePath} -> ${state}`);
            allUrisToFire.add(uri.toString());

            let isDirectory = false;
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                isDirectory = stat.type === vscode.FileType.Directory;
            } catch (e) {
                // File deleted on disk but still in memory state
                Logger.warn(`ContextStateProvider: File not found on disk, treating as file for state update: ${uri.fsPath}`);
            }

            if (isDirectory) {
                const descendantUris = await this.getAllDescendantUris(uri);
                descendantUris.forEach(u => allUrisToFire.add(u.toString()));

                // Remove existing states for children to enforce new parent state
                Object.keys(workspaceState).forEach(key => {
                    const normalizedKey = this.normalize(key);
                    if (normalizedKey === relativePath || normalizedKey.startsWith(relativePath + '/')) {
                        delete workspaceState[key];
                    }
                });

                if (state === 'included' || state === 'definitions-only') {
                    // Explicitly add all children files for these states
                    await this.updateChildrenState(uri, state, workspaceState);
                } else {
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

        await this.context.workspaceState.update(this.stateKey, workspaceState);
        const urisToUpdate = Array.from(allUrisToFire).map(s => vscode.Uri.parse(s));
        this.refresh();
        this._onDidChangeFileDecorations.fire(urisToUpdate);
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
        const complexDocs = new Set(['.pdf', '.docx', '.pptx', '.xlsx', '.msg', '.odt', '.rtf']);
        const images = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.tiff']);
        const commonBinaries = new Set(['.exe', '.dll', '.so', '.dylib', '.pyc', '.o', '.obj', '.bin', '.dat']);

        if (complexDocs.has(ext) || images.has(ext) || commonBinaries.has(ext)) {
            return false;
        }

        return true;
    }

    private async updateChildrenState(dirUri: vscode.Uri, state: ContextState, workspaceState: { [key: string]: ContextState }): Promise<vscode.Uri[]> {
        const urisToFire: vscode.Uri[] = [dirUri];
        let filesIncludedCount = 0;
        let filesSkippedCount = 0;

        const processDirectory = async (currentDirUri: vscode.Uri) => {
            let entries;
            try {
                entries = await vscode.workspace.fs.readDirectory(currentDirUri);
            } catch (error) {
                return;
            }

            for (const [name, type] of entries) {
                const entryUri = vscode.Uri.joinPath(currentDirUri, name);
                if (this.isExcluded(entryUri)) {
                    continue;
                }

                if (type === vscode.FileType.Directory) {
                    // Folders are always added to the 'fire' list to update decorations
                    urisToFire.push(entryUri);
                    // Inherit state only if not collapsed or excluded
                    if (state !== 'collapsed' && state !== 'fully-excluded') {
                        await processDirectory(entryUri);
                    } else {
                         const relativePath = this.normalize(vscode.workspace.asRelativePath(entryUri, false));
                         workspaceState[relativePath] = state;
                    }
                } else if (type === vscode.FileType.File) {
                    // Only include if it's a genuine text file
                    if (state === 'included' && !this.isLightweightTextFile(entryUri)) {
                        filesSkippedCount++;
                        continue; 
                    }

                    const relativePath = this.normalize(vscode.workspace.asRelativePath(entryUri, false));
                    workspaceState[relativePath] = state;
                    urisToFire.push(entryUri);
                    filesIncludedCount++;
                }
            }
        };

        await processDirectory(dirUri);

        if (state === 'included' && filesSkippedCount > 0) {
            vscode.window.showInformationMessage(
                `Lollms: Included ${filesIncludedCount} text files. Skipped ${filesSkippedCount} non-text files (PDF, images, etc).`
            );
        }

        this._onDidChangeFileDecorations.fire(urisToFire);
        return urisToFire;
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
                '**/__pycache__/**', '**/*.pyc', '**/*.pyo', '**/*.pyd',
                '**/*.obj', '**/*.bin', '**/.DS_Store', '**/node_modules/**', '**/venv/**', '**/.venv/**', '**/env/**', '**/.git/**'
            ];

            const combinedExcludes = Array.from(new Set([...exceptions, ...standardExcludes]));
            const excludePattern = combinedExcludes.length > 1 ? `{${combinedExcludes.join(',')}}` : (combinedExcludes[0] || "");

            if (onProgress) onProgress(30, "Librarian: Indexing files (ripgrep scan)...");

            let files: vscode.Uri[] = [];
            try {
                files = await vscode.workspace.findFiles(
                    new vscode.RelativePattern(folder, '**/*'),
                    excludePattern,
                    20000 // Large cap for big projects
                );
            } catch (e: any) {
                Logger.error(`Native findFiles failed: ${e}`);
            }

            if (files.length === 0) {
                if (onProgress) onProgress(50, "Librarian: Scanning folders manually...");
                const fallbackFiles: vscode.Uri[] = [];
                const walk = async (uri: vscode.Uri, depth: number) => {
                    if (depth > 4) return;
                    try {
                        const entries = await vscode.workspace.fs.readDirectory(uri);
                        for (const [name, type] of entries) {
                            const entryUri = vscode.Uri.joinPath(uri, name);
                            if (this.isExcluded(entryUri)) continue;
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
            for (const file of files) {
                if (this.isExcluded(file)) continue;
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

    public async getAllVisibleFiles(signal?: AbortSignal): Promise<string[]> {
        if (this._cachedVisibleFiles && !this._isTreeDirty) {
            return this._cachedVisibleFiles;
        }
        return this.triggerFullScan();
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
    
    public getIncludedFiles(): { path: string, state: ContextState }[] {
        const workspaceState = this.context.workspaceState.get<{ [key: string]: ContextState }>(this.stateKey, {});
        if (!workspaceState) return [];

        const workspaceFolder = this.workspaceFolder || (vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0] : undefined);
        if (!workspaceFolder) return [];

        const folders = vscode.workspace.workspaceFolders || [];

        return Object.entries(workspaceState)
            .filter(([key, state]) => {
                if (!key || typeof key !== 'string') return false;
                if (state !== 'included' && state !== 'definitions-only') return false;

                // 1. Resolve URI
                let fileUri: vscode.Uri;
                const segments = key.split('/');
                const projectFolder = folders.length > 1
                    ? folders.find(f => f.name.toLowerCase() === segments[0].toLowerCase())
                    : undefined;
                if (projectFolder && segments.length > 1) {
                    fileUri = vscode.Uri.joinPath(projectFolder.uri, segments.slice(1).join('/'));
                } else {
                    fileUri = vscode.Uri.joinPath(workspaceFolder.uri, key);
                }

                // 2. Strict ignore check (heavy folders, glob exclusions, etc.)
                if (this.isStrictlyIgnored(fileUri)) {
                    return false;
                }

                // Effective State Check: Ensure no parent is 'collapsed' or 'fully-excluded'
                // which would override this specific file's inclusion.
                let currentPath = key;
                while (currentPath.includes('/')) {
                    const lastSlash = currentPath.lastIndexOf('/');
                    currentPath = currentPath.substring(0, lastSlash);
                    const parentState = workspaceState[currentPath];
                    if (parentState === 'collapsed' || parentState === 'fully-excluded') return false;

                    let parentUri: vscode.Uri;
                    const parentSegments = currentPath.split('/');
                    const parentFolder = folders.length > 1
                        ? folders.find(f => f.name.toLowerCase() === parentSegments[0].toLowerCase())
                        : undefined;
                    if (parentFolder && parentSegments.length > 1) {
                        parentUri = vscode.Uri.joinPath(parentFolder.uri, parentSegments.slice(1).join('/'));
                    } else {
                        parentUri = vscode.Uri.joinPath(workspaceFolder.uri, currentPath);
                    }

                    if (this.isStrictlyIgnored(parentUri)) return false;
                }
                return true;
            })
            .map(([key, state]) => ({ path: key, state }));
    }

    public async addFilesToContext(files: string[]): Promise<string[]> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) return [];

        const workspaceState = this.context.workspaceState.get<{ [key: string]: ContextState }>(this.stateKey, {});
        const urisToFire: vscode.Uri[] = [];
        const addedPaths: string[] = [];

        for (const file of files) {
            let targetUri: vscode.Uri | undefined;
            // Clean paths aggressively by stripping both leading AND trailing slashes
            const normalizedPath = this.normalize(file).trim().replace(/^\/+/, '').replace(/\/+$/, '');
            if (!normalizedPath) continue;

            const segments = normalizedPath.split('/');
            const fileName = segments[segments.length - 1];

            // 1. SOVEREIGN NAMESPACE CHECK: Does the first segment match a project name?
            const projectFolder = folders.find(f => f.name === segments[0]);
            if (projectFolder && segments.length > 1) {
                const subPath = segments.slice(1).join('/');
                targetUri = vscode.Uri.joinPath(projectFolder.uri, subPath);
                try { await vscode.workspace.fs.stat(targetUri); } catch { targetUri = undefined; }
            }

            // 2. SEARCH RESOLUTION: Check across all roots for existence (Relative Path)
            if (!targetUri) {
                for (const folder of folders) {
                    const testUri = vscode.Uri.joinPath(folder.uri, normalizedPath);
                    try {
                        await vscode.workspace.fs.stat(testUri);
                        targetUri = testUri;
                        break;
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
                const key = this.normalize(vscode.workspace.asRelativePath(targetUri, false));
                workspaceState[key] = 'included';
                urisToFire.push(targetUri);
                addedPaths.push(file); // Return the original string so the webview can map it back
                Logger.info(`[Librarian] Successfully resolved and added: ${key}`);
            } else {
                Logger.warn(`[Librarian] Failed to resolve path: ${file}`);
            }
        }

        await this.context.workspaceState.update(this.stateKey, workspaceState);
        this.refresh();
        this._onDidChangeFileDecorations.fire(urisToFire);
        return addedPaths;
    }

    public async fullReset(): Promise<void> {
        await this.context.workspaceState.update(this.stateKey, {});
        this.refresh();
        this._onDidChangeFileDecorations.fire(undefined); 
    }

    public async softReset(): Promise<void> {
        const workspaceState = this.context.workspaceState.get<{ [key: string]: ContextState }>(this.stateKey, {});
        const newState: { [key: string]: ContextState } = {};

        for (const [key, state] of Object.entries(workspaceState)) {
            // Keep exclusions and collapsed folders.
            // Revert 'included' and 'definitions-only' to default (tree-only).
            if (state === 'fully-excluded' || state === 'collapsed') {
                newState[key] = state;
            }
        }

        await this.context.workspaceState.update(this.stateKey, newState);
        this.refresh();
        this._onDidChangeFileDecorations.fire(undefined);
    }

    /**
     * Scouts a folder during expansion to see if it should be suggested for collapsing.
     */
    private async scoutFolderForCollapsing(item: ContextItem) {
        const isMuted = this.context.globalState.get<boolean>(ContextStateProvider.MUTE_DEEP_WARNING_KEY, false);
        if (isMuted) return;

        // If the folder is already explicitly collapsed or excluded, don't nag
        const currentState = this.getStateForUri(item.resourceUri);
        if (currentState === 'collapsed' || currentState === 'fully-excluded') return;

        const folderName = path.basename(item.resourceUri.fsPath).toLowerCase();
        const relPath = this.normalize(vscode.workspace.asRelativePath(item.resourceUri, false));
        const depth = relPath.split('/').length;

        let reason = "";
        if (ContextStateProvider.BUILD_DEBUG_PATTERNS.includes(folderName)) {
            reason = `looks like a build or debug artifact folder`;
        } else if (ContextStateProvider.VENV_PATTERNS.includes(folderName) || folderName.includes('venv')) {
            reason = `appears to be a virtual environment`;
        } else if (depth >= ContextStateProvider.DEPTH_THRESHOLD) {
            reason = `is quite deep (${depth} levels)`;
        }

        if (reason) {
            const message = `The folder "${path.basename(item.resourceUri.fsPath)}" ${reason}. Including its content might bloat the AI context. Would you like to set it to Collapsed (C)?`;
            const choices = ["Collapse Folder", "Ignore", "Don't Ask Again"];
            
            vscode.window.showInformationMessage(message, ...choices).then(async selection => {
                if (selection === "Collapse Folder") {
                    await this.setStateForUri(item.resourceUri, 'collapsed');
                } else if (selection === "Don't Ask Again") {
                    await this.context.globalState.update(ContextStateProvider.MUTE_DEEP_WARNING_KEY, true);
                }
            });
        }
    }
}
