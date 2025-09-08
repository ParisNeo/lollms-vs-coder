import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class FileTreeProvider implements vscode.TreeDataProvider<FileItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<FileItem | undefined | null | void> = new vscode.EventEmitter<FileItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<FileItem | undefined | null | void> = this._onDidChangeTreeData.event;
  
    private contextFiles: Set<string> = new Set(); // Files with full content
    private treeOnlyFiles: Set<string> = new Set(); // Files shown in tree but no content
    private excludedFiles: Set<string> = new Set(); // Files completely excluded
    
    private excludedExtensions = ['.exe', '.dll', '.bin', '.obj', '.o', '.so', '.dylib', '.a'];
    private excludedFolders = ['node_modules', '.git', 'dist', 'build', 'out', '.vscode'];
  
    constructor(private workspaceRoot: string, private context: vscode.ExtensionContext) {
      // Load saved states
      const savedContext = context.workspaceState.get<string[]>('aiContextFiles', []);
      const savedTreeOnly = context.workspaceState.get<string[]>('aiTreeOnlyFiles', []);
      const savedExcluded = context.workspaceState.get<string[]>('aiExcludedFiles', []);
      
      this.contextFiles = new Set(savedContext);
      this.treeOnlyFiles = new Set(savedTreeOnly);
      this.excludedFiles = new Set(savedExcluded);
      
      // Add all eligible files by default if no saved state
      if (savedContext.length === 0 && savedTreeOnly.length === 0 && savedExcluded.length === 0) {
        this.initializeDefaultContext();
      }
    }
  
    private async initializeDefaultContext() {
      const allFiles = await this.getAllWorkspaceFiles();
      allFiles.forEach(file => this.contextFiles.add(file));
      this._onDidChangeTreeData.fire();
    }

  private async getAllWorkspaceFiles(): Promise<string[]> {
    const files: string[] = [];
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return files;

    const scanDirectory = async (dirPath: string, relativePath: string = ''): Promise<void> => {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const relPath = path.join(relativePath, entry.name);

        if (entry.isDirectory()) {
          if (!this.excludedFolders.includes(entry.name) && !entry.name.startsWith('.')) {
            await scanDirectory(fullPath, relPath);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (!this.excludedExtensions.includes(ext) && !entry.name.startsWith('.')) {
            files.push(relPath);
          }
        }
      }
    };

    await scanDirectory(workspaceFolder.uri.fsPath);
    return files;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: FileItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: FileItem): Thenable<FileItem[]> {
    if (!this.workspaceRoot) {
      vscode.window.showInformationMessage('No workspace folder found');
      return Promise.resolve([]);
    }

    if (element) {
      return Promise.resolve(this.getFilesInDirectory(element.resourceUri!.fsPath, element.relativePath));
    } else {
      return Promise.resolve(this.getFilesInDirectory(this.workspaceRoot, ''));
    }
  }

  private getFilesInDirectory(dirPath: string, relativePath: string): FileItem[] {
    const items: FileItem[] = [];
    
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const relPath = path.join(relativePath, entry.name);

        if (entry.isDirectory() && !this.excludedFolders.includes(entry.name) && !entry.name.startsWith('.')) {
          const item = new FileItem(
            entry.name,
            relPath,
            vscode.Uri.file(fullPath),
            vscode.TreeItemCollapsibleState.Collapsed,
            'folder'
          );
          items.push(item);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (!this.excludedExtensions.includes(ext) && !entry.name.startsWith('.')) {
            // Skip if file is completely excluded
            if (!this.excludedFiles.has(relPath)) {
              const fileState = this.getFileState(relPath);
              const item = new FileItem(
                entry.name,
                relPath,
                vscode.Uri.file(fullPath),
                vscode.TreeItemCollapsibleState.None,
                'file',
                fileState
              );
              items.push(item);
            }
          }
        }
      }
    } catch (error) {
      console.error('Error reading directory:', error);
    }

    return items.sort((a, b) => {
      if (a.type === 'folder' && b.type === 'file') return -1;
      if (a.type === 'file' && b.type === 'folder') return 1;
      return a.label!.toString().localeCompare(b.label!.toString());
    });
  }

  private getFileState(filePath: string): FileState {
    if (this.contextFiles.has(filePath)) return 'included';
    if (this.treeOnlyFiles.has(filePath)) return 'tree-only';
    return 'excluded';
  }

  cycleFileState(item: FileItem) {
    if (item.type !== 'file') return;

    const currentState = this.getFileState(item.relativePath);
    
    // Remove from all sets first
    this.contextFiles.delete(item.relativePath);
    this.treeOnlyFiles.delete(item.relativePath);
    this.excludedFiles.delete(item.relativePath);

    // Cycle: included -> tree-only -> excluded -> included
    switch (currentState) {
      case 'included':
        this.treeOnlyFiles.add(item.relativePath);
        break;
      case 'tree-only':
        this.excludedFiles.add(item.relativePath);
        break;
      case 'excluded':
        this.contextFiles.add(item.relativePath);
        break;
    }

    this.saveState();
    this._onDidChangeTreeData.fire();
  }

  private saveState() {
    this.context.workspaceState.update('aiContextFiles', Array.from(this.contextFiles));
    this.context.workspaceState.update('aiTreeOnlyFiles', Array.from(this.treeOnlyFiles));
    this.context.workspaceState.update('aiExcludedFiles', Array.from(this.excludedFiles));
  }

  getContextFiles(): string[] {
    return Array.from(this.contextFiles);
  }

  getTreeOnlyFiles(): string[] {
    return Array.from(this.treeOnlyFiles);
  }

  getAllVisibleFiles(): string[] {
    return [...Array.from(this.contextFiles), ...Array.from(this.treeOnlyFiles)];
  }

  toggleFileInContext(item: FileItem) {
    if (item.type === 'file') {
      if (this.contextFiles.has(item.relativePath)) {
        this.contextFiles.delete(item.relativePath);
      } else {
        this.contextFiles.add(item.relativePath);
      }
      
      // Save to workspace state
      this.context.workspaceState.update('aiContextFiles', Array.from(this.contextFiles));
      this._onDidChangeTreeData.fire();
    }
  }

  addFileToContext(filePath: string) {
    this.contextFiles.add(filePath);
    this.context.workspaceState.update('aiContextFiles', Array.from(this.contextFiles));
    this._onDidChangeTreeData.fire();
  }

  removeFileFromContext(filePath: string) {
    this.contextFiles.delete(filePath);
    this.context.workspaceState.update('aiContextFiles', Array.from(this.contextFiles));
    this._onDidChangeTreeData.fire();
  }
}
export type FileState = 'included' | 'tree-only' | 'excluded';

