import * as vscode from 'vscode';
import * as path from 'path';

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
    }

    public async switchWorkspace(newWorkspaceRoot: string) {
        this.workspaceRoot = newWorkspaceRoot;
        this.stateKey = `context-state-${newWorkspaceRoot}`;
        this.refresh();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
        if (vscode.workspace.workspaceFolders?.[0]) {
            this._onDidChangeFileDecorations.fire(vscode.workspace.workspaceFolders[0].uri);
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
            if (this.isExcluded(uri.fsPath)) {
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

    private isExcluded(filePath: string): boolean {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const exceptions = config.get<string[]>('contextFileExceptions') || [];
        const fileUri = vscode.Uri.file(filePath);
    
        for (let pattern of exceptions) {
            const filter: vscode.DocumentFilter = { pattern: pattern };
            if (vscode.languages.match(filter, { uri: fileUri, scheme: 'file', languageId: '' })) {
                return true;
            }
        }
        return false;
    }

    public getStateForUri(uri: vscode.Uri): ContextState {
        const workspaceState = this.context.workspaceState.get<{ [key: string]: ContextState }>(this.stateKey, {});
        const relativePath = vscode.workspace.asRelativePath(uri, false);
        return workspaceState[relativePath] || 'tree-only';
    }

    public async setStateForUri(uri: vscode.Uri, state: ContextState) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (!workspaceFolder) return;
    
        const workspaceState = this.context.workspaceState.get<{ [key: string]: ContextState }>(this.stateKey, {});
        const relativePath = vscode.workspace.asRelativePath(uri, false);
    
        const stat = await vscode.workspace.fs.stat(uri);
    
        if (stat.type === vscode.FileType.Directory) {
            Object.keys(workspaceState).forEach(key => {
                if (key.startsWith(relativePath + path.sep) || key === relativePath) {
                    delete workspaceState[key];
                }
            });
    
            if (state === 'included') {
                await this.updateChildrenState(uri, 'add', workspaceState);
            } else {
                workspaceState[relativePath] = state;
            }
        } else {
            workspaceState[relativePath] = state;
        }
    
        await this.context.workspaceState.update(this.stateKey, workspaceState);
        this.refresh();
        this._onDidChangeFileDecorations.fire(uri);
    }

    private async updateChildrenState(dirUri: vscode.Uri, action: 'add', workspaceState: { [key: string]: ContextState }) {
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
                if (this.isExcluded(entryUri.fsPath)) {
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
    }

    public async getAllVisibleFiles(): Promise<string[]> {
        const workspaceState = this.context.workspaceState.get<{ [key: string]: ContextState }>(this.stateKey, {});
        const visibleFiles: string[] = [];
    
        const workspaceFolder = vscode.workspace.workspaceFolders?.find(f => f.uri.fsPath === this.workspaceRoot);
        if (!workspaceFolder) return [];
    
        const processDirectory = async (dirUri: vscode.Uri) => {
            const relativePath = vscode.workspace.asRelativePath(dirUri, false);
            if (workspaceState[relativePath] === 'fully-excluded' || this.isExcluded(dirUri.fsPath)) {
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
    
                if (workspaceState[entryRelativePath] === 'fully-excluded' || this.isExcluded(entryUri.fsPath)) {
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
}