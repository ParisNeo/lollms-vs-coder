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
    this.reinitializeFileTreeProvider();
  }

  public reinitializeFileTreeProvider() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      this.fileTreeProvider = new FileTreeProvider(workspaceFolder.uri.fsPath, this.context);
    } else {
      this.fileTreeProvider = undefined;
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

    const includedFiles = contextFiles.filter(p => !p.endsWith(path.sep));
    if (includedFiles.length > 0) {
      content += `## File Contents (${includedFiles.length} files)\n\n`;
      for (const filePath of contextFiles) {
        try {
          const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
          const stat = await vscode.workspace.fs.stat(fullPath);

          // FIX: Only attempt to read content if the path points to a file.
          if (stat.type === vscode.FileType.File) {
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
          }
          // If it's a directory, we simply ignore it here. Its presence is noted in the project tree.

        } catch (error) {
          content += `### ${filePath}\n\n⚠️ **Error processing entry:** ${error}\n\n`;
        }
      }
    } else {
      content += '## File Contents\n\n**No files are currently included in the context.**\n\n';
    }

    result.text = content;
    return result;
  }

  private async generateProjectTree(): Promise<string> {
    
    if (!this.fileTreeProvider) {
      return '## Project Structure\n\n*No project structure available - no workspace folder found.*\n';
    }

    const allVisibleFiles = await this.fileTreeProvider.getAllVisibleFiles();
    
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

    const generateTreeString = (obj: any, prefix: string = '', isLast: boolean = true): string => {
      let result = '';
      const keys = Object.keys(obj).sort((a, b) => {
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
}