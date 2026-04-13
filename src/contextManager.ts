import * as vscode from 'vscode';
import * as path from 'path';
import { ContextStateProvider } from './commands/contextStateProvider';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { SkillsManager, Skill } from './skillsManager';
import { CodeGraphManager } from './codeGraphManager';
import * as mammoth from 'mammoth';
const pdfParse = require('pdf-parse');
import { stripThinkingTags } from './utils';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import fetch from 'node-fetch';
import { URL } from 'url';
const execAsync = promisify(exec);

export interface ContextResult {
  text: string;
  images: { filePath: string; data: string }[];
  projectTree: string;
  selectedFilesContent: string;
  skillsContent: string;
  importedSkills: Skill[];
  diagrams?: { type: string; mermaid: string }[];
}

export class ContextManager {
  private contextStateProvider?: ContextStateProvider;
  private skillsManager?: SkillsManager;
  private codeGraphManager?: CodeGraphManager;
  private context: vscode.ExtensionContext;
  private lollmsAPI: LollmsAPI;
  private imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);
  private docExtensions = new Set(['.pdf', '.docx', '.xlsx', '.pptx', '.msg']);
  private binaryExtensions = new Set([
      '.pth', '.pt', '.onnx', '.tflite', '.pb', '.h5', '.hdf5', '.pkl', '.bin', 
      '.exe', '.dll', '.so', '.dylib', '.class', '.jar', '.war', '.ear', 
      '.zip', '.tar', '.gz', '.7z', '.rar', '.iso', '.img', '.db', '.sqlite', '.sqlite3',
      '.pyc', '.pyo', '.pyd', '.pth', '.pt', '.pkl', '.pickle'
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
  private static PROJECT_SKILLS_KEY = 'lollms_project_active_skills';
  private static TOKEN_CACHE_KEY = 'lollms_token_cache';

  // --- GLOBAL CACHE STATE ---
  private _cachedTreeString: string | null = null;
  private _isTreeDirty: boolean = true;
  private _fileContentCache!: Map<string, { content: string, state: ContextState }>;

  constructor(context: vscode.ExtensionContext, lollmsAPI: LollmsAPI) {
    this.context = context;
    this.lollmsAPI = lollmsAPI;
    this._fileContentCache = new Map();
  }

  /**
   * Invalidates the entire tree cache (e.g. on file create/delete/rename)
   */
  public markTreeDirty() {
    this._isTreeDirty = true;
    this._cachedTreeString = null;
  }

  /**
   * Invalidates the content of a specific file in the cache.
   * Called when a file is saved or deleted.
   */
  public refreshFileInCache(uri: vscode.Uri) {
    const relPath = this.normalize(vscode.workspace.asRelativePath(uri, false));
    this._fileContentCache?.delete(relPath);
    // Invalidate tree because file content changes can affect [C] / [D] markers 
    // and code graph accuracy.
    this.markTreeDirty();
  }

  /**
   * Resets all caches (e.g. on workspace switch)
   */
  public clearAllCaches() {
    this._cachedTreeString = null;
    this._isTreeDirty = true;
    this._fileContentCache?.clear();
  }
  
  public setContextStateProvider(provider: ContextStateProvider | undefined) {
      this.contextStateProvider = provider;
      // Invalidate tree cache whenever the user changes file inclusion/exclusion states
      this.contextStateProvider?.onDidChangeTreeData(() => {
          this.markTreeDirty();
      });
  }

  public setSkillsManager(manager: SkillsManager) {
      this.skillsManager = manager;
  }

  public setCodeGraphManager(manager: CodeGraphManager) {
      this.codeGraphManager = manager;
  }

  getContextStateProvider(): ContextStateProvider | undefined {
    return this.contextStateProvider;
  }

  public getLastContext(): ContextResult | null {
      return this._lastContext;
  }
  private normalize(p: string): string {
      return p.replace(/\\/g, '/');
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

  public async searchWorkspaceContent(query: string, options: { matchCase: boolean, wholeWord: boolean, include?: string, exclude?: string } = { matchCase: false, wholeWord: false }, signal?: AbortSignal): Promise<{path: string, snippet: string, line?: string}[]> {
    const results: {path: string, snippet: string, line?: string}[] = [];
    const maxResults = 100;
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return [];

    const cwd = workspaceFolder.uri.fsPath;

    try {
        let stdout = "";
        // 1. Try git grep first (Supports rich boolean logic)
        try {
            // Increase max-count per file to find better snippets
            let gitGrepArgs = `-n -I --max-count=3 --context=0`;
            if (!options.matchCase) gitGrepArgs += ` -i`;
            if (options.wholeWord) gitGrepArgs += ` -w`;

            const orParts = query.split('|').map(p => p.trim()).filter(p => p);
            let patternArgs = "";
            
            orParts.forEach((part, idx) => {
                if (idx > 0) patternArgs += " --or ";
                const andTerms = part.split(/\s+/).filter(p => p);
                if (andTerms.length > 1) patternArgs += " ( ";
                
                andTerms.forEach((term, tIdx) => {
                    const isNot = term.startsWith('-');
                    const actualTerm = isNot ? term.substring(1) : term;
                    if (tIdx > 0) patternArgs += " --and ";
                    if (isNot) patternArgs += " --not ";
                    patternArgs += ` -e "${actualTerm.replace(/"/g, '\\"')}" `;
                });

                if (andTerms.length > 1) patternArgs += " ) ";
            });
            
            // Handle Includes and Excludes via Git Pathspecs
            let pathspec = "";
            if (options.include) {
                pathspec += options.include.split(',').map(p => `"${p.trim()}"`).join(' ');
            }
            if (options.exclude) {
                pathspec += " " + options.exclude.split(',').map(p => `":!${p.trim()}"`).join(' ');
            }

            const res = await execAsync(`git grep ${gitGrepArgs} ${patternArgs} -- ${pathspec}`, { cwd, maxBuffer: 1024 * 1024 });
            stdout = res.stdout;
        } catch (e) {
            // 2. Fallback to system tools
            const isWin = process.platform === 'win32';
            let command = "";
            const pattern = query.replace(/"/g, '\\"');
            
            if (isWin) {
                // findstr /I = case insensitive. /BE = match start/end (closest to whole word findstr has)
                // Note: findstr's whole-word support is limited.
                let findstrArgs = `/S /N`;
                if (!options.matchCase) findstrArgs += ` /I`;
                // For whole word on Windows, we'll wrap in regex boundaries if word is set
                const winPattern = options.wholeWord ? `\\<${pattern}\\>` : pattern;
                command = `findstr ${findstrArgs} /C:"${winPattern}" *`;
            } else {
                let grepArgs = `-r -n -I -m 1`;
                if (!options.matchCase) grepArgs += ` -i`;
                if (options.wholeWord) grepArgs += ` -w`;
                command = `grep ${grepArgs} "${pattern}" .`;
            }
            try {
                const res = await execAsync(command, { cwd, maxBuffer: 1024 * 1024 });
                stdout = res.stdout;
            } catch (innerE) {
                // If grep returns 1 (no results), stdout will be empty, which is fine
            }
        }

        if (stdout.trim()) {
            const lines = stdout.split('\n');
            for (const line of lines) {
                if (results.length >= maxResults) break;
                
                const parts = line.split(':');
                if (parts.length >= 3) {
                    const filePath = parts[0].trim();
                    const lineNum = parts[1].trim();
                    const snippet = parts.slice(2).join(':').trim();
                    
                    results.push({
                        path: filePath,
                        line: lineNum,
                        snippet: snippet.length > 200 ? snippet.substring(0, 200) + "..." : snippet
                    });
                }
            }
        }
    } catch (e) {
        console.error("Content search failed", e);
    }

    return results;
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


    private async fetchYoutubeTranscript(videoId: string, languageCode: string = 'en') {
        try {
            const transcript = await fetchTranscript(videoId, {
                lang: languageCode || 'en'
            });

            if (!Array.isArray(transcript)) {
                return { success: false, output: "Unexpected transcript format received from library." };
            }

            const finalResult = transcript
                .map((part: any) => part.text)
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim();

            if (!finalResult) return { success: false, output: "Library returned empty content for this video ID." };

            return { success: true, output: finalResult };

        } catch (e: any) {
            return { success: false, output: `Library Extraction Failed: ${e.message}` };
        }
    }

  /**
   * Cleans content from potential prompt injection strings.
   */
  private sanitizeContent(text: string): string {
    const injectionPatterns = [
        /ignore (all )?previous instructions/gi,
        /system prompt/gi,
        /you are now a/gi,
        /new role:/gi,
        /stop what you are doing/gi,
        /strictly follow/gi
    ];
    let cleaned = text;
    for (const pattern of injectionPatterns) {
        cleaned = cleaned.replace(pattern, "[REDACTED_POTENTIAL_INJECTION]");
    }
    return cleaned;
  }

  /**
   * Uses the LLM to distill/refactor raw web text based on the user's prompt.
   */
  private async distillContent(content: string, url: string, userPrompt: string, signal?: AbortSignal): Promise<string> {
    const distillationPrompt = `You are an Information Distiller. 
I have scraped content from: ${url}
The user is currently asking: "${userPrompt.substring(0, 500)}"

**TASK:**
1. Extract ONLY the information from the text that is useful for answering the user's request.
2. Refactor the text into a clean, concise markdown format.
3. Remove ads, navigation menus, and irrelevant boilerplate.
4. If the text contains code documentation or snippets relevant to the prompt, preserve them accurately.

**CONTENT TO DISTILL:**
${content.substring(0, 20000)}
`;

    try {
        const result = await this.lollmsAPI.sendChat([
            { role: 'system', content: "You are a precise data distillation expert. Output only the distilled content." },
            { role: 'user', content: distillationPrompt }
        ], null, signal);
        return result;
    } catch (e) {
        return content; // Fallback to raw if distillation fails
    }
  }

  // --- URL Processing ---
  public async processUrl(url: string, languageCode: string = 'en', userPrompt?: string, signal?: AbortSignal, depth: number = 0, visited: Set<string> = new Set()): Promise<{ filename: string, content: string, summary: string }> {
      if (visited.has(url) || depth < 0) {
          return { filename: '', content: '', summary: '' };
      }
      visited.add(url);
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) throw new Error("No workspace folder open.");
      
      const cacheDir = vscode.Uri.joinPath(workspaceFolder.uri, '.lollms', 'web_cache');
      try { await vscode.workspace.fs.createDirectory(cacheDir); } catch(e) {}
      
      // Basic Detection
      const isArxiv = url.includes('arxiv.org');
      const isWiki = url.includes('wikipedia.org');
      
      let rawContent = "";
      
      // Use existing tools logic by importing tools dynamically to avoid circular deps or re-implement basic fetch
      // Re-implementing simplified versions here to keep ContextManager independent
      
      if (isArxiv) {
          // Arxiv API
          try {
              const idMatch = url.match(/abs\/([0-9.]+)/) || url.match(/pdf\/([0-9.]+)/);
              if (idMatch) {
                  const id = idMatch[1];
                  const res = await fetch(`http://export.arxiv.org/api/query?id_list=${id}`);
                  const xml = await res.text();
                  // Extract Title and Summary from XML
                  const titleMatch = xml.match(/<title>([\s\S]*?)<\/title>/);
                  const summaryMatch = xml.match(/<summary>([\s\S]*?)<\/summary>/);
                  
                  const title = titleMatch ? titleMatch[1].trim() : "Unknown Title";
                  const summary = summaryMatch ? summaryMatch[1].trim() : "No summary available.";
                  
                  rawContent = `[ArXiv Paper] ${url}\n\nTitle: ${title}\n\n### Abstract:\n${summary}`;
              } else {
                  rawContent = `Could not parse ArXiv ID from ${url}`;
              }
          } catch(e) { rawContent = `ArXiv fetch error: ${e}`; }
      } else if (isWiki) {
          try {
              // Extract title from URL (e.g. https://en.wikipedia.org/wiki/Artificial_intelligence)
              const titlePart = url.split('/wiki/')[1] || url.split('/').pop() || "";
              const api = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exlimit=1&titles=${titlePart}&explaintext=1&format=json`;
              
              const res = await fetch(api);
              const json: any = await res.json();
              const pages = json.query?.pages;
              const pageId = Object.keys(pages)[0];
              
              if (pageId && pageId !== "-1") {
                  const pageTitle = pages[pageId].title;
                  const extract = pages[pageId].extract;
                  rawContent = `[Wikipedia] ${pageTitle}\nSource: ${url}\n\n${extract}`;
              } else {
                   // Fallback to scrape
                   throw new Error("Page not found in API");
              }
          } catch(e) { 
              // Continue to generic scrape if API fails
          }
      } 
      
      if (!rawContent) {
          // General Web Scrape
          try {
              const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Lollms VS Coder)' } });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const html = await res.text();
              // Strip tags
              rawContent = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gim, "")
                               .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gim, "")
                               .replace(/<[^>]+>/g, " ")
                               .replace(/\s+/g, " ")
                               .trim();
          } catch (e: any) {
              throw new Error(`Failed to scrape ${url}: ${e.message}`);
          }
      }
      
      // --- NEW: Distillation & Injection Protection ---
      const config = vscode.workspace.getConfiguration('lollmsVsCoder');
      const shouldDistill = config.get<boolean>('distillWebResults') ?? true;
      const antiInjection = config.get<boolean>('antiPromptInjection') ?? true;

      let processedContent = rawContent;

      if (antiInjection) {
          processedContent = this.sanitizeContent(processedContent);
      }

      if (shouldDistill && userPrompt) {
          processedContent = await this.distillContent(processedContent, url, userPrompt, signal);
      }

      // Create a clean filename
      const urlObj = new URL(url);
      const safeName = (urlObj.hostname + urlObj.pathname).replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
      const filename = `web_${safeName}.md`;
      
      // Token Limit Logic (30k tokens ~ 120k chars)
      const maxChars = 120000;
      let finalContent = processedContent;
      if (processedContent.length > maxChars) {
          finalContent = `[DATA TOO LARGE - TRUNCATED]\n\n${processedContent.substring(0, maxChars)}\n\n... (30,000 token limit reached)`;
      }

      const fileContent = `# Source: ${url}\n# Date: ${new Date().toISOString()}\n\n${finalContent}`;
      const fileUri = vscode.Uri.joinPath(cacheDir, filename);
      
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from(fileContent, 'utf8'));
      
      // Add to context
      const relativePath = path.join('.lollms', 'web_cache', filename);
      await this.contextStateProvider?.addFilesToContext([relativePath]);

      // --- RECURSIVE SCRAPING ---
      if (depth > 0) {
          const linkRegex = /href=["'](https?:\/\/[^"']+)["']/g;
          let match;
          const internalLinks: string[] = [];
          const origin = new URL(url).origin;

          while ((match = linkRegex.exec(rawContent)) !== null) {
              const link = match[1];
              if (link.startsWith(origin) && !visited.has(link)) {
                  internalLinks.push(link);
              }
          }

          // Limit recursion to avoid explosion (max 5 links per page in depth)
          for (const link of internalLinks.slice(0, 5)) {
              if (signal?.aborted) break;
              await this.processUrl(link, languageCode, userPrompt, signal, depth - 1, visited);
          }
      }
      
      return { 
          filename: relativePath, 
          content: rawContent, 
          summary: rawContent.substring(0, 200) + "..." 
      };
  }

  /**
   * Performs a search on specialized web providers and returns results for user selection.
   */
  public async searchWebInfo(action: string, query: string, signal?: AbortSignal): Promise<any[]> {
      const results: any[] = [];
      try {
          if (action === 'google') {
              const config = vscode.workspace.getConfiguration('lollmsVsCoder');
              const apiKey = config.get<string>('searchApiKey');
              const cx = config.get<string>('searchCx');
              if (!apiKey || !cx) throw new Error("Google Search not configured in Settings.");

              const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(query)}`;
              const res = await fetch(url, { timeout: 10000 }); // 10s timeout
              const data: any = await res.json();
              return (data.items || []).map((i: any) => ({ title: i.title, url: i.link, snippet: i.snippet }));
          } else if (action === 'ddg') {
              // DuckDuckGo simple HTML fallback search
              const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
              const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
              const html = await res.text();
              const linkRegex = /<a class="result__a" rel="noopener" href="([^"]+)">([^<]+)<\/a>/g;
              let m;
              while ((m = linkRegex.exec(html)) !== null && results.length < 5) {
                  results.push({ title: m[2], url: m[1], snippet: "" });
              }
              return results;
          } else if (action === 'wiki') {
              const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`;
              const res = await fetch(url, { timeout: 8000 });
              const data: any = await res.json();
              if (data.query?.search) {
                  return data.query.search.map((i: any) => ({
                      title: i.title,
                      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(i.title)}`,
                      snippet: i.snippet.replace(/<[^>]+>/g, '')
                  }));
              }
          } else if (action === 'arxiv') {
              const url = `http://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&max_results=5`;
              const res = await fetch(url);
              const txt = await res.text();
              const titles = [...txt.matchAll(/<title>([\s\S]*?)<\/title>/g)].map(m => m[1].trim()).slice(1);
              const ids = [...txt.matchAll(/<id>([\s\S]*?)<\/id>/g)].map(m => m[1].trim()).slice(1);
              const summaries = [...txt.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map(m => m[1].trim().substring(0, 200));
              return titles.map((t, i) => ({ title: t, url: ids[i], snippet: summaries[i] }));
          }
      } catch (e) {
          console.error(`Search failed for ${action}:`, e);
      }
      return results;
  }

  private async searchLocalCache(query: string, signal?: AbortSignal): Promise<string> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return "";

    const cacheDir = vscode.Uri.joinPath(workspaceFolder.uri, '.lollms', 'web_cache');
    try {
        const entries = await vscode.workspace.fs.readDirectory(cacheDir);
        let combined = "";
        const keywords = query.toLowerCase().split(' ').filter(k => k.length > 3);

        for (const [name, type] of entries) {
            if (type === vscode.FileType.File && name.endsWith('.md')) {
                const contentBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(cacheDir, name));
                const content = Buffer.from(contentBytes).toString('utf8').toLowerCase();
                
                // Simple keyword check for cache hit
                if (keywords.some(k => content.includes(k))) {
                    combined += `\n--- Cached Result (${name}) ---\n${content.substring(0, 2000)}...\n`;
                }
            }
        }
        return combined;
    } catch {
        return "";
    }
  }

  // --- UPGRADED AGENTIC AUTO-SKILL SELECTION ---
    /**
   * REWRITTEN: Multi-step Librarian Agent for Skill Selection.
   * Behaves exactly like the Context Agent with iterative reasoning and tools.
   */
  public async runSkillSelectionAgent(
    userPrompt: string,
    model: string,
    signal: AbortSignal,
    currentSkillIds: string[],
    onUpdate: (content: string) => void,
    discussion: any = null
  ): Promise<string[]> {
    if (!this.skillsManager) return currentSkillIds;

    const allSkills = await this.skillsManager.getSkills();
    const actionLog: string[] = [];
    const selectedIds = new Set<string>(currentSkillIds);
    const executedActions = new Set<string>();
    let cumulativeBrain = ""; 
    const MAX_STEPS = 8;

    const renderUpdate = (status: string, finished: boolean = false, step: number = 0) => {
        const sortedSkills = allSkills.filter(s => selectedIds.has(s.id));
        const skillsListItems = sortedSkills.map(s => `<li><span class="codicon codicon-lightbulb"></span> ${s.name}</li>`).join('');
        
        const skillsTree = selectedIds.size > 0 
            ? `<details ${finished ? 'open' : ''}><summary>📂 <strong>Active Skills (${selectedIds.size})</strong></summary><ul class="file-list-tree">${skillsListItems}</ul></details>`
            : `*No specialized skills currently active.*`;
        
        const logHtml = actionLog.map(l => `<div class="agent-log-item">${l}</div>`).join('');
        const logSection = actionLog.length > 0
             ? `<details ${finished ? '' : 'open'}><summary>📜 Discovery Log</summary><div class="agent-log-container">${logHtml}</div></details>`
             : '';

        const scratchpadHtml = cumulativeBrain 
            ? `<div class="plan-scratchpad" style="margin-top:10px;"><details open><summary class="scratchpad-header">🧠 Librarian Reasoning</summary><div class="scratchpad-content">${cumulativeBrain}</div></details></div>`
            : '';
        
        let spinnerHtml = finished 
            ? `<div class="status-line"><span class="codicon codicon-check" style="color:var(--vscode-charts-green)"></span> <span>Library Optimized</span></div>`
            : `<div class="status-line"><div class="spinner"></div> <span>Searching Library (Step ${step + 1}): ${status}</span></div>`;
        
        onUpdate(`**💡 Auto-Skill Agent**\n\n${spinnerHtml}\n\n${scratchpadHtml}\n\n${skillsTree}\n\n${logSection}`);
    };

    const systemPrompt = `You are the Expert Librarian Agent for the LoLLMs Skills Library.
Your goal is to optimize the AI's "Skill Context" by selecting specific documentation, protocols, or code patterns from the library that are relevant to the user's request.

### 📚 LIBRARIAN PROTOCOL
1. **Analyze**: Identify the tech stack, library APIs (e.g. safe_store, moltbook), or complex patterns in the request.
2. **Search**: Use tools to find skills you aren't sure about. 
3. **Verify**: If you see a skill name that sounds relevant, READ its description/content before adding it.
4. **Finalize**: Use \`select_skills\` to update the active list.

**AVAILABLE TOOLS:**
1. \`get_skill_catalog()\`: Returns a list of ALL available skill IDs, names, and categories.
2. \`read_skill_details(id="id")\`: Returns the full content and documentation of a specific skill.
3. \`search_library(query="term")\`: Performs a keyword search across skill names and descriptions.
4. \`select_skills(add=["id1"], remove=["id2"])\`: Add or remove skills from the active context.
5. \`done()\`: Finish the optimization.

**OUTPUT FORMAT**: You must output a JSON object. Use 'scratchpad' for your current step-by-step thoughts.
\`\`\`json
{
  "scratchpad": "I see the user mentioned RAG. I will search for 'safe_store' skills to see what documentation we have.",
  "tool": "tool_name",
  "params": { ... }
}
\`\`\``;

    const fullContext = await this.getContextContent({ includeTree: true, modelName: model, signal });

    let chatHistory: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `
# PROJECT CONTEXT
${fullContext.projectTree}
${fullContext.selectedFilesContent.substring(0, 5000)}...

**USER REQUEST:** "${userPrompt}"
**CURRENTLY ACTIVE SKILLS:** ${JSON.stringify(Array.from(selectedIds))}` }
    ];

    renderUpdate("Initializing search...");

    for (let step = 0; step < MAX_STEPS; step++) {
        if (signal.aborted) break;

        const response = await this.lollmsAPI.sendChat(chatHistory, null, signal, model);
        chatHistory.push({ role: 'assistant', content: response });

        const cleanResponse = stripThinkingTags(response);
        const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/);
        
        if (!jsonMatch) {
            actionLog.push("❌ Failed to parse response.");
            break;
        }

        try {
            const toolCall = JSON.parse(jsonMatch[0]);
            if (toolCall.scratchpad) {
                // Render scratchpad line with bullet and markdown support
                cumulativeBrain += `\n- ${toolCall.scratchpad}`;
            }

            const actionFingerprint = JSON.stringify({ tool: toolCall.tool, params: toolCall.params });
            if (executedActions.has(actionFingerprint) && toolCall.tool !== 'done') {
                chatHistory.push({ role: 'system', content: "LOOP DETECTED: You already called this tool with these parameters. Move forward or call 'done'." });
                continue;
            }
            executedActions.add(actionFingerprint);

            if (toolCall.scratchpad) {
                const newEntry = toolCall.scratchpad.trim();
                cumulativeBrain += `\n\n**Insight**: ${newEntry}`;
            }

            if (toolCall.tool === 'done') {
                renderUpdate("Complete", true, step);
                break;
            }

            if (toolCall.tool === 'get_skill_catalog') {
                const catalog = allSkills.map(s => ({ id: s.id, name: s.name, category: s.category }));
                chatHistory.push({ role: 'system', content: `LIBRARY CATALOG:\n${JSON.stringify(catalog, null, 2)}` });
                actionLog.push("📖 Retrieved full skill catalog.");
                renderUpdate("Reviewing catalog...", false, step);
            } 
            else if (toolCall.tool === 'read_skill_details') {
                const skill = allSkills.find(s => s.id === toolCall.params.id);
                if (skill) {
                    chatHistory.push({ role: 'system', content: `SKILL CONTENT (${skill.id}):\n${skill.content}` });
                    actionLog.push(`🔍 Inspected skill: **${skill.name}**`);
                    renderUpdate(`Reading ${skill.name}...`, false, step);
                } else {
                    chatHistory.push({ role: 'system', content: "Error: Skill ID not found." });
                }
            }
            else if (toolCall.tool === 'search_library') {
                const query = toolCall.params.query.toLowerCase();
                const matches = allSkills.filter(s => 
                    s.name.toLowerCase().includes(query) || 
                    s.description.toLowerCase().includes(query) ||
                    s.category?.toLowerCase().includes(query)
                ).map(s => ({ id: s.id, name: s.name, description: s.description }));
                
                chatHistory.push({ role: 'system', content: `SEARCH RESULTS for "${query}":\n${JSON.stringify(matches, null, 2)}` });
                actionLog.push(`🔎 Searched library for: "${query}" (${matches.length} matches)`);
                if (toolCall.scratchpad) actionLog.push(`💡 **Insight**: ${toolCall.scratchpad}`);
                renderUpdate("Filtering results...", false, step);
            }
            else if (toolCall.tool === 'select_skills') {
                const toAdd = toolCall.params.add || [];
                const toRemove = toolCall.params.remove || [];
                toAdd.forEach((id: string) => selectedIds.add(id));
                toRemove.forEach((id: string) => selectedIds.delete(id));
                actionLog.push(`✅ Updated selection: +${toAdd.length} / -${toRemove.length} skills.`);
                if (toolCall.scratchpad) actionLog.push(`💡 **Insight**: ${toolCall.scratchpad}`);
                renderUpdate("Updating selection...", false, step);
            }
        } catch (e: any) {
            actionLog.push(`❌ Tool execution failed: ${e.message}`);
        }
    }

    renderUpdate("Optimization complete.", true, MAX_STEPS);
    return Array.from(selectedIds);
  }

  // --- WEB RESEARCH AGENT ---
  /**
   * Manages the structured briefing entries stored in the discussion data zone.
   */
  private updateBriefingData(discussion: any, action: 'add' | 'amend', id: string, content: string) {
    if (!discussion) return;

    let entries: Record<string, string> = {};
    const raw = (discussion.discussion_data_zone || "").trim();
    
    try {
        if (raw.startsWith('{')) {
            entries = JSON.parse(raw);
        } else if (raw.length > 0) {
            entries = { "analysis": raw };
        }
    } catch { 
        entries = {}; 
    }

    // Clean formatting and accumulate
    entries[id] = content.trim();
    discussion.discussion_data_zone = JSON.stringify(entries, null, 2);
    
    // Explicitly notify the discussion manager to persist this discovery
    vscode.commands.executeCommand('lollms-vs-coder.refreshDiscussions');
  }

  public renderBriefing(discussion: any): string {
    const fallback = "Librarian is analyzing project state...";
    if (!discussion || !discussion.discussion_data_zone) return fallback;
    
    try {
        const raw = discussion.discussion_data_zone.trim();
        if (!raw.startsWith('{')) return raw || fallback;

        const entries = JSON.parse(raw);
        const keys = Object.keys(entries);
        if (keys.length === 0) return fallback;
        
        return keys.map(id => {
            const title = id.replace(/_/g, ' ').toUpperCase();
            return `**[${title}]**\n${entries[id]}`;
        }).join('\n\n');
    } catch { 
        return discussion.discussion_data_zone || fallback; 
    }
  }

  // --- WEB RESEARCH AGENT ---
  public async runWebResearchAgent(
      userPrompt: string,
      model: string,
      signal: AbortSignal,
      onUpdate: (content: string) => void,
      onOverlayUpdate?: (status: string) => void,
      discussion: any = null,
      fullHistory: ChatMessage[] = []
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    const searchInCache = config.get<boolean>('searchInCacheFirst') ?? true;
    const searchProvider = config.get<string>('searchProvider') || 'google_custom_search';
    const apiKey = config.get<string>('searchApiKey');
    const cx = config.get<string>('searchCx');
    
    // Check if configuration exists for Google
    const canGoogle = searchProvider === 'google_custom_search' && !!apiKey && !!cx;

    const systemPrompt = `You are the **Web Research Specialist**. 
Your goal is to acquire external knowledge (documentation, library APIs, recent bug fixes) that is missing from the local project. 
You have access to a shared **Team Briefing**; use it to store and correct the team's understanding of external dependencies.

### 📜 THE RESEARCHER'S CONSTITUTION
1. **NO REDUNDANCY**: Do not search for information already present in the "EXISTING PROJECT CONTEXT" or "SHARED TEAM BRIEFING".
2. **DISTILLATION**: When you read a page, extract only the parts relevant to the user's request.
3. **REPORTING**: Use \`add_briefing_entry\` to inform the Librarian and Worker LLM of your findings.
4. **BELIEF CORRECTION**: If you find that a previous assumption in the briefing is wrong (e.g., an API version has changed), use \`amend_briefing_entry\` immediately.

**TEAM COORDINATION TOOLS:**
1. \`add_briefing_entry(id="unique_id", info="technical details")\`: Record a new technical discovery from the web.
2. \`amend_briefing_entry(id="existing_id", info="updated details")\`: Correct or expand a previous entry.
3. \`summon_specialist(agent="librarian|skills", reason="why")\`: Call the Librarian if you discover a local file you need to check, or the Skills agent for protocol help.

**RESEARCH TOOLS:**
4. \`plan_searches(queries=[{"provider": "google|arxiv|wikipedia|stackoverflow", "q": "query string"}])\`: Execute searches in parallel.
5. \`read_and_add(urls=["url1", "url2"])\`: Scrape these URLs and add their content to the project context as research files.
6. \`done()\`: Finish research mission.

**OUTPUT FORMAT**: JSON only
\`\`\`json
{
  "tool": "tool_name",
  "params": { ... }
}
\`\`\`
`;

    // Fetch context so the Web Agent knows what we already have
    const fullContext = await this.getContextContent({ includeTree: true, modelName: model, signal });
    const sharedKnowledge = this.renderBriefing(discussion);

    const actionLog: string[] = [];
    const foundResults: { url: string, title: string, provider: string }[] = [];
    const addedSources: { url: string, title: string }[] = [];
    const chatHistory: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `
# EXISTING PROJECT CONTEXT
${fullContext.projectTree}
${fullContext.selectedFilesContent}

# SHARED KNOWLEDGE
${sharedKnowledge}

**USER REQUEST:** "${userPrompt}"
Google Available: ${canGoogle}` }
    ];

    const renderUpdate = (status: string, finished: boolean = false) => {
        const logHtml = actionLog.map(l => `<div class="agent-log-item" style="font-size:0.85em; margin-bottom:2px;">${l}</div>`).join('');
        const logSection = actionLog.length > 0
                ? `<details ${finished ? '' : 'open'} style="margin-top:10px;"><summary>🌍 Research Activity</summary><div class="agent-log-container" style="padding: 8px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 4px; max-height: 150px; overflow-y: auto;">${logHtml}</div></details>`
                : '';
        
        let foundHtml = '';
        if (foundResults.length > 0) {
            const items = foundResults.map(r => 
                `<div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 0.9em; margin-bottom: 4px;">
                    <span style="opacity:0.7; font-size:0.8em; width: 80px; display: inline-block;">[${r.provider}]</span>
                    <a href="${r.url}" title="${r.title}">${r.url}</a>
                </div>`
            ).join('');
            foundHtml = `<details open style="margin-top:10px;"><summary>🔍 Found Links (${foundResults.length})</summary><div style="padding: 8px; border: 1px solid var(--vscode-widget-border); border-radius: 4px;">${items}</div></details>`;
        }

        let sourcesHtml = '';
        if (addedSources.length > 0) {
            const listItems = addedSources.map(s => 
                `<li style="margin-bottom:6px;">📑 <span style="font-weight:600;">${s.title}</span><br><span style="font-size:0.8em; opacity:0.7;">${s.url}</span></li>`
            ).join('');
            sourcesHtml = `<details open style="margin-top:10px;"><summary>📚 <strong>Added to Context (${addedSources.length})</strong></summary><ul class="file-list-tree" style="list-style:none; padding-left:5px;">${listItems}</ul></details>`;
        }
        
        let spinnerHtml = '';
        if (!finished) {
            spinnerHtml = `<div class="status-line" style="display:flex; align-items:center; gap:8px;"><div class="spinner"></div> <span style="font-weight:600;">${status}</span></div>`;
        } else {
            spinnerHtml = `<div class="status-line" style="display:flex; align-items:center; gap:8px;"><span class="codicon codicon-check" style="color:var(--vscode-charts-green)"></span> <span style="font-weight:600;">Research Complete</span></div>`;
        }
        
        const currentBriefing = this.renderBriefing(discussion);
        const briefingHtml = `<div class="technical-briefing-card">
            <div class="briefing-header"><span class="codicon codicon-note"></span> Team Technical Briefing</div>
            <div class="briefing-content">${currentBriefing.replace(/\n/g, '<br>')}</div>
        </div>`;

        const fullMessage = `**🌍 Web Research Agent**\n\n${spinnerHtml}\n\n${briefingHtml}\n\n${foundHtml}\n\n${sourcesHtml}\n\n${logSection}`;
        onUpdate(fullMessage);
    };

    chatHistory.push({ role: 'system', content: `SHARED TEAM KNOWLEDGE:\n${sharedKnowledge}` });

    renderUpdate("Analyzing request...");

    let steps = 0;
    const MAX_STEPS = 5;

    while (steps < MAX_STEPS) {
        if (signal.aborted) break;
        steps++;

        let response = "";
        try {
            response = await this.lollmsAPI.sendChat(chatHistory, null, signal, model);
        } catch (e: any) {
            actionLog.push(`❌ LLM Error: ${e.message}`);
            renderUpdate("Error", true);
            break;
        }

        chatHistory.push({ role: 'assistant', content: response });
        const cleanResponse = stripThinkingTags(response);
        let jsonMatch = cleanResponse.match(/```json\s*([\s\S]+?)\s*```/) || cleanResponse.match(/\{[\s\S]*\}/);

        if (!jsonMatch) {
            actionLog.push("🛑 output format invalid, stopping.");
            break;
        }

        try {
            const toolCall = JSON.parse(jsonMatch[1] || jsonMatch[0]);
            const toolName = toolCall.tool;
            const params = toolCall.params || {};

            if (toolName === 'done') {
                renderUpdate("Finished", true);
                break;
            }

            if (toolName === 'plan_searches') {
                const queries = params.queries || [];

                if (searchInCache) {
                    renderUpdate("Checking local cache...");
                    const cacheHits = await this.searchLocalCache(userPrompt, signal);
                    if (cacheHits) {
                        actionLog.push(`📦 Found relevant data in local .lollms cache.`);
                        chatHistory.push({ role: 'system', content: `LOCAL CACHE HITS:\n${cacheHits}\n\nReview this data. If it answers the prompt, you can 'done'. Otherwise proceed with external searches.` });
                    }
                }
                if (!Array.isArray(queries) || queries.length === 0) {
                    actionLog.push("⚠️ No queries provided.");
                    continue;
                }

                const providersText = Array.from(new Set(queries.map((q: any) => q.provider))).join(', ');
                actionLog.push(`🔍 Searching via: **${providersText}**`);
                queries.forEach((q: any) => {
                    actionLog.push(`&nbsp;&nbsp;• [${q.provider}] ${q.q}`);
                });
                renderUpdate("Searching...");

                const searchPromises = queries.map(async (q: any) => {
                    const provider = q.provider;
                    const query = q.q;
                    
                    // Update Webview Search Log
                    if (!signal.aborted) {
                        onUpdate(`LOG_UPDATE:{"engine":"${provider}","query":"${query}"}`);
                    }

                    try {
                        let result = "";
                        if (provider === 'google') {
                             if (!canGoogle) return `[Google Skipped - No Key]`;
                             const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(query)}`;
                             const res = await fetch(url);
                             const data: any = await res.json();
                             if (data.items) {
                                 result = data.items.map((i:any) => {
                                     foundResults.push({ url: i.link, title: i.title, provider: 'Google' });
                                     return `[${i.title}](${i.link}): ${i.snippet}`;
                                 }).join('\n');
                             } else {
                                 result = "No results.";
                             }
                        } else if (provider === 'arxiv') {
                             const url = `http://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&start=0&max_results=3`;
                             const res = await fetch(url);
                             const txt = await res.text();
                             const titles = [...txt.matchAll(/<title>([\s\S]*?)<\/title>/g)].map(m => m[1].trim()).slice(1);
                             const ids = [...txt.matchAll(/<id>([\s\S]*?)<\/id>/g)].map(m => m[1].trim()).slice(1);
                             const summaries = [...txt.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map(m => m[1].trim().substring(0, 200));
                             result = titles.map((t, i) => {
                                 foundResults.push({ url: ids[i], title: t, provider: 'ArXiv' });
                                 return `[${t}](${ids[i]}): ${summaries[i]}...`;
                             }).join('\n');
                        } else if (provider === 'wikipedia') {
                             const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json`;
                             const res = await fetch(url);
                             const data: any = await res.json();
                             if (data.query?.search) {
                                 result = data.query.search.map((i:any) => {
                                     const wUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(i.title)}`;
                                     foundResults.push({ url: wUrl, title: i.title, provider: 'Wikipedia' });
                                     return `[${i.title}](${wUrl}): ${i.snippet.replace(/<[^>]+>/g, '')}`;
                                 }).join('\n');
                             }
                        } else if (provider === 'stackoverflow') {
                            const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow`;
                            const res = await fetch(url);
                            const data: any = await res.json();
                            if (data.items) {
                                result = data.items.map((i:any) => {
                                    foundResults.push({ url: i.link, title: i.title, provider: 'StackOverflow' });
                                    return `[${i.title}](${i.link}) (Answered: ${i.is_answered})`;
                                }).join('\n');
                            }
                        }
                        
                        return `### Results for ${provider}: "${query}"\n${result}`;
                    } catch (e: any) {
                        return `Error searching ${provider}: ${e.message}`;
                    }
                });

                const results = await Promise.all(searchPromises);
                const combinedResults = results.join('\n\n');
                
                chatHistory.push({ 
                    role: 'system', 
                    content: `SEARCH RESULTS:\n${combinedResults}\n\nNow decide to 'read_and_add' useful links or 'done'.` 
                });
                const searchStatus = `Found ${foundResults.length} URLs, selecting relevant info...`;
                actionLog.push(`✅ ${searchStatus}`);
                if (onOverlayUpdate) onOverlayUpdate(`🔍 ${searchStatus}`);

            } else if (toolName === 'read_and_add') {
                const urls = params.urls || [];
                if (urls.length === 0) continue;
                
                actionLog.push(`📥 Scraping ${urls.length} selected pages...`);
                renderUpdate("Reading content...");

                const readPromises = urls.map(async (url: string) => {
                    try {
                        const res = await this.processUrl(url, 'en', userPrompt, signal);
                        const fileName = res.filename.split(/[\\/]/).pop() || 'Document';
                        addedSources.push({ url, title: fileName });
                        return `📖 Added: ${res.filename} (${res.content.length} chars)`;
                    } catch (e: any) {
                        return `❌ Failed to read ${url}: ${e.message}`;
                    }
                });

                const results = await Promise.all(readPromises);
                actionLog.push(results.join('\n'));
                
                chatHistory.push({ role: 'system', content: `Operation results:\n${results.join('\n')}` });
            } else {
                 actionLog.push(`❓ Unknown tool: ${toolName}`);
            }

        } catch (e: any) {
             actionLog.push(`JSON Parse Error: ${e.message}`);
        }
    }
    
    renderUpdate("Research Complete", true);
  }

  public async runContextAgent(
      userPrompt: string, 
      model: string,
      signal: AbortSignal, 
      onUpdate: (content: string) => void,
      onStatusUpdate?: (status: string) => void,
      initialKeywords?: string[],
      mode: 'selection_only' | 'collaborative' = 'collaborative',
      discussion: any = null,
      fullHistory: ChatMessage[] = [],
      dashboardMode: boolean = false
  ): Promise<{ context: string, analysis: string }> {
      const MAX_STEPS = 10;
      const MAX_RETRIES = 3;
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder || !this.contextStateProvider) {
          onUpdate("❌ No workspace context available.");
          return "";
      }

      const allFiles = await this.contextStateProvider.getAllVisibleFiles(signal);
      if (allFiles.length === 0) {
          actionLog.push("⚠️ No files found in workspace.");
          onUpdate(`**🧠 Librarian Mission Report**\n\n⚠️ **Blank Workspace**: I couldn't find any visible files in the project. Please ensure you are in the correct folder.`);
          return { context: "", analysis: "Workspace is empty." };
      }

      const currentContextFiles = this.contextStateProvider.getIncludedFiles().map(f => f.path);
      const selectedFiles = new Set<string>(currentContextFiles);
      const initialCount = selectedFiles.size;

      // Show immediate intent before starting heavy tree generation
      onUpdate(`**🧠 Auto-Context Agent**\n\n*Initializing Librarian...*`);

      // 1. Fetch FULL context (Tree + Selected File Contents) BEFORE starting
      const fullContext = await this.getContextContent({ 
          includeTree: true, 
          modelName: model,
          signal 
      });

      

      const fileTree = fullContext.projectTree;
      const currentContents = fullContext.selectedFilesContent;
      // Removed redundant local declaration of 'discussion' as it is now provided via method parameters
      const aggression = this.contextStateProvider.context.globalState.get<any>('lollms_last_capabilities')?.contextAggression || 'respect';

      let aggressionInstruction = "";
      switch(aggression) {
          case 'minimal': 
            aggressionInstruction = "STRICT BREVITY: Select the absolute minimum number of files. If you can answer with 1 file instead of 3, do it.";
            break;
          case 'none':
            aggressionInstruction = "MAXIMUM CONTEXT: Recover as many potentially relevant files as possible to ensure the LLM has zero missing information.";
            break;
          case 'signatures':
            aggressionInstruction = "SMART SIGNATURES: For files needed only for reference (API definitions, utilities), use the 'signatures' mode. Use 'full' only for files likely to be modified.";
            break;
          case 'respect':
          default:
            aggressionInstruction = "BALANCED: Aim to use about 75% of the available context window. Avoid over-filling but ensure core logic is present.";
            break;
      }

      const isCollaborative = mode === 'collaborative';
      const roleTitle = isCollaborative ? "Lead Architect & Librarian" : "Context Librarian";
      
      const systemPrompt = `You are the **Lead Project Librarian**. 
Your primary mission is to synchronize the project context for the Worker LLM who will execute the task next.

### 📜 THE LIBRARIAN'S CONSTITUTION
1.  **FAST-PATH DISCOVERY (CRITICAL)**: Look at the "ACCESSIBLE FILE CONTENTS" section below. If the files required to solve the user's objective are ALREADY fully loaded, you are FORBIDDEN from using \`read_file\` or \`search_files\`. You must immediately output \`add_briefing_entry\` if needed, and then call \`done\`. DO NOT OVERTHINK IT.
2.  **CONTEXT SYNC IS PRIMARY**: Your most important action is \`add_files\`. If you identify a relevant file missing from the context, you MUST add it. Peeking with \`read_file\` is only for temporary investigation.
3.  **BRIEFING IS SECONDARY**: Use \`add_briefing_entry\` to record high-level facts (e.g. "Uses TensorFlow 2.x"). Do not solve the coding problem yourself.
4.  **NO REDUNDANCY**: Do not "read" what you can already "see". If a file is listed in the context, assume you have its full contents.
5.  **CLEAN THE SLATE**: If approaching the context limit, use \`remove_files\` to eject irrelevant files.
6.  **NO GHOSTING**: Do not assume the Worker can see what you see. If you find a dependency, add it.
7.  **EXACT PATHS**: Use the absolute paths provided in the tree. Never guess.

### ⚖️ AGGRESSION MODE
${aggressionInstruction}

### 🏗️ THE OPERATOR'S PROTOCOL (AUTONOMY MANDATE)
You are an **Autonomous Software Engineer**, not a consultant. Your goal is to deliver a finished, verified result.

**PHASE 0: HYGIENE & SAFETY (MANDATORY)**
- Before any change: Check \`git status\`.
- If there are uncommitted changes, use \`request_user_input\` to ask: "Workspace is dirty. Should I commit/stash or continue anyway?".
- Create a dedicated feature branch for the task (e.g., \`ai/test-trm-logic\`).

**PHASE 1: DEEP DISCOVERY**
- Read relevant source code. Do NOT guess logic from filenames.
- Identify how to run the current training/test suite.

**PHASE 2: EMPIRICAL VERIFICATION**
- Run the code. Capture the failure or the baseline performance.
- Only propose enhancements AFTER you have seen the current code run and fail (or provide metrics).

**PHASE 3: IMPLEMENTATION & SELF-HEAL**
- Apply changes.
- Run tests again. If they fail, fix them immediately in a loop.

**PHASE 4: DEFINITION OF DONE**
- The task is ONLY complete when the code runs without errors AND meets the objective.
- Only then, provide your final synthesis.
### ⚖️ AGGRESSION MODE
${aggressionInstruction}

**TEAM COORDINATION TOOLS:**
1. \`add_briefing_entry(id="unique_id", info="technical details")\`: Record a new technical discovery (classes, logic, patterns).
2. \`amend_briefing_entry(id="existing_id", info="updated details")\`: Correct or expand a previous discovery.
3. \`summon_specialist(agent="web|skills", reason="why")\`: Call the Web Research or Skills agent if you need internet docs or library protocols.

**INVESTIGATION TOOLS:**
4. \`add_files(files=[{"path": "p1", "mode": "full|signatures"}])\`: Persistently add files to the AI's permanent memory.
5. \`remove_files(paths=["path1", "path2"])\`: Remove files from the current context to save tokens.
6. \`read_file(path="path", start_line=0, end_line=500)\`: "Peek" at a file to decide if it's relevant.
6. \`search_files(pattern="regex", path=".")\`: performs a high-speed grep search through the codebase.
7. \`read_code_graph(type="class_diagram|import_graph")\`: Get a structural overview of the project architecture.
8. \`get_file_info(path="path")\`: Returns file size and total line count.
9. \`done()\`: Finish context selection and mission.

**OUTPUT FORMAT**: You must output a JSON object. 
- \`scratchpad\`: Your internal thought process for this step.
- \`tool\`: The tool name.
- \`params\`: The tool parameters.

Example:
{
  "scratchpad": "Found UserAuth class in auth.ts. It uses a custom JWT decorator. I need to find where that decorator is defined.",
  "tool": "add_briefing_entry",
  "params": { "id": "auth_logic", "info": "Authentication uses the UserAuth class which relies on a @verify_token decorator." }
}
`;

      const actionLog: string[] = [];
      const executedActions = new Set<string>();
      let cumulativeBrain = ""; // Internal master state

      // Build history context for the Librarian
      const historyContext = fullHistory.length > 0 
          ? `### 📜 DISCUSSION HISTORY\n${fullHistory.map(m => `**${m.role.toUpperCase()}**: ${typeof m.content === 'string' ? m.content : '[Multipart content]'}`).join('\n\n')}\n\n---\n`
          : "";

      // 2. Inject previous agent findings (Inter-operability)
      const sharedKnowledge = fullHistory.length > 0 ? (fullHistory[0] as any).discussion_data_zone || "" : "";

      let initialUserContent = `${historyContext}
# SHARED TEAM KNOWLEDGE (PREVIOUS AGENTS)
${sharedKnowledge}

**USER OBJECTIVE:** "${userPrompt}"

# CURRENT PROJECT STATE
${fileTree}

# ACCESSIBLE FILE CONTENTS (Already Read)
${currentContents || "No files read yet."}
`;
      
      if (initialKeywords && initialKeywords.length > 0) {
          const status = `Searching keywords: ${initialKeywords.join(', ')}...`;
          if (onStatusUpdate) onStatusUpdate(status);
          actionLog.push(`🔍 Grounding search for: **${initialKeywords.join(', ')}**`);
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

      let technicalBriefing = "Librarian is still analyzing the code logic...";

      const renderUpdate = (status: string, finished: boolean = false, step: number = 0) => {
          const sortedFiles = Array.from(selectedFiles).sort();
          const filesListItems = sortedFiles.map(f => `<li><span class="codicon codicon-file"></span> ${f}</li>`).join('');

          const filesTree = selectedFiles.size > 0 
              ? `<details ${finished ? 'open' : ''}><summary>📂 <strong>Context Files Selected (${selectedFiles.size})</strong></summary><ul class="file-list-tree">${filesListItems}</ul></details>`
              : `*No files added yet.*`;

          const timelineHtml = actionLog.map((l, i) => {
            const isLast = i === actionLog.length - 1 && !finished;
            // Only mark as failed if it's an explicit TOOL error, not just a mention of a bug
            const isToolFailure = l.includes('❌') || l.includes('Tool execution failed');
            
            let stateClass = 'success';
            let icon = '<span class="codicon codicon-check" style="color:var(--vscode-charts-green)"></span>';

            if (isLast) {
                stateClass = 'active';
                icon = '<div class="spinner"></div>';
            } else if (isToolFailure) {
                stateClass = 'failed';
                icon = '<span class="codicon codicon-close" style="color:var(--vscode-charts-red)"></span>';
            }

            return `
            <div class="timeline-item ${stateClass}" style="display:flex; align-items:flex-start; gap:10px; margin-bottom:2px;">
                <div class="timeline-dot" style="flex-shrink:0; margin-top:2px;">${icon}</div>
                <div class="timeline-content" style="flex:1; font-size:11px; line-height:1.2;">${l}</div>
            </div>`;
          }).join('');

          const logSection = actionLog.length > 0
               ? `<details ${finished ? '' : 'open'}><summary>📜 Mission Timeline</summary><div class="mission-timeline">${timelineHtml}</div></details>`
               : '';

          const currentBriefing = this.renderBriefing(discussion);
            // Helper to render the briefing data zone
            const renderDataBriefing = () => {
                const raw = discussion?.discussion_data_zone || "";
                if (!raw.trim()) return "Librarian is analyzing project state...";
                try {
                    if (!raw.startsWith('{')) return raw;
                    const entries = JSON.parse(raw);
                    return Object.keys(entries).map(id => {
                        const title = id.replace(/_/g, ' ').toUpperCase();
                        return `<strong>[${title}]</strong><br>${entries[id]}`;
                    }).join('<br><br>');
                } catch { return raw; }
            };

            const briefingHtml = `<div class="technical-briefing-card">
                <details open>
                    <summary class="briefing-header">
                        <div style="display:flex; align-items:center; gap:8px; flex:1;">
                            <span class="codicon codicon-note"></span> Team Technical Briefing
                        </div>
                        <div style="display:flex; gap:4px;">
                            <button class="msg-action-btn" onclick="const text = this.closest('.technical-briefing-card').querySelector('.briefing-content').innerText; vscode.postMessage({command:'copyToClipboard', text: text})" title="Copy Briefing Content" style="opacity:0.6; padding:0; margin:0; height:16px;">
                                <i class="codicon codicon-copy"></i>
                            </button>
                            <button class="msg-action-btn" onclick="vscode.postMessage({command:'updateDiscussionCapabilitiesPartial', partial:{clearBriefing:true}})" title="Clear Technical Briefing" style="opacity:0.6; padding:0; margin:0; height:16px;">
                                <i class="codicon codicon-trash"></i>
                            </button>
                        </div>
                    </summary>
                    <div class="briefing-scroll-area">
                        <div class="briefing-content">${renderDataBriefing()}</div>
                    </div>
                </details>
            </div>`;
          let spinnerHtml = finished 
              ? `<div class="status-line"><span class="codicon codicon-check" style="color:var(--vscode-charts-green)"></span> <span style="font-weight:bold;">Context Synchronized</span></div>`
              : `<div class="status-line"><div class="spinner"></div> <span>Step ${step + 1}: ${status}</span></div>`;

          if (dashboardMode) {
              onUpdate(`${spinnerHtml}\n\n${filesTree}\n\n${logSection}`);
          } else {
              const fullMessage = `**🧠 Librarian Mission Report**\n${spinnerHtml}\n${briefingHtml}\n${filesTree}\n${logSection}`;
              onUpdate(fullMessage);
          }
      };

      if (initialCount > 0) {
          actionLog.push(`ℹ️ Librarian started with ${initialCount} files already in context.`);
      }
      actionLog.push("🔍 Analyzing project structure and request...");
      if (onStatusUpdate) onStatusUpdate("Librarian is analyzing your objective...");
      
      // Force immediate UI update to show Librarian is "Thinking"
      renderUpdate("Analyzing Intent...", false, 0);

      let retryCount = 0;
      let stepsTaken = 0;

      for (let step = 0; step < MAX_STEPS; step++) {
          if (signal.aborted) throw new Error("Context agent aborted.");

          // 1. Calculate current Token Load to inform pruning decisions
          const currentData = await this.getContextContent({ includeTree: true, modelName: model, signal });
          const tokenCheck = await this.lollmsAPI.tokenize(currentData.text, model);
          const limitCheck = await this.lollmsAPI.getContextSize(model);
          
          const loadStatus = `
### 🔋 TOKEN LOAD (CRITICAL)
- Used: ${tokenCheck.count} tokens
- Max Capacity: ${limitCheck.context_size} tokens
- Remaining: ${limitCheck.context_size - tokenCheck.count} tokens
${(tokenCheck.count / limitCheck.context_size) > 0.8 ? "⚠️ WARNING: Context is nearly full. PRUNE irrelevant files now." : ""}
`.trim();

          // Use 'user' role to provide current reality to the Librarian
          chatHistory.push({ 
              role: 'user', 
              content: `${loadStatus}

### 🛠️ ACTUAL PROJECT STATE
${currentData.projectTree}

### 🧠 CUMULATIVE BRAIN (YOUR NOTES)
${cumulativeBrain || "No observations yet."}

[Currently Selected Files]: ${JSON.stringify(Array.from(selectedFiles))}

**INSTRUCTION**: Review the load and the tree. 
- If the context is sufficient, call \`done\`.
- If a dependency is missing, call \`add_files\`.
- If context is full, call \`remove_files\`.`,
              skipInPrompt: true 
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

          let jsonStr = "";
          const markdownMatch = cleanResponse.match(/```json\s*([\s\S]+?)\s*```/);
          if (markdownMatch) {
              jsonStr = markdownMatch[1];
          } else {
              const lastBrace = cleanResponse.lastIndexOf('}');
              const firstBrace = cleanResponse.indexOf('{');
              if (firstBrace !== -1 && lastBrace !== -1) {
                  jsonStr = cleanResponse.substring(firstBrace, lastBrace + 1);
              }
          }

          if (!jsonStr) {
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

          // Declare variables outside the try block for unified access
          let toolCall: any = null;
          let toolName: string = "";
          let params: any = {};

          try {
              toolCall = JSON.parse(jsonStr);
              toolName = toolCall?.tool || "";
              params = toolCall?.params || {};

              // 🧠 Update Internal Reasoning
              if (toolCall?.scratchpad) {
                  const newEntry = toolCall.scratchpad.trim();
                  cumulativeBrain += `\n\n**Insight**: ${newEntry}`;
                  actionLog.push(`🧠 **Insight**: ${newEntry}`);
              }

              // 📝 Update Technical Briefing (Notes for the Worker)
              if (toolCall?.briefing) {
                  technicalBriefing = toolCall.briefing.trim();
              }

              // Loop Prevention
              const actionFingerprint = JSON.stringify({ tool: toolName, params });
              if (executedActions.has(actionFingerprint) && toolName !== 'done') {
                  chatHistory.push({ 
                      role: 'system', 
                      content: `WARNING: You already executed this exact tool call earlier. Avoid infinite loops.` 
                  });
                  actionLog.push(`⚠️ Loop detected.`);
                  continue;
              }
              executedActions.add(actionFingerprint);
              retryCount = 0;

              if (toolName === 'done') {
                  actionLog.push(`✅ Optimization complete.`);
                  renderUpdate("Context Ready", true, step);
                  break;
              }

          if (toolName === 'add_briefing_entry' || toolName === 'amend_briefing_entry') {
              this.updateBriefingData(discussion, toolName === 'add_briefing_entry' ? 'add' : 'amend', params.id, params.info);
              actionLog.push(`📝 **Briefing Updated**: ${params.id}`);
              renderUpdate("Updating Knowledge Base...", false, step);
              chatHistory.push({ role: 'system', content: "SUCCESS: Briefing entry updated." });
              continue;
          }

          if (toolName === 'summon_specialist') {
              actionLog.push(`📣 **Summoning ${params.agent}**: ${params.reason}`);
              renderUpdate(`Waiting for ${params.agent}...`, false, step);
              
              if (params.agent === 'web') {
                  await this.runWebResearchAgent(params.reason, model, signal, onUpdate, onStatusUpdate, discussion, fullHistory);
              } else if (params.agent === 'skills') {
                  await this.runSkillSelectionAgent(params.reason, model, signal, [], onUpdate, discussion);
              }
              
              chatHistory.push({ role: 'system', content: `Specialist ${params.agent} has finished. Check the Team Briefing and Project Context for new data.` });
              continue;
          }

              stepsTaken++;

              if (toolName === 'search_files') {
                const results = await this.searchWorkspaceContent(params.pattern, { matchCase: false, wholeWord: false, include: params.path });
                const output = results.length > 0 
                    ? results.map(r => `${r.path}:${r.line} - ${r.snippet}`).join('\n').substring(0, 4000)
                    : "No matches found.";
                chatHistory.push({ role: 'system', content: `SEARCH RESULTS:\n${output}` });
                actionLog.push(`🔍 Smart Search: "${params.pattern}" found ${results.length} hits.`);
                renderUpdate("Searching files...", false, step);
              }
              else if (toolName === 'read_code_graph') {
                if (this.codeGraphManager) {
                    const mermaid = this.codeGraphManager.generateMermaid(params.type || 'class_diagram');
                    chatHistory.push({ role: 'system', content: `CODE GRAPH:\n\`\`\`mermaid\n${mermaid}\n\`\`\`` });
                    actionLog.push(`📊 Read structural graph: ${params.type || 'class_diagram'}`);
                    renderUpdate("Analyzing project structure...", false, step);
                }
              }
              else if (toolName === 'get_file_info') {
                  const pathArg = params.path;
                  if (pathArg) {
                      const uri = vscode.Uri.joinPath(workspaceFolder.uri, pathArg);
                      const stats = await vscode.workspace.fs.stat(uri);
                      const doc = await vscode.workspace.openTextDocument(uri);
                      chatHistory.push({ role: 'system', content: `FILE INFO for ${pathArg}:\nSize: ${stats.size} bytes\nLines: ${doc.lineCount}` });
                      actionLog.push(`📊 Info: ${pathArg}`);
                  }
              } else if (toolName === 'add_files') {
                  const files = params.files;
                  if (Array.isArray(files)) {
                      const addedPaths: string[] = [];
                      for (const fileItem of files) {
                          const fPath = typeof fileItem === 'string' ? fileItem : fileItem.path;
                          const fMode = typeof fileItem === 'string' ? 'included' : (fileItem.mode === 'signatures' ? 'definitions-only' : 'included');
                          if (allFiles.includes(fPath)) {
                              selectedFiles.add(fPath);
                              addedPaths.push(fPath);
                              const uri = vscode.Uri.joinPath(workspaceFolder.uri, fPath);
                              await this.contextStateProvider.setStateForUris([uri], fMode);
                          }
                      }
                      actionLog.push(`➕ **Context Update**: Added \`${addedPaths.join(', ')}\` to context.`);
                      renderUpdate("Updating context...", false, step);
                  }
              } else if (toolName === 'remove_files') {
                  const paths = params.paths || [];
                  if (Array.isArray(paths)) {
                      const removed: string[] = [];
                      for (const p of paths) {
                          if (selectedFiles.has(p)) {
                              selectedFiles.delete(p);
                              removed.push(p);
                              const uri = vscode.Uri.joinPath(workspaceFolder.uri, p);
                              await this.contextStateProvider.setStateForUris([uri], 'tree-only');
                          }
                      }
                      actionLog.push(`➖ **Context Pruned**: Removed \`${removed.join(', ')}\`.`);
                      renderUpdate("Cleaning context...", false, step);
                  }
              } else if (toolName === 'read_file') {
                  const pathArg = params.path || params.file;
                  if (pathArg && allFiles.includes(pathArg)) {
                      actionLog.push(`🔍 **Peeking**: Inspecting logic in \`${pathArg}\`...`);
                      const uri = vscode.Uri.joinPath(workspaceFolder.uri, pathArg);
                      const doc = await vscode.workspace.openTextDocument(uri);
                      const start = params.start_line || 0;
                      const end = params.end_line || Math.min(start + 400, doc.lineCount);
                      const text = doc.getText(new vscode.Range(new vscode.Position(start, 0), new vscode.Position(Math.min(end, doc.lineCount - 1), 1000)));
                      chatHistory.push({ role: 'system', content: `Content of ${pathArg}:\n\`\`\`\n${text}\n\`\`\`` });
                      renderUpdate(`Reading ${pathArg}...`, false, step);
                  }
              } else if (toolName === 'search_keywords') {
                const keywords = params.keywords || params.query;
                if (Array.isArray(keywords)) {
                    const results = await this.searchWorkspaceKeywords(keywords, workspaceFolder.uri.fsPath);
                    chatHistory.push({ role: 'system', content: results });
                    actionLog.push(`🔍 Searched: ${keywords.join(', ')}`);
                    renderUpdate("Searching...", false, step);
                }
              } else {
                   actionLog.push(`⚠️ Unknown tool: ${toolName}`);
              }
          } catch (e: any) {
              actionLog.push(`❌ Error: ${e.message}`);
              if (retryCount < MAX_RETRIES) {
                  retryCount++;
                  chatHistory.push({ role: 'system', content: "ERROR: Tool failed. Try a different approach." });
                  continue;
              }
              break;
          }
      }

      renderUpdate("Context Ready", true, stepsTaken);

      let finalContext = "";
      if (selectedFiles.size > 0) {
          finalContext = await this.readSpecificFiles(Array.from(selectedFiles));
      }
      
      return {
          context: finalContext,
          analysis: cumulativeBrain
      };
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
   * Process a file and return its text representation. 
   * If it's a PDF with images, they are added to the 'imagesOut' array.
   */
  public async processFile(fileName: string, base64Data: string, imagesOut?: { filePath: string; data: string }[], mode?: string): Promise<string> {
      const ext = path.extname(fileName).toLowerCase();
      const buffer = Buffer.from(base64Data, 'base64');

      if (this.binaryExtensions.has(ext)) {
          return `(Binary file ${fileName} content excluded)`;
      }

      if (ext === '.pdf' || this.docExtensions.has(ext)) {
          try {
              if (ext === '.pdf') {
                  // For text extraction, try backend, fallback to local pdf-parse
                  try {
                      return await this.lollmsAPI.extractText(base64Data, fileName);
                  } catch (e) {
                      return await this.parsePdfLocal(buffer);
                  }
              }
              // Standard extraction for other docs
              return await this.lollmsAPI.extractText(base64Data, fileName);
          } catch (apiError: any) {
              if (ext === '.docx') {
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
  
  async getContextContent(options?: { includeTree?: boolean, signal?: AbortSignal, importedSkillIds?: string[], activeDiagramIds?: string[], modelName?: string, allowRLM?: boolean, onProgress?: (pct: number) => void, capabilities?: DiscussionCapabilities }): Promise<ContextResult> {
    const result: ContextResult = { text: '', images:[], projectTree: '', selectedFilesContent: '', skillsContent: '', importedSkills:[] };
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    const maxImageSize = config.get<number>('maxImageSize') || 1024;
    
    // Check vision capability
    const enableVision = options?.capabilities?.enableImages !== false;
    const useVisualDocs = options?.capabilities?.useImageModeForDocs === true;
    const includeTree = options?.includeTree !== false; 
    const signal = options?.signal;

    // --- RLM (Recursive Language Model) / Long Context Logic ---
    let useRLM = false;
    if (options?.allowRLM && this.contextStateProvider && options?.modelName) {
        try {
            const sizeData = await this.lollmsAPI.getContextSize(options.modelName);
            if (sizeData && sizeData.context_size > 0) {
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (workspaceFolder) {
                    let totalBytes = 0;
                    const includedFiles = this.contextStateProvider.getIncludedFiles();
                    
                    // Quick estimate of context usage based on file size
                    for (const f of includedFiles) {
                        try {
                            const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(workspaceFolder.uri, f.path));
                            totalBytes += stat.size;
                        } catch { }
                    }
                    
                    // Roughly 1 token ~= 3.5 chars (bytes for utf8 ascii). 
                    // We use 70% threshold.
                    const estimatedTokens = totalBytes / 3.5;
                    if (estimatedTokens > (sizeData.context_size * 0.7)) {
                        useRLM = true;
                    }
                }
            }
        } catch (e) {
            console.error("Failed to check context size for RLM:", e);
        }
    }

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

    if (includeTree) {
        if (signal?.aborted) throw new Error("Operation cancelled");
        if (this._isTreeDirty || !this._cachedTreeString) {
            this._cachedTreeString = await this.generateProjectTree(signal, options?.onProgress);
            this._isTreeDirty = false;
        }
        result.projectTree = this._cachedTreeString;
    }

    const includedFiles = contextFiles.filter(f => !f.path.endsWith(path.sep));
    
    if (useRLM) {
        result.selectedFilesContent += `### 🐢 LONG CONTEXT MODE (RLM ACTIVATED)\n`;
        result.selectedFilesContent += `Context limit reached. Contents are hidden. Refer to the tree for files marked [C].\n\n`;
        result.selectedFilesContent += `**INSTRUCTIONS:**\n- Use \`read_file\` to peek at specific files.\n- Use \`search_files\` to find code.\n- Use \`rlm_repl\` to maintain state and memory.\n\n`;
        result.selectedFilesContent += `### RLM MEMORY\n- **Front Memory (Scratchpad):** [Empty]\n- **Back Memory (Persistent):** [Empty]\n`;
    } else if (includedFiles.length > 0) {
      result.selectedFilesContent += "## Loaded code files\n\n"
      result.selectedFilesContent += "The content of the files added to the context is provided here.\n"
      result.selectedFilesContent += "If you need to load other files use files loading tag.\n"
      result.selectedFilesContent += "Only load files if they are not already loaded here and you do need them to perform the task.\n^,"

      // Redundant Index removed. Markers are now in the Project Structure tree.
      for (let i = 0; i < includedFiles.length; i++) {
        const fileEntry = includedFiles[i];

        if (i % 10 === 0) {
             await new Promise(resolve => setTimeout(resolve, 0));
        }

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

          let fileContent = '';

          // 1. Try State-Aware Cache First
          const cached = this._fileContentCache.get(filePath);
          if (cached && cached.state === contextState) {
              fileContent = cached.content;
          } 
          // 2. Read from disk and process based on type
          else {
              const fileBytes = await vscode.workspace.fs.readFile(fullPath);
              const fileBuffer = Buffer.from(fileBytes);

              if (this.imageExtensions.has(ext)) {
                  if (!enableVision) {
                      result.selectedFilesContent += `### \`${filePath}\` (Image Muted - Vision Disabled)\n\n`;
                      continue;
                  }
                  const base64Data = fileBuffer.toString('base64');
                  const mime = ext === '.svg' ? 'image/svg+xml' : `image/${ext.substring(1).replace('jpg', 'jpeg')}`;
                  const dataUrl = `data:${mime};base64,${base64Data}`;
                  
                  result.images.push({ filePath, data: dataUrl });
                  result.selectedFilesContent += `### \`${filePath}\` (Image Attached)\n\n`;
                  continue; 
              }

              if (this.isBinary(fileBuffer)) {
                  result.selectedFilesContent += `\`\`\`${this.getLanguageId(filePath)}:${filePath}\n(Binary content detected and excluded)\n\`\`\`\n\n`;
                  continue;
              }
              
              if (this.docExtensions.has(ext)) {
                  try {
                      fileContent = await this.processFile(filePath, fileBuffer.toString('base64'), result.images);
                  } catch (e: any) {
                      fileContent = `⚠️ **Extraction failed:** ${e.message}`;
                  }
              } else if (ext === '.ipynb') {
                  try {
                      const notebookJson = JSON.parse(fileBuffer.toString('utf8'));
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
                  fileContent = fileBuffer.toString('utf8');
              }
              
              // Only cache text content to avoid bloating memory with large base64 strings
              if (fileContent.length < 500000) { // 500kb limit per file in cache
                  this._fileContentCache.set(filePath, { content: fileContent, state: contextState });
              }
          }
          
          result.selectedFilesContent += `\`\`\`${this.getLanguageId(filePath)}:${filePath}\n${fileContent}\n\`\`\`\n\n`;

        } catch (error) {
          result.selectedFilesContent += `### ${filePath}\n\n⚠️ **Error processing entry:** ${error}\n\n`;
        }
      }
    }

    const discussionSkillIds = options?.importedSkillIds || [];
    const projectSkillIds = await this.getActiveProjectSkills();
    
    const allSkillIds = Array.from(new Set([...discussionSkillIds, ...projectSkillIds]));

    // --- DIAGRAMS CONTEXT ---
    const activeDiagramIds = options?.activeDiagramIds || [];
    if (activeDiagramIds.length > 0 && this.codeGraphManager) {
        // Ensure graph is built if it's currently empty
        if (this.codeGraphManager.getGraphData().nodes.length === 0 && this.codeGraphManager.getBuildState() === 'idle') {
            await this.codeGraphManager.buildGraph();
        }

        result.diagrams = [];
        for (const diagType of activeDiagramIds) {
            const mermaid = this.codeGraphManager.generateMermaid(diagType);
            result.diagrams.push({ type: diagType, mermaid });
        }
    }

    result.skillsContent = "";
    if (this.skillsManager && allSkillIds.length > 0) {
        const skills = await this.skillsManager.getSkills();
        for (const skill of skills) {
            if (allSkillIds.includes(skill.id)) {
                result.importedSkills.push(skill);
                const scopeLabel = skill.scope === 'global' ? 'GLOBAL' : 'PROJECT';
                result.skillsContent += `\n#### 💎 SOURCE OF TRUTH: ${skill.name.toUpperCase()} (${scopeLabel} SKILL)\n`;
                result.skillsContent += `> Description: ${skill.description}\n`;
                result.skillsContent += `\`\`\`${skill.language || 'text'}\n${skill.content}\n\`\`\`\n\n`;
            }
        }
    }
    result.text = `# 📂 PROJECT: ${path.basename(workspaceFolder.uri.fsPath)}\n`;
    result.text += `**Sandbox Protocol:** You are restricted to this project folder. Use ONLY relative paths for all file operations.\n`;
    result.text += `**Active Context:** ${includedFiles.length} Files | ${allSkillIds.length} Skills\n\n`;

    if (result.skillsContent) {
        result.text += `## 🎓 ACTIVE SKILLS\n${result.skillsContent}---\n\n`;
    }

    if (result.projectTree) {
        result.text += `${result.projectTree}\n`;
    }
    if (result.selectedFilesContent) {
        result.text += result.selectedFilesContent;
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

  private async generateProjectTree(signal?: AbortSignal, onProgress?: (percentage: number) => void): Promise<string> {
    
    if (!this.contextStateProvider) {
      return '## 🌳 PROJECT STRUCTURE\n\n*No project structure available - no workspace folder found.*\n';
    }

    const contextFiles = this.contextStateProvider.getIncludedFiles();

    // 1. Update UI to show we are scanning, not just "Building"
    if (onProgress) onProgress(5); 

    // 2. Fast Scan
    const allVisibleFiles = await this.contextStateProvider.getAllVisibleFiles(signal);
    if (signal?.aborted) throw new Error("Operation cancelled");

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return '## 🌳 PROJECT STRUCTURE\n\n*No workspace folder found.*\n';
    }

    let tree = '## 🌳 PROJECT STRUCTURE\n\n';
    
    if (allVisibleFiles.length === 0) {
      tree += '*No files are currently visible in the context. Right-click files in the explorer to change their context state.*\n';
      return tree;
    }

    // --- SAFETY CHECK: Truncate large trees to prevent API Context Length errors ---
    const FILE_LIMIT = 1500; // Reduced for Librarian safety
    let effectiveFiles = allVisibleFiles;
    let warningMsg = '';

    if (allVisibleFiles.length > FILE_LIMIT) {
        effectiveFiles = allVisibleFiles.slice(0, FILE_LIMIT);
        warningMsg = `\n*(⚠️ Tree truncated: ${allVisibleFiles.length - FILE_LIMIT} files hidden. Use .lollms/context_exceptions to ignore large folders like node_modules or build.)*\n`;
    }

    tree += '```text\n';
    
    const fileTree: { [key: string]: any } = {};
    
    // Enhanced Performance: Crawl files in larger batches but yield strictly
    for (let i = 0; i < effectiveFiles.length; i++) {
        if (i % 50 === 0) {
            await new Promise(resolve => setTimeout(resolve, 2)); 
            if (onProgress) {
                const pct = Math.round((i / effectiveFiles.length) * 100);
                onProgress(pct);
            }
        }
        
        const filePath = effectiveFiles[i];
        if (filePath.includes(':') || filePath.startsWith('/') || filePath.startsWith('\\')) {
            continue;
        }

        // FIX: Split on both slashes to avoid flattening on Windows
        const parts = filePath.split(/[\\/]/).filter(part => part.length > 0);
        
        // --- PRUNING LOGIC: Skip children of collapsed folders ---
        let isCollapsedByParent = false;
        let currentPathAcc = "";
        for (let j = 0; j < parts.length - 1; j++) {
            currentPathAcc = currentPathAcc ? currentPathAcc + '/' + parts[j] : parts[j];
            const parentUri = vscode.Uri.joinPath(workspaceFolder.uri, currentPathAcc);
            if (this.contextStateProvider?.getStateForUri(parentUri) === 'collapsed') {
                isCollapsedByParent = true;
                break;
            }
        }
        if (isCollapsedByParent) continue;
        // ---------------------------------------------------------

        let current = fileTree;
        parts.forEach((part, index) => {
            if (!current[part]) {
                current[part] = index === parts.length - 1 ? null : {};
            }
            if (current[part] !== null) {
                current = current[part];
            }
        });
    }

    // Create a map for quick state lookup during tree construction
    const stateMap = new Map<string, string>();
    contextFiles.forEach(f => stateMap.set(this.normalize(f.path), f.state));

    // Token-efficient YAML-style tree generation
    const generateTreeString = (obj: any, indentLevel: number = 0, currentPath: string = ''): string => {
      let result = '';
      const keys = Object.keys(obj).sort((a, b) => {
        const aIsDir = obj[a] !== null;
        const bIsDir = obj[b] !== null;
        if (aIsDir && !bIsDir) return -1;
        if (!aIsDir && bIsDir) return 1;
        return a.localeCompare(b);
      });

      const indent = '  '.repeat(indentLevel);

      keys.forEach((key) => {
        const fullPath = currentPath ? currentPath + '/' + key : key;
        const normalizedPath = this.normalize(fullPath);
        const isDirectory = obj[key] !== null;
        
        let suffix = "";
        let isCollapsed = false;

        if (this.contextStateProvider && workspaceFolder) {
            const uri = vscode.Uri.joinPath(workspaceFolder.uri, fullPath);
            const state = isDirectory ? this.contextStateProvider.getStateForUri(uri) : stateMap.get(normalizedPath);
            
            if (state === 'collapsed') {
                isCollapsed = true;
                suffix = " (Collapsed)";
            } else if (state === 'included') {
                suffix = " [C]"; // Content Loaded
            } else if (state === 'definitions-only') {
                suffix = " [D]"; // Definitions Only
            }
        }

        if (isCollapsed) {
             result += indent + key + '/' + suffix + '\n';
             return; 
        }
        
        result += indent + key + (isDirectory ? '/' : '') + suffix + '\n';

        if (isDirectory) {
          result += generateTreeString(obj[key], indentLevel + 1, fullPath);
        }
      });

      return result;
    };

    tree += generateTreeString(fileTree);
    tree += '```\n' + warningMsg;

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


  public async getCachedTokens(filePath: string, currentHash: string): Promise<number | null> {
      const cache = this.context.workspaceState.get<Record<string, { hash: string, tokens: number }>>(ContextManager.TOKEN_CACHE_KEY, {});
      const entry = cache[filePath];
      if (entry && entry.hash === currentHash) {
          return entry.tokens;
      }
      return null;
  }

  public async setCachedTokens(filePath: string, hash: string, tokens: number) {
      const cache = this.context.workspaceState.get<Record<string, { hash: string, tokens: number }>>(ContextManager.TOKEN_CACHE_KEY, {});
      cache[filePath] = { hash, tokens };
      await this.context.workspaceState.update(ContextManager.TOKEN_CACHE_KEY, cache);
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

