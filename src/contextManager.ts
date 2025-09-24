// src/contextManager.ts

import * as vscode from 'vscode';
import * as path from 'path';
import { FileTreeProvider } from './commands/fileTreeProvider';
import jimp from 'jimp';
import { LollmsAPI } from './lollmsAPI';

export interface ContextResult {
  text: string;
  images: { filePath: string; data: string }[];
}

export class ContextManager {
  private fileTreeProvider?: FileTreeProvider;
  private context: vscode.ExtensionContext;
  private lollmsAPI: LollmsAPI;
  private imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];

  constructor(context: vscode.ExtensionContext, lollmsAPI: LollmsAPI) {
    this.context = context;
    this.lollmsAPI = lollmsAPI;
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
      content += `Warining: Only some files contents are shown here. If you need more file contents, don't hesistate to ask the user to select more files that you need to see.\n\n`;
      for (const filePath of contextFiles) {
        try {
          const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
          const stat = await vscode.workspace.fs.stat(fullPath);

          if (stat.type === vscode.FileType.File) {
            const ext = path.extname(filePath).toLowerCase();

            if (this.imageExtensions.includes(ext)) {
              // ... (image handling logic remains the same) ...
            } else if (ext === '.ipynb') {
                try {
                    const fileBytes = await vscode.workspace.fs.readFile(fullPath);
                    const notebookJson = JSON.parse(Buffer.from(fileBytes).toString('utf8'));
                    let notebookContent = '';
                    if (notebookJson.cells && Array.isArray(notebookJson.cells)) {
                        notebookJson.cells.forEach((cell: any, index: number) => {
                            const source = Array.isArray(cell.source) ? cell.source.join('') : '';
                            if (cell.cell_type === 'code') {
                                notebookContent += `--- Cell ${index + 1} (code) ---\n`;
                                notebookContent += '```python\n';
                                notebookContent += source + '\n';
                                notebookContent += '```\n\n';
                            } else if (cell.cell_type === 'markdown') {
                                notebookContent += `--- Cell ${index + 1} (markdown) ---\n`;
                                notebookContent += source + '\n\n';
                            }
                        });
                    }
                    content += `### \`${filePath}\` (Jupyter Notebook)\n\n`;
                    content += notebookContent;
                } catch (e: any) {
                    content += `### \`${filePath}\`\n\n⚠️ **Error parsing Jupyter Notebook:** ${e.message}\n\n`;
                }
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
  
  public async getAutoSelectionForContext(userPrompt: string): Promise<string[] | null> {
    if (!this.fileTreeProvider) {
        vscode.window.showErrorMessage("File Tree Provider not available.");
        return null;
    }

    const projectTree = await this.generateProjectTree();

    const systemPrompt = `You are an expert AI assistant specializing in analyzing user prompts to determine which files in a project are relevant for context.
Your task is to review the user's objective and the provided project file tree.
Based on this information, you must identify the most relevant files.

**CRITICAL INSTRUCTIONS:**
1.  **JSON ONLY:** Your entire response MUST be a single, valid JSON array of strings.
2.  **NO EXTRA TEXT:** Do not add any conversational text, explanations, apologies, or markdown formatting. Your response must begin with \`[\` and end with \`]\`.
3.  **FILE PATHS:** The strings in the array must be the exact relative paths of the files as they appear in the project tree.
4.  **RELEVANCE:** Select only the files that are most likely to be needed to accomplish the user's objective. Do not select irrelevant files.
5.  **DO NOT ANSWER:** Do not answer the user's prompt or provide any other information. Your sole purpose is to output the JSON array of file paths.

Example Response:
[
  "src/commands/chatPanel.ts",
  "src/extension.ts",
  "package.json"
]`;
    
    const fullUserPrompt = `**User Objective:**
"${userPrompt}"

**Project File Tree:**
${projectTree}

Based on the objective and the file tree, which files are the most relevant? Return your answer as a JSON array of file paths.`;

    try {
        const responseText = await this.lollmsAPI.sendChat([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: fullUserPrompt }
        ]);

        const jsonString = this.extractJsonArray(responseText);
        if (!jsonString) {
            throw new Error(`No valid JSON array found in the AI's response. Raw response: ${responseText}`);
        }

        const fileList = JSON.parse(jsonString);

        if (Array.isArray(fileList) && fileList.every(item => typeof item === 'string')) {
            return fileList;
        } else {
            throw new Error("The AI's response was not a valid array of strings.");
        }

    } catch (error: any) {
        vscode.window.showErrorMessage(vscode.l10n.t('error.aiFailedToSelectFiles', error.message));
        return null;
    }
  }

  private extractJsonArray(text: string): string | null {
    const markdownMatch = text.match(/```json\s*([\s\S]+?)\s*```/);
    if (markdownMatch && markdownMatch[1]) {
        return markdownMatch[1];
    }
    const firstBracket = text.indexOf('[');
    const lastBracket = text.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket > firstBracket) {
        return text.substring(firstBracket, lastBracket + 1);
    }
    return null;
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