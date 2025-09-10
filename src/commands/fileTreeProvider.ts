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
    
    private defaultExcludedExtensions = ['.exe', '.dll', '.bin', '.obj', '.o', '.so', '.dylib', '.a', '.vsix'];
    private imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg'];
    private defaultExcludedFolders = ['node_modules', '.git', 'dist', 'build', 'out'];
  
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

                if (this.defaultExcludedFolders.includes(entry.name)) continue;
                if (entry.name.startsWith('.') && entry.name !== '.vscode') continue;
                
                const fullPath = path.join(dirPath, entry.name);
                const state = this.getPathState(relPath);

                if (entry.isDirectory()) {
                    items.push(new FileItem(entry.name, relPath, vscode.Uri.file(fullPath), vscode.TreeItemCollapsibleState.Collapsed, 'folder', state));
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (!this.defaultExcludedExtensions.includes(ext)) {
                        const isImage = this.imageExtensions.includes(ext);
                        items.push(new FileItem(entry.name, relPath, vscode.Uri.file(fullPath), vscode.TreeItemCollapsibleState.None, isImage ? 'image' : 'file', state));
                    }
                }
            }
        } catch (error) { console.error(`Error reading directory ${dirPath}:`, error); }

        return items.sort((a, b) => {
            if (a.type === 'folder' && b.type !== 'folder') return -1;
            if (a.type !== 'folder' && b.type === 'folder') return 1;
            return a.label!.toString().localeCompare(b.label!.toString());
        });
    }

    private getPathState(relPath: string): PathState {
        if (this.fullyExcludedPaths.has(relPath)) return 'fully-excluded';
        if (this.contextFiles.has(relPath)) return 'included';
        if (this.treeOnlyFiles.has(relPath)) return 'tree-only';
        
        // Check if a parent is fully excluded
        let parent = path.dirname(relPath);
        while (parent !== '.') {
            if (this.fullyExcludedPaths.has(parent)) return 'fully-excluded';
            parent = path.dirname(parent);
        }

        return 'tree-only'; // Default state is visible but not in context
    }

    async cycleFileState(item: FileItem) {
        const currentState = this.getPathState(item.relativePath);
        this.contextFiles.delete(item.relativePath);
        this.treeOnlyFiles.delete(item.relativePath);
        this.fullyExcludedPaths.delete(item.relativePath);

        if (item.type === 'folder') {
            if (currentState === 'fully-excluded') {
                this.treeOnlyFiles.add(item.relativePath);
            } else {
                this.fullyExcludedPaths.add(item.relativePath);
                await this.removeFolderFromContext(item); // Clean up children
            }
        } else { // File or Image
            switch (currentState) {
                case 'included':
                    this.treeOnlyFiles.add(item.relativePath); break;
                case 'tree-only':
                    this.fullyExcludedPaths.add(item.relativePath); break;
                case 'fully-excluded':
                    this.contextFiles.add(item.relativePath);
                    this.ensurePathIsVisible(item.relativePath);
                    break;
            }
        }
        this.saveState();
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

    async addFolderToContext(folderItem: FileItem) {
        const files = await this.getAllFilesInFolder(folderItem.resourceUri.fsPath);
        files.forEach(file => this.addFileToContext(file));
        this.ensurePathIsVisible(folderItem.relativePath);
        this.saveState();
        this.refresh();
        vscode.window.showInformationMessage(`Added ${files.length} files from '${folderItem.label}' to context.`);
    }

    async removeFolderFromContext(folderItem: FileItem) {
        const files = await this.getAllFilesInFolder(folderItem.resourceUri.fsPath);
        let removedCount = 0;
        files.forEach(file => {
            if(this.contextFiles.delete(file)) removedCount++;
            this.treeOnlyFiles.delete(file);
        });
        this.saveState();
        this.refresh();
        vscode.window.showInformationMessage(`Removed ${removedCount} files from '${folderItem.label}' from context.`);
    }

    private async getAllFilesInFolder(dirPath: string): Promise<string[]> {
        let files: string[] = [];
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (!workspaceRoot) return [];

        try {
            const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                const relPath = path.relative(workspaceRoot, fullPath);
                if (this.getPathState(relPath) === 'fully-excluded') continue;
                if (entry.isDirectory()) {
                    files.push(...await this.getAllFilesInFolder(fullPath));
                } else if (entry.isFile()) {
                    files.push(relPath);
                }
            }
        } catch (error) { console.error(`Error reading folder ${dirPath}:`, error); }
        return files;
    }

    private saveState() {
        this.context.workspaceState.update('aiContextFiles', Array.from(this.contextFiles));
        this.context.workspaceState.update('aiTreeOnlyFiles', Array.from(this.treeOnlyFiles));
        this.context.workspaceState.update('aiFullyExcludedPaths', Array.from(this.fullyExcludedPaths));
    }

    getContextFiles(): string[] { return Array.from(this.contextFiles); }
    getTreeOnlyFiles(): string[] { return Array.from(this.treeOnlyFiles); }
    getAllVisibleFiles(): string[] { return [...this.getContextFiles(), ...this.getTreeOnlyFiles()]; }
    addFileToContext(filePath: string) { this.contextFiles.add(filePath); this.treeOnlyFiles.delete(filePath); this.fullyExcludedPaths.delete(filePath); this.ensurePathIsVisible(filePath); }
    removeFileFromContext(filePath: string) { this.contextFiles.delete(filePath); }
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
    this.tooltip = `${this.relativePath} - ${this.getStateDescription()}`;
    this.command = { command: 'lollms-vs-coder.cycleFileState', title: 'Cycle AI Context State', arguments: [this] };
    this.iconPath = this.getStateIcon();
  }

  private getStateDescription(): string {
    switch (this.state) {
      case 'included': return 'Included in AI context (content + path)';
      case 'tree-only': return 'Visible to AI (path only)';
      case 'fully-excluded': return 'Hidden from AI (will not be sent in context)';
    }
  }

  private getStateIcon(): vscode.ThemeIcon {
    switch (this.state) {
      case 'included':
        return new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
      case 'tree-only':
        const icon = this.type === 'folder' ? vscode.ThemeIcon.Folder : new vscode.ThemeIcon('eye');
        return icon;
      case 'fully-excluded':
        return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('testing.iconFailed'));
    }
  }
}