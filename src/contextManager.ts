// src/contextManager.ts

import * as vscode from 'vscode';
import * as path from 'path';
import { FileTreeProvider } from './commands/fileTreeProvider';
import jimp from 'jimp';

export interface ContextResult {
  text: string;
  images: { filePath: string; data: string }[];
}

export class ContextManager {
  private fileTreeProvider?: FileTreeProvider;
  private context: vscode.ExtensionContext;
  private imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    console.log('ContextManager constructor called');
    this.initializeFileTreeProvider();
  }

  private initializeFileTreeProvider() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      console.log('Initializing FileTreeProvider for workspace:', workspaceFolder.uri.fsPath);
      this.fileTreeProvider = new FileTreeProvider(workspaceFolder.uri.fsPath, this.context);
      console.log('FileTreeProvider initialized successfully');
    } else {
      console.log('No workspace folder found - ContextManager will have limited functionality');
    }
  }

  getFileTreeProvider(): FileTreeProvider | undefined {
    return this.fileTreeProvider;
  }

  async getContextContent(): Promise<ContextResult> {
    const result: ContextResult = { text: '', images: [] };

    if (!this.fileTreeProvider) {
      result.text = this.getNoWorkspaceMessage();
      return result;
    }
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      result.text = this.getNoWorkspaceMessage();
      return result;
    }

    const contextFiles = this.fileTreeProvider.getContextFiles();
    let content = `# Project Context\n\n**Workspace:** ${path.basename(workspaceFolder.uri.fsPath)}\n\n`;
    content += await this.generateProjectTree();
    content += '\n';

    if (contextFiles.length > 0) {
      content += `## File Contents (${contextFiles.length} files)\n\n`;
      for (const filePath of contextFiles) {
        try {
          const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
          const ext = path.extname(filePath).toLowerCase();

          if (this.imageExtensions.includes(ext)) {
            const fileBytes = await vscode.workspace.fs.readFile(fullPath);
            const image = await jimp.read(Buffer.from(fileBytes));
            
            const config = vscode.workspace.getConfiguration('lollmsVsCoder');
            const maxSize = config.get<number>('maxImageSize') || 1024;

            if (maxSize > 0 && (image.getWidth() > maxSize || image.getHeight() > maxSize)) {
                image.scaleToFit(maxSize, maxSize);
            }
            
            const base64 = await image.getBase64Async(image.getMIME());
            result.images.push({ filePath, data: base64 });
            content += `### \`${filePath}\`\n\n*Image included in context*\n\n`;

          } else {
            let fileContent: string | undefined;
            const openDocument = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === fullPath.fsPath);
            
            if (openDocument) {
              fileContent = openDocument.getText();
            } else {
              const fileBytes = await vscode.workspace.fs.readFile(fullPath);
              fileContent = Buffer.from(fileBytes).toString('utf8');
            }

            content += `### \`${filePath}\`\n\n`;
            const language = path.extname(filePath).substring(1);
            content += '```' + language + '\n';
            content += fileContent;
            content += '\n```\n\n';
          }

        } catch (error) {
          content += `### ${filePath}\n\n⚠️ **Error reading file:** ${error}\n\n`;
        }
      }
    } else {
      content += '## File Contents\n\n**No files are currently included in the context.**\n\n';
    }

    result.text = content;
    return result;
  }

  private async generateProjectTree(): Promise<string> {
    console.log('Generating project tree...');
    
    if (!this.fileTreeProvider) {
      return '## Project Structure\n\n*No project structure available - no workspace folder found.*\n';
    }

    const allVisibleFiles = this.fileTreeProvider.getAllVisibleFiles();
    console.log('All visible files count:', allVisibleFiles.length);
    
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return '## Project Structure\n\n*No workspace folder found.*\n';
    }

    let tree = '## Project Structure\n\n';
    
    if (allVisibleFiles.length === 0) {
      tree += '*No files are currently visible in the context. Use the file tree in the Lollms Settings sidebar to manage file visibility.*\n';
      return tree;
    }

    tree += '```'
    tree += path.basename(workspaceFolder.uri.fsPath) + '/\n';

    // Build nested file structure
    const fileTree: { [key: string]: any } = {};
    
    allVisibleFiles.forEach(filePath => {
      const parts = filePath.split(path.sep).filter(part => part.length > 0);
      let current = fileTree;
      
      parts.forEach((part, index) => {
        if (!current[part]) {
          current[part] = index === parts.length - 1 ? null : {};
        }
        if (current[part] !== null) {
          current = current[part];
        }
      });
    });

    // Generate tree string representation
    const generateTreeString = (obj: any, prefix: string = '', isLast: boolean = true): string => {
      let result = '';
      const keys = Object.keys(obj).sort((a, b) => {
        // Directories first, then files
        const aIsDir = obj[a] !== null;
        const bIsDir = obj[b] !== null;
        if (aIsDir && !bIsDir) return -1;
        if (!aIsDir && bIsDir) return 1;
        return a.localeCompare(b);
      });

      keys.forEach((key, index) => {
        const isLastItem = index === keys.length - 1;
        const connector = isLastItem ? '└── ' : '├── ';
        result += prefix + connector + key + '\n';

        if (obj[key] !== null) {
          const newPrefix = prefix + (isLastItem ? '    ' : '│   ');
          result += generateTreeString(obj[key], newPrefix, isLastItem);
        }
      });

      return result;
    };

    tree += generateTreeString(fileTree);
    tree += '```\n';

    console.log('Generated project tree');
    return tree;
  }

  private getNoWorkspaceMessage(): string {
    return `# Project Context

**No workspace folder is currently open.**

To use Lollms with your project files:
1. Open a folder in VS Code (File → Open Folder)
2. Use the file tree in the Lollms Settings sidebar to select which files to include
3. Start chatting with context about your code

Currently operating without project context.
`;
  }

  addFileToContext(uri: vscode.Uri) {
    if (!this.fileTreeProvider) {
      vscode.window.showWarningMessage('No workspace folder available to add files to context.');
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const relativePath = vscode.workspace.asRelativePath(uri);
      this.fileTreeProvider.addFileToContext(relativePath);
      vscode.window.showInformationMessage(`Added ${relativePath} to AI context`);
      console.log(`Added file to context: ${relativePath}`);
    }
  }

  removeFileFromContext(uri: vscode.Uri) {
    if (!this.fileTreeProvider) {
      vscode.window.showWarningMessage('No workspace folder available to remove files from context.');
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const relativePath = vscode.workspace.asRelativePath(uri);
      this.fileTreeProvider.removeFileFromContext(relativePath);
      vscode.window.showInformationMessage(`Removed ${relativePath} from AI context`);
      console.log(`Removed file from context: ${relativePath}`);
    }
  }

  // Get summary of current context for debugging
  getContextSummary(): string {
    if (!this.fileTreeProvider) {
      return 'No FileTreeProvider available';
    }

    const contextFiles = this.fileTreeProvider.getContextFiles();
    const treeOnlyFiles = this.fileTreeProvider.getTreeOnlyFiles();
    
    return `Context Summary:
- Files with content: ${contextFiles.length}
- Files tree-only: ${treeOnlyFiles.length}
- Total visible files: ${contextFiles.length + treeOnlyFiles.length}`;
  }
}