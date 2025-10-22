// src/contextManager.ts

import * as vscode from 'vscode';
import * as path from 'path';
import { ContextStateProvider } from './commands/contextStateProvider';
import Jimp = require('jimp');
import { LollmsAPI } from './lollmsAPI';

export interface ContextResult {
  text: string;
  images: { filePath: string; data: string }[];
}

export class ContextManager {
  private contextStateProvider?: ContextStateProvider;
  private context: vscode.ExtensionContext;
  private lollmsAPI: LollmsAPI;
  private imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);
  private docExtensions = new Set(['.pdf', '.docx', '.xlsx', '.pptx', '.msg']);

  constructor(context: vscode.ExtensionContext, lollmsAPI: LollmsAPI) {
    this.context = context;
    this.lollmsAPI = lollmsAPI;
  }
  
  public setContextStateProvider(provider: ContextStateProvider | undefined) {
      this.contextStateProvider = provider;
  }

  getContextStateProvider(): ContextStateProvider | undefined {
    return this.contextStateProvider;
  }

  async getContextContent(): Promise<ContextResult> {
    const result: ContextResult = { text: '', images: [] };
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    const maxImageSize = config.get<number>('maxImageSize') || 1024;

    if (!this.contextStateProvider) {
      result.text = this.getNoWorkspaceMessage();
      return result;
    }
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      result.text = this.getNoWorkspaceMessage();
      return result;
    }

    const contextFiles = this.contextStateProvider.getIncludedFiles();
    let content = `# Project Context\n\n**Workspace:** ${path.basename(workspaceFolder.uri.fsPath)}\n\n`;
    content += await this.generateProjectTree();
    content += '\n';

    const includedFiles = contextFiles.filter(p => !p.endsWith(path.sep));
    if (includedFiles.length > 0) {
      content += `## File Contents (${includedFiles.length} files)\n\n`;
      content += `Warning: Only some files' contents are shown here. If you need more file contents, don't hesitate to ask the user to select more files that you need to see.\n\n`;
      
      for (const filePath of contextFiles) {
        try {
          const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
          const stat = await vscode.workspace.fs.stat(fullPath);
          if (stat.type !== vscode.FileType.File) continue;

          const ext = path.extname(filePath).toLowerCase();
          const fileBytes = await vscode.workspace.fs.readFile(fullPath);
          const buffer = Buffer.from(fileBytes);
          let fileContent = '';

          if (this.imageExtensions.has(ext)) {
            const image = await Jimp.read(buffer);
            if (maxImageSize > 0 && (image.getWidth() > maxImageSize || image.getHeight() > maxImageSize)) {
              image.scaleToFit(maxImageSize, maxImageSize);
            }
            const base64Data = await image.getBase64Async(image.getMIME());
            result.images.push({ filePath, data: base64Data });
            content += `### \`${filePath}\` (Image Attached)\n\n`;
            continue; 
          } else if (this.docExtensions.has(ext)) {
            try {
                fileContent = await this.lollmsAPI.extractText(buffer.toString('base64'), filePath);
            } catch (e: any) {
                fileContent = `⚠️ **Error processing document on backend:** ${e.message}`;
            }
          } else if (ext === '.ipynb') {
            try {
              const notebookJson = JSON.parse(buffer.toString('utf8'));
              if (notebookJson.cells && Array.isArray(notebookJson.cells)) {
                  notebookJson.cells.forEach((cell: any, index: number) => {
                      const source = Array.isArray(cell.source) ? cell.source.join('') : '';
                      if (cell.cell_type === 'code') {
                          fileContent += `--- Cell ${index + 1} (code) ---\n\`\`\`python\n${source}\n\`\`\`\n\n`;
                      } else if (cell.cell_type === 'markdown') {
                          fileContent += `--- Cell ${index + 1} (markdown) ---\n${source}\n\n`;
                      }
                  });
              }
            } catch (e: any) {
                fileContent = `⚠️ **Error parsing Jupyter Notebook:** ${e.message}`;
            }
          } else {
            fileContent = buffer.toString('utf8');
          }
          
          content += `### \`${filePath}\`\n\n`;
          const language = path.extname(filePath).substring(1);
          content += '```' + language + '\n';
          content += fileContent;
          content += '\n```\n\n`';

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
    if (!this.contextStateProvider) {
        vscode.window.showErrorMessage("Context State Provider not available.");
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
        ], null);

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
    
    if (!this.contextStateProvider) {
      return '## Project Structure\n\n*No project structure available - no workspace folder found.*\n';
    }

    const allVisibleFiles = await this.contextStateProvider.getAllVisibleFiles();
    
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return '## Project Structure\n\n*No workspace folder found.*\n';
    }

    let tree = '## Project Structure\n\n';
    
    if (allVisibleFiles.length === 0) {
      tree += '*No files are currently visible in the context. Right-click files in the explorer to change their context state.*\n';
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
2. Right-click on files in the explorer to set their AI Context State
3. Start chatting with context about your code

Currently operating without project context.
`;
  }
}