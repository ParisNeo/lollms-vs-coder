import * as vscode from 'vscode';
import * as path from 'path';
import { ContextStateProvider } from './commands/contextStateProvider';
import Jimp = require('jimp');
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { SkillsManager, Skill } from './skillsManager';
import * as mammoth from 'mammoth';
const pdfParse = require('pdf-parse');
import { stripThinkingTags } from './utils';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';

const execAsync = promisify(exec);

export interface ContextResult {
  text: string;
  images: { filePath: string; data: string }[];
  projectTree: string;
  selectedFilesContent: string;
  skillsContent: string;
  importedSkills: Skill[];
}

export class ContextManager {
  private contextStateProvider?: ContextStateProvider;
  private skillsManager?: SkillsManager;
  private context: vscode.ExtensionContext;
  private lollmsAPI: LollmsAPI;
  private imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);
  private docExtensions = new Set(['.pdf', '.docx', '.xlsx', '.pptx', '.msg']);
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
  
  // Storage key for persistent project skills
  private static PROJECT_SKILLS_KEY = 'lollms_project_active_skills';

  constructor(context: vscode.ExtensionContext, lollmsAPI: LollmsAPI) {
    this.context = context;
    this.lollmsAPI = lollmsAPI;
  }
  
  public setContextStateProvider(provider: ContextStateProvider | undefined) {
      this.contextStateProvider = provider;
  }

  public setSkillsManager(manager: SkillsManager) {
      this.skillsManager = manager;
  }

  getContextStateProvider(): ContextStateProvider | undefined {
    return this.contextStateProvider;
  }

  public getLastContext(): ContextResult | null {
      return this._lastContext;
  }

  private isBinary(buffer: Buffer): boolean {
      const chunk = buffer.slice(0, Math.min(buffer.length, 1024));
      return chunk.includes(0);
  }

  private getLanguageId(filePath: string): string {
      const ext = path.extname(filePath).toLowerCase().substring(1);
      return this.extensionToLanguageMap[ext] || ext || 'plaintext';
  }

  private async extractDefinitions(uri: vscode.Uri): Promise<string> {
      try {
          const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri);
          if (!symbols || symbols.length === 0) return "(No definitions found)";

          const formatSymbol = (symbol: vscode.DocumentSymbol, indent: string = ''): string => {
              const kindMap: { [key: number]: string } = {
                  [vscode.SymbolKind.Class]: 'class', [vscode.SymbolKind.Method]: 'method', [vscode.SymbolKind.Function]: 'function',
                  [vscode.SymbolKind.Constructor]: 'constructor', [vscode.SymbolKind.Interface]: 'interface', [vscode.SymbolKind.Enum]: 'enum',
                  [vscode.SymbolKind.Variable]: 'variable', [vscode.SymbolKind.Constant]: 'constant', [vscode.SymbolKind.Property]: 'property',
                  [vscode.SymbolKind.Struct]: 'struct'
              };
              const kindName = kindMap[symbol.kind] || 'symbol';
              const significantKinds = [
                  vscode.SymbolKind.Class, vscode.SymbolKind.Method, vscode.SymbolKind.Function, 
                  vscode.SymbolKind.Interface, vscode.SymbolKind.Enum, vscode.SymbolKind.Constructor, vscode.SymbolKind.Struct
              ];
              if (!significantKinds.includes(symbol.kind)) return ''; 

              let output = `${indent}${kindName} ${symbol.name}`;
              if (symbol.detail) output += `: ${symbol.detail}`;
              output += '\n';
              for (const child of symbol.children) output += formatSymbol(child, indent + '  ');
              return output;
          };

          let definitions = '';
          for (const symbol of symbols) definitions += formatSymbol(symbol);
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
              
              content += `\`\`\`${this.getLanguageId(filePath)}:${filePath}\n${text}\n\`\`\`\n\n`;
          } catch (error) { }
      }
      return content;
  }

  private async searchWorkspaceKeywords(keywords: string[], cwd: string): Promise<string> {
    if (keywords.length === 0) return "No keywords provided.";
    
    let combinedResults = `Keyword Search Results:\n`;
    
    for (const keyword of keywords) {
        const pattern = keyword.replace(/"/g, '\\"');
        try {
            try {
                const { stdout } = await execAsync(`git grep -n -I -c "${pattern}"`, { cwd });
                if (stdout.trim()) {
                    combinedResults += `\nMatches for "${keyword}" (count per file):\n${stdout.trim()}\n`;
                    continue;
                }
            } catch (e) {}

            let command = os.platform() === 'win32' 
              ? `findstr /S /N /I /P "${pattern}" *` 
              : `grep -r -n -I -l "${pattern}" .`;
            
            const { stdout } = await execAsync(command, { cwd });
            if (stdout.trim()) {
                combinedResults += `\nMatches for "${keyword}":\n${stdout.trim().substring(0, 2000)}\n`;
            } else {
                combinedResults += `\nMatches for "${keyword}": No matches found.\n`;
            }
        } catch (e) {
            combinedResults += `\nMatches for "${keyword}": Search operation failed.\n`;
        }
    }
    return combinedResults;
  }

  public async runContextAgent(
      userPrompt: string, 
      model: string,
      signal: AbortSignal, 
      onUpdate: (content: string) => void,
      initialKeywords?: string[]
  ): Promise<string> {
      const MAX_STEPS = 10;
      const MAX_RETRIES = 3;
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder || !this.contextStateProvider) {
          onUpdate("❌ No workspace context available.");
          return "";
      }

      const allFiles = await this.contextStateProvider.getAllVisibleFiles(signal);
      if (allFiles.length === 0) {
          onUpdate("⚠️ No visible files found in project.");
          return "";
      }

      const currentContextFiles = this.contextStateProvider.getIncludedFiles().map(f => f.path);
      const selectedFiles = new Set<string>(currentContextFiles);
      const initialCount = selectedFiles.size;

      const fileTree = await this.generateProjectTree(signal);
      
      const systemPrompt = `You are a Senior Context Librarian Agent.
Your goal is to prepare the perfect context for an LLM to answer the user's request.
You have access to the project structure and the list of currently selected files.

**AVAILABLE TOOLS:**
1. \`add_files(files=["path1", "path2"])\`: Add files to the context (read their content).
2. \`remove_files(files=["path1"])\`: Remove files from the context.
3. \`read_file(file="path")\`: Peek at a file's content without fully adding it.
4. \`search_keywords(keywords=["funcName", "className"])\`: Search the entire codebase for specific strings. Use this to find where logic exists before adding files.
5. \`done()\`: Finish the context selection process.

**RULES:**
- Analyze the user request and the current selection.
- If you aren't sure where logic is, use \`search_keywords\` first.
- Only add files that are strictly relevant to save tokens.
- **OUTPUT JSON ONLY**: Reply with a valid JSON object describing the tool call.

**JSON FORMAT:**
\`\`\`json
{
  "tool": "tool_name",
  "params": { ... }
}
\`\`\`
`;

      const actionLog: string[] = [];
      let initialUserContent = `**User Request:** "${userPrompt}"\n\n**Project Structure:**\n${fileTree}`;
      
      if (initialKeywords && initialKeywords.length > 0) {
          actionLog.push(`🔍 Grounding search for keywords: ${initialKeywords.join(', ')}...`);
          const searchResults = await this.searchWorkspaceKeywords(initialKeywords, workspaceFolder.uri.fsPath);
          initialUserContent += `\n\n**Initial Search Results:**\n${searchResults}`;
      }

      if (selectedFiles.size > 0) {
          initialUserContent += `\n\n**Currently Selected Files:**\n${JSON.stringify(Array.from(selectedFiles))}`;
      }

      let chatHistory: ChatMessage[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: initialUserContent }
      ];

      const renderUpdate = (status: string, finished: boolean = false, step: number = 0) => {
          const sortedFiles = Array.from(selectedFiles).sort();
          const filesListItems = sortedFiles.map(f => `<li><span class="codicon codicon-file"></span> ${f}</li>`).join('');
          
          const filesTree = selectedFiles.size > 0 
              ? `<details ${finished ? 'open' : ''}><summary>📂 <strong>Context Files (${selectedFiles.size})</strong></summary><ul class="file-list-tree">${filesListItems}</ul></details>`
              : `*No files selected.*`;
          
          const logHtml = actionLog.map(l => `<div class="agent-log-item">${l}</div>`).join('');
          const logSection = actionLog.length > 0
               ? `<details ${finished ? '' : 'open'}><summary>📜 Agent Execution Log</summary><div class="agent-log-container">${logHtml}</div></details>`
               : '';
          
          let spinnerHtml = '';
          if (!finished) {
              spinnerHtml = `<div class="status-line"><div class="spinner"></div> <span>Files selection Round ${step + 1}: ${status}</span></div>`;
          } else {
              spinnerHtml = `<div class="status-line"><span class="codicon codicon-check"></span> <span>Context Ready</span></div>`;
          }
          
          const fullMessage = `**🧠 Auto-Context Agent**\n\n${spinnerHtml}\n\n${filesTree}\n\n${logSection}`;
          onUpdate(fullMessage);
      };

      if (initialCount > 0) {
          actionLog.push(`ℹ️ Started with ${initialCount} previously selected files.`);
      }
      actionLog.push("🔍 Analyzing project structure and request...");
      renderUpdate("Thinking...", false, 0);

      let retryCount = 0;
      let stepsTaken = 0;

      for (let step = 0; step < MAX_STEPS; step++) {
          if (signal.aborted) throw new Error("Context agent aborted.");

          chatHistory.push({ 
              role: 'system', 
              content: `[System Update] Currently selected files: ${JSON.stringify(Array.from(selectedFiles))}. Continue refining or call done().` 
          });

          let response = "";
          try {
              response = await this.lollmsAPI.sendChat(chatHistory, null, signal, model);
          } catch (e: any) {
              actionLog.push(`❌ LLM Error: ${e.message}`);
              renderUpdate("Error", true, step);
              break;
          }
          
          chatHistory.push({ role: 'assistant', content: response });

          const cleanResponse = stripThinkingTags(response);
          let jsonMatch = cleanResponse.match(/```json\s*([\s\S]+?)\s*```/) || cleanResponse.match(/\{[\s\S]*\}/);
          
          if (!jsonMatch) {
              if (retryCount < MAX_RETRIES) {
                  retryCount++;
                  chatHistory.push({ 
                      role: 'system', 
                      content: "ERROR: You must output ONLY a valid JSON object. Use one of the provided tools." 
                  });
                  continue; 
              } else {
                  actionLog.push(`❌ Agent failed to output JSON.`);
                  break;
              }
          }

          try {
              const toolCall = JSON.parse(jsonMatch[1] || jsonMatch[0]);
              const toolName = toolCall.tool;
              const params = toolCall.params || {};

              retryCount = 0;

              if (toolName === 'done') {
                  actionLog.push(`✅ Optimization complete.`);
                  renderUpdate("Context Ready", true, step);
                  break;
              }

              stepsTaken++;

              if (toolName === 'add_files') {
                  const files = params.files || params.paths;
                  if (Array.isArray(files)) {
                      const validFiles = files.filter(f => allFiles.includes(f));
                      if (validFiles.length > 0) {
                          validFiles.forEach(f => selectedFiles.add(f));
                          await this.contextStateProvider.addFilesToContext(validFiles);
                          actionLog.push(`➕ Added: ${validFiles.length} file(s).`);
                          renderUpdate("Updating context...", false, step);
                      }
                  }
              } else if (toolName === 'remove_files') {
                  const files = params.files || params.paths;
                  if (Array.isArray(files)) {
                      files.forEach(f => selectedFiles.delete(f));
                      const uris = files.map((f: string) => vscode.Uri.joinPath(workspaceFolder.uri, f));
                      await this.contextStateProvider.setStateForUris(uris, 'tree-only'); 
                      actionLog.push(`➖ Removed: ${files.length} file(s).`);
                      renderUpdate("Updating context...", false, step);
                  }
              } else if (toolName === 'read_file') {
                  const pathArg = params.path || params.file;
                  if (pathArg && allFiles.includes(pathArg)) {
                      const content = await this.readSpecificFiles([pathArg]);
                      const snippet = content.substring(0, 4000);
                      chatHistory.push({ role: 'system', content: `Content of ${pathArg}:\n\`\`\`\n${snippet}\n\`\`\`` });
                      actionLog.push(`📖 Peeked: ${pathArg}`);
                      renderUpdate("Reading file...", false, step);
                  }
              } else if (toolName === 'search_keywords') {
                const keywords = params.keywords || params.query;
                if (Array.isArray(keywords)) {
                    const results = await this.searchWorkspaceKeywords(keywords, workspaceFolder.uri.fsPath);
                    chatHistory.push({ role: 'system', content: results });
                    actionLog.push(`🔍 Searched for: ${keywords.join(', ')}`);
                    renderUpdate("Searching codebase...", false, step);
                }
              } else {
                   actionLog.push(`⚠️ Unknown tool: ${toolName}`);
              }

          } catch (e: any) {
              actionLog.push(`❌ Tool Error: ${e.message}`);
          }
      }

      renderUpdate("Context Ready", true, stepsTaken);

      if (selectedFiles.size > 0) {
          return await this.readSpecificFiles(Array.from(selectedFiles));
      }
      return "";
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
  
  async getContextContent(options?: { includeTree?: boolean, signal?: AbortSignal, importedSkillIds?: string[] }): Promise<ContextResult> {
    const result: ContextResult = { text: '', images: [], projectTree: '', selectedFilesContent: '', skillsContent: '', importedSkills: [] };
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    const maxImageSize = config.get<number>('maxImageSize') || 1024;
    const includeTree = options?.includeTree !== false; 
    const signal = options?.signal;
    // We add this here so it's always present when inspecting or sending context
    const skillProtocol = `
### SKILL CREATION PROTOCOL
If the user asks to "save this as a skill", "remember this", or "learn how to do X", wrap the resulting documentation/code in a <skill> tag.
Format:
<skill>
# Skill Name
Description of what this teaches or provides.
\`\`\`language
code or instructions
\`\`\`
</skill>
`;
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
    
    if (this.skillsManager) {
        const skills = await this.skillsManager.getSkills();
        const allowedIds = options?.importedSkillIds;

        if (skills.length > 0 && allowedIds && allowedIds.length > 0) {
            for (const skill of skills) {
                if (allowedIds.includes(skill.id)) {
                    result.importedSkills.push(skill);
                    result.skillsContent += `### Skill: ${skill.name}\n\`\`\`${skill.language || 'text'}\n${skill.content}\n\`\`\`\n\n`;
                }
            }
        }
    }

    if (includeTree) {
        if (signal?.aborted) throw new Error("Operation cancelled");
        result.projectTree = await this.generateProjectTree(signal);
    }

    const includedFiles = contextFiles.filter(f => !f.path.endsWith(path.sep));
    
    if (includedFiles.length > 0) {
      for (const fileEntry of includedFiles) {
        if (signal?.aborted) throw new Error("Operation cancelled");

        const filePath = fileEntry.path;
        const contextState = fileEntry.state;

        try {
          const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
          const stat = await vscode.workspace.fs.stat(fullPath);
          if (stat.type !== vscode.FileType.File) continue;

          const ext = path.extname(filePath).toLowerCase();

          if (this.binaryExtensions.has(ext)) {
              result.selectedFilesContent += `\`\`\`${this.getLanguageId(filePath)}:${filePath}\n(Binary file content excluded)\n\`\`\`\n\n`;
              continue;
          }

          if (contextState === 'definitions-only') {
              const definitions = await this.extractDefinitions(fullPath);
              result.selectedFilesContent += `\`\`\`${this.getLanguageId(filePath)}:${filePath} (Definitions Only)\n${definitions}\n\`\`\`\n\n`;
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
            result.selectedFilesContent += `### \`${filePath}\` (Image Attached)\n\n`;
            continue; 
          } else {
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
                    result.selectedFilesContent += `\`\`\`${this.getLanguageId(filePath)}:${filePath}\n(Binary content detected and excluded)\n\`\`\`\n\n`;
                    continue;
                }
                fileContent = buffer.toString('utf8');
            }
          }
          
          result.selectedFilesContent += `\`\`\`${this.getLanguageId(filePath)}:${filePath}\n${fileContent}\n\`\`\`\n\n`;

        } catch (error) {
          result.selectedFilesContent += `### ${filePath}\n\n⚠️ **Error processing entry:** ${error}\n\n`;
        }
      }
    }

    // MERGE Discussion Skills AND Project Persistent Skills
    const discussionSkillIds = options?.importedSkillIds || [];
    const projectSkillIds = await this.getActiveProjectSkills();
    
    // Unique set of IDs
    const allSkillIds = Array.from(new Set([...discussionSkillIds, ...projectSkillIds]));

    if (this.skillsManager && allSkillIds.length > 0) {
        const skills = await this.skillsManager.getSkills();
        for (const skill of skills) {
            if (allSkillIds.includes(skill.id)) {
                result.importedSkills.push(skill);
                const scopeLabel = skill.scope === 'global' ? 'GLOBAL' : 'PROJECT';
                result.skillsContent += `### Skill (${scopeLabel}): ${skill.name}\n> ${skill.description}\n\`\`\`${skill.language || 'text'}\n${skill.content}\n\`\`\`\n\n`;
            }
        }
    }
    if (this.skillsManager && allSkillIds.length > 0) {
        result.skillsContent += skillProtocol + "\n"; // Inject the protocol here
        const skills = await this.skillsManager.getSkills();
        for (const skill of skills) {
            if (allSkillIds.includes(skill.id)) {
                result.importedSkills.push(skill);
                const scopeLabel = skill.scope === 'global' ? 'GLOBAL' : 'PROJECT';
                result.skillsContent += `### Skill (${scopeLabel}): ${skill.name}\n> ${skill.description}\n\`\`\`${skill.language || 'text'}\n${skill.content}\n\`\`\`\n\n`;
            }
        }
    } else {
        // Even if no skills are loaded, we provide the protocol so the AI knows it CAN create them
        result.skillsContent = skillProtocol;
    }    
    result.text = `# Project Context\n\n**Workspace:** ${path.basename(workspaceFolder.uri.fsPath)}\n\n`;
    if (result.skillsContent) {
        result.text += `## Active Skills & Protocols\n${result.skillsContent}---\n\n`;
    }

    if (result.projectTree) {
        result.text += `${result.projectTree}\n`;
    }
    if (result.selectedFilesContent) {
        result.text += `## File Contents\n\n${result.selectedFilesContent}`;
    } else {
        result.text += '## File Contents\n\n**No files are currently included in the context.**\n\n';
    }

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
2.  **NO EXTRA TEXT:** Do NOT add any conversational text.
3.  **FILE PATHS:** The strings in the array must be the exact relative paths of the files.
4.  **RELENANCE:** Select only the files that are most likely to be needed.
5.  **DO NOT ANSWER:** Your sole purpose is to output the JSON array.

Example Response:
[
  "src/commands/chatPanel.ts",
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
            throw new Error(`No valid JSON array found in the AI's response.`);
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

  private async generateProjectTree(signal?: AbortSignal): Promise<string> {
    
    if (!this.contextStateProvider) {
      return '## Project Structure\n\n*No project structure available - no workspace folder found.*\n';
    }

    const allVisibleFiles = await this.contextStateProvider.getAllVisibleFiles(signal);
    if (signal?.aborted) throw new Error("Operation cancelled");

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


  public async getActiveProjectSkills(): Promise<string[]> {
      return this.context.workspaceState.get<string[]>(ContextManager.PROJECT_SKILLS_KEY, []);
  }

  public async addSkillToProject(skillId: string) {
      const current = await this.getActiveProjectSkills();
      if (!current.includes(skillId)) {
          await this.context.workspaceState.update(ContextManager.PROJECT_SKILLS_KEY, [...current, skillId]);
      }
  }

  public async removeSkillFromProject(skillId: string) {
      const current = await this.getActiveProjectSkills();
      const updated = current.filter(id => id !== skillId);
      await this.context.workspaceState.update(ContextManager.PROJECT_SKILLS_KEY, updated);
  }

}

