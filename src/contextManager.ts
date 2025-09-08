import * as vscode from 'vscode';
import * as fs from 'fs';
import { FileTreeProvider } from './commands/fileTreeProvider';
import * as path from 'path';

export class ContextManager {
  private fileTreeProvider?: FileTreeProvider;

  constructor(private context: vscode.ExtensionContext) {
    this.initializeFileTreeProvider();
  }

  private initializeFileTreeProvider() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      this.fileTreeProvider = new FileTreeProvider(workspaceFolder.uri.fsPath, this.context);
    }
  }

  getFileTreeProvider(): FileTreeProvider | undefined {
    return this.fileTreeProvider;
  }

  async getContextContent(): Promise<string> {
    if (!this.fileTreeProvider) {
      return '';
    }

    const contextFiles = this.fileTreeProvider.getContextFiles();
    const treeOnlyFiles = this.fileTreeProvider.getTreeOnlyFiles();
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return '';
    }

    let content = '# Project Context\n\n';
    
    // Show project structure first
    content += await this.generateProjectTree();
    content += '\n';
    
    // Then show file contents
    content += `## File Contents (${contextFiles.length} files)\n\n`;

    for (const filePath of contextFiles) {
      try {
        const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
        const fileContent = await fs.promises.readFile(fullPath.fsPath, 'utf8');
        
        content += `### ${filePath}\n`;
        content += '```'
        content += fileContent;
        content += '\n```\n\n';
      } catch (error) {
        content += `### ${filePath}\n`;
        content += `Error reading file: ${error}\n\n`;
      }
    }

    if (treeOnlyFiles.length > 0) {
      content += `## Files in Tree Only (${treeOnlyFiles.length} files - structure visible, content excluded)\n`;
      treeOnlyFiles.forEach(file => {
        content += `- ${file}\n`;
      });
      content += '\n';
    }

    return content;
  }

  private async generateProjectTree(): Promise<string> {
    if (!this.fileTreeProvider) {
      return '';
    }

    const allVisibleFiles = this.fileTreeProvider.getAllVisibleFiles();
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return '';
    }

    let tree = '## Project Structure\n\n```'
    tree += path.basename(workspaceFolder.uri.fsPath) + '/\n';

    // Build tree structure
    const fileTree: { [key: string]: any } = {};
    
    allVisibleFiles.forEach(filePath => {
      const parts = filePath.split(path.sep);
      let current = fileTree;
      
      parts.forEach((part, index) => {
        if (!current[part]) {
          current[part] = index === parts.length - 1 ? null : {};
        }
        current = current[part];
      });
    });

    // Generate tree string
    const generateTreeString = (obj: any, prefix: string = '', isLast: boolean = true): string => {
      let result = '';
      const keys = Object.keys(obj).sort();
      
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

  private getLanguageFromExtension(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const langMap: { [key: string]: string } = {
      'ts': 'typescript',
      'js': 'javascript',
      'py': 'python',
      'java': 'java',
      'cpp': 'cpp',
      'c': 'c',
      'cs': 'csharp',
      'php': 'php',
      'rb': 'ruby',
      'go': 'go',
      'rs': 'rust',
      'html': 'html',
      'css': 'css',
      'scss': 'scss',
      'json': 'json',
      'xml': 'xml',
      'yaml': 'yaml',
      'yml': 'yaml',
      'md': 'markdown',
      'sh': 'bash',
      'sql': 'sql'
    };
    return langMap[ext || ''] || '';
  }

  addFileToContext(uri: vscode.Uri) {
    if (this.fileTreeProvider) {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (workspaceFolder) {
        const relativePath = vscode.workspace.asRelativePath(uri);
        this.fileTreeProvider.addFileToContext(relativePath);
        vscode.window.showInformationMessage(`Added ${relativePath} to AI context`);
      }
    }
  }

  removeFileFromContext(uri: vscode.Uri) {
    if (this.fileTreeProvider) {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (workspaceFolder) {
        const relativePath = vscode.workspace.asRelativePath(uri);
        this.fileTreeProvider.removeFileFromContext(relativePath);
        vscode.window.showInformationMessage(`Removed ${relativePath} from AI context`);
      }
    }
  }
}
