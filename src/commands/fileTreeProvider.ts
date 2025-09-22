import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export type PathState = 'included' | 'tree-only' | 'fully-excluded';

export class FileTreeProvider implements vscode.TreeDataProvider<FileItem>, vscode.Disposable {
    private _onDidChangeTreeData: vscode.EventEmitter<FileItem | undefined | null | void> = new vscode.EventEmitter<FileItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<FileItem | undefined | null | void> = this._onDidChangeTreeData.event;
  
    private contextFiles: Set<string> = new Set();
    private treeOnlyFiles: Set<string> = new Set();
    private fullyExcludedPaths: Set<string> = new Set();
    
    private binaryFileExtensions = new Set(['.exe', '.dll', '.bin', '.obj', '.o', '.so', '.dylib', '.a', '.vsix', '.nupkg', '.jar', '.class', '.pyc', '.pyo', '.pyd', '.egg', '.whl']);
    private imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg']);
    private excludedFolders = new Set(['node_modules', '.git', 'dist', 'build', 'out', '__pycache__', '.pytest_cache', '.mypy_cache', 'egg-info']);
  
    private watcher: vscode.FileSystemWatcher;

    constructor(private workspaceRoot: string, private context: vscode.ExtensionContext) {
      this.contextFiles = new Set(context.workspaceState.get<string[]>('aiContextFiles', []));
      this.treeOnlyFiles = new Set(context.workspaceState.get<string[]>('aiTreeOnlyFiles', []));
      this.fullyExcludedPaths = new Set(context.workspaceState.get<string[]>('aiFullyExcludedPaths', []));

      // Initialize the file watcher
      this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.workspaceRoot, '**/*'));
      
      this.watcher.onDidCreate(() => this.refresh());
      this.watcher.onDidChange(() => this.refresh());
      this.watcher.onDidDelete(uri => this.handleFileDelete(uri));
    }
  
    private async handleFileDelete(uri: vscode.Uri): Promise<void> {
        const relPath = path.relative(this.workspaceRoot, uri.fsPath).replace(/\\/g, '/');
        
        let stateChanged = false;
        if (this.contextFiles.has(relPath)) {
            this.contextFiles.delete(relPath);
            stateChanged = true;
        }
        if (this.treeOnlyFiles.has(relPath)) {
            this.treeOnlyFiles.delete(relPath);
            stateChanged = true;
        }
        if (this.fullyExcludedPaths.has(relPath)) {
            this.fullyExcludedPaths.delete(relPath);
            stateChanged = true;
        }

        if (stateChanged) {
            await this.saveState();
        }
        
        this.refresh();
    }

    public dispose(): void {
        this.watcher.dispose();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: FileItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: FileItem): Thenable<FileItem[]> {
        if (!this.workspaceRoot) return Promise.resolve([]);
        const dirPath = element ? element.resourceUri!.fsPath : this.workspaceRoot;
        const relativePath = element ? element.relativePath : '';
        return Promise.resolve(this.getDirectoryContents(dirPath, relativePath));
    }

    private getDirectoryContents(dirPath: string, relativePath: string): FileItem[] {
        if (!fs.existsSync(dirPath)) return [];
        const items: FileItem[] = [];
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const relPath = path.join(relativePath, entry.name);

                if (this.excludedFolders.has(entry.name)) continue;
                if (entry.name.startsWith('.') && entry.name !== '.vscode') continue;
                
                const fullPath = path.join(dirPath, entry.name);
                const state = this.getPathState(relPath);
                
                if (state === 'fully-excluded' && this.fullyExcludedPaths.has(relPath)) {
                    // If the item itself is explicitly excluded, show it so it can be un-excluded.
                    // But don't show children of fully excluded folders unless they have their own state.
                } else if (state === 'fully-excluded') {
                    continue; // Don't show children of fully-excluded parents unless they have specific state
                }

                if (entry.isDirectory()) {
                    items.push(new FileItem(entry.name, relPath, vscode.Uri.file(fullPath), vscode.TreeItemCollapsibleState.Collapsed, 'folder', state));
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    const isImage = this.imageExtensions.has(ext);
                    const isBinary = this.binaryFileExtensions.has(ext);
                    
                    if (!isBinary || isImage) {
                        items.push(new FileItem(entry.name, relPath, vscode.Uri.file(fullPath), vscode.TreeItemCollapsibleState.None, isImage ? 'image' : 'file', state));
                    }
                }
            }
        } catch (error) { console.error(`Error reading directory ${dirPath}:`, error); }

        return items.sort((a, b) => {
            const aIsDir = a.collapsibleState !== vscode.TreeItemCollapsibleState.None;
            const bIsDir = b.collapsibleState !== vscode.TreeItemCollapsibleState.None;
            if (aIsDir && !bIsDir) return -1;
            if (!aIsDir && bIsDir) return 1;
            return a.label!.toString().localeCompare(b.label!.toString());
        });
    }

    private getPathState(relPath: string): PathState {
        if (this.fullyExcludedPaths.has(relPath)) return 'fully-excluded';
        if (this.contextFiles.has(relPath)) return 'included';
        if (this.treeOnlyFiles.has(relPath)) return 'tree-only';

        let parent = path.dirname(relPath);
        while (parent !== '.' && parent !== '/') {
            if (this.fullyExcludedPaths.has(parent)) return 'fully-excluded';
            if (this.contextFiles.has(parent)) return 'included';
            // `tree-only` is not inherited because it's the default.
            parent = path.dirname(parent);
        }
        
        return 'tree-only'; // Default state
    }

    async cycleFileState(item: FileItem) {
        const currentState = this.getPathState(item.relativePath);
        let nextState: PathState;

        switch (currentState) {
            case 'included':       nextState = 'tree-only'; break;
            case 'tree-only':      nextState = 'fully-excluded'; break;
            case 'fully-excluded': nextState = 'included'; break;
        }

        if (item.type === 'folder') {
            await this._applyStateToFolderAndChildren(item.relativePath, nextState);
        } else {
            this._setPathState(item.relativePath, nextState);
        }

        if (nextState !== 'fully-excluded') {
            this.ensurePathIsVisible(item.relativePath);
        }

        await this.saveState();
        this.refresh();
    }
    
    private _setPathState(relPath: string, state: PathState) {
        this.contextFiles.delete(relPath);
        this.treeOnlyFiles.delete(relPath);
        this.fullyExcludedPaths.delete(relPath);

        switch (state) {
            case 'included':       this.contextFiles.add(relPath); break;
            case 'tree-only':      this.treeOnlyFiles.add(relPath); break;
            case 'fully-excluded': this.fullyExcludedPaths.add(relPath); break;
        }
    }

    private async _applyStateToFolderAndChildren(folderRelPath: string, state: PathState) {
        const fullPath = path.join(this.workspaceRoot, folderRelPath);
        const filesToUpdate = await this.getAllFilesInFolder(fullPath, true);
        
        // Also apply to the folder itself
        this._setPathState(folderRelPath, state);

        // Apply to all children
        filesToUpdate.forEach(fileRelPath => {
            this._setPathState(fileRelPath, state);
        });
    }

    private ensurePathIsVisible(relPath: string) {
        let parent = path.dirname(relPath);
        while (parent !== '.' && parent !== '/') {
            if (this.fullyExcludedPaths.has(parent)) {
                this.fullyExcludedPaths.delete(parent);
                this.treeOnlyFiles.add(parent);
            }
            parent = path.dirname(parent);
        }
    }

    async addFileToContext(relPath: string) {
        this._setPathState(relPath, 'included');
        this.ensurePathIsVisible(relPath);
        await this.saveState();
        this.refresh();
    }
    
    async removeFileFromContext(relPath: string) {
        this._setPathState(relPath, 'tree-only');
        await this.saveState();
        this.refresh();
    }

    async addFolderToContext(folderItem: FileItem) {
        await this._applyStateToFolderAndChildren(folderItem.relativePath, 'included');
        this.ensurePathIsVisible(folderItem.relativePath);
        await this.saveState();
        this.refresh();
        vscode.window.showInformationMessage(`Included '${folderItem.label}' and its contents in the context.`);
    }

    async removeFolderFromContext(folderItem: FileItem) {
        await this._applyStateToFolderAndChildren(folderItem.relativePath, 'tree-only');
        await this.saveState();
        this.refresh();
        vscode.window.showInformationMessage(`Switched '${folderItem.label}' and its contents to tree-only context.`);
    }

    private async getAllFilesInFolder(dirPath: string, includeFolders: boolean = false): Promise<string[]> {
        let items: string[] = [];
        if (!this.workspaceRoot) return [];
    
        try {
            const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                const relPath = path.relative(this.workspaceRoot, fullPath);
                
                if (this.excludedFolders.has(entry.name)) continue;
                if (entry.name.startsWith('.') && entry.name !== '.vscode') continue;
                
                if (entry.isDirectory()) {
                    if (includeFolders) {
                        items.push(relPath);
                    }
                    items.push(...await this.getAllFilesInFolder(fullPath, includeFolders));
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    const isImage = this.imageExtensions.has(ext);
                    const isBinary = this.binaryFileExtensions.has(ext);
                    if (!isBinary || isImage) {
                        items.push(relPath);
                    }
                }
            }
        } catch (error) { console.error(`Error reading folder ${dirPath}:`, error); }
        return items;
    }

    private async saveState() {
        await this.context.workspaceState.update('aiContextFiles', Array.from(this.contextFiles));
        await this.context.workspaceState.update('aiTreeOnlyFiles', Array.from(this.treeOnlyFiles));
        await this.context.workspaceState.update('aiFullyExcludedPaths', Array.from(this.fullyExcludedPaths));
    }

    getContextFiles(): string[] { return Array.from(this.contextFiles); }
    
    public async getAllVisibleFiles(): Promise<string[]> {
        if (!this.workspaceRoot) return [];
        const allItems = await this.getAllFilesInFolder(this.workspaceRoot, true);
        return allItems.filter(item => this.getPathState(item) !== 'fully-excluded');
    }
}

export class FileItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly relativePath: string,
    public readonly resourceUri: vscode.Uri,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly type: 'file' | 'folder' | 'image',
    public readonly state: PathState
  ) {
    super(label, collapsibleState);
    this.contextValue = type;
    this.tooltip = `${this.relativePath}\nState: ${this.getStateDescription()}`;
    
    this.iconPath = this.getStateIcon();

    if (type === 'file' || type === 'image') {
        this.command = { command: 'vscode.open', title: 'Open File', arguments: [this.resourceUri] };
    }
  }

  private getStateDescription(): string {
    switch (this.state) {
      case 'included': return 'Included in AI context (content and path sent to AI)';
      case 'tree-only': return 'Visible in tree (path sent to AI, content is not)';
      case 'fully-excluded': return 'Excluded from AI context';
    }
  }

  private getStateIcon(): vscode.ThemeIcon {
    switch (this.state) {
      case 'included':
        return new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
      case 'tree-only':
        return this.type === 'folder' ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
      case 'fully-excluded':
        return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
      default:
        return vscode.ThemeIcon.File;
    }
  }
}