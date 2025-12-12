import * as vscode from 'vscode';
import * as path from 'path';
import { ContextStateProvider } from './commands/contextStateProvider';
import Jimp = require('jimp');
import { LollmsAPI } from './lollmsAPI';
import * as mammoth from 'mammoth';
// Use require for pdf-parse to avoid some bundling issues with esbuild if not using default import
const pdfParse = require('pdf-parse');

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
  // Explicitly exclude common binary and ML model formats
  private binaryExtensions = new Set([
      '.pth', '.pt', '.onnx', '.tflite', '.pb', '.h5', '.hdf5', '.pkl', '.bin', 
      '.exe', '.dll', '.so', '.dylib', '.class', '.jar', '.war', '.ear', 
      '.zip', '.tar', '.gz', '.7z', '.rar', '.iso', '.img', '.db', '.sqlite', '.sqlite3',
      '.pyc', '.pyo', '.pyd'
  ]);

  private extensionToLanguageMap: { [key: string]: string } = {
      'py': 'python',
      'js': 'javascript',
      'jsx': 'javascript',
      'ts': 'typescript',
      'tsx': 'typescript',
      'vue': 'vue',
      'rs': 'rust',
      'sh': 'bash',
      'md': 'markdown',
      'json': 'json',
      'html': 'html',
      'css': 'css',
      'scss': 'scss',
      'less': 'less',
      'cpp': 'cpp',
      'c': 'c',
      'h': 'c',
      'hpp': 'cpp',
      'cs': 'csharp',
      'go': 'go',
      'java': 'java',
      'php': 'php',
      'rb': 'ruby',
      'swift': 'swift',
      'kt': 'kotlin',
      'lua': 'lua',
      'r': 'r',
      'sql': 'sql',
      'yaml': 'yaml',
      'yml': 'yaml',
      'xml': 'xml',
      'bat': 'batch',
      'ps1': 'powershell',
      'tex': 'latex',
      'vb': 'vb',
      'fs': 'fsharp',
      'erl': 'erlang',
      'ex': 'elixir',
      'pl': 'perl',
      'dart': 'dart',
      'm': 'objectivec',
      'mm': 'objectivec',
      'scala': 'scala',
      'hs': 'haskell',
      'clj': 'clojure',
      'cljs': 'clojure',
      'dockerfile': 'dockerfile',
      'groovy': 'groovy',
      'gradle': 'groovy',
      'toml': 'toml',
      'ini': 'ini',
      'tf': 'terraform',
      'svelte': 'svelte',
      'ejs': 'ejs',
      'erb': 'erb',
      'hbs': 'handlebars'
  };
  
  private _lastContext: ContextResult | null = null;

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

  public getLastContext(): ContextResult | null {
      return this._lastContext;
  }

  private isBinary(buffer: Buffer): boolean {
      // Check first 1024 bytes for null bytes, which is a strong indicator of binary content
      const chunk = buffer.slice(0, Math.min(buffer.length, 1024));
      return chunk.includes(0);
  }

  private getLanguageId(filePath: string): string {
      const ext = path.extname(filePath).toLowerCase().substring(1);
      return this.extensionToLanguageMap[ext] || ext || 'plaintext';
  }

  private async extractDefinitions(uri: vscode.Uri): Promise<string> {
      try {
          const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
              'vscode.executeDocumentSymbolProvider', 
              uri
          );

          if (!symbols || symbols.length === 0) {
              return "(No definitions found)";
          }

          const formatSymbol = (symbol: vscode.DocumentSymbol, indent: string = ''): string => {
              const kindMap: { [key: number]: string } = {
                  [vscode.SymbolKind.Class]: 'class',
                  [vscode.SymbolKind.Method]: 'method',
                  [vscode.SymbolKind.Function]: 'function',
                  [vscode.SymbolKind.Constructor]: 'constructor',
                  [vscode.SymbolKind.Interface]: 'interface',
                  [vscode.SymbolKind.Enum]: 'enum',
                  [vscode.SymbolKind.Variable]: 'variable',
                  [vscode.SymbolKind.Constant]: 'constant',
                  [vscode.SymbolKind.Property]: 'property',
                  [vscode.SymbolKind.Struct]: 'struct'
              };
              
              const kindName = kindMap[symbol.kind] || 'symbol';
              
              // Only include significant symbols for context reduction
              const significantKinds = [
                  vscode.SymbolKind.Class, 
                  vscode.SymbolKind.Method, 
                  vscode.SymbolKind.Function, 
                  vscode.SymbolKind.Interface,
                  vscode.SymbolKind.Enum,
                  vscode.SymbolKind.Constructor,
                  vscode.SymbolKind.Struct
              ];

              if (!significantKinds.includes(symbol.kind)) {
                  return ''; 
              }

              let output = `${indent}${kindName} ${symbol.name}`;
              if (symbol.detail) {
                  output += `: ${symbol.detail}`;
              }
              output += '\n';

              for (const child of symbol.children) {
                  output += formatSymbol(child, indent + '  ');
              }
              return output;
          };

          let definitions = '';
          for (const symbol of symbols) {
              definitions += formatSymbol(symbol);
          }
          
          return definitions.trim() || "(No significant definitions found)";

      } catch (e) {
          return `(Error extracting definitions: ${e})`;
      }
  }

  public async getWorkspaceFilePaths(): Promise<string[]> {
      if (!this.contextStateProvider) return [];
      return await this.contextStateProvider.getAllVisibleFiles();
  }

  public async readSpecificFiles(filePaths: string[]): Promise<string> {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder || !filePaths || filePaths.length === 0) return '';

      let content = '';
      for (const filePath of filePaths) {
          try {
              const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
              const stat = await vscode.workspace.fs.stat(fullPath);
              if (stat.type !== vscode.FileType.File) continue;

              const ext = path.extname(filePath).toLowerCase();
              if (this.binaryExtensions.has(ext)) continue;

              const fileBytes = await vscode.workspace.fs.readFile(fullPath);
              const buffer = Buffer.from(fileBytes);

              if (this.isBinary(buffer)) continue;

              const text = buffer.toString('utf8');
              
              content += `File: ${filePath}\n`;
              const language = this.getLanguageId(filePath);
              content += '```' + language + '\n';
              content += text;
              content += '\n```\n\n';
          } catch (error) {
              // Skip files that can't be read
          }
      }
      return content;
  }

  private async parsePdfLocal(buffer: Buffer): Promise<string> {
      try {
          const data = await pdfParse(buffer);
          return data.text;
      } catch (e) {
          return `[Local PDF Parse Failed: ${e}]`;
      }
  }

  private async parseDocxLocal(buffer: Buffer): Promise<string> {
      try {
          const result = await mammoth.extractRawText({ buffer: buffer });
          return result.value;
      } catch (e) {
          return `[Local DOCX Parse Failed: ${e}]`;
      }
  }

  /**
   * Processes a file content buffer/base64 based on its extension.
   * Handles text extraction for PDFs, DOCX, etc., and checks for binary content.
   */
  public async processFile(fileName: string, base64Data: string): Promise<string> {
      const ext = path.extname(fileName).toLowerCase();
      const buffer = Buffer.from(base64Data, 'base64');

      if (this.binaryExtensions.has(ext)) {
          return `(Binary file ${fileName} content excluded)`;
      }

      if (this.docExtensions.has(ext)) {
          try {
              return await this.lollmsAPI.extractText(base64Data, fileName);
          } catch (apiError: any) {
              // Fallback mechanism
              if (ext === '.pdf') {
                  return await this.parsePdfLocal(buffer);
              } else if (ext === '.docx') {
                  return await this.parseDocxLocal(buffer);
              }
              return `⚠️ **Error processing document:** ${(apiError as Error).message}`;
          }
      } else if (ext === '.ipynb') {
          try {
              const notebookJson = JSON.parse(buffer.toString('utf8'));
              let fileContent = '';
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
              return fileContent;
          } catch (e: any) {
              return `⚠️ **Error parsing Jupyter Notebook:** ${e.message}`;
          }
      } else {
          if (this.isBinary(buffer)) {
              return `(Binary content detected in ${fileName} and excluded)`;
          }
          return buffer.toString('utf8');
      }
  }

  async getContextContent(options?: { includeTree?: boolean }): Promise<ContextResult> {
    const result: ContextResult = { text: '', images: [] };
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    const maxImageSize = config.get<number>('maxImageSize') || 1024;
    const includeTree = options?.includeTree !== false; // Default true

    if (!this.contextStateProvider) {
      result.text = this.getNoWorkspaceMessage();
      this._lastContext = result;
      return result;
    }
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      result.text = this.getNoWorkspaceMessage();
      this._lastContext = result;
      return result;
    }

    const contextFiles = this.contextStateProvider.getIncludedFiles();
    let content = `# Project Context\n\n**Workspace:** ${path.basename(workspaceFolder.uri.fsPath)}\n\n`;
    
    if (includeTree) {
        content += await this.generateProjectTree();
        content += '\n';
    }

    const includedFiles = contextFiles.filter(f => !f.path.endsWith(path.sep));
    
    if (includedFiles.length > 0) {
      content += `## File Contents (${includedFiles.length} files)\n\n`;
      content += `Warning: Only some files' contents are shown here. If you need more file contents, don't hesitate to ask the user to select more files that you need to see.\n\n`;
      
      for (const fileEntry of includedFiles) {
        const filePath = fileEntry.path;
        const contextState = fileEntry.state;

        try {
          const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
          const stat = await vscode.workspace.fs.stat(fullPath);
          if (stat.type !== vscode.FileType.File) continue;

          const ext = path.extname(filePath).toLowerCase();

          if (this.binaryExtensions.has(ext)) {
              content += `File: ${filePath}\n(Binary file content excluded)\n\n`;
              continue;
          }

          if (contextState === 'definitions-only') {
              const definitions = await this.extractDefinitions(fullPath);
              content += `File: ${filePath} (Definitions Only)\n`;
              content += '```text\n';
              content += definitions;
              content += '\n```\n\n';
              continue;
          }

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
          } else {
            // Reuse the processFile logic implicitly or reimplement to keep the flow
            // Since we already have the buffer, avoiding base64 conversion back and forth unless necessary
            // For now, let's keep the specific logic here to avoid re-reading
            
            if (this.docExtensions.has(ext)) {
                try {
                    fileContent = await this.lollmsAPI.extractText(buffer.toString('base64'), filePath);
                } catch (apiError: any) {
                    if (ext === '.pdf') {
                        fileContent = await this.parsePdfLocal(buffer);
                    } else if (ext === '.docx') {
                        fileContent = await this.parseDocxLocal(buffer);
                    } else {
                        fileContent = `⚠️ **Error processing document on backend:** ${apiError.message}`;
                    }
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
                if (this.isBinary(buffer)) {
                    content += `File: ${filePath}\n(Binary content detected and excluded)\n\n`;
                    continue;
                }
                fileContent = buffer.toString('utf8');
            }
          }
          
          content += `File: ${filePath}\n`;
          const language = this.getLanguageId(filePath);
          content += '```' + language + '\n';
          content += fileContent;
          content += '\n```\n\n';

        } catch (error) {
          content += `### ${filePath}\n\n⚠️ **Error processing entry:** ${error}\n\n`;
        }
      }
    } else {
      content += '## File Contents\n\n**No files are currently included in the context.**\n\n';
    }

    result.text = content;
    this._lastContext = result;
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

    tree += '```text\n';
    
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

    const generateTreeString = (obj: any, prefix: string = '', isLast: boolean = true, currentPath: string = ''): string => {
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
        
        let displayKey = key;
        const fullPath = currentPath ? path.join(currentPath, key) : key;
        
        let isCollapsed = false;
        if (this.contextStateProvider && workspaceFolder) {
            const uri = vscode.Uri.joinPath(workspaceFolder.uri, fullPath);
            const state = this.contextStateProvider.getStateForUri(uri);
            if (state === 'collapsed') {
                isCollapsed = true;
            }
        }

        if (isCollapsed) {
             displayKey += ' (Content Hidden)';
        }
        
        result += prefix + connector + displayKey + '\n';

        if (obj[key] !== null) {
          const newPrefix = prefix + (isLastItem ? '    ' : '│   ');
          result += generateTreeString(obj[key], newPrefix, isLastItem, fullPath);
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
