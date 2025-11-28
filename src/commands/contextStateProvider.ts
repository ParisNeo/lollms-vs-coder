import * as vscode from 'vscode';
import * as path from 'path';
import { minimatch } from 'minimatch';

export type ContextState = 'included' | 'tree-only' | 'fully-excluded' | 'collapsed';

class ContextItem extends vscode.TreeItem {
    constructor(
        public readonly resourceUri: vscode.Uri,
        public readonly state: ContextState,
        public readonly isDirectory: boolean
    ) {
        super(
            vscode.workspace.asRelativePath(resourceUri, false), 
            state === 'collapsed' 
                ? vscode.TreeItemCollapsibleState.None 
                : (isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)
        );
        this.id = resourceUri.toString();
        this.contextValue = `contextItem:${state}`;

        if (state === 'collapsed') {
            this.iconPath = vscode.ThemeIcon.Folder;
            this.description = " (Content Hidden)";
            this.tooltip = "Folder exists but content is hidden from AI context to save tokens.";
        }
    }
}

export class ContextStateProvider implements vscode.TreeDataProvider<ContextItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ContextItem | undefined | null | void> = new vscode.EventEmitter<ContextItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ContextItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private _onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[]> = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
    readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[]> = this._onDidChangeFileDecorations.event;

    private workspaceRoot: string;
    private context: vscode.ExtensionContext;
    private stateKey: string;
    
    // Default folders to show as collapsed (content hidden)
    // Removed __pycache__ as it is now fully excluded
    private defaultCollapsedFolders = new Set([
        'node_modules', 'dist', 'build', 'out', 'bin', 'obj', 'target',
        'venv', '.venv', 'env', '.env', 
        '.git', '.idea', '.vscode', '.ruff_cache'
    ]);

    constructor(workspaceRoot: string, context: vscode.ExtensionContext) {
        this.workspaceRoot = workspaceRoot;
        this.context = context;
        this.stateKey = `context-state-${this.workspaceRoot}`;
        
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

    public async switchWorkspace(newWorkspaceRoot: string) {
        this.workspaceRoot = newWorkspaceRoot;
        this.stateKey = `context-state-${newWorkspaceRoot}`;
        await this.cleanNonExistentFiles();
        await this.migrateDefaultCollapsedFolders();
        this.refresh();
    }

    refresh(): void {
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
        const workspaceFolder = vscode.workspace.workspaceFolders?.find(f => f.uri.fsPath === this.workspaceRoot);
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
        if (!this.workspaceRoot) {
            return [];
        }

        if (element && element.state === 'collapsed') {
            return [];
        }

        const parentUri = element ? element.resourceUri : vscode.Uri.file(this.workspaceRoot);
        const entries = await vscode.workspace.fs.readDirectory(parentUri);
        
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
        const segments = relativePath.split('/');

        // Always exclude .lollms folder and __pycache__ anywhere in path
        if (segments.includes('.lollms') || segments.includes('__pycache__')) {
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
        const workspaceState = this.context.workspaceState.get<{ [key: string]: ContextState }>(this.stateKey, {});
        const relativePath = this.normalize(vscode.workspace.asRelativePath(uri, false));
        
        // 1. Check exact match
        if (workspaceState[relativePath]) {
            return workspaceState[relativePath];
        }

        // 2. Check for ancestor state (inheritance for exclusion/collapsed)
        let currentPath = relativePath;
        while (currentPath.includes('/')) {
            const lastSlash = currentPath.lastIndexOf('/');
            currentPath = currentPath.substring(0, lastSlash);
            
            const parentState = workspaceState[currentPath];
            if (parentState === 'fully-excluded') return 'fully-excluded';
            if (parentState === 'collapsed') return 'collapsed';
            
            // Also check default collapsed folders for parents
            if (this.defaultCollapsedFolders.has(path.basename(currentPath))) {
                return 'collapsed';
            }
        }

        const basename = path.basename(uri.fsPath);
        if (this.defaultCollapsedFolders.has(basename)) {
            return 'collapsed';
        }

        return 'tree-only';
    }

    public async setStateForUris(uris: vscode.Uri[], state: ContextState) {
        if (uris.length === 0) return;
    
        const workspaceState = this.context.workspaceState.get<{ [key: string]: ContextState }>(this.stateKey, {});
        const allUrisToFire = new Set<string>();

        for (const uri of uris) {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
            if (!workspaceFolder) continue;

            const relativePath = this.normalize(vscode.workspace.asRelativePath(uri, false));
            allUrisToFire.add(uri.toString());

            const stat = await vscode.workspace.fs.stat(uri);

            if (stat.type === vscode.FileType.Directory) {
                const descendantUris = await this.getAllDescendantUris(uri);
                descendantUris.forEach(u => allUrisToFire.add(u.toString()));

                // Remove existing states for children to enforce new parent state
                Object.keys(workspaceState).forEach(key => {
                    const normalizedKey = this.normalize(key);
                    if (normalizedKey === relativePath || normalizedKey.startsWith(relativePath + '/')) {
                        delete workspaceState[key];
                    }
                });

                if (state === 'included') {
                    // "Included" means "explicitly add all children files"
                    await this.updateChildrenState(uri, 'add', workspaceState);
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

    private async updateChildrenState(dirUri: vscode.Uri, action: 'add', workspaceState: { [key: string]: ContextState }): Promise<vscode.Uri[]> {
        const urisToFire: vscode.Uri[] = [dirUri];
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
                urisToFire.push(entryUri);
    
                if (type === vscode.FileType.Directory) {
                    await processDirectory(entryUri);
                } else if (type === vscode.FileType.File) {
                    const relativePath = this.normalize(vscode.workspace.asRelativePath(entryUri, false));
                    if (action === 'add') {
                        workspaceState[relativePath] = 'included';
                    }
                }
            }
        };
        await processDirectory(dirUri);
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

    public async getAllVisibleFiles(): Promise<string[]> {
        const workspaceState = this.context.workspaceState.get<{ [key: string]: ContextState }>(this.stateKey, {});
        const visibleFiles: string[] = [];
    
        const workspaceFolder = vscode.workspace.workspaceFolders?.find(f => f.uri.fsPath === this.workspaceRoot);
        if (!workspaceFolder) return [];
    
        const processDirectory = async (dirUri: vscode.Uri) => {
            const relativePath = this.normalize(vscode.workspace.asRelativePath(dirUri, false));
            
            // Check state with inheritance
            let currentState = this.getStateForUri(dirUri);

            if (currentState === 'fully-excluded' || this.isExcluded(dirUri)) {
                return;
            }

            if (currentState === 'collapsed') {
                visibleFiles.push(relativePath);
                return; // Stop recursion
            }
    
            let entries;
            try {
                entries = await vscode.workspace.fs.readDirectory(dirUri);
            } catch (error) {
                return; 
            }
    
            for (const [name, type] of entries) {
                const entryUri = vscode.Uri.joinPath(dirUri, name);
                const entryRelativePath = this.normalize(vscode.workspace.asRelativePath(entryUri, false));
    
                // Re-check child exclusion
                if (this.isExcluded(entryUri)) {
                    continue;
                }
    
                if (type === vscode.FileType.Directory) {
                    await processDirectory(entryUri);
                } else {
                    // Check if file is explicitly excluded or part of a collapsed/excluded parent
                    const fileState = this.getStateForUri(entryUri);
                    if (fileState !== 'fully-excluded') {
                        visibleFiles.push(entryRelativePath);
                    }
                }
            }
        };
    
        await processDirectory(workspaceFolder.uri);
        return visibleFiles;
    }
    
    public getIncludedFiles(): string[] {
        const workspaceState = this.context.workspaceState.get<{ [key: string]: ContextState }>(this.stateKey, {});
        // Only return explicitly included files. 
        // We do NOT want to return files that are implicitly 'tree-only' (default).
        // Since 'included' must be explicitly set on files (folders set to included propagate to files in updateChildrenState),
        // we can just filter for 'included'.
        
        return Object.keys(workspaceState).filter(key => workspaceState[key] === 'included');
    }

    public async addFilesToContext(files: string[]): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return;
        
        const workspaceState = this.context.workspaceState.get<{ [key: string]: ContextState }>(this.stateKey, {});
        const urisToFire: vscode.Uri[] = [];

        files.forEach(file => {
            const normalizedFile = this.normalize(file);
            workspaceState[normalizedFile] = 'included';
            urisToFire.push(vscode.Uri.joinPath(workspaceFolder.uri, file));
        });

        await this.context.workspaceState.update(this.stateKey, workspaceState);
        this.refresh();
        this._onDidChangeFileDecorations.fire(urisToFire);
    }
    public async resetState(): Promise<void> {
        await this.context.workspaceState.update(this.stateKey, {});
        this.refresh();
    }
}