export class FileItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly relativePath: string,
    public readonly resourceUri: vscode.Uri,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly type: 'file' | 'folder',
    public readonly fileState?: FileState
  ) {
    super(label, collapsibleState);
    
    if (type === 'file' && fileState) {
      this.tooltip = `${this.relativePath} - ${this.getStateDescription(fileState)}`;
      this.contextValue = type;
      
      this.command = {
        command: 'lollms-vs-coder.cycleFileState',
        title: 'Cycle AI Context State',
        arguments: [this]
      };
      
      // Set icon based on state
      this.iconPath = this.getStateIcon(fileState);
    } else if (type === 'folder') {
      this.tooltip = this.relativePath;
      this.iconPath = vscode.ThemeIcon.Folder;
    }
  }

  private getStateDescription(state: FileState): string {
    switch (state) {
      case 'included': return 'Included (tree + content)';
      case 'tree-only': return 'Tree only (no content)';
      case 'excluded': return 'Excluded';
    }
  }

  private getStateIcon(state: FileState): vscode.ThemeIcon {
    switch (state) {
      case 'included':
        return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
      case 'tree-only':
        return new vscode.ThemeIcon('eye', new vscode.ThemeColor('charts.yellow'));
      case 'excluded':
        return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('charts.gray'));
    }
  }
}
