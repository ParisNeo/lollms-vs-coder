import * as vscode from 'vscode';
import * as path from 'path';
import { minimatch } from 'minimatch';

export type ContextState = 'included' | 'tree-only' | 'fully-excluded';

class ContextItem extends vscode.TreeItem {
    constructor(
        public readonly resourceUri: vscode.Uri,
        public readonly state: ContextState,
        public readonly isDirectory: boolean
    ) {
        super(vscode.workspace.asRelativePath(resourceUri, false), isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.id = resourceUri.toString();
        this.contextValue = `contextItem:${state}`;
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
        this.cleanNonExistentFiles().then(() => this.refresh());
    }

    public async switchWorkspace(newWorkspaceRoot: string) {
        this.workspaceRoot = newWorkspaceRoot;
        this.stateKey = `context-state-${newWorkspaceRoot}`;
        await this.cleanNonExistentFiles();
        this.refresh();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
        this._onDidChangeFileDecorations.fire();
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
                // File does not exist, so mark it for removal
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
            const relativePath = vscode.workspace.asRelativePath(uri, false);
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

        const parentUri = element ? element.resourceUri : vscode.Uri.file(this.workspaceRoot);
        const entries = await vscode.workspace.fs.readDirectory(parentUri);
        
        const items: ContextItem[] = [];
        for (const [name, type] of entries) {
            const uri = vscode.Uri.joinPath(parentUri, name);
            if (this.isExcluded(uri)) {
                continue;
            }
            const state = this.getStateForUri(uri);
            const isDirectory = type === vscode.FileType.Directory;
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
    
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const exceptions = config.get<string[]>('contextFileExceptions') || [];
        const relativePath = path.relative(workspaceFolder.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
    
        // If the path is empty, it's the root folder, which should not be excluded.
        if (relativePath === '') {
            return false;
        }

        return exceptions.some(pattern => minimatch(relativePath, pattern, { dot: true }));
    }

    public getStateForUri(uri: vscode.Uri): ContextState {
        const workspaceState = this.context.workspaceState.get<{ [key: string]: ContextState }>(this.stateKey, {});
        const relativePath = vscode.workspace.asRelativePath(uri, false);
        return workspaceState[relativePath] || 'tree-only';
    }

    public async setStateForUris(uris: vscode.Uri[], state: ContextState) {
        if (uris.length === 0) return;
    
        const workspaceState = this.context.workspaceState.get<{ [key: string]: ContextState }>(this.stateKey, {});
        const allUrisToFire = new Set<string>(); // Use a Set to avoid duplicates

        for (const uri of uris) {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
            if (!workspaceFolder) continue;

            const relativePath = vscode.workspace.asRelativePath(uri, false);
            allUrisToFire.add(uri.toString());

            const stat = await vscode.workspace.fs.stat(uri);

            if (stat.type === vscode.FileType.Directory) {
                const descendantUris = await this.getAllDescendantUris(uri);
                descendantUris.forEach(u => allUrisToFire.add(u.toString()));

                // Clear out existing states for the directory and its children before setting the new state
                Object.keys(workspaceState).forEach(key => {
                    if (key.startsWith(relativePath + path.sep) || key === relativePath) {
                        delete workspaceState[key];
                    }
                });

                if (state === 'included') {
                    // This will batch-add all children to the workspaceState object
                    await this.updateChildrenState(uri, 'add', workspaceState);
                } else {
                    // For tree-only or excluded, just set the state on the directory itself
                    workspaceState[relativePath] = state;
                }
            } else { // It's a file
                workspaceState[relativePath] = state;
            }
        }

        await this.context.workspaceState.update(this.stateKey, workspaceState);
        
        // Convert Set of strings back to array of Uris
        const urisToUpdate = Array.from(allUrisToFire).map(s => vscode.Uri.parse(s));

        // Fire events only once after all changes are made
        this.refresh(); // Updates the tree view
        this._onDidChangeFileDecorations.fire(urisToUpdate); // Updates file explorer decorations
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
                console.warn(`Could not read directory ${currentDirUri.fsPath}:`, error);
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
                    const relativePath = vscode.workspace.asRelativePath(entryUri, false);
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
        } catch (e) {
            // Ignore errors if directory cannot be read
        }
        return descendants;
    }

    public async getAllVisibleFiles(): Promise<string[]> {
        const workspaceState = this.context.workspaceState.get<{ [key: string]: ContextState }>(this.stateKey, {});
        const visibleFiles: string[] = [];
    
        const workspaceFolder = vscode.workspace.workspaceFolders?.find(f => f.uri.fsPath === this.workspaceRoot);
        if (!workspaceFolder) return [];
    
        const processDirectory = async (dirUri: vscode.Uri) => {
            const relativePath = vscode.workspace.asRelativePath(dirUri, false);
            if (workspaceState[relativePath] === 'fully-excluded' || this.isExcluded(dirUri)) {
                return;
            }
    
            let entries;
            try {
                entries = await vscode.workspace.fs.readDirectory(dirUri);
            } catch (error) {
                return; 
            }
    
            for (const [name, type] of entries) {
                const entryUri = vscode.Uri.joinPath(dirUri, name);
                const entryRelativePath = vscode.workspace.asRelativePath(entryUri, false);
    
                if (workspaceState[entryRelativePath] === 'fully-excluded' || this.isExcluded(entryUri)) {
                    continue;
                }
    
                if (type === vscode.FileType.Directory) {
                    await processDirectory(entryUri);
                } else {
                    visibleFiles.push(entryRelativePath);
                }
            }
        };
    
        await processDirectory(workspaceFolder.uri);
        return visibleFiles;
    }
    
    public getIncludedFiles(): string[] {
        const workspaceState = this.context.workspaceState.get<{ [key: string]: ContextState }>(this.stateKey, {});
        return Object.keys(workspaceState).filter(key => workspaceState[key] === 'included');
    }

    public async addFilesToContext(files: string[]): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return;
        
        const workspaceState = this.context.workspaceState.get<{ [key: string]: ContextState }>(this.stateKey, {});
        const urisToFire: vscode.Uri[] = [];

        files.forEach(file => {
            workspaceState[file] = 'included';
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