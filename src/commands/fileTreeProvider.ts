import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export type PathState = 'included' | 'tree-only' | 'fully-excluded';

export class FileTreeProvider implements vscode.TreeDataProvider<FileItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<FileItem | undefined | null | void> = new vscode.EventEmitter<FileItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<FileItem | undefined | null | void> = this._onDidChangeTreeData.event;
  
    private contextFiles: Set<string> = new Set();
    private treeOnlyFiles: Set<string> = new Set();
    private fullyExcludedPaths: Set<string> = new Set();
    
    // Enhanced exclusion lists
    private binaryFileExtensions = new Set(['.exe', '.dll', '.bin', '.obj', '.o', '.so', '.dylib', '.a', '.vsix', '.nupkg', '.jar', '.class', '.pyc', '.pyo', '.pyd', '.egg', '.whl']);
    private imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg']);
    private excludedFolders = new Set(['node_modules', '.git', 'dist', 'build', 'out', '__pycache__', '.pytest_cache', '.mypy_cache', 'egg-info']);
  
    constructor(private workspaceRoot: string, private context: vscode.ExtensionContext) {
      this.contextFiles = new Set(context.workspaceState.get<string[]>('aiContextFiles', []));
      this.treeOnlyFiles = new Set(context.workspaceState.get<string[]>('aiTreeOnlyFiles', []));
      this.fullyExcludedPaths = new Set(context.workspaceState.get<string[]>('aiFullyExcludedPaths', []));
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
        
        // Check if a parent is fully excluded
        let parent = path.dirname(relPath);
        while (parent !== '.' && parent !== '/') {
            if (this.fullyExcludedPaths.has(parent)) return 'fully-excluded';
            parent = path.dirname(parent);
        }

        if (this.contextFiles.has(relPath)) return 'included';
        if (this.treeOnlyFiles.has(relPath)) return 'tree-only';
        
        return 'tree-only'; // Default state is visible but not in context
    }

    async cycleFileState(item: FileItem) {
        const currentState = this.getPathState(item.relativePath);
        
        // Clear old state
        this.contextFiles.delete(item.relativePath);
        this.treeOnlyFiles.delete(item.relativePath);
        this.fullyExcludedPaths.delete(item.relativePath);

        // Determine and set next state
        switch (currentState) {
            case 'included': // Next is tree-only
                this.treeOnlyFiles.add(item.relativePath);
                break;
            case 'tree-only': // Next is fully-excluded
                this.fullyExcludedPaths.add(item.relativePath);
                break;
            case 'fully-excluded': // Next is included
                this.contextFiles.add(item.relativePath);
                this.ensurePathIsVisible(item.relativePath); // Make sure parents are not excluded
                break;
        }

        await this.saveState();
        this.refresh();
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
        this.contextFiles.add(relPath);
        this.treeOnlyFiles.delete(relPath);
        this.fullyExcludedPaths.delete(relPath);
        this.ensurePathIsVisible(relPath);
        await this.saveState();
        this.refresh();
    }
    
    async removeFileFromContext(relPath: string) {
        if (this.contextFiles.delete(relPath)) {
            this.treeOnlyFiles.add(relPath); // Move to tree-only instead of removing completely
            await this.saveState();
            this.refresh();
        }
    }

    async addFolderToContext(folderItem: FileItem) {
        const files = await this.getAllFilesInFolder(folderItem.resourceUri.fsPath);
        files.forEach(fileRelPath => this.addFileToContext(fileRelPath));
        this.ensurePathIsVisible(folderItem.relativePath);
        await this.saveState();
        this.refresh();
        vscode.window.showInformationMessage(`Added ${files.length} files from '${folderItem.label}' to context.`);
    }

    async removeFolderFromContext(folderItem: FileItem) {
        const files = await this.getAllFilesInFolder(folderItem.resourceUri.fsPath);
        let removedCount = 0;
        files.forEach(fileRelPath => {
            if(this.contextFiles.delete(fileRelPath)) {
                this.treeOnlyFiles.add(fileRelPath);
                removedCount++;
            }
        });
        await this.saveState();
        this.refresh();
        vscode.window.showInformationMessage(`Removed ${removedCount} files from '${folderItem.label}' from context.`);
    }

    private async getAllFilesInFolder(dirPath: string): Promise<string[]> {
        let files: string[] = [];
        const workspaceRoot = this.workspaceRoot;
        if (!workspaceRoot) return [];

        try {
            const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                const relPath = path.relative(workspaceRoot, fullPath);
                if (this.getPathState(relPath) === 'fully-excluded') continue;
                if (this.excludedFolders.has(entry.name)) continue;
                
                if (entry.isDirectory()) {
                    files.push(...await this.getAllFilesInFolder(fullPath));
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (!this.binaryFileExtensions.has(ext) || this.imageExtensions.has(ext)) {
                        files.push(relPath);
                    }
                }
            }
        } catch (error) { console.error(`Error reading folder ${dirPath}:`, error); }
        return files;
    }

    private async saveState() {
        await this.context.workspaceState.update('aiContextFiles', Array.from(this.contextFiles));
        await this.context.workspaceState.update('aiTreeOnlyFiles', Array.from(this.treeOnlyFiles));
        await this.context.workspaceState.update('aiFullyExcludedPaths', Array.from(this.fullyExcludedPaths));
    }

    getContextFiles(): string[] { return Array.from(this.contextFiles); }
    
    public async getAllVisibleFiles(): Promise<string[]> {
        if (!this.workspaceRoot) return [];
        return this.getAllFilesInFolder(this.workspaceRoot);
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
    
    // Set the icon based on the state.
    this.iconPath = this.getStateIcon();

    // For files and images, a single click should open them.
    // The state can be changed via the context menu or the inline action icon on hover.
    if (type === 'file' || type === 'image') {
        this.command = { command: 'vscode.open', title: 'Open File', arguments: [this.resourceUri] };
    }
    // For folders, we do not set a command to preserve the default expand/collapse behavior.
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
        // For 'tree-only' state, use the default file/folder icons provided by the theme.
        return this.type === 'folder' ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
      case 'fully-excluded':
        return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
      default:
        // Fallback to a default file icon if state is unknown.
        return vscode.ThemeIcon.File;
    }
  }
}