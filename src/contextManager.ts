import * as vscode from 'vscode';
import * as path from 'path';
import { ContextStateProvider } from './commands/contextStateProvider';
import Jimp = require('jimp');
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

  public setCodeGraphManager(manager: CodeGraphManager) {
      this.codeGraphManager = manager;
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

  public async searchWorkspaceContent(query: string, options: { matchCase: boolean, wholeWord: boolean } = { matchCase: false, wholeWord: false }, signal?: AbortSignal): Promise<{path: string, snippet: string}[]> {
    const results: {path: string, snippet: string}[] = [];
    const maxResults = 50;
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return [];

    const cwd = workspaceFolder.uri.fsPath;

    try {
        let stdout = "";
        // 1. Try git grep first (Supports rich boolean logic)
        try {
            let gitGrepArgs = `-n -I --max-count=1`;
            if (!options.matchCase) gitGrepArgs += ` -i`;
            if (options.wholeWord) gitGrepArgs += ` -w`;

            // Parse Boolean Logic for git grep
            // Split by OR first
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
            
            const res = await execAsync(`git grep ${gitGrepArgs} ${patternArgs}`, { cwd, maxBuffer: 1024 * 1024 });
            stdout = res.stdout;
        } catch (e) {
            // 2. Fallback to system tools
            const isWin = process.platform === 'win32';
            let command = "";
            
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
                
                // Format is usually path:line:content
                const parts = line.split(':');
                if (parts.length >= 3) {
                    const filePath = parts[0].trim();
                    const snippet = parts.slice(2).join(':').trim();
                    
                    // Avoid duplicates
                    if (!results.some(r => r.path === filePath)) {
                        results.push({
                            path: filePath,
                            snippet: snippet.substring(0, 150)
                        });
                    }
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

  private extractVideoId(url: string): string | null {
      const patterns = [
          /(?:v=|\/shorts\/|\/embed\/|youtu\.be\/)([^#&?]*)/,
          /[?&]v=([^#&?]*)/
      ];
      for (const p of patterns) {
          const match = url.match(p);
          if (match && match[1] && match[1].length === 11) return match[1];
      }
      return null;
  }

private async fetchYoutubeTranscript(videoId: string, languageCode: string = 'en'): Promise<string> {
      try {
        const headers = { 
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9'
        };

        // 1. Fetch the video page to get API Key and Initial Data
        const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers });
        const html = await pageRes.text();
        
        const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
        if (!apiKeyMatch) return "Could not retrieve InnerTube API key.";
        const apiKey = apiKeyMatch[1];

        // Extract ytInitialData which contains the transcript params
        const dataMatch = html.match(/var ytInitialData = ({.*?});/);
        if (!dataMatch) return "Could not find video data on the page.";
        const ytInitialData = JSON.parse(dataMatch[1]);

        // 2. Locate the transcript params (continuation token)
        let transcriptParams: string | undefined;
        const engagementPanels = ytInitialData.engagementPanels || [];
        for (const panel of engagementPanels) {
            const renderer = panel.engagementPanelSectionListRenderer;
            if (renderer?.panelIdentifier === 'engagement-panel-transcript') {
                transcriptParams = renderer.content?.transcriptRenderer?.params 
                                || renderer.header?.engagementPanelTitleHeaderRenderer?.menu?.menuRenderer?.items?.[0]?.menuServiceItemRenderer?.serviceEndpoint?.getTranscriptEndpoint?.params;
            }
        }

        if (!transcriptParams) return "No transcript available for this video (or it is disabled).";

        // 3. Call the specialized get_transcript endpoint
        const transcriptUrl = `https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}`;
        const transcriptRes = await fetch(transcriptUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                context: {
                    client: {
                        clientName: "WEB",
                        clientVersion: "2.20240210.05.00"
                    }
                },
                params: transcriptParams
            })
        });

        if (!transcriptRes.ok) return `Transcript API Error: ${transcriptRes.status}`;
        const transcriptData: any = await transcriptRes.json();

        // 4. Parse the segments from the transcript response
        const panels = transcriptData.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer?.body?.transcriptBodyRenderer?.cueGroups || [];
        const textParts: string[] = [];
        
        for (const group of panels) {
            const cues = group.transcriptCueGroupRenderer?.cues || [];
            for (const cue of cues) {
                const text = cue.transcriptCueRenderer?.shortId?.simpleText || cue.transcriptCueRenderer?.cue?.simpleText || "";
                if (text) textParts.push(text);
            }
        }

        const finalResult = textParts.join(' ').replace(/\s+/g, ' ').trim();
        return finalResult || "Extraction failed: The transcript response contained no text segments.";

      } catch(e: any) {
          return `Error fetching transcript: ${e.message}`;
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
      const isYoutube = url.includes('youtube.com') || url.includes('youtu.be');
      const isArxiv = url.includes('arxiv.org');
      const isWiki = url.includes('wikipedia.org');
      
      let rawContent = "";
      
      // Use existing tools logic by importing tools dynamically to avoid circular deps or re-implement basic fetch
      // Re-implementing simplified versions here to keep ContextManager independent
      
      if (isYoutube) {
          try {
             const videoId = this.extractVideoId(url);
             if (videoId) {
                 const transcript = await this.fetchYoutubeTranscript(videoId, languageCode);
                 rawContent = `[YouTube Video] ${url}\nVideo ID: ${videoId}\n\n### TRANSCRIPT:\n${transcript}`;
             } else {
                 rawContent = `Invalid YouTube URL: ${url}`;
             }
          } catch(e) {
              rawContent = `Failed to load YouTube content: ${e}`;
          }
      } else if (isArxiv) {
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
    onUpdate: (content: string) => void
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

    let chatHistory: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `**USER REQUEST:** "${userPrompt}"\n\n**CURRENTLY ACTIVE SKILLS:** ${JSON.stringify(Array.from(selectedIds))}` }
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
                renderUpdate("Filtering results...", false, step);
            }
            else if (toolCall.tool === 'select_skills') {
                const toAdd = toolCall.params.add || [];
                const toRemove = toolCall.params.remove || [];
                toAdd.forEach((id: string) => selectedIds.add(id));
                toRemove.forEach((id: string) => selectedIds.delete(id));
                actionLog.push(`✅ Updated selection: +${toAdd.length} / -${toRemove.length} skills.`);
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
  public async runWebResearchAgent(
      userPrompt: string,
      model: string,
      signal: AbortSignal,
      onUpdate: (content: string) => void,
      onOverlayUpdate?: (status: string) => void
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    const searchInCache = config.get<boolean>('searchInCacheFirst') ?? true;
    const searchProvider = config.get<string>('searchProvider') || 'google_custom_search';
    const apiKey = config.get<string>('searchApiKey');
    const cx = config.get<string>('searchCx');
    
    // Check if configuration exists for Google
    const canGoogle = searchProvider === 'google_custom_search' && !!apiKey && !!cx;

    const systemPrompt = `You are a Web Research Librarian. 
Your goal is to check if the user's request requires external knowledge (documentation, libraries, recent events).
If yes, you must plan searches, execute them, review results, and add valuable content to the context.

**AVAILABLE TOOLS:**
1. \`plan_searches(queries=[{"provider": "google|arxiv|wikipedia|stackoverflow", "q": "query string"}])\`: Execute searches in parallel.
   - Use 'google' for general docs/info (Only if available).
   - Use 'stackoverflow' for specific coding errors.
   - Use 'arxiv' for research papers.
   - Use 'wikipedia' for general concepts.
2. \`read_and_add(urls=["url1", "url2"])\`: Scrape these URLs and add their content to the project context as files.
3. \`done()\`: Finish research.

**RULES:**
- Don't search if the request is purely about existing code (e.g. "refactor this function"). Call \`done()\` immediately.
- Minimise noise. Only add high-quality documentation or solutions.
- **OUTPUT JSON ONLY**: Reply with a valid JSON object.

**JSON FORMAT:**
\`\`\`json
{
  "tool": "tool_name",
  "params": { ... }
}
\`\`\`
`;

    const actionLog: string[] = [];
    const foundResults: { url: string, title: string, provider: string }[] = [];
    const addedSources: { url: string, title: string }[] = [];
    const chatHistory: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Request: "${userPrompt}"\n\nGoogle Available: ${canGoogle}` }
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
        
        const fullMessage = `**🌍 Web Research Agent**\n\n${spinnerHtml}\n\n${foundHtml}\n\n${sourcesHtml}\n\n${logSection}`;
        onUpdate(fullMessage);
    };

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
      initialKeywords?: string[]
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
          onUpdate("⚠️ No visible files found in project.");
          return "";
      }

      const currentContextFiles = this.contextStateProvider.getIncludedFiles().map(f => f.path);
      const selectedFiles = new Set<string>(currentContextFiles);
      const initialCount = selectedFiles.size;

      const fileTree = await this.generateProjectTree(signal, (pct) => {
          const status = `Scanning project structure: ${pct}%...`;
          if (onStatusUpdate) onStatusUpdate(status);
          onUpdate(`**🧠 Auto-Context Agent**\n\n### 📂 Building File Tree...\n\n<div class="token-progress-container" style="height:8px; margin-bottom:10px;"><div class="token-progress-bar range-safe" style="width:${pct}%"></div></div>\n\n*${status}*`);
      });
      
      // Get current aggression level from capabilities
      const discussion = this.lollmsAPI.globalState?.get<any>(`discussion-${model}`); // Simplified lookup
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

      const systemPrompt = `You are a Senior Context Librarian Agent.
Your goal is to prepare the perfect context for an LLM to answer the user's request.
${aggressionInstruction}

### 🧠 STATEFUL MEMORY PROTOCOL
I will track your long-term memory for you. 
In your 'scratchpad' field, provide ONLY the **newest** observations and conclusions from your last action. 
I will append these to your "CUMULATIVE BRAIN" and show it to you in the next turn.

**Your Scratchpad Output should focus on:**
1. **LATEST OBSERVATION**: Specific findings from the last tool result.
2. **UPDATED VERDICT**: Immediate decision on current file relevance.
3. **NEXT STEP REASONING**: Why your next tool call is the right choice.

**AVAILABLE TOOLS:**
1. \`add_files(files=[{"path": "p1", "mode": "full|signatures"}])\`: Finalize selection for context.
2. \`read_file(path="path", start_line=0, end_line=500)\`: Read a specific segment of a file. If the file is large, use pagination.
3. \`get_file_info(path="path")\`: Returns file size and total line count without reading content.
4. \`search_keywords(keywords=["funcName", "className"])\`: Search for strings to locate logic.
5. \`done()\`: Finish context selection.

**RULES:**
- If a file is truncated, use \`read_file\` with a new \`start_line\` to see the rest.
- Never guess content. If you see a class definition but no methods, read further down.
- Only add files that are strictly relevant to the user's specific request.
- **OUTPUT JSON ONLY**: Reply with a valid JSON object.

**JSON FORMAT:**
\`\`\`json
{
  "scratchpad": "I need to find the authentication logic. I will search for 'login' to locate the correct files.",
  "tool": "tool_name",
  "params": { ... }
}
\`\`\`
`;

      const actionLog: string[] = [];
      const executedActions = new Set<string>();
      let cumulativeBrain = ""; // Internal master state

      let initialUserContent = `**User Request:** "${userPrompt}"\n\n**Project Structure:**\n${fileTree}`;
      
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
              content: `### 🧠 CUMULATIVE BRAIN (MEMORY)\n${cumulativeBrain || "No observations yet."}\n\n[Status] Selected: ${JSON.stringify(Array.from(selectedFiles))}. Continue or 'done()'.` 
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
              
              if (toolCall.scratchpad) {
                  const newEntry = toolCall.scratchpad.trim();
                  // Append to master memory for LLM context
                  cumulativeBrain += `\n- Step ${step + 1}: ${newEntry}`;
                  // Append to user log for timeline view
                  actionLog.push(`🧠 **Insight**: ${newEntry}`);
              }

              // Loop Prevention
              const actionFingerprint = JSON.stringify({ tool: toolName, params });
              if (executedActions.has(actionFingerprint) && toolName !== 'done') {
                  chatHistory.push({ 
                      role: 'system', 
                      content: `WARNING: You already executed this exact tool call earlier. Avoid infinite loops. Use your scratchpad to store conclusions, and pick a different tool, change parameters, or call \`done()\` if you are finished.` 
                  });
                  actionLog.push(`⚠️ Loop detected. Re-prompting agent.`);
                  continue;
              }
              executedActions.add(actionFingerprint);

              retryCount = 0;

              if (toolName === 'done') {
                  actionLog.push(`✅ Optimization complete.`);
                  renderUpdate("Context Ready", true, step);
                  break;
              }

              stepsTaken++;

              if (toolName === 'get_file_info') {
                  const pathArg = params.path;
                  if (pathArg) {
                      const uri = vscode.Uri.joinPath(workspaceFolder.uri, pathArg);
                      const stats = await vscode.workspace.fs.stat(uri);
                      const doc = await vscode.workspace.openTextDocument(uri);
                      chatHistory.push({ 
                          role: 'system', 
                          content: `FILE INFO for ${pathArg}:\nSize: ${stats.size} bytes\nTotal Lines: ${doc.lineCount}` 
                      });
                      actionLog.push(`📊 Info: ${pathArg} (${doc.lineCount} lines)`);
                  }
              } else if (toolName === 'add_files') {
                  const files = params.files;
                  if (Array.isArray(files)) {
                      for (const fileItem of files) {
                          const fPath = typeof fileItem === 'string' ? fileItem : fileItem.path;
                          const fMode = typeof fileItem === 'string' ? 'included' : (fileItem.mode === 'signatures' ? 'definitions-only' : 'included');
                          
                          if (allFiles.includes(fPath)) {
                              selectedFiles.add(fPath);
                              const uri = vscode.Uri.joinPath(workspaceFolder.uri, fPath);
                              await this.contextStateProvider.setStateForUris([uri], fMode);
                          }
                      }
                      actionLog.push(`➕ Processed: ${files.length} file(s).`);
                      renderUpdate("Updating context...", false, step);
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
                      const uri = vscode.Uri.joinPath(workspaceFolder.uri, pathArg);
                      const doc = await vscode.workspace.openTextDocument(uri);
                      const start = params.start_line || 0;
                      const end = params.end_line || Math.min(start + 400, doc.lineCount);
                      
                      const range = new vscode.Range(
                          new vscode.Position(start, 0),
                          new vscode.Position(Math.min(end, doc.lineCount - 1), 1000)
                      );
                      const text = doc.getText(range);
                      
                      const statusMsg = end < doc.lineCount 
                        ? `[TRUNCATED] Showing lines ${start}-${end} of ${doc.lineCount}. Use read_file with start_line=${end} to see more.`
                        : `[END OF FILE] Showing lines ${start}-${doc.lineCount}.`;

                      chatHistory.push({ 
                          role: 'system', 
                          content: `Content of ${pathArg}:\n\`\`\`\n${text}\n\`\`\`\n\n${statusMsg}` 
                      });
                      actionLog.push(`📖 Read ${pathArg} (L${start}-L${end})`);
                      renderUpdate("Reading file segment...", false, step);
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
        result.projectTree = await this.generateProjectTree(signal, options?.onProgress);
    }

    const includedFiles = contextFiles.filter(f => !f.path.endsWith(path.sep));
    
    if (useRLM) {
        result.selectedFilesContent += `### 🐢 LONG CONTEXT MODE (RLM ACTIVATED)\n`;
        result.selectedFilesContent += `The total size of selected files exceeds 70% of the context window. Content is hidden.\n\n`;
        result.selectedFilesContent += `**AVAILABLE FILES:**\n`;
        for (const f of includedFiles) {
            result.selectedFilesContent += `- ${f.path}\n`;
        }
        result.selectedFilesContent += `\n**INSTRUCTIONS:**\n- Use \`read_file\` to peek at specific files.\n- Use \`search_files\` to find code.\n- Use \`rlm_repl\` to maintain state and memory.\n\n`;
        result.selectedFilesContent += `### RLM MEMORY\n- **Front Memory (Scratchpad):** [Empty]\n- **Back Memory (Persistent):** [Empty]\n`;
    } else if (includedFiles.length > 0) {
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

          const fileBytes = await vscode.workspace.fs.readFile(fullPath);
          const buffer = Buffer.from(fileBytes);
          let fileContent = '';

          if (this.imageExtensions.has(ext)) {
            if (!enableVision) {
                result.selectedFilesContent += `### \`${filePath}\` (Image Muted - Vision Disabled)\n\n`;
                continue;
            }
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
                if (useVisualDocs && enableVision) {
                    try {
                        // Request backend to convert document to images
                        const visualData = await this.lollmsAPI.extractVisualText(buffer.toString('base64'), filePath);
                        if (visualData.images) {
                            visualData.images.forEach((img: string, idx: number) => {
                                result.images.push({ filePath: `${filePath}#page${idx+1}`, data: img });
                            });
                            fileContent = `[Document converted to ${visualData.images.length} images for Vision analysis]`;
                        } else {
                            fileContent = visualData.text || "";
                        }
                    } catch (e) {
                        fileContent = `⚠️ **Visual extraction failed, falling back to text:** ${e}`;
                        fileContent += await this.lollmsAPI.extractText(buffer.toString('base64'), filePath);
                    }
                } else {
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
    result.text += `**Sandbox Protocol:** You are restricted to this project folder. Use ONLY relative paths (e.g., \`src/main.ts\`) for all file operations.\n`;
    result.text += `**Active Context:** ${includedFiles.length} Files | ${allSkillIds.length} Skills\n\n`;

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

  private async generateProjectTree(signal?: AbortSignal, onProgress?: (percentage: number) => void): Promise<string> {
    
    if (!this.contextStateProvider) {
      return '## Project Structure\n\n*No project structure available - no workspace folder found.*\n';
    }

    // Pass the signal to get visible files (which already yields)
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

    // --- SAFETY CHECK: Truncate very large file lists to prevent freeze/OOM ---
    const FILE_LIMIT = 2000;
    let effectiveFiles = allVisibleFiles;
    let warningMsg = '';

    if (allVisibleFiles.length > FILE_LIMIT) {
        effectiveFiles = allVisibleFiles.slice(0, FILE_LIMIT);
        warningMsg = `\n*(Tree truncated: ${allVisibleFiles.length - FILE_LIMIT} additional files hidden to save memory. Use context exclusions to hide irrelevant folders.)*\n`;
    }

    tree += '```text\n';
    
    const fileTree: { [key: string]: any } = {};
    
    // Performance Optimization: Process file list in chunks to avoid blocking the event loop
    for (let i = 0; i < effectiveFiles.length; i++) {
        if (i % 200 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
            if (onProgress) {
                onProgress(Math.round((i / effectiveFiles.length) * 100));
            }
        }
        
        const filePath = effectiveFiles[i];
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
    }

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

