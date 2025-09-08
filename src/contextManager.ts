// src/contextManager.ts

import * as vscode from 'vscode';
import * as path from 'path';
import { FileTreeProvider } from './commands/fileTreeProvider';

export class ContextManager {
  private fileTreeProvider?: FileTreeProvider;
  private context: vscode.ExtensionContext;

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

  async getContextContent(): Promise<string> {
    console.log('Getting context content...');
    
    if (!this.fileTreeProvider) {
      console.log('No file tree provider available');
      return this.getNoWorkspaceMessage();
    }

    const contextFiles = this.fileTreeProvider.getContextFiles();
    const treeOnlyFiles = this.fileTreeProvider.getTreeOnlyFiles();
    
    console.log('Context files count:', contextFiles.length);
    console.log('Tree only files count:', treeOnlyFiles.length);
    console.log('Context files list:', contextFiles);
    
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      console.log('No workspace folder available');
      return this.getNoWorkspaceMessage();
    }

    let content = '# Project Context\n\n';
    
    // Add workspace info
    content += `**Workspace:** ${path.basename(workspaceFolder.uri.fsPath)}\n`;
    content += `**Path:** ${workspaceFolder.uri.fsPath}\n\n`;
    
    // Show project structure first
    content += await this.generateProjectTree();
    content += '\n';
    
    // Then show file contents
    if (contextFiles.length > 0) {
      content += `## File Contents (${contextFiles.length} files)\n\n`;

      for (const filePath of contextFiles) {
        try {
          const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
          console.log('Reading file:', fullPath.fsPath);
          
          const fileStats = await vscode.workspace.fs.stat(fullPath);
          if (fileStats.type === vscode.FileType.File) {
            const fileContent = await vscode.workspace.fs.readFile(fullPath);
            const textContent = Buffer.from(fileContent).toString('utf8');
            
            content += `### ${filePath}\n\n`;
            const language = this.getLanguageFromExtension(filePath);
            content += '```'
            content += textContent;
            content += '\n```\n\n';
            
            console.log(`Added file ${filePath} (${textContent.length} chars)`);
          }
        } catch (error) {
          console.error(`Error reading file ${filePath}:`, error);
          content += `### ${filePath}\n\n`;
          content += `⚠️ **Error reading file:** ${error}\n\n`;
        }
      }
    } else {
      content += '## File Contents\n\n';
      content += '**No files are currently included in the context.** Use the file tree in the Lollms Settings sidebar to add files.\n\n';
    }

    // Add tree-only files section
    if (treeOnlyFiles.length > 0) {
      content += `## Files in Tree Only (${treeOnlyFiles.length} files)\n\n`;
      content += '*These files are visible in the project structure but their content is excluded:*\n\n';
      treeOnlyFiles.forEach(file => {
        content += `- \`${file}\`\n`;
      });
      content += '\n';
    }

    console.log('Generated context content length:', content.length);
    return content;
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

  private getLanguageFromExtension(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase().substring(1);
    const langMap: { [key: string]: string } = {
      'ts': 'typescript',
      'tsx': 'typescript',
      'js': 'javascript',
      'jsx': 'javascript',
      'py': 'python',
      'java': 'java',
      'cpp': 'cpp',
      'cxx': 'cpp',
      'cc': 'cpp',
      'c': 'c',
      'h': 'c',
      'hpp': 'cpp',
      'cs': 'csharp',
      'php': 'php',
      'rb': 'ruby',
      'go': 'go',
      'rs': 'rust',
      'html': 'html',
      'htm': 'html',
      'css': 'css',
      'scss': 'scss',
      'sass': 'sass',
      'less': 'less',
      'json': 'json',
      'xml': 'xml',
      'yaml': 'yaml',
      'yml': 'yaml',
      'md': 'markdown',
      'markdown': 'markdown',
      'sh': 'bash',
      'bash': 'bash',
      'zsh': 'bash',
      'fish': 'fish',
      'sql': 'sql',
      'vue': 'vue',
      'svelte': 'svelte',
      'dart': 'dart',
      'kt': 'kotlin',
      'swift': 'swift',
      'scala': 'scala',
      'r': 'r',
      'dockerfile': 'dockerfile',
      'makefile': 'makefile',
      'cmake': 'cmake',
      'toml': 'toml',
      'ini': 'ini',
      'cfg': 'ini',
      'conf': 'ini'
    };
    return langMap[ext] || '';
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
