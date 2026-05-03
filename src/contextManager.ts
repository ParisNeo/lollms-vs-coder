import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from './logger';
import { ContextStateProvider, ContextState } from './commands/contextStateProvider';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { SkillsManager, Skill } from './skillsManager';
import { DiscussionCapabilities } from './utils';
import { CodeGraphManager } from './codeGraphManager';
import * as mammoth from 'mammoth';
const pdfParse = require('pdf-parse');
import { stripThinkingTags } from './utils';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import fetch from 'node-fetch';
import { URL } from 'url';
const YoutubeTranscript = require('youtube-transcript').default || require('youtube-transcript');
const execAsync = promisify(exec);

export interface ContextResult {
  text: string;
  projectName: string;
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
    'py': 'python', 'js': 'javascript', 'jsx': 'javascript', 'ts': 'typescript',
    'tsx': 'typescript', 'vue': 'vue', 'rs': 'rust', 'sh': 'bash', 'md': 'markdown',
    'json': 'json', 'html': 'html', 'css': 'css', 'scss': 'scss', 'less': 'less',
    'cpp': 'cpp', 'c': 'c', 'h': 'c', 'hpp': 'cpp', 'cs': 'csharp', 'go': 'go',
    'java': 'java', 'php': 'php', 'rb': 'ruby', 'swift': 'swift', 'kt': 'kotlin',
    'lua': 'lua', 'r': 'r', 'sql': 'sql', 'yaml': 'yaml', 'yml': 'yaml', 'xml': 'xml',
    'bat': 'batch', 'ps1': 'powershell', 'tex': 'latex', 'vb': 'vb', 'fs': 'fsharp',
    'erl': 'erlang', 'ex': 'elixir', 'pl': 'perl', 'dart': 'dart', 'm': 'objectivec',
    'mm': 'objectivec', 'scala': 'scala', 'hs': 'haskell', 'clj': 'clojure',
    'cljs': 'clojure', 'dockerfile': 'dockerfile', 'groovy': 'groovy', 'gradle': 'groovy',
    'toml': 'toml', 'ini': 'ini', 'tf': 'terraform', 'svelte': 'svelte', 'ejs': 'ejs',
    'erb': 'erb', 'hbs': 'handlebars'
  };

  private _lastContext: ContextResult | null = null;
  private static PROJECT_SKILLS_KEY = 'lollms_project_active_skills';
  private static TOKEN_CACHE_KEY = 'lollms_token_cache';

  // --- GLOBAL CACHE STATE ---
  private _cachedTreeString: string | null = null;
  private _isTreeDirty: boolean = true;
  private _fileTreeObject: any = null;
  private _fileContentCache!: Map<string, { content: string, state: ContextState }>;
  private _cachedVisibleFiles: string[] | null = null;

  constructor(context: vscode.ExtensionContext, lollmsAPI: LollmsAPI) {
    this.context = context;
    this.lollmsAPI = lollmsAPI;
    this._fileContentCache = new Map();
  }

  // ─────────────────────────────────────────────────────────────
  // CACHE MANAGEMENT
  // ─────────────────────────────────────────────────────────────

  public updateTreeStructure(uri: vscode.Uri, type: 'create' | 'delete' | 'change') {
    if (!this._fileTreeObject) return;
    const relPath = this.normalize(vscode.workspace.asRelativePath(uri, false));
    const parts = relPath.split('/').filter(p => p.length > 0);

    if (type === 'create') {
      let current = this._fileTreeObject;
      parts.forEach((part, index) => {
        if (!current[part]) current[part] = index === parts.length - 1 ? null : {};
        current = current[part];
      });
    } else if (type === 'delete') {
      let current = this._fileTreeObject;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!current[parts[i]]) return;
        current = current[parts[i]];
      }
      delete current[parts[parts.length - 1]];
    }
    this._cachedTreeString = null;
    this._cachedVisibleFiles = null;
    this._isTreeDirty = false;
  }

  public markTreeDirty() {
    this._isTreeDirty = true;
    this._fileTreeObject = null;
    this._cachedTreeString = null;
    this._cachedVisibleFiles = null;
  }

  public isTreeDirty(): boolean {
    return this._isTreeDirty || !this._cachedTreeString;
  }

  public refreshFileInCache(uri: vscode.Uri) {
    const relPath = this.normalize(vscode.workspace.asRelativePath(uri, false));
    // Clear the specific file from cache to force a fresh disk read in getContextContent
    this._fileContentCache?.delete(relPath);
    // Also clear namespaced path if it exists
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length > 1) {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (folder) {
            this._fileContentCache?.delete(`${folder.name}/${relPath}`);
        }
    }
    this.markTreeDirty();
  }

  public clearAllCaches() {
    this._cachedTreeString = null;
    this._isTreeDirty = true;
    this._fileContentCache?.clear();
  }

  // ─────────────────────────────────────────────────────────────
  // ACCESSORS / SETTERS
  // ─────────────────────────────────────────────────────────────

  public get extensionContext(): vscode.ExtensionContext { return this.context; }

  public getGlobalBriefing(): string {
    return this.context.workspaceState.get<string>('lollms_global_briefing', '');
  }
  public async setGlobalBriefing(content: string) {
    await this.context.workspaceState.update('lollms_global_briefing', content);
  }

  public setContextStateProvider(provider: ContextStateProvider | undefined) {
    this.contextStateProvider = provider;
    this.contextStateProvider?.onDidChangeTreeData(() => { this.markTreeDirty(); });
  }
  public setSkillsManager(manager: SkillsManager) { this.skillsManager = manager; }
  public setCodeGraphManager(manager: CodeGraphManager) { this.codeGraphManager = manager; }
  public getContextStateProvider(): ContextStateProvider | undefined { return this.contextStateProvider; }
  public getLastContext(): ContextResult | null { return this._lastContext; }

  private normalize(p: string): string { return p.replace(/\\/g, '/'); }

  private isBinary(buffer: Buffer): boolean {
    const chunk = buffer.slice(0, Math.min(buffer.length, 1024));
    return chunk.includes(0);
  }

  private getLanguageId(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase().substring(1);
    return this.extensionToLanguageMap[ext] || ext || 'plaintext';
  }

  // ─────────────────────────────────────────────────────────────
  // PATH RESOLUTION
  // ─────────────────────────────────────────────────────────────

  public async resolveWorkspaceFromPath(namespacedPath: string): Promise<{ folder: vscode.WorkspaceFolder | undefined, relativePath: string, uri: vscode.Uri } | null> {
    const folders = vscode.workspace.workspaceFolders || [];
    const normalized = namespacedPath.replace(/\\/g, '/').trim();
    const segments = normalized.split('/');

    if (path.isAbsolute(normalized)) {
      const uri = vscode.Uri.file(normalized);
      return { folder: vscode.workspace.getWorkspaceFolder(uri), relativePath: normalized, uri };
    }

    if (folders.length > 1) {
      const projectFolder = folders.find(f => f.name === segments[0]);
      if (projectFolder) {
        const relativeToRoot = segments.slice(1).join('/');
        const uri = vscode.Uri.joinPath(projectFolder.uri, relativeToRoot);
        try {
          await vscode.workspace.fs.stat(uri);
          return { folder: projectFolder, relativePath: relativeToRoot, uri };
        } catch {
          const uriWithSegment = vscode.Uri.joinPath(projectFolder.uri, normalized);
          try {
            await vscode.workspace.fs.stat(uriWithSegment);
            return { folder: projectFolder, relativePath: normalized, uri: uriWithSegment };
          } catch {}
        }
      }
      for (const folder of folders) {
        const testUri = vscode.Uri.joinPath(folder.uri, normalized);
        try {
          await vscode.workspace.fs.stat(testUri);
          return { folder, relativePath: normalized, uri: testUri };
        } catch {}
      }
    }

    const activeFolder = folders[0];
    if (activeFolder) {
      const uriDirect = vscode.Uri.joinPath(activeFolder.uri, normalized);
      try {
        await vscode.workspace.fs.stat(uriDirect);
        return { folder: activeFolder, relativePath: normalized, uri: uriDirect };
      } catch {
        if (segments[0] === activeFolder.name && segments.length > 1) {
          const relStripped = segments.slice(1).join('/');
          const uriStripped = vscode.Uri.joinPath(activeFolder.uri, relStripped);
          try {
            await vscode.workspace.fs.stat(uriStripped);
            return { folder: activeFolder, relativePath: relStripped, uri: uriStripped };
          } catch {}
        }
      }
      let finalRel = normalized;
      if (segments[0] === activeFolder.name && segments.length > 1) {
        finalRel = segments.slice(1).join('/');
      }
      return { folder: activeFolder, relativePath: finalRel, uri: vscode.Uri.joinPath(activeFolder.uri, finalRel) };
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────
  // TREE GENERATION
  // ─────────────────────────────────────────────────────────────

  /**
   * Generates an isolated, physically-walked tree for a single workspace folder.
   * Uses the physical FS walk approach from v1 for accuracy and correct exclusion handling.
   */
  public async generateIsolatedProjectTree(
    folder: vscode.WorkspaceFolder,
    signal?: AbortSignal,
    capabilities?: DiscussionCapabilities
  ): Promise<string> {
    const projectTreeObj: any = {};

    const injectPathIntoTree = (relPath: string) => {
      const normalizedPath = relPath.replace(/\\/g, '/');
      const parts = normalizedPath.split('/').filter(p => p.length > 0 && p !== '.' && p !== '..');
      if (parts.length === 0) return;

      let current: any = projectTreeObj;
      let checkUri = folder.uri;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isLast = i === parts.length - 1;
        checkUri = vscode.Uri.joinPath(checkUri, part);

        const state = this.contextStateProvider?.getStateForUri(checkUri);
        if (this.contextStateProvider?.isStrictlyIgnored(checkUri) || state === 'fully-excluded') {
          return;
        }

        if (!current[part]) {
          current[part] = isLast ? null : {};
        } else if (!isLast && current[part] === null) {
          current[part] = {};
        }

        if (current[part] !== null) current = current[part];
      }
    };

    const walk = async (dirUri: vscode.Uri, depth: number) => {
      if (depth > 8 || (signal && signal.aborted)) return;
      try {
        const entries = await vscode.workspace.fs.readDirectory(dirUri);
        for (const [name, type] of entries) {
          const entryUri = vscode.Uri.joinPath(dirUri, name);
          const state = this.contextStateProvider?.getStateForUri(entryUri);

          if (this.contextStateProvider?.isStrictlyIgnored(entryUri) || state === 'fully-excluded') continue;

          const relPath = this.normalize(path.relative(folder.uri.fsPath, entryUri.fsPath));
          if (relPath && relPath !== '.') injectPathIntoTree(relPath);

          if (type === vscode.FileType.Directory && state !== 'collapsed') {
            await walk(entryUri, depth + 1);
          }
        }
      } catch (e) {
        Logger.error(`Tree walk failed for ${dirUri.fsPath}: ${e}`);
      }
    };

    await walk(folder.uri, 0);

    let treeString = '```text\n';
    const render = (obj: any, prefix: string = '', currentLocalPath: string = ''): string => {
      if (!obj || typeof obj !== 'object') return '';
      let out = '';
      const keys = Object.keys(obj).sort((a, b) => {
        const aIsDir = obj[a] !== null;
        const bIsDir = obj[b] !== null;
        if (aIsDir && !bIsDir) return -1;
        if (!aIsDir && bIsDir) return 1;
        return a.localeCompare(b);
      });

      keys.forEach((key, index) => {
        const isLast = index === keys.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        const isDirectory = obj[key] !== null;
        const localPath = currentLocalPath ? currentLocalPath + '/' + key : key;
        const uri = vscode.Uri.joinPath(folder.uri, localPath);
        const state = this.contextStateProvider?.getStateForUri(uri);

        let suffix = "";
        let isCollapsed = false;

        if (state === 'collapsed') {
          isCollapsed = true;
          suffix = " (Collapsed)";
        } else if (state === 'included') {
          suffix = " [C]";
        } else if (state === 'definitions-only') {
          suffix = " [D]";
        }

        out += prefix + connector + key + (isDirectory ? '/' : '') + (suffix ? ` ${suffix}` : '') + '\n';

        if (isDirectory && !isCollapsed) {
          out += render(obj[key], prefix + (isLast ? '    ' : '│   '), localPath);
        } else if (isDirectory && isCollapsed) {
          out += prefix + (isLast ? '    ' : '│   ') + '└── ⚠️[COLLAPSED: Use add_files if you need contents]\n';
        }
      });
      return out;
    };

    treeString += render(projectTreeObj);
    treeString += '```\n';
    return treeString;
  }

  /**
   * Generates the combined project tree for agents (uses cached global tree).
   * Used by agents that need the full workspace picture.
   */
  public async generateProjectTree(
    signal?: AbortSignal,
    onProgress?: (percentage: number) => void,
    capabilities?: DiscussionCapabilities
  ): Promise<string> {
    if (!this.contextStateProvider || !vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      return '## 🌳 PROJECT STRUCTURE\n\n*No project structure available - no workspace folder found.*\n';
    }

    const folderSettings = capabilities?.folderSettings || {};
    const folders = vscode.workspace.workspaceFolders.filter(f => {
      const settings = folderSettings[f.uri.toString()];
      return !settings || settings.tree !== false;
    });

    if (folders.length === 0) {
      return '## 🌳 PROJECT STRUCTURE\n(All project structures hidden by user settings)\n';
    }

    const contextFiles = this.contextStateProvider.getIncludedFiles();

    if (this._isTreeDirty || !this._fileTreeObject) {
      if (onProgress) onProgress(10);
      this._fileTreeObject = {};

      const injectPath = (relPath: string, rootFolderName?: string) => {
        if (!relPath || relPath.includes('Malformed Block') || relPath.includes('<<<<<<< SEARCH')) return;
        let normalizedPath = relPath.replace(/\\/g, '/');
        if (folders.length > 1 && rootFolderName && normalizedPath.startsWith(rootFolderName + '/')) {
          normalizedPath = normalizedPath.substring(rootFolderName.length + 1);
        }
        const parts = normalizedPath.split('/').filter(p => p.length > 0 && p !== '.' && p !== '..');
        if (parts.length === 0) return;

        let current = this._fileTreeObject;
        if (folders.length > 1 && rootFolderName) {
          if (!current[rootFolderName]) current[rootFolderName] = {};
          current = current[rootFolderName];
        }

        parts.forEach((part, index) => {
          const isLast = index === parts.length - 1;
          if (!current[part]) {
            current[part] = isLast ? null : {};
          } else if (!isLast && current[part] === null) {
            current[part] = {};
          }
          if (current[part] !== null) current = current[part];
        });
      };

      for (const file of contextFiles) {
        const root = folders.find(f => {
          try { fs.statSync(path.join(f.uri.fsPath, file.path)); return true; } catch { return false; }
        });
        injectPath(file.path, root?.name);
      }

      const allVisibleFiles = await this.contextStateProvider.getAllVisibleFiles(signal);
      for (const filePath of allVisibleFiles) {
        const root = folders.find(f =>
          filePath.startsWith(f.name + '/') ||
          this.normalize(vscode.workspace.asRelativePath(vscode.Uri.joinPath(f.uri, filePath), false)) === filePath
        );
        injectPath(filePath, root?.name);
      }

      const walkSync = async (dirUri: vscode.Uri, rootName: string, depth: number) => {
        if (depth > 5 || (signal && signal.aborted)) return;
        try {
          const entries = await vscode.workspace.fs.readDirectory(dirUri);
          for (const [name, type] of entries) {
            const entryUri = vscode.Uri.joinPath(dirUri, name);
            const relPath = this.normalize(vscode.workspace.asRelativePath(entryUri, false));
            if (['.DS_Store', 'node_modules', '__pycache__'].includes(name)) continue;
            injectPath(relPath, rootName);
            if (type === vscode.FileType.Directory) {
              const state = this.contextStateProvider?.getStateForUri(entryUri);
              if (state !== 'collapsed' && !name.startsWith('.')) {
                await walkSync(entryUri, rootName, depth + 1);
              }
            }
          }
        } catch (e) {}
      };

      for (const folder of folders) {
        await walkSync(folder.uri, folder.name, 0);
      }
      this._isTreeDirty = false;
    }

    let treeString = '## 🌳 PROJECT STRUCTURE\n\n```text\n';

    const render = (obj: any, prefix: string = '', currentPath: string = '', rootFolder?: vscode.WorkspaceFolder): string => {
      if (!obj || typeof obj !== 'object') return '';
      let out = '';
      const keys = Object.keys(obj).sort((a, b) => {
        const aIsDir = obj[a] !== null;
        const bIsDir = obj[b] !== null;
        if (aIsDir && !bIsDir) return -1;
        if (!aIsDir && bIsDir) return 1;
        return a.localeCompare(b);
      });

      keys.forEach((key, index) => {
        const isLast = index === keys.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        const isDirectory = obj[key] !== null;

        let activeRoot = rootFolder;
        if (folders.length > 1 && !rootFolder) activeRoot = folders.find(f => f.name === key);
        else if (folders.length === 1) activeRoot = folders[0];

        if (activeRoot && !rootFolder) {
          const settings = folderSettings[activeRoot.uri.toString()];
          if (settings && settings.tree === false) return;
        }

        const isTopLevelProjectName = folders.length > 1 && !rootFolder;
        let subPath = folders.length > 1
          ? (currentPath ? currentPath + '/' + key : (rootFolder ? key : ''))
          : (currentPath ? currentPath + '/' + key : key);

        let suffix = "";
        let isCollapsed = false;

        if (this.contextStateProvider && activeRoot && !isTopLevelProjectName) {
          const uri = vscode.Uri.joinPath(activeRoot.uri, subPath || '.');
          const state = this.contextStateProvider.getStateForUri(uri);
          if (state === 'fully-excluded') return;
          if (state === 'collapsed') { isCollapsed = true; suffix = " (Collapsed)"; }
          else if (state === 'included') suffix = " [C]";
          else if (state === 'definitions-only') suffix = " [D]";
        }

        out += prefix + connector + key + (isDirectory ? '/' : '') + (suffix ? ` ${suffix}` : '') + '\n';

        if (isDirectory && !isCollapsed) {
          out += render(obj[key], prefix + (isLast ? '    ' : '│   '), subPath || key, activeRoot);
        } else if (isDirectory && isCollapsed) {
          out += prefix + (isLast ? '    ' : '│   ') + '└── ... (contents truncated)\n';
        }
      });
      return out;
    };

    treeString += render(this._fileTreeObject);
    treeString += '```\n';
    return treeString;
  }

  // ─────────────────────────────────────────────────────────────
  // MAIN CONTEXT ASSEMBLY — Per-project tree + files
  // ─────────────────────────────────────────────────────────────

  async getContextContent(options?: {
    includeTree?: boolean,
    signal?: AbortSignal,
    importedSkillIds?: string[],
    activeDiagramIds?: string[],
    modelName?: string,
    allowRLM?: boolean,
    onProgress?: (pct: number) => void,
    capabilities?: DiscussionCapabilities
  }): Promise<ContextResult> {

    const result: ContextResult = {
      text: '', projectName: '', images: [],
      projectTree: '', selectedFilesContent: '', skillsContent: '', importedSkills: []
    };

    const signal = options?.signal;
    const enableVision = options?.capabilities?.enableImages !== false;
    const includeTree = options?.includeTree !== false;
    const folderSettings = options?.capabilities?.folderSettings || {};
    const isGlobalMuted = this.context.workspaceState.get<boolean>('lollms_global_context_muted', false);

    if (!this.contextStateProvider || !vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      result.text = this.getNoWorkspaceMessage();
      this._lastContext = result;
      return result;
    }

    const activeFolders = vscode.workspace.workspaceFolders;
    const contextFiles = this.contextStateProvider.getIncludedFiles();
    result.projectName = path.basename(activeFolders[0].uri.fsPath);

    // ── RLM check ──────────────────────────────────────────────
    let useRLM = false;
    if (options?.allowRLM && options?.modelName) {
      try {
        const sizeData = await this.lollmsAPI.getContextSize(options.modelName);
        if (sizeData?.context_size > 0) {
          let totalBytes = 0;
          for (const f of contextFiles) {
            try {
              const stat = await vscode.workspace.fs.stat(
                vscode.Uri.joinPath(activeFolders[0].uri, f.path)
              );
              totalBytes += stat.size;
            } catch {}
          }
          if (totalBytes / 3.5 > sizeData.context_size * 0.7) useRLM = true;
        }
      } catch (e) { console.error("RLM check failed:", e); }
    }

    // ── Workspace Structure Briefing ─────────────────────────────
    result.text = `# 🏢 SOVEREIGN WORKSPACE STRUCTURE\n`;
    result.text += `You are operating in a multi-root VS Code environment with ${activeFolders.length} independent project(s).\n\n`;

    result.text += `### 🌐 HOW TO INTERACT\n`;
    result.text += `1. **Addressing**: Always refer to files using the full namespaced path: \`ProjectName/path/to/file.ext\`.\n`;
    result.text += `2. **Partial Vision**: The user has selected **${contextFiles.length}** file(s) for your primary context. You can see the full structure in the tree, but you only "possess" the code for specific files.\n`;
    result.text += `3. **Expansion**: If you see a file in the tree that you need to read but its content is missing below, you MUST use the \`<add_files_to_context>\` tag (or \`read_file\` tool in Agent Mode) to request it. Do NOT guess the implementation.\n\n`;

    result.text += `### 🏷️ CONTEXT MARKERS (LEGEND)\n`;
    result.text += `- **\`[C]\` (Content Loaded)**: The full source code of this file is available in the 'LOADED FILE CONTENTS' section below.\n`;
    result.text += `- **\`[D]\` (Definitions Only)**: Only the class/function signatures are loaded. High-level structure is known, but logic is hidden.\n`;
    result.text += `- **(No Marker)**: The file is visible in the structure, but its content is completely **HIDDEN** from your current memory.\n\n`;

    // ── Skills (global, shown once) ─────────────────────────────
    const discussionSkillIds = options?.importedSkillIds || [];
    const projectSkillIds = await this.getActiveProjectSkills();
    const allSkillIds = Array.from(new Set([...discussionSkillIds, ...projectSkillIds]));

    if (this.skillsManager && allSkillIds.length > 0) {
      await this.skillsManager.getSkills(); // ensure cache refreshed
      const skills = await this.skillsManager.getSkills();
      result.skillsContent = "";
      for (const skill of skills) {
        if (allSkillIds.includes(skill.id)) {
          result.importedSkills.push(skill);
          const scopeLabel = skill.scope === 'global' ? 'GLOBAL' : 'PROJECT';
          const cleanName = skill.name.replace(/SOURCE OF TRUTH:\s*/gi, '').trim();
          result.skillsContent += `\n#### 💎 SOURCE OF TRUTH: ${cleanName.toUpperCase()} (${scopeLabel} SKILL)\n`;
          result.skillsContent += `> ${skill.description}\n`;
          result.skillsContent += `\`\`\`${skill.language || 'text'}\n${skill.content}\n\`\`\`\n\n`;
        }
      }
      if (result.skillsContent) {
        result.text += `## 🎓 ACTIVE SKILLS\n${result.skillsContent}---\n\n`;
      }
    }

    // ── Diagrams (global, shown once) ───────────────────────────
    const activeDiagramIds = options?.activeDiagramIds || [];
    if (activeDiagramIds.length > 0 && this.codeGraphManager) {
      if (this.codeGraphManager.getGraphData().nodes.length === 0 && this.codeGraphManager.getBuildState() === 'idle') {
        await this.codeGraphManager.buildGraph();
      }
      result.diagrams = [];
      for (const diagType of activeDiagramIds) {
        if (diagType === 'text_summary') {
          result.text += `\n### PROJECT ARCHITECTURE SUMMARY\n\`\`\`yaml\n${this.codeGraphManager.generateTextSummary()}\n\`\`\`\n\n`;
        } else {
          result.diagrams.push({ type: diagType, mermaid: this.codeGraphManager.generateMermaid(diagType) });
        }
      }
    }

    // ── Per-project blocks ──────────────────────────────────────
    for (const folder of activeFolders) {
      if (signal?.aborted) throw new Error("Operation cancelled");

      const settings = folderSettings[folder.uri.toString()] || { tree: true, content: true };
      if (isGlobalMuted || (!settings.tree && !settings.content)) continue;

      const projectName = folder.name;

      result.text += `${'#'.repeat(50)}\n`;
      result.text += `## 🏗️ PROJECT: ${projectName.toUpperCase()}\n`;
      result.text += `${'#'.repeat(50)}\n\n`;

      // ── A. Per-project TREE ──────────────────────────────────
      if (includeTree && settings.tree !== false) {
        const isolatedTree = await this.generateIsolatedProjectTree(folder, signal, options?.capabilities);
        result.text += `### 🌳 ${projectName.toUpperCase()} — FILE STRUCTURE\n`;
        result.text += isolatedTree + '\n';
        // Also accumulate for agents that read result.projectTree
        result.projectTree += `### ${projectName}\n${isolatedTree}\n`;
      } else if (settings.tree === false) {
        result.text += `*(Tree hidden for ${projectName} by Workspace Access Matrix)*\n\n`;
      }

      // ── B. Per-project FILE CONTENTS ────────────────────────
      if (settings.content === false) {
        result.text += `*(File contents hidden for ${projectName} by Workspace Access Matrix)*\n\n`;
        continue;
      }

      result.text += `### 📄 ${projectName.toUpperCase()} — LOADED FILE CONTENTS\n\n`;

      if (useRLM) {
        result.text += `> **Long Context Mode (RLM):** Context limit approaching. File contents are hidden.\n`;
        result.text += `> Use \`read_file\` to inspect specific files, \`search_files\` to locate code.\n\n`;
      } else {
        let projectContentBuffer = "";
        let filesInThisFolderCount = 0;

        // Use the contextFiles list (73 files in your case) and filter by ownership
        for (const fileEntry of contextFiles) {
          if (signal?.aborted) throw new Error("Operation cancelled");

          // CRITICAL: Use the existing resolver to handle namespacing/roots correctly
          const resolution = await this.resolveWorkspaceFromPath(fileEntry.path);

          // Verify if this file belongs to the CURRENT folder in the project block
          if (!resolution || !resolution.folder || resolution.folder.uri.toString() !== folder.uri.toString()) {
            continue; 
          }

          filesInThisFolderCount++;
          const namespacedPath = fileEntry.path;
          const contextState = fileEntry.state;
          const fileUri = resolution.uri;
          const relativePath = resolution.relativePath;

          // Header matches the "Sovereign" protocol: FolderName/Path
          const headerPath = activeFolders.length > 1 ? `${folder.name}/${relativePath}` : relativePath;

          if (this.contextStateProvider.isStrictlyIgnored(fileUri)) continue;

          try {
            const stat = await vscode.workspace.fs.stat(fileUri);
            if (stat.type !== vscode.FileType.File) continue;

            const languageId = this.getLanguageId(relativePath);
            const ext = path.extname(relativePath).toLowerCase();
            const cacheKey = headerPath;

            if (this.binaryExtensions.has(ext)) {
              projectContentBuffer += `\`\`\`${languageId}:${headerPath}\n(Binary file content excluded)\n\`\`\`\n\n`;
              continue;
            }

            if (contextState === 'definitions-only') {
              const definitions = await this.extractDefinitions(fileUri);
              projectContentBuffer += `\`\`\`${languageId}:${headerPath} (Definitions Only)\n${definitions}\n\`\`\`\n\n`;
              continue;
            }

            let fileContent = '';
            const cached = this._fileContentCache.get(cacheKey);
            const openDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === fileUri.toString());

            // If the document is open in VS Code, ALWAYS use the editor content to ensure
            // the AI sees what the user sees, even before saving.
            if (openDoc) {
                fileContent = openDoc.getText();
            } else if (cached && cached.state === contextState) {
                fileContent = cached.content;
            } else {
              let fileBuffer: Buffer;
              if (openDoc) {
                fileBuffer = Buffer.from(openDoc.getText(), 'utf8');
              } else {
                const fileBytes = await vscode.workspace.fs.readFile(fileUri);
                fileBuffer = Buffer.from(fileBytes);
              }

              if (this.imageExtensions.has(ext)) {
                if (!enableVision) {
                  projectContentBuffer += `### \`${headerPath}\` (Image Muted — Vision Disabled)\n\n`;
                  continue;
                }
                const base64Data = fileBuffer.toString('base64');
                let mime = ext.substring(1).replace('jpg', 'jpeg');
                if (ext === '.svg') mime = 'svg+xml';

                // Ensure data URI format is standard
                const dataUri = `data:image/${mime};base64,${base64Data}`;

                result.images.push({ filePath: headerPath, data: dataUri });
                projectContentBuffer += `### \`${headerPath}\` (Image Attached)\n\n`;
                continue;
              }

              if (this.isBinary(fileBuffer)) {
                projectContentBuffer += `\`\`\`${languageId}:${headerPath}\n(Binary content detected and excluded)\n\`\`\`\n\n`;
                continue;
              }

              if (this.docExtensions.has(ext)) {
                fileContent = await this.processFile(relativePath, fileBuffer.toString('base64'), result.images);
              } else if (ext === '.ipynb') {
                const notebookJson = JSON.parse(fileBuffer.toString('utf8'));
                if (notebookJson.cells && Array.isArray(notebookJson.cells)) {
                    notebookJson.cells.forEach((cell: any, index: number) => {
                        const source = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
                        if (cell.cell_type === 'code') fileContent += `--- Cell ${index + 1} (code) ---\n\`\`\`python\n${source}\n\`\`\`\n\n`;
                        else if (cell.cell_type === 'markdown') fileContent += `--- Cell ${index + 1} (markdown) ---\n${source}\n\n`;
                    });
                }
              } else {
                fileContent = fileBuffer.toString('utf8');
              }

              if (fileContent.length < 500000) {
                this._fileContentCache.set(cacheKey, { content: fileContent, state: contextState });
              }
            }

            projectContentBuffer += `\`\`\`${languageId}:${headerPath}\n${fileContent}\n\`\`\`\n\n`;

          } catch (error) {
            projectContentBuffer += `### ${headerPath}\n\n⚠️ **Error reading project file:** ${error}\n\n`;
          }
        }

        if (filesInThisFolderCount === 0) {
          result.text += `*(No file contents currently loaded for ${projectName}.)*\n\n`;
        } else {
          result.text += projectContentBuffer;
          result.selectedFilesContent += `## Project: ${projectName}\n${projectContentBuffer}`;
        }
      }
    }

    this._lastContext = result;
    return result;
  }

  // ─────────────────────────────────────────────────────────────
  // FILE OPERATIONS
  // ─────────────────────────────────────────────────────────────

  private async extractDefinitions(uri: vscode.Uri): Promise<string> {
    try {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri);
      if (!symbols || symbols.length === 0) return "(No definitions found)";

      const formatSymbol = (symbol: vscode.DocumentSymbol, indent: string = ''): string => {
        const kindMap: { [key: number]: string } = {
          [vscode.SymbolKind.Class]: 'class', [vscode.SymbolKind.Method]: 'method',
          [vscode.SymbolKind.Function]: 'function', [vscode.SymbolKind.Constructor]: 'constructor',
          [vscode.SymbolKind.Interface]: 'interface', [vscode.SymbolKind.Enum]: 'enum',
          [vscode.SymbolKind.Variable]: 'variable', [vscode.SymbolKind.Constant]: 'constant',
          [vscode.SymbolKind.Property]: 'property', [vscode.SymbolKind.Struct]: 'struct'
        };
        const kindName = kindMap[symbol.kind] || 'symbol';
        const significantKinds = [
          vscode.SymbolKind.Class, vscode.SymbolKind.Method, vscode.SymbolKind.Function,
          vscode.SymbolKind.Interface, vscode.SymbolKind.Enum, vscode.SymbolKind.Constructor,
          vscode.SymbolKind.Struct
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

  public async getWorkspaceFilePaths(selectedFolders?: string[]): Promise<string[]> {
    if (!this.contextStateProvider) return [];
    const allFiles = await this.contextStateProvider.getAllVisibleFiles();
    if (!selectedFolders || selectedFolders.length === 0) return allFiles;

    const activeFolderPaths = (vscode.workspace.workspaceFolders || [])
      .filter(f => selectedFolders.includes(f.uri.toString()))
      .map(f => f.uri.fsPath);

    return allFiles.filter(f => {
      const fullPath = path.isAbsolute(f) ? f : path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, f);
      return activeFolderPaths.some(root => fullPath.startsWith(root));
    });
  }

  public async readSpecificFiles(filePaths: string[]): Promise<string> {
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length === 0 || !filePaths || filePaths.length === 0) return '';

    let content = '';
    for (const filePath of filePaths) {
      try {
        let fullPath: vscode.Uri | undefined;
        const normalizedPath = filePath.replace(/\\/g, '/');
        const segments = normalizedPath.split('/');

        for (const folder of folders) {
          const uriDirect = vscode.Uri.joinPath(folder.uri, normalizedPath);
          const uriStripped = (segments[0] === folder.name && segments.length > 1)
            ? vscode.Uri.joinPath(folder.uri, segments.slice(1).join('/'))
            : null;

          try {
            await vscode.workspace.fs.stat(uriDirect);
            fullPath = uriDirect; break;
          } catch {
            if (uriStripped) {
              try { await vscode.workspace.fs.stat(uriStripped); fullPath = uriStripped; break; } catch {}
            }
          }
        }

        if (!fullPath) continue;
        const stat = await vscode.workspace.fs.stat(fullPath);
        if (stat.type !== vscode.FileType.File) continue;

        const ext = path.extname(filePath).toLowerCase();
        if (this.binaryExtensions.has(ext)) continue;

        let text = '';
        const openDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === fullPath.toString());
        if (openDoc) {
          text = openDoc.getText();
        } else {
          const fileBytes = await vscode.workspace.fs.readFile(fullPath);
          const buffer = Buffer.from(fileBytes);
          if (this.isBinary(buffer)) continue;
          text = buffer.toString('utf8');
        }
        content += `\`\`\`${this.getLanguageId(filePath)}:${filePath}\n${text}\n\`\`\`\n\n`;
      } catch (error) {}
    }
    return content;
  }

  public async processFile(
    fileName: string,
    base64Data: string,
    imagesOut?: { filePath: string; data: string }[],
    mode?: string
  ): Promise<string> {
    const ext = path.extname(fileName).toLowerCase();
    const buffer = Buffer.from(base64Data, 'base64');

    if (this.binaryExtensions.has(ext)) return `(Binary file ${fileName} content excluded)`;

    if (ext === '.pdf' || this.docExtensions.has(ext)) {
      try {
        if (ext === '.pdf') {
          try { return await this.lollmsAPI.extractText(base64Data, fileName); }
          catch (e) { return await this.parsePdfLocal(buffer); }
        }
        return await this.lollmsAPI.extractText(base64Data, fileName);
      } catch (apiError: any) {
        if (ext === '.docx') return await this.parseDocxLocal(buffer);
        return `⚠️ **Error processing document:** ${(apiError as Error).message}`;
      }
    } else if (ext === '.ipynb') {
      try {
        const notebookJson = JSON.parse(buffer.toString('utf8'));
        let fileContent = '';
        if (notebookJson.cells && Array.isArray(notebookJson.cells)) {
          notebookJson.cells.forEach((cell: any, index: number) => {
            const source = Array.isArray(cell.source) ? cell.source.join('') : '';
            if (cell.cell_type === 'code') fileContent += `--- Cell ${index + 1} (code) ---\n\`\`\`python\n${source}\n\`\`\`\n\n`;
            else if (cell.cell_type === 'markdown') fileContent += `--- Cell ${index + 1} (markdown) ---\n${source}\n\n`;
          });
        }
        return fileContent;
      } catch (e: any) { return `⚠️ **Error parsing Jupyter Notebook:** ${e.message}`; }
    } else {
      if (this.isBinary(buffer)) return `(Binary content detected in ${fileName} and excluded)`;
      return buffer.toString('utf8');
    }
  }

  private async parsePdfLocal(buffer: Buffer): Promise<string> {
    try { const data = await pdfParse(buffer); return data.text; }
    catch (e) { return `[Local PDF Parse Failed: ${e}]`; }
  }

  private async parseDocxLocal(buffer: Buffer): Promise<string> {
    try { const result = await mammoth.extractRawText({ buffer }); return result.value; }
    catch (e) { return `[Local DOCX Parse Failed: ${e}]`; }
  }

  // ─────────────────────────────────────────────────────────────
  // SEARCH UTILITIES
  // ─────────────────────────────────────────────────────────────

  public async searchWorkspaceContent(
    query: string,
    options: { matchCase: boolean, wholeWord: boolean, include?: string, exclude?: string, literal?: boolean } = { matchCase: false, wholeWord: false },
    signal?: AbortSignal
  ): Promise<{ path: string, snippet: string, line?: string }[]> {
    const results: { path: string, snippet: string, line?: string }[] = [];
    const maxResults = 100;
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return [];

    const cwd = workspaceFolder.uri.fsPath;
    try {
      let stdout = "";
      try {
        let gitGrepArgs = `-n -I --max-count=3 --context=0`;
        if (!options.matchCase) gitGrepArgs += ` -i`;
        if (options.wholeWord) gitGrepArgs += ` -w`;
        if (options.literal) gitGrepArgs += ` -F`;

        let patternArgs = "";
        if (options.literal) {
          patternArgs = `-e "${query.replace(/"/g, '\\"')}"`;
        } else {
          const orParts = query.split('|').map(p => p.trim()).filter(p => p);
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
        }

        let pathspec = "";
        if (options.include) pathspec += options.include.split(',').map(p => `"${p.trim()}"`).join(' ');
        if (options.exclude) pathspec += " " + options.exclude.split(',').map(p => `":!${p.trim()}"`).join(' ');
        const res = await execAsync(`git grep ${gitGrepArgs} ${patternArgs} -- ${pathspec}`, { cwd, maxBuffer: 1024 * 1024 });
        stdout = res.stdout;
      } catch (e) {
        const isWin = process.platform === 'win32';
        const pattern = query.replace(/"/g, '\\"');
        let command = isWin
          ? `findstr /S /N /L${!options.matchCase ? ' /I' : ''} /C:"${pattern}" *`
          : `grep -r -n -I -m 1 -F${!options.matchCase ? ' -i' : ''}${options.wholeWord ? ' -w' : ''} "${pattern}" .`;
        try { const res = await execAsync(command, { cwd, maxBuffer: 1024 * 1024 }); stdout = res.stdout; } catch {}
      }

      if (stdout.trim()) {
        for (const line of stdout.split('\n')) {
          if (results.length >= maxResults) break;
          const parts = line.split(':');
          if (parts.length >= 3) {
            const snippet = parts.slice(2).join(':').trim();
            results.push({
              path: parts[0].trim(), line: parts[1].trim(),
              snippet: snippet.length > 200 ? snippet.substring(0, 200) + "..." : snippet
            });
          }
        }
      }
    } catch (e) { console.error("Content search failed", e); }
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
          if (stdout.trim()) { combinedResults += `\nMatches for "${keyword}" (count per file):\n${stdout.trim()}\n`; continue; }
        } catch (e) {}
        const command = os.platform() === 'win32'
          ? `findstr /S /N /I /P "${pattern}" *`
          : `grep -r -n -I -l "${pattern}" .`;
        const { stdout } = await execAsync(command, { cwd });
        combinedResults += stdout.trim()
          ? `\nMatches for "${keyword}":\n${stdout.trim().substring(0, 2000)}\n`
          : `\nMatches for "${keyword}": No matches found.\n`;
      } catch (e) {
        combinedResults += `\nMatches for "${keyword}": Search operation failed.\n`;
      }
    }
    return combinedResults;
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
          if (keywords.some(k => content.includes(k))) {
            combined += `\n--- Cached Result (${name}) ---\n${content.substring(0, 2000)}...\n`;
          }
        }
      }
      return combined;
    } catch { return ""; }
  }

  // ─────────────────────────────────────────────────────────────
  // WEB / URL PROCESSING
  // ─────────────────────────────────────────────────────────────

  private sanitizeContent(text: string): string {
    const injectionPatterns = [
      /ignore (all )?previous instructions/gi, /system prompt/gi,
      /you are now a/gi, /new role:/gi, /stop what you are doing/gi, /strictly follow/gi
    ];
    let cleaned = text;
    for (const pattern of injectionPatterns) cleaned = cleaned.replace(pattern, "[REDACTED_POTENTIAL_INJECTION]");
    return cleaned;
  }

  private async distillContent(content: string, url: string, userPrompt: string, signal?: AbortSignal): Promise<string> {
    const distillationPrompt = `You are an Information Distiller. 
I have scraped content from: ${url}
The user is currently asking: "${userPrompt.substring(0, 500)}"
**TASK:** Extract ONLY the information useful for answering the user's request. Refactor into clean, concise markdown. Remove ads, nav menus, boilerplate. Preserve relevant code snippets.
**CONTENT TO DISTILL:**\n${content.substring(0, 20000)}`;
    try {
      return await this.lollmsAPI.sendChat([
        { role: 'system', content: "You are a precise data distillation expert. Output only the distilled content." },
        { role: 'user', content: distillationPrompt }
      ], null, signal);
    } catch (e) { return content; }
  }

  public async processUrl(
    url: string,
    languageCode: string = 'en',
    userPrompt?: string,
    signal?: AbortSignal,
    depth: number = 0,
    visited: Set<string> = new Set()
  ): Promise<{ filename: string, content: string, summary: string }> {
    if (visited.has(url) || depth < 0) return { filename: '', content: '', summary: '' };
    visited.add(url);

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) throw new Error("No workspace folder open.");

    const cacheDir = vscode.Uri.joinPath(workspaceFolder.uri, '.lollms', 'web_cache');
    try { await vscode.workspace.fs.createDirectory(cacheDir); } catch (e) {}

    let rawContent = "";

    if (url.includes('arxiv.org')) {
      try {
        const idMatch = url.match(/abs\/([0-9.]+)/) || url.match(/pdf\/([0-9.]+)/);
        if (idMatch) {
          const res = await fetch(`http://export.arxiv.org/api/query?id_list=${idMatch[1]}`);
          const xml = await res.text();
          const title = xml.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() || "Unknown Title";
          const summary = xml.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() || "No summary.";
          rawContent = `[ArXiv Paper] ${url}\n\nTitle: ${title}\n\n### Abstract:\n${summary}`;
        } else { rawContent = `Could not parse ArXiv ID from ${url}`; }
      } catch (e) { rawContent = `ArXiv fetch error: ${e}`; }
    } else if (url.includes('wikipedia.org')) {
      try {
        const titlePart = url.split('/wiki/')[1] || url.split('/').pop() || "";
        const api = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exlimit=1&titles=${titlePart}&explaintext=1&format=json`;
        const res = await fetch(api);
        const json: any = await res.json();
        const pages = json.query?.pages;
        const pageId = Object.keys(pages)[0];
        if (pageId && pageId !== "-1") {
          rawContent = `[Wikipedia] ${pages[pageId].title}\nSource: ${url}\n\n${pages[pageId].extract}`;
        } else throw new Error("Page not found");
      } catch (e) {}
    }

    if (!rawContent) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Lollms VS Coder)' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        rawContent = html
          .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gim, "")
          .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gim, "")
          .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      } catch (e: any) { throw new Error(`Failed to scrape ${url}: ${e.message}`); }
    }

    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    let processedContent = rawContent;
    if (config.get<boolean>('antiPromptInjection') ?? true) processedContent = this.sanitizeContent(processedContent);
    if ((config.get<boolean>('distillWebResults') ?? true) && userPrompt) {
      processedContent = await this.distillContent(processedContent, url, userPrompt, signal);
    }

    const urlObj = new URL(url);
    const safeName = (urlObj.hostname + urlObj.pathname).replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
    const filename = `web_${safeName}.md`;
    const maxChars = 120000;
    if (processedContent.length > maxChars) {
      processedContent = `[DATA TOO LARGE - TRUNCATED]\n\n${processedContent.substring(0, maxChars)}\n\n... (30,000 token limit reached)`;
    }

    const fileUri = vscode.Uri.joinPath(cacheDir, filename);
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(`# Source: ${url}\n# Date: ${new Date().toISOString()}\n\n${processedContent}`, 'utf8'));

    const relativePath = path.join('.lollms', 'web_cache', filename);
    await this.contextStateProvider?.addFilesToContext([relativePath]);

    if (depth > 0) {
      const linkRegex = /href=["'](https?:\/\/[^"']+)["']/g;
      const origin = new URL(url).origin;
      const internalLinks: string[] = [];
      let match;
      while ((match = linkRegex.exec(rawContent)) !== null) {
        if (match[1].startsWith(origin) && !visited.has(match[1])) internalLinks.push(match[1]);
      }
      for (const link of internalLinks.slice(0, 5)) {
        if (signal?.aborted) break;
        await this.processUrl(link, languageCode, userPrompt, signal, depth - 1, visited);
      }
    }

    return { filename: relativePath, content: rawContent, summary: rawContent.substring(0, 200) + "..." };
  }

  public async searchWebInfo(action: string, query: string, signal?: AbortSignal): Promise<any[]> {
    const results: any[] = [];
    try {
      if (action === 'google') {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const apiKey = config.get<string>('searchApiKey');
        const cx = config.get<string>('searchCx');
        if (!apiKey || !cx) throw new Error("Google Search not configured in Settings.");
        const res = await fetch(`https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(query)}`, { timeout: 10000 } as any);
        const data: any = await res.json();
        return (data.items || []).map((i: any) => ({ title: i.title, url: i.link, snippet: i.snippet }));
      } else if (action === 'ddg') {
        const res = await fetch(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const html = await res.text();
        const linkRegex = /<a class="result__a" rel="noopener" href="([^"]+)">([^<]+)<\/a>/g;
        let m;
        while ((m = linkRegex.exec(html)) !== null && results.length < 5) results.push({ title: m[2], url: m[1], snippet: "" });
        return results;
      } else if (action === 'wiki') {
        const res = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`, { timeout: 8000 } as any);
        const data: any = await res.json();
        if (data.query?.search) {
          return data.query.search.map((i: any) => ({
            title: i.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(i.title)}`,
            snippet: i.snippet.replace(/<[^>]+>/g, '')
          }));
        }
      } else if (action === 'arxiv') {
        const res = await fetch(`http://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&max_results=5`);
        const txt = await res.text();
        const titles = [...txt.matchAll(/<title>([\s\S]*?)<\/title>/g)].map(m => m[1].trim()).slice(1);
        const ids = [...txt.matchAll(/<id>([\s\S]*?)<\/id>/g)].map(m => m[1].trim()).slice(1);
        const summaries = [...txt.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map(m => m[1].trim().substring(0, 200));
        return titles.map((t, i) => ({ title: t, url: ids[i], snippet: summaries[i] }));
      }
    } catch (e) { console.error(`Search failed for ${action}:`, e); }
    return results;
  }

  // ─────────────────────────────────────────────────────────────
  // BRIEFING MANAGEMENT
  // ─────────────────────────────────────────────────────────────

  private updateBriefingData(discussion: any, action: 'add' | 'amend', id: string, content: string) {
    if (!discussion) return;
    let entries: Record<string, string> = {};
    const raw = (discussion.discussion_data_zone || "").trim();
    try {
      if (raw.startsWith('{')) entries = JSON.parse(raw);
      else if (raw.length > 0) entries = { "analysis": raw };
    } catch { entries = {}; }
    entries[id] = content.trim();
    discussion.discussion_data_zone = JSON.stringify(entries, null, 2);
    vscode.commands.executeCommand('lollms-vs-coder.refreshDiscussions');
  }

  public renderBriefing(discussion: any): string {
    const fallback = "Librarian is analyzing project state...";
    let briefingText = "";
    try {
      const globalBriefing = this.getGlobalBriefing();
      if (globalBriefing) briefingText += `**[GLOBAL CONSTRAINTS]**\n${globalBriefing}\n\n`;
    } catch (e) {}

    if (!discussion?.discussion_data_zone) return (briefingText + fallback).trim();
    try {
      const raw = discussion.discussion_data_zone.trim();
      if (!raw.startsWith('{')) { briefingText += `**[LOCAL CONSTRAINTS]**\n${raw}`; return briefingText.trim(); }
      const entries = JSON.parse(raw);
      const keys = Object.keys(entries);
      if (keys.length === 0) return (briefingText + fallback).trim();
      const entriesText = keys.map(id => `**[${id.replace(/_/g, ' ').toUpperCase()}]**\n${entries[id]}`).join('\n\n');
      return (briefingText + entriesText).trim();
    } catch { return (briefingText + (discussion.discussion_data_zone || fallback)).trim(); }
  }

  // ─────────────────────────────────────────────────────────────
  // SKILL SELECTION AGENT
  // ─────────────────────────────────────────────────────────────

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
      const spinnerHtml = finished
        ? `<div class="status-line"><span class="codicon codicon-check" style="color:var(--vscode-charts-green)"></span> <span>Library Optimized</span></div>`
        : `<div class="status-line"><div class="spinner"></div> <span>Searching Library (Step ${step + 1}): ${status}</span></div>`;
      onUpdate(`**💡 Auto-Skill Agent**\n\n${spinnerHtml}\n\n${scratchpadHtml}\n\n${skillsTree}\n\n${logSection}`);
    };

    const systemPrompt = `You are the Expert Librarian Agent for the LoLLMs Skills Library.
Your goal is to optimize the AI's "Skill Context" by selecting specific documentation, protocols, or code patterns from the library that are relevant to the user's request.

### 📚 LIBRARIAN PROTOCOL
1. **Analyze**: Identify the tech stack, library APIs, or complex patterns in the request.
2. **Search**: Use tools to find skills you aren't sure about.
3. **Verify**: Read skill content before adding it.
4. **Finalize**: Use \`select_skills\` to update the active list.

**AVAILABLE TOOLS:**
1. \`get_skill_catalog()\`: Returns all available skill IDs, names, and categories.
2. \`read_skill_details(id="id")\`: Returns full content of a specific skill.
3. \`search_library(query="term")\`: Keyword search across skill names and descriptions.
4. \`select_skills(add=["id1"], remove=["id2"])\`: Add/remove skills from active context.
5. \`done()\`: Finish optimization.

**OUTPUT FORMAT**: JSON object only.
\`\`\`json
{ "scratchpad": "reasoning...", "tool": "tool_name", "params": { ... } }
\`\`\``;

    const fullContext = await this.getContextContent({ includeTree: true, modelName: model, signal });
    let chatHistory: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `# PROJECT CONTEXT\n${fullContext.projectTree}\n${fullContext.selectedFilesContent.substring(0, 5000)}...\n\n**USER REQUEST:** "${userPrompt}"\n**CURRENTLY ACTIVE SKILLS:** ${JSON.stringify(Array.from(selectedIds))}` }
    ];

    renderUpdate("Initializing search...");

    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal.aborted) break;
      const response = await this.lollmsAPI.sendChat(chatHistory, null, signal, model);
      chatHistory.push({ role: 'assistant', content: response });

      const cleanResponse = stripThinkingTags(response);
      const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { actionLog.push("❌ Failed to parse response."); break; }

      try {
        const toolCall = JSON.parse(jsonMatch[0]);
        if (toolCall.scratchpad) cumulativeBrain += `\n- ${toolCall.scratchpad}`;

        const actionFingerprint = JSON.stringify({ tool: toolCall.tool, params: toolCall.params });
        if (executedActions.has(actionFingerprint) && toolCall.tool !== 'done') {
          chatHistory.push({ role: 'system', content: "LOOP DETECTED: You already called this tool with these parameters. Move forward or call 'done'." });
          continue;
        }
        executedActions.add(actionFingerprint);

        if (toolCall.tool === 'done') { renderUpdate("Complete", true, step); break; }

        if (toolCall.tool === 'get_skill_catalog') {
          const catalog = allSkills.map(s => ({ id: s.id, name: s.name, category: s.category }));
          chatHistory.push({ role: 'system', content: `LIBRARY CATALOG:\n${JSON.stringify(catalog, null, 2)}` });
          actionLog.push("📖 Retrieved full skill catalog.");
          renderUpdate("Reviewing catalog...", false, step);
        } else if (toolCall.tool === 'read_skill_details') {
          const skill = allSkills.find(s => s.id === toolCall.params.id);
          if (skill) {
            chatHistory.push({ role: 'system', content: `SKILL CONTENT (${skill.id}):\n${skill.content}` });
            actionLog.push(`🔍 Inspected skill: **${skill.name}**`);
            renderUpdate(`Reading ${skill.name}...`, false, step);
          } else { chatHistory.push({ role: 'system', content: "Error: Skill ID not found." }); }
        } else if (toolCall.tool === 'search_library') {
          const query = toolCall.params.query.toLowerCase();
          const matches = allSkills.filter(s =>
            s.name.toLowerCase().includes(query) ||
            s.description.toLowerCase().includes(query) ||
            s.category?.toLowerCase().includes(query)
          ).map(s => ({ id: s.id, name: s.name, description: s.description }));
          chatHistory.push({ role: 'system', content: `SEARCH RESULTS for "${query}":\n${JSON.stringify(matches, null, 2)}` });
          actionLog.push(`🔎 Searched library for: "${query}" (${matches.length} matches)`);
          renderUpdate("Filtering results...", false, step);
        } else if (toolCall.tool === 'select_skills') {
          const toAdd = toolCall.params.add || [];
          const toRemove = toolCall.params.remove || [];
          toAdd.forEach((id: string) => selectedIds.add(id));
          toRemove.forEach((id: string) => selectedIds.delete(id));
          actionLog.push(`✅ Updated selection: +${toAdd.length} / -${toRemove.length} skills.`);
          renderUpdate("Updating selection...", false, step);
        }
      } catch (e: any) { actionLog.push(`❌ Tool execution failed: ${e.message}`); }
    }

    renderUpdate("Optimization complete.", true, MAX_STEPS);
    return Array.from(selectedIds);
  }

  // ─────────────────────────────────────────────────────────────
  // WEB RESEARCH AGENT
  // ─────────────────────────────────────────────────────────────

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
    const apiKey = config.get<string>('searchApiKey');
    const cx = config.get<string>('searchCx');
    const searchProvider = config.get<string>('searchProvider') || 'google_custom_search';
    const canGoogle = searchProvider === 'google_custom_search' && !!apiKey && !!cx;

    const systemPrompt = `You are the **Web Research Specialist**.
Your goal is to acquire external knowledge (documentation, library APIs, recent bug fixes) missing from the local project.

### 📜 THE RESEARCHER'S CONSTITUTION
1. **NO REDUNDANCY**: Do not search for information already in "EXISTING PROJECT CONTEXT" or "SHARED TEAM BRIEFING".
2. **DISTILLATION**: Extract only parts relevant to the user's request.
3. **REPORTING**: Use \`add_briefing_entry\` to record findings.
4. **BELIEF CORRECTION**: Use \`amend_briefing_entry\` if a previous assumption was wrong.

**TEAM COORDINATION TOOLS:**
1. \`add_briefing_entry(id="unique_id", info="technical details")\`
2. \`amend_briefing_entry(id="existing_id", info="updated details")\`
3. \`summon_specialist(agent="librarian|skills", reason="why")\`

**RESEARCH TOOLS:**
4. \`plan_searches(queries=[{"provider": "google|arxiv|wikipedia|stackoverflow", "q": "query"}])\`
5. \`read_and_add(urls=["url1", "url2"])\`
6. \`done()\`

**OUTPUT FORMAT**: JSON only
\`\`\`json
{ "tool": "tool_name", "params": { ... } }
\`\`\``;

    const fullContext = await this.getContextContent({ includeTree: true, modelName: model, signal });
    const sharedKnowledge = this.renderBriefing(discussion);
    const actionLog: string[] = [];
    const foundResults: { url: string, title: string, provider: string }[] = [];
    const addedSources: { url: string, title: string }[] = [];

    const chatHistory: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `# EXISTING PROJECT CONTEXT\n${fullContext.projectTree}\n${fullContext.selectedFilesContent}\n\n# SHARED KNOWLEDGE\n${sharedKnowledge}\n\n**USER REQUEST:** "${userPrompt}"\nGoogle Available: ${canGoogle}` }
    ];

    const renderUpdate = (status: string, finished: boolean = false) => {
      const logHtml = actionLog.map(l => `<div class="agent-log-item" style="font-size:0.85em; margin-bottom:2px;">${l}</div>`).join('');
      const logSection = actionLog.length > 0
        ? `<details ${finished ? '' : 'open'} style="margin-top:10px;"><summary>🌍 Research Activity</summary><div class="agent-log-container" style="padding:8px;background:var(--vscode-editor-inactiveSelectionBackground);border-radius:4px;max-height:150px;overflow-y:auto;">${logHtml}</div></details>`
        : '';
      const foundHtml = foundResults.length > 0
        ? `<details open style="margin-top:10px;"><summary>🔍 Found Links (${foundResults.length})</summary><div style="padding:8px;border:1px solid var(--vscode-widget-border);border-radius:4px;">${foundResults.map(r => `<div style="font-size:0.9em;margin-bottom:4px;"><span style="opacity:0.7;font-size:0.8em;width:80px;display:inline-block;">[${r.provider}]</span><a href="${r.url}">${r.url}</a></div>`).join('')}</div></details>`
        : '';
      const sourcesHtml = addedSources.length > 0
        ? `<details open style="margin-top:10px;"><summary>📚 <strong>Added to Context (${addedSources.length})</strong></summary><ul class="file-list-tree" style="list-style:none;padding-left:5px;">${addedSources.map(s => `<li>📑 <span style="font-weight:600;">${s.title}</span><br><span style="font-size:0.8em;opacity:0.7;">${s.url}</span></li>`).join('')}</ul></details>`
        : '';
      const spinnerHtml = finished
        ? `<div class="status-line"><span class="codicon codicon-check" style="color:var(--vscode-charts-green)"></span> <span style="font-weight:600;">Research Complete</span></div>`
        : `<div class="status-line"><div class="spinner"></div> <span style="font-weight:600;">${status}</span></div>`;
      const currentBriefing = this.renderBriefing(discussion);
      const briefingHtml = `<div class="technical-briefing-card"><div class="briefing-header"><span class="codicon codicon-note"></span> Team Technical Briefing</div><div class="briefing-content">${currentBriefing.replace(/\n/g, '<br>')}</div></div>`;
      onUpdate(`**🌍 Web Research Agent**\n\n${spinnerHtml}\n\n${briefingHtml}\n\n${foundHtml}\n\n${sourcesHtml}\n\n${logSection}`);
    };

    chatHistory.push({ role: 'system', content: `SHARED TEAM KNOWLEDGE:\n${sharedKnowledge}` });
    renderUpdate("Analyzing request...");

    for (let steps = 0; steps < 5; steps++) {
      if (signal.aborted) break;
      let response = "";
      try { response = await this.lollmsAPI.sendChat(chatHistory, null, signal, model); }
      catch (e: any) { actionLog.push(`❌ LLM Error: ${e.message}`); renderUpdate("Error", true); break; }

      chatHistory.push({ role: 'assistant', content: response });
      const cleanResponse = stripThinkingTags(response);
      const jsonMatch = cleanResponse.match(/```json\s*([\s\S]+?)\s*```/) || cleanResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { actionLog.push("🛑 Output format invalid, stopping."); break; }

      try {
        const toolCall = JSON.parse(jsonMatch[1] || jsonMatch[0]);
        const toolName = toolCall.tool;
        const params = toolCall.params || {};

        if (toolName === 'done') { renderUpdate("Finished", true); break; }

        if (toolName === 'add_briefing_entry' || toolName === 'amend_briefing_entry') {
          this.updateBriefingData(discussion, toolName === 'add_briefing_entry' ? 'add' : 'amend', params.id, params.info);
          actionLog.push(`📝 **Briefing Updated**: ${params.id}`);
          chatHistory.push({ role: 'system', content: "SUCCESS: Briefing entry updated." });
          renderUpdate("Updating Knowledge Base...");
          continue;
        }

        if (toolName === 'summon_specialist') {
          actionLog.push(`📣 **Summoning ${params.agent}**: ${params.reason}`);
          if (params.agent === 'librarian') await this.runContextAgent(params.reason, model, signal, onUpdate, onOverlayUpdate, undefined, 'collaborative', discussion, fullHistory);
          else if (params.agent === 'skills') await this.runSkillSelectionAgent(params.reason, model, signal, [], onUpdate, discussion);
          chatHistory.push({ role: 'system', content: `Specialist ${params.agent} has finished.` });
          continue;
        }

        if (toolName === 'plan_searches') {
          const queries = params.queries || [];
          if (searchInCache) {
            const cacheHits = await this.searchLocalCache(userPrompt, signal);
            if (cacheHits) {
              actionLog.push(`📦 Found relevant data in local cache.`);
              chatHistory.push({ role: 'system', content: `LOCAL CACHE HITS:\n${cacheHits}\n\nIf this answers the prompt, call 'done'. Otherwise proceed with searches.` });
            }
          }
          if (!Array.isArray(queries) || queries.length === 0) { actionLog.push("⚠️ No queries provided."); continue; }

          actionLog.push(`🔍 Searching via: **${Array.from(new Set(queries.map((q: any) => q.provider))).join(', ')}**`);
          renderUpdate("Searching...");

          const searchPromises = queries.map(async (q: any) => {
            const provider = q.provider;
            const query = q.q;
            try {
              let result = "";
              if (provider === 'google') {
                if (!canGoogle) return `[Google Skipped - No Key]`;
                const res = await fetch(`https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(query)}`);
                const data: any = await res.json();
                if (data.items) result = data.items.map((i: any) => { foundResults.push({ url: i.link, title: i.title, provider: 'Google' }); return `[${i.title}](${i.link}): ${i.snippet}`; }).join('\n');
                else result = "No results.";
              } else if (provider === 'arxiv') {
                const res = await fetch(`http://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&start=0&max_results=3`);
                const txt = await res.text();
                const titles = [...txt.matchAll(/<title>([\s\S]*?)<\/title>/g)].map(m => m[1].trim()).slice(1);
                const ids = [...txt.matchAll(/<id>([\s\S]*?)<\/id>/g)].map(m => m[1].trim()).slice(1);
                const summaries = [...txt.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map(m => m[1].trim().substring(0, 200));
                result = titles.map((t, i) => { foundResults.push({ url: ids[i], title: t, provider: 'ArXiv' }); return `[${t}](${ids[i]}): ${summaries[i]}...`; }).join('\n');
              } else if (provider === 'wikipedia') {
                const res = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json`);
                const data: any = await res.json();
                if (data.query?.search) result = data.query.search.map((i: any) => { const wUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(i.title)}`; foundResults.push({ url: wUrl, title: i.title, provider: 'Wikipedia' }); return `[${i.title}](${wUrl}): ${i.snippet.replace(/<[^>]+>/g, '')}`; }).join('\n');
              } else if (provider === 'stackoverflow') {
                const res = await fetch(`https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow`);
                const data: any = await res.json();
                if (data.items) result = data.items.map((i: any) => { foundResults.push({ url: i.link, title: i.title, provider: 'StackOverflow' }); return `[${i.title}](${i.link}) (Answered: ${i.is_answered})`; }).join('\n');
              }
              return `### Results for ${provider}: "${query}"\n${result}`;
            } catch (e: any) { return `Error searching ${provider}: ${e.message}`; }
          });

          const results = await Promise.all(searchPromises);
          chatHistory.push({ role: 'system', content: `SEARCH RESULTS:\n${results.join('\n\n')}\n\nNow decide to 'read_and_add' useful links or 'done'.` });
          actionLog.push(`✅ Found ${foundResults.length} URLs.`);
          if (onOverlayUpdate) onOverlayUpdate(`🔍 Found ${foundResults.length} URLs`);

        } else if (toolName === 'read_and_add') {
          const urls = params.urls || [];
          if (urls.length === 0) continue;
          actionLog.push(`📥 Scraping ${urls.length} pages...`);
          renderUpdate("Reading content...");
          const readResults = await Promise.all(urls.map(async (url: string) => {
            try {
              const res = await this.processUrl(url, 'en', userPrompt, signal);
              const fileName = res.filename.split(/[\\/]/).pop() || 'Document';
              addedSources.push({ url, title: fileName });
              return `📖 Added: ${res.filename}`;
            } catch (e: any) { return `❌ Failed: ${url}: ${e.message}`; }
          }));
          chatHistory.push({ role: 'system', content: `Operation results:\n${readResults.join('\n')}` });
        } else {
          actionLog.push(`❓ Unknown tool: ${toolName}`);
        }
      } catch (e: any) { actionLog.push(`JSON Parse Error: ${e.message}`); }
    }

    renderUpdate("Research Complete", true);
  }

  // ─────────────────────────────────────────────────────────────
  // CONTEXT AGENT (Librarian)
  // ─────────────────────────────────────────────────────────────

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
    const actionLog: string[] = [];
    const executedActions = new Set<string>();
    let cumulativeBrain = "";

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0 || !this.contextStateProvider) {
      return { context: "", analysis: "No workspace available." };
    }

    const fileTree = await this.generateProjectTree(signal, undefined, discussion?.capabilities);
    const sharedKnowledge = this.renderBriefing(discussion);
    let allFiles = await this.contextStateProvider.getAllVisibleFiles(signal);

    if (allFiles.length === 0 && fileTree.includes('├──')) {
      Logger.warn("Librarian index empty but structure exists. Proceeding with structural mode.");
      const pathsFromTree = [...fileTree.matchAll(/([A-Za-z0-9_.\-\/]+\.[a-z0-9]+)\s*[\[(]/g)].map(m => m[1]);
      allFiles = Array.from(new Set(pathsFromTree));
    }

    const currentContextFiles = this.contextStateProvider.getIncludedFiles().map(f => f.path);
    const selectedFiles = new Set<string>(currentContextFiles);
    const initialCount = selectedFiles.size;
    let rephrasedObjective = "Analyzing mission...";

    const systemPrompt = `You are the **Lead Project Librarian**.
Your goal is to optimize the project context for the Worker LLM by selecting the right files.

### 📜 LIBRARIAN PROTOCOL (TREE-FIRST MANDATE)
1. **USE YOUR EYES**: The 'PROJECT WORLD STATE' tree lists every visible file. 
2. **DIRECT ADDITION**: If the file you need is in the tree, call \`add_files\` immediately with the exact path.
3. **WHEN TO SEARCH**: Use search tools ONLY if a folder is marked \`(Collapsed)\` or you need to grep for a string.
4. **NO HALLUCINATION**: If a file is not in the tree and search returns nothing, it doesn't exist.
5. **STATUS MARKERS**: Files marked \`[C]\` or \`[D]\` are already loaded — do not add them again.
6. **NO REDUNDANCY**: Do not \`read_file\` a file already marked \`[C]\`.

**TOOLS:**
1. \`add_briefing_entry(id, info)\`: Record a technical discovery.
2. \`amend_briefing_entry(id, info)\`: Update a previous discovery.
3. \`add_files(files=[{"path", "mode"}])\`: Add files (mode: "included" or "signatures").
4. \`remove_files(paths=[])\`: Prune unnecessary files to save tokens.
5. \`read_file(path, start_line, end_line)\`: Peek at a file.
6. \`find_files_by_name(pattern)\`: Search file index (e.g. "*.vue").
7. \`grep_search(pattern, path)\`: Search text inside files.
8. \`done()\`: Finish scouting.

**OUTPUT**: JSON only.
\`\`\`json
{ "scratchpad": "Thinking...", "tool": "tool_name", "params": { ... } }
\`\`\``;

    let initialUserContent = `**USER OBJECTIVE:** "${userPrompt}"\n\n# SHARED TEAM BRIEFING\n${sharedKnowledge || "No briefing entries yet."}\n\n# PROJECT WORLD STATE\n${fileTree}\n\n**LIBRARIAN MANDATE**: Analyze the Objective and the Tree. If required files are marked \`[C]\`, call \`done\`. Otherwise, scout for missing dependencies.`;

    if (initialKeywords && initialKeywords.length > 0) {
      if (onStatusUpdate) onStatusUpdate(`Searching keywords: ${initialKeywords.join(', ')}...`);
      actionLog.push(`🔍 Grounding search for: **${initialKeywords.join(', ')}**`);
      const searchResults = await this.searchWorkspaceKeywords(initialKeywords, folders[0].uri.fsPath);
      initialUserContent += `\n\n**Initial Search Results:**\n${searchResults}`;
    }

    if (selectedFiles.size > 0) initialUserContent += `\n\n**Currently Selected Files:**\n${JSON.stringify(Array.from(selectedFiles))}`;

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
        const isToolFailure = l.includes('❌') || l.includes('Tool execution failed');
        let stateClass = 'success';
        let icon = '<span class="codicon codicon-check" style="color:var(--vscode-charts-green)"></span>';
        if (isLast) { stateClass = 'active'; icon = '<div class="spinner"></div>'; }
        else if (isToolFailure) { stateClass = 'failed'; icon = '<span class="codicon codicon-close" style="color:var(--vscode-charts-red)"></span>'; }
        if (l.startsWith('[GIT]')) icon = '<span class="codicon codicon-git-commit"></span>';
        return `<div class="timeline-item ${stateClass}" style="display:flex;align-items:flex-start;gap:10px;margin-bottom:2px;"><div class="timeline-dot" style="flex-shrink:0;margin-top:2px;">${icon}</div><div class="timeline-content" style="flex:1;font-size:11px;">${l}</div></div>`;
      }).join('');

      const logSection = actionLog.length > 0
        ? `<details ${finished ? '' : 'open'}><summary>📜 Mission Timeline</summary><div class="mission-timeline">${timelineHtml}</div></details>`
        : '';

      const renderDataBriefing = () => {
        const raw = discussion?.discussion_data_zone || "";
        if (!raw.trim()) return "Librarian is analyzing project state...";
        try {
          if (!raw.startsWith('{')) return raw;
          const entries = JSON.parse(raw);
          return Object.keys(entries).map(id => `<strong>[${id.replace(/_/g, ' ').toUpperCase()}]</strong><br>${entries[id]}`).join('<br><br>');
        } catch { return raw; }
      };

      const objectiveHtml = `<div class="technical-briefing-card" style="border-left-color:var(--vscode-charts-orange);margin-bottom:10px;"><div class="briefing-header" style="color:var(--vscode-charts-orange);"><span class="codicon codicon-target"></span> MISSION OBJECTIVE</div><div class="briefing-content" style="padding:0 16px 12px 16px;font-weight:600;">${rephrasedObjective}</div></div>`;
      const briefingHtml = `<div class="technical-briefing-card"><details open><summary class="briefing-header"><div style="display:flex;align-items:center;gap:8px;flex:1;"><span class="codicon codicon-note"></span> Team Technical Briefing</div><div style="display:flex;gap:4px;"><button class="msg-action-btn" onclick="const text=this.closest('.technical-briefing-card').querySelector('.briefing-content').innerText;vscode.postMessage({command:'copyToClipboard',text:text})" style="opacity:0.6;padding:0;margin:0;height:16px;" title="Copy"><i class="codicon codicon-copy"></i></button><button class="msg-action-btn" onclick="vscode.postMessage({command:'updateDiscussionCapabilitiesPartial',partial:{clearBriefing:true}})" style="opacity:0.6;padding:0;margin:0;height:16px;" title="Clear"><i class="codicon codicon-trash"></i></button></div></summary><div class="briefing-scroll-area"><div class="briefing-content">${renderDataBriefing()}</div></div></details></div>`;
      const spinnerHtml = finished
        ? `<div class="status-line"><span class="codicon codicon-check" style="color:var(--vscode-charts-green)"></span> <span style="font-weight:bold;">Context Synchronized</span></div>`
        : `<div class="status-line"><div class="spinner"></div> <span>Step ${step + 1}: ${status}</span></div>`;

      if (dashboardMode) onUpdate(`${spinnerHtml}\n\n${objectiveHtml}\n\n${filesTree}\n\n${logSection}`);
      else onUpdate(`**🧠 Librarian Mission Report**\n${spinnerHtml}\n${objectiveHtml}\n${briefingHtml}\n${filesTree}\n${logSection}`);
    };

    if (initialCount > 0) actionLog.push(`ℹ️ Librarian started with ${initialCount} files already in context.`);
    if (onStatusUpdate) onStatusUpdate("Librarian is formulating mission objective...");
    renderUpdate("Formulating Objective...", false, 0);

    try {
      const rephraseRes = await this.lollmsAPI.sendChat([
        { role: 'system', content: "You are a concise technical architect." },
        { role: 'user', content: `Re-phrase the following user request into a concise professional mission objective. Focus on the technical outcome. Output ONLY the re-phrased text.\n\nUSER REQUEST: "${userPrompt}"` }
      ], null, signal, model);
      rephrasedObjective = stripThinkingTags(rephraseRes).trim();
      actionLog.push(`🎯 **Objective Formulated**: ${rephrasedObjective}`);
    } catch (e) { rephrasedObjective = userPrompt; }

    actionLog.push("🔍 Analyzing project structure...");
    if (onStatusUpdate) onStatusUpdate("Librarian is analyzing project state...");
    renderUpdate("Analyzing Project...", false, 0);

    let retryCount = 0;
    let stepsTaken = 0;

    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal.aborted) throw new Error("Context agent aborted.");

      const currentData = await this.getContextContent({ includeTree: true, modelName: model, signal });
      const tokenCheck = await this.lollmsAPI.tokenize(currentData.text, model);
      const limitCheck = await this.lollmsAPI.getContextSize(model);

      const loadStatus = `### 🔋 TOKEN LOAD\n- Used: ${tokenCheck.count} tokens\n- Max: ${limitCheck.context_size} tokens\n- Remaining: ${limitCheck.context_size - tokenCheck.count} tokens\n${(tokenCheck.count / limitCheck.context_size) > 0.8 ? "⚠️ WARNING: Context nearly full. PRUNE now." : ""}`;

      chatHistory.push({
        role: 'user',
        content: `${loadStatus}\n\n### 🛠️ ACTUAL PROJECT STATE\n${currentData.projectTree}\n\n### 🧠 YOUR NOTES\n${cumulativeBrain || "No observations yet."}\n\n[Currently Selected]: ${JSON.stringify(Array.from(selectedFiles))}\n\n**INSTRUCTION**: If context is sufficient, call \`done\`. If dependency missing, call \`add_files\`. If full, call \`remove_files\`.`,
        skipInPrompt: true
      });

      let response = "";
      try { response = await this.lollmsAPI.sendChat(chatHistory, null, signal, model); }
      catch (e: any) { actionLog.push(`❌ LLM Error: ${e.message}`); renderUpdate("Error", true, step); break; }

      chatHistory.push({ role: 'assistant', content: response });
      const cleanResponse = stripThinkingTags(response);

      let jsonStr = "";
      const markdownMatch = cleanResponse.match(/```json\s*([\s\S]+?)\s*```/);
      if (markdownMatch) {
        jsonStr = markdownMatch[1];
      } else {
        const firstBrace = cleanResponse.indexOf('{');
        const lastBrace = cleanResponse.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) jsonStr = cleanResponse.substring(firstBrace, lastBrace + 1);
      }

      if (!jsonStr) {
        if (retryCount < MAX_RETRIES) {
          retryCount++;
          chatHistory.push({ role: 'system', content: "ERROR: You must output ONLY a valid JSON object. Use one of the provided tools." });
          continue;
        } else { actionLog.push(`❌ Agent failed to output JSON.`); break; }
      }

      let toolCall: any = null;
      let toolName: string = "";
      let params: any = {};

      try {
        toolCall = JSON.parse(jsonStr);
        toolName = toolCall?.tool || "";
        params = toolCall?.params || {};

        if (toolCall?.scratchpad) {
          const newEntry = toolCall.scratchpad.trim();
          cumulativeBrain += `\n\n**Insight**: ${newEntry}`;
          actionLog.push(`🧠 **Insight**: ${newEntry}`);
        }
        if (toolCall?.briefing) technicalBriefing = toolCall.briefing.trim();

        const actionFingerprint = JSON.stringify({ tool: toolName, params });
        if (executedActions.has(actionFingerprint) && toolName !== 'done') {
          chatHistory.push({ role: 'system', content: `WARNING: You already executed this exact tool call. Avoid infinite loops.` });
          actionLog.push(`⚠️ Loop detected.`);
          continue;
        }
        executedActions.add(actionFingerprint);
        retryCount = 0;

        if (toolName === 'done') { actionLog.push(`✅ Optimization complete.`); renderUpdate("Context Ready", true, step); break; }

        if (toolName === 'summon_specialist') {
          actionLog.push(`📣 **Summoning ${params.agent}**: ${params.reason}`);
          renderUpdate(`Waiting for ${params.agent}...`, false, step);
          if (params.agent === 'web') await this.runWebResearchAgent(params.reason, model, signal, onUpdate, onStatusUpdate, discussion, fullHistory);
          else if (params.agent === 'skills') await this.runSkillSelectionAgent(params.reason, model, signal, [], onUpdate, discussion);
          chatHistory.push({ role: 'system', content: `Specialist ${params.agent} has finished.` });
          continue;
        }

        if (toolName === 'add_briefing_entry' || toolName === 'amend_briefing_entry') {
          this.updateBriefingData(discussion, toolName === 'add_briefing_entry' ? 'add' : 'amend', params.id, params.info);
          actionLog.push(`📝 **Briefing Updated**: ${params.id}`);
          chatHistory.push({ role: 'system', content: "SUCCESS: Briefing entry updated." });
          renderUpdate("Updating Knowledge Base...", false, step);
          continue;
        }

        stepsTaken++;

        if (toolName === 'search_files' || toolName === 'grep_search') {
          const results = await this.searchWorkspaceContent(params.pattern, { matchCase: false, wholeWord: false, include: params.path });
          const output = results.length > 0 ? results.map(r => `${r.path}:${r.line} - ${r.snippet}`).join('\n').substring(0, 4000) : "No matches found.";
          chatHistory.push({ role: 'system', content: `SEARCH RESULTS:\n${output}` });
          actionLog.push(`🔍 Grep: "${params.pattern}" → ${results.length} hits.`);
          renderUpdate("Searching files...", false, step);
        } else if (toolName === 'find_files_by_name') {
          const pattern = (params.pattern || "").toLowerCase();
          const matches = allFiles.filter(f => f.toLowerCase().includes(pattern));
          chatHistory.push({ role: 'system', content: `FILES MATCHING "${pattern}":\n${JSON.stringify(matches.slice(0, 50))}` });
          actionLog.push(`📂 Find by name: "${pattern}" → ${matches.length} results.`);
          renderUpdate("Searching files...", false, step);
        } else if (toolName === 'read_code_graph') {
          if (this.codeGraphManager) {
            const mermaid = this.codeGraphManager.generateMermaid(params.type || 'class_diagram');
            chatHistory.push({ role: 'system', content: `CODE GRAPH:\n\`\`\`mermaid\n${mermaid}\n\`\`\`` });
            actionLog.push(`📊 Read structural graph: ${params.type || 'class_diagram'}`);
            renderUpdate("Analyzing structure...", false, step);
          }
        } else if (toolName === 'add_files') {
          const files = params.files;
          if (Array.isArray(files)) {
            const addedPaths: string[] = [];
            for (const fileItem of files) {
              const fPath = typeof fileItem === 'string' ? fileItem : fileItem.path;
              const fMode = (typeof fileItem !== 'string' && fileItem.mode === 'signatures') ? 'definitions-only' : 'included';
              const resolution = await this.resolveWorkspaceFromPath(fPath);
              if (resolution) {
                selectedFiles.add(fPath);
                addedPaths.push(fPath);
                await this.contextStateProvider.setStateForUris([resolution.uri], fMode);
              } else {
                actionLog.push(`⚠️ **Path Error**: Could not locate \`${fPath}\` on disk.`);
              }
            }
            if (addedPaths.length > 0) actionLog.push(`✅ **Context Updated**: Added ${addedPaths.length} files.`);
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
                const resolution = await this.resolveWorkspaceFromPath(p);
                if (resolution) await this.contextStateProvider.setStateForUris([resolution.uri], 'tree-only');
              }
            }
            actionLog.push(`➖ **Context Pruned**: Removed ${removed.length} files.`);
            renderUpdate("Cleaning context...", false, step);
          }
        } else if (toolName === 'read_file') {
          let pathArg = params.path || params.file;
          if (pathArg && !allFiles.includes(pathArg)) {
            const possibleMatch = allFiles.find(f => f.endsWith('/' + pathArg) || f.endsWith('\\' + pathArg));
            if (possibleMatch) pathArg = possibleMatch;
          }

          if (pathArg) {
            const resolution = await this.resolveWorkspaceFromPath(pathArg);
            if (resolution) {
              actionLog.push(`🔍 **Peeking**: \`${pathArg}\`...`);
              const doc = await vscode.workspace.openTextDocument(resolution.uri);
              const start = params.start_line || 0;
              const end = Math.min(params.end_line || start + 400, doc.lineCount);
              const text = doc.getText(new vscode.Range(new vscode.Position(start, 0), new vscode.Position(Math.min(end, doc.lineCount - 1), 1000)));
              chatHistory.push({ role: 'system', content: `Content of ${pathArg}:\n\`\`\`\n${text}\n\`\`\`` });
              renderUpdate(`Reading ${pathArg}...`, false, step);
            }
          }
        } else if (toolName === 'search_keywords') {
          const keywords = params.keywords || params.query;
          if (Array.isArray(keywords)) {
            const results = await this.searchWorkspaceKeywords(keywords, folders[0].uri.fsPath);
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
    if (selectedFiles.size > 0) finalContext = await this.readSpecificFiles(Array.from(selectedFiles));

    return { context: finalContext, analysis: cumulativeBrain };
  }

  // ─────────────────────────────────────────────────────────────
  // AUTO-SELECTION (Quick, non-agentic)
  // ─────────────────────────────────────────────────────────────

  public async getAutoSelectionForContext(userPrompt: string): Promise<string[] | null> {
    if (!this.contextStateProvider) { vscode.window.showErrorMessage("Context State Provider not available."); return null; }
    const projectTree = await this.generateProjectTree();
    const systemPrompt = `You are an expert AI assistant. Review the user's objective and the project file tree. Identify the most relevant files.

**CRITICAL:**
1. JSON ONLY — your entire response must be a single, valid JSON array of strings.
2. NO extra text, preamble, or markdown.
3. Strings must be exact relative paths from the tree.

Example:
["src/commands/chatPanel.ts", "package.json"]`;

    try {
      const responseText = await this.lollmsAPI.sendChat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `**User Objective:**\n"${userPrompt}"\n\n**Project File Tree:**\n${projectTree}\n\nWhich files are most relevant? Return JSON array of file paths.` }
      ], null);

      const jsonString = this.extractJsonArray(responseText);
      if (!jsonString) throw new Error(`No valid JSON array found in the AI's response.`);
      const fileList = JSON.parse(jsonString);
      if (Array.isArray(fileList) && fileList.every(item => typeof item === 'string')) return fileList;
      throw new Error("The AI's response was not a valid array of strings.");
    } catch (error: any) {
      vscode.window.showErrorMessage(vscode.l10n.t('error.aiFailedToSelectFiles', error.message));
      return null;
    }
  }

  private extractJsonArray(text: string): string | null {
    const markdownMatch = text.match(/```json\s*([\s\S]+?)\s*```/);
    if (markdownMatch?.[1]) return markdownMatch[1];
    const firstBracket = text.indexOf('[');
    const lastBracket = text.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket > firstBracket) return text.substring(firstBracket, lastBracket + 1);
    return null;
  }

  // ─────────────────────────────────────────────────────────────
  // SKILLS / TOKEN CACHE
  // ─────────────────────────────────────────────────────────────

  public async getCachedTokens(filePath: string, currentHash: string): Promise<number | null> {
    const cache = this.context.workspaceState.get<Record<string, { hash: string, tokens: number }>>(ContextManager.TOKEN_CACHE_KEY, {});
    const entry = cache[filePath];
    return (entry && entry.hash === currentHash) ? entry.tokens : null;
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
    if (!current.includes(skillId)) await this.context.workspaceState.update(ContextManager.PROJECT_SKILLS_KEY, [...current, skillId]);
  }

  public async removeSkillFromProject(skillId: string) {
    const current = await this.getActiveProjectSkills();
    await this.context.workspaceState.update(ContextManager.PROJECT_SKILLS_KEY, current.filter(id => id !== skillId));
  }

  // ─────────────────────────────────────────────────────────────
  // PRIVATE HELPERS
  // ─────────────────────────────────────────────────────────────

  private getNoWorkspaceMessage(): string {
    return `# Project Context\n\n**No workspace folder is currently open.**\n\nTo use Lollms with your project files:\n1. Open a folder in VS Code (File → Open Folder)\n2. Right-click on files in the explorer to set their AI Context State\n3. Start chatting with context about your code\n\nCurrently operating without project context.\n`;
  }

  private async fetchYoutubeTranscript(videoId: string, languageCode: string = 'en') {
    try {
      const transcript = await YoutubeTranscript.fetchTranscript(videoId, { lang: languageCode || 'en' });
      if (!Array.isArray(transcript)) return { success: false, output: "Unexpected transcript format." };
      const finalResult = transcript.map((part: any) => part.text).join(' ').replace(/\s+/g, ' ').trim();
      if (!finalResult) return { success: false, output: "Empty transcript." };
      return { success: true, output: finalResult };
    } catch (e: any) { return { success: false, output: `Extraction Failed: ${e.message}` }; }
  }
}