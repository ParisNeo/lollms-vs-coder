import * as vscode from 'vscode';
import { LollmsAPI, ChatMessage } from '../../lollmsAPI';
import { ContextManager, ContextResult } from '../../contextManager';
import { Discussion, DiscussionManager } from '../../discussionManager';
import { AgentManager } from '../../agentManager';
import { HerdManager } from '../../herdManager';
import { 
    getProcessedSystemPrompt, 
    stripThinkingTags, 
    stripLibrarianReferences, 
    DiscussionCapabilities as BaseDiscussionCapabilities, 
    isModelVisionCapable,
    isValidFilePath,
    ensureStrictAlternatingRoles,
    normalizePseudoFileBlocks,
    extractFileBlocks,
    parseFileTagAttributes,
    estimateImageTokens,
    getContextLimitForModel,
    findHunkInWorkspace,
    stripAnsiCodes,
    isProjectFile,
    arePathsEqual,
    findExplicitEndTag,
    detectInteractiveForm,
    detectUserInteractionDemand
} from '../../utils';
import { LibrarianPromptBuilder } from '../../system_prompts/librarianPrompt';

type DiscussionCapabilities = BaseDiscussionCapabilities & {
    folderSettings?: Record<string, { tree?: boolean; content?: boolean }>;
    preciseTokenization?: boolean;
    disableProjectContext?: boolean;
    mutedFiles?: string[];
    herdRounds?: number;
    monitoredLogPaths?: string[];
    sparqlEnabled?: boolean;
    contextPruningStrategy?: 'aggressive' | 'balanced' | 'permissive';
    historyMaxPercent?: number;
    [key: string]: any;
};
import * as path from 'path';
import { InfoPanel } from '../infoPanel';
import { ProcessManager } from '../../processManager';
import { getNonce } from './getNonce';
import { SkillsManager } from '../../skillsManager';
import { Logger } from '../../logger';
import { PersonalityManager } from '../../personalityManager';
import { GitIntegration } from '../../gitIntegration';
import { applyDiffToString, applySearchReplace, normalizeAiderContent, parseAiderHunks } from '../../utils';
import { BigDataProcessor } from '../../bigDataProcessing';
import { AutomationPanel } from '../../panels/automationPanel';
import { LocalizationManager } from '../../utils/localizationManager';
import { LollmsServices } from '../../lollmsContext';
import { ContextLibrarian } from '../../contextLibrarian';
import { ContextPoisoningGate } from '../../security/contextPoisoningGate';
import { AgentSecurityGuard, AgentSecurityLevel } from '../../security/agentSecurityGuard';
import { CodeLossReviewPanel } from '../../panels/codeLossReviewPanel';

interface ActiveGeneration {
    messageId: string;
    buffer: string;
    model: string;
    startTime: number;
    tokenCount: number; // Added to track metrics
    listeners: Set<(chunk: string) => void>;
    onComplete: Set<(fullContent: string) => void>;
}

export class ChatPanel {
  public static panels: Map<string, ChatPanel> = new Map();
  // Static registry to persist AgentManagers even if their UI panel is disposed
  public static activeAgents: Map<string, AgentManager> = new Map();
  // Static registry for standard chat generations
  public static activeGenerations: Map<string, ActiveGeneration> = new Map();
  private static _tokenCountCache: Map<string, number> = new Map();
  private static _contextSizeCache: Map<string, number> = new Map();
  private static _globalSyncQueue: Promise<void> = Promise.resolve();

  public static currentPanel: ChatPanel | undefined;
  public static isBatchApplying = false;
  public readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _services: LollmsServices;
  public readonly _lollmsAPI: LollmsAPI;
  private _contextManager!: ContextManager;
  private _discussionManager!: DiscussionManager & { context: any };
  private _gitIntegration: GitIntegration;
  private _currentDiscussion: Discussion | null = null;
  public agentManager!: AgentManager;
  private _toolManager!: any;
  public projectMemoryManager: any;
  public chatHistory: ChatMessage[] = [];
  public herdManager?: HerdManager;
  private _executionLogs: string[] = [];
  private processManager!: ProcessManager;
  private discussionId: string;
  private _isWebviewReady = false;
  private _isLoadPending = false;
  private _inputResolver: ((value: string) => void) | null = null;
  // Embedded agent mode: single answer block accumulation state
  private _activeAgentAnswerId?: string;
  private _pendingAgentQuestion?: { resolve: (v: string) => void; reject: (e: Error) => void; messageId: string; question: string; options?: any };
  private _skillsManager: SkillsManager;
  private _personalityManager?: PersonalityManager;
  private _isDisposed = false;

  public get isWebviewReady(): boolean { return this._isWebviewReady; }
  public get isDisposed(): boolean { return this._isDisposed; }
  private get contextStateProvider(): any { return this._contextManager ? this._contextManager.getContextStateProvider() : undefined; }
  
  private _viewReadyPromise: Promise<void>;
  private _viewReadyResolver!: () => void;
  
  private _discussionCapabilities: DiscussionCapabilities;
  private _tokenAbortController: AbortController | null = null;
  private _isTokenizing: boolean = false;
  private _isSendingMessage: boolean = false;
  private _currentPromptAddedFiles: Set<string> = new Set<string>();
  private _pendingJustAddedFiles: Set<string> = new Set<string>();

  // Track active listeners to prevent duplication
  private _activeGenerationListener?: (chunk: string) => void;
  private _activeGenerationCompleteListener?: (fullContent: string) => void;
  private pdfExtractionPromises: Record<string, { resolve: (val: string[]) => void, reject: (err: Error) => void, timeout: NodeJS.Timeout }> = {};

  private _activeRepairController: AbortController | null = null;
  private _activeInterProjectController: AbortController | null = null;
  private _diagnosticWatchUris: Set<string> = new Set();

  // Tracks failing patches to prevent infinite repetition loops
  private _failedPatchesRegistry: Map<string, Set<string>> = new Map();
  private _batchRepairAttempts: Map<string, number> = new Map();

  private _initialPrompt?: string;
  private _initialImages?: { name: string; data: string }[];
  private _shouldOpenWizardOnLoad = false;
  private _activeMultiPartPlan?: {
      totalParts: number;
      currentPartIndex: number;
      parts: {
          editFiles: string[];
          partInstruction: string;
          fileModes?: Array<{ path: string; mode: 'full' | 'structure' | 'symbols'; symbols?: string[] }>;
      }[];
  };

  private _activeTokenizationPromise: Promise<void> | null = null;
  private _tokenizationPendingRerun = false;
  private _tokenizationPendingOptions: any = null;

  public static createOrShow(services: LollmsServices, discussionId: string, preferredColumn?: vscode.ViewColumn): ChatPanel {
    const column = preferredColumn || (vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined);

    const existingPanel = ChatPanel.panels.get(discussionId);
    if (existingPanel) {
      existingPanel._panel.reveal(column, false);
      ChatPanel.currentPanel = existingPanel;
      return existingPanel;
    }

    const preciseTokenizationVal = vscode.workspace.getConfiguration('lollmsVsCoder').get<boolean>('preciseTokenization', false);

    const panel = vscode.window.createWebviewPanel(
      'lollmsChat',
      'Lollms Chat',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [
            services.extensionUri,
            vscode.Uri.joinPath(services.extensionUri, 'out'),
            vscode.Uri.joinPath(services.extensionUri, 'out', 'webview'),
            vscode.Uri.joinPath(services.extensionUri, 'out', 'styles'),
            services.extensionUri,
            vscode.Uri.joinPath(services.extensionUri, 'media'),
            vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri : services.extensionUri
        ],
        retainContextWhenHidden: true // Enabled with optimized state-hydration to speed up tab switching significantly
      }
    );
    panel.iconPath = vscode.Uri.joinPath(services.extensionUri, 'media', 'lollms-icon.svg');

    const newPanel = new ChatPanel(panel, services, discussionId);

    ChatPanel.panels.set(discussionId, newPanel);
    ChatPanel.currentPanel = newPanel;
    return newPanel;
  }

  private _codeGraphManager!: any;

  private constructor(panel: vscode.WebviewPanel, services: LollmsServices, discussionId: string) {
    this._panel = panel;
    this._extensionUri = services.extensionUri;
    this._services = services;
    this._lollmsAPI = services.lollmsAPI;
    this._discussionManager = services.discussionManager as any;
    this._contextManager = services.contextManager;
    this.discussionId = discussionId;
    this._gitIntegration = services.gitIntegration;
    this._skillsManager = services.skillsManager;
    this._toolManager = services.toolManager;
    this._codeGraphManager = services.codeGraphManager;
    this.projectMemoryManager = services.projectMemoryManager;

    this._discussionCapabilities = this._discussionManager.getLastCapabilities();

    this._viewReadyPromise = new Promise<void>((resolve) => {
        this._viewReadyResolver = resolve;
    });

    // Ensure load pending state is initialized to true on panel creation
    this._isLoadPending = true;

    panel.onDidChangeViewState(e => {
        if (e.webviewPanel.active) {
            ChatPanel.currentPanel = this;
        }
    });

    this._panel.onDidDispose(() => this.dispose(), null, []);
    this._updateHtmlForWebview(); 
    this._setWebviewMessageListener(this._panel.webview);
  }
  
  public setPersonalityManager(manager: PersonalityManager) { this._personalityManager = manager; }
  public setHerdManager(manager: HerdManager) { this.herdManager = manager; }
  public getCurrentDiscussion(): Discussion | null { return this._currentDiscussion; }
  private log(message: string, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO') {
      const timestamp = new Date().toLocaleTimeString();
      const logEntry = `[${timestamp}] [${level}] ${message}`;
      console.log(logEntry);
      if (level === 'ERROR') Logger.error(message);
      else if (level === 'WARN') Logger.warn(message);
      else Logger.info(message);
      this._executionLogs.push(logEntry);
      if (this._executionLogs.length > 2000) this._executionLogs.shift();
  }
  private async _updateHtmlForWebview() { this._panel.webview.html = await this._getHtmlForWebview(this._panel.webview); }
  public setContextManager(contextManager: ContextManager) { this._contextManager = contextManager; }
  
  public setProcessManager(processManager: ProcessManager) { 
      this.processManager = processManager; 

      // Ensure AgentManager is initialized and processManager is wired to both branches
      if (ChatPanel.activeAgents.has(this.discussionId)) {
          this.agentManager = ChatPanel.activeAgents.get(this.discussionId)!;
          this.agentManager.setUI(this);
          this.agentManager.setProcessManager(processManager);
          this.agentManager.personalityManager = this._personalityManager;
          this.agentManager.projectMemoryManager = this.projectMemoryManager;
      } else {
          this.agentManager = new AgentManager(
              this, 
              this._lollmsAPI, 
              this._contextManager, 
              this._gitIntegration,
              this._discussionManager,
              this._extensionUri,
              this._codeGraphManager, 
              this._skillsManager,
              this._toolManager
          );
          this.agentManager.setProcessManager(processManager);
          this.agentManager.personalityManager = this._personalityManager;
          this.agentManager.projectMemoryManager = this.projectMemoryManager;
          ChatPanel.activeAgents.set(this.discussionId, this.agentManager);
      }
  }
  
    public async executeAutomationPipeline(
        content: string,
        messageId: string,
        signal: AbortSignal,
        processId: string,
        options?: {
            xmlBlockIndexOffset?: number;
            fencedBlockIndexOffset?: number;
            skipContextTools?: boolean;
            autoFix?: boolean;
            skipGuardianRepairLoop?: boolean;
        }
    ): Promise<{modifiedFiles: string[]; appliedCount: number; failedPatches: Array<{ filePath: string; error: string }> }> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return { modifiedFiles: [], appliedCount: 0, failedPatches: [] };
        }

        const modifiedFiles = new Set<string>();
        const failedPatches: Array<{ filePath: string; error: string }> = [];
        let appliedCount = 0;
        let xmlLocalIdx = options?.xmlBlockIndexOffset ?? 0;
        let fencedLocalIdx = options?.fencedBlockIndexOffset ?? 0;

        // 0. Process Mute, Unmute, and Granular Structure/Definitions Tags (unless already handled by the turn tool loop)
        const isFastMode = !(this._discussionCapabilities.useLibrarian === true && this._discussionCapabilities.contextGovernorEnabled !== false);
        const enableAutoFix = options?.autoFix !== undefined ? options.autoFix : (this._discussionCapabilities.autoFix !== false);
        const isSystemId = messageId.startsWith('self_correction') || messageId.startsWith('guardian') || messageId.startsWith('system') || messageId.startsWith('inspection');

        const tagScanContent = this.stripProtectedRegionsForTagScan(content);

        if (!options?.skipContextTools) {
            await this.processStructureTags(content);

            const muteRegex = /<mute_files\b[^>]*?>([\s\S]*?)<\/mute_files>/gim;
            let muteMatch;
            while ((muteMatch = muteRegex.exec(tagScanContent)) !== null) {
                if (signal.aborted) break;
                const paths = muteMatch[1].split(/[\r\n,]+/).map(p => p.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
                if (paths.length > 0) {
                    await this.muteFiles(paths);
                }
            }

            const unmuteRegex = /<unmute_files\b[^>]*?>([\s\S]*?)<\/unmute_files>/gim;
            let unmuteMatch;
            while ((unmuteMatch = unmuteRegex.exec(tagScanContent)) !== null) {
                if (signal.aborted) break;
                const paths = unmuteMatch[1].split(/[\r\n,]+/).map(p => p.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
                if (paths.length > 0) {
                    await this.unmuteFiles(paths);
                }
            }

            // 0.2. Automatically unmute any muted files requested via add_files_to_context
            const addContextRegex = /<add_files_to_context\b[^>]*?>([\s\S]*?)<\/add_files_to_context>/gim;
            let addContextMatch;
            while ((addContextMatch = addContextRegex.exec(tagScanContent)) !== null) {
                if (signal.aborted) break;
                const paths = addContextMatch[1].split(/[\r\n,]+/).map(p => p.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
                if (paths.length > 0) {
                    await this.unmuteFiles(paths);
                    if (this._discussionCapabilities.autoApply || this._discussionCapabilities.autoExecuteTools) {
                        await this._contextManager.getContextStateProvider()?.addFilesToContext(paths);
                    }
                }
            }
        }


        // 0.5. Process Mission Briefing Section Tags (Autonomous in Agent Mode or when Auto-Apply is active)
        const isAgent = this._discussionCapabilities.agentMode === true;
        const isAutoApply = this._discussionCapabilities.autoApply === true;
        const briefingRegex = /<mission_briefing\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mission_briefing>)/gim;
        let briefingMatch;
        while ((briefingMatch = briefingRegex.exec(tagScanContent)) !== null) {
            if (signal.aborted) break;
            if (!isAgent && !isAutoApply) {
                // In Assistant and Co-Engineer modes without auto-apply, the interactive proposal card is rendered in the webview with Apply button
                continue;
            }

            const attrStr = briefingMatch[1] || "";
            const innerContent = (briefingMatch[2] || "").trim();

            const actionMatch = attrStr.match(/action=["'](add|edit|delete|write|patch|upsert|remove)["']/i);
            const action = (actionMatch ? actionMatch[1].toLowerCase() : (innerContent.includes('<<<<<<< SEARCH') ? 'patch' : 'upsert')) as 'add' | 'edit' | 'delete' | 'write' | 'patch' | 'upsert' | 'remove';

            const scopeMatch = attrStr.match(/scope=["'](global|local)["']/i);
            const scope = (scopeMatch ? scopeMatch[1].toLowerCase() : 'global') as 'global' | 'local';

            const catMatch = attrStr.match(/category=["'](doctrine|architecture|decisions|pitfalls|tasks|custom)["']/i);
            const sectionMatch = attrStr.match(/section=["']([^"']+)["']/i);
            const idMatch = attrStr.match(/id=["']([^"']+)["']/i);
            const titleMatch = attrStr.match(/title=["']([^"']+)["']/i);

            const updatedBriefing = await this._contextManager.updateMissionBriefing(
                innerContent,
                action,
                scope,
                this._currentDiscussion,
                {
                    category: catMatch ? (catMatch[1].toLowerCase() as any) : undefined,
                    section: sectionMatch ? sectionMatch[1].trim() : undefined,
                    id: idMatch ? idMatch[1].trim() : undefined,
                    title: titleMatch ? titleMatch[1].trim() : undefined
                }
            );

            if (this._currentDiscussion && !this._currentDiscussion.id.startsWith('temp-')) {
                await this._discussionManager.saveDiscussion(this._currentDiscussion);
            }

            this._panel.webview.postMessage({
                command: 'updateBriefingContent',
                text: updatedBriefing
            });

            this._panel.webview.postMessage({
                command: 'missionBriefingApplied',
                action: action,
                scope: scope
            });

            this.updateContextAndTokens({ isBackgroundSync: false });
            this.log(`Mission Doctrine automatically applied (Action: ${action}, Scope: ${scope}).`);
        }

        // 0.6. Process Knowledge Graph Insight Tags (<record_insight>, <add_insight>)
        const insightRegex = /<(?:record_insight|add_insight)\b([^>]*?)>([\s\S]*?)<\/(?:record_insight|add_insight)>/gim;
        let insMatch;
        while ((insMatch = insightRegex.exec(tagScanContent)) !== null) {
            if (signal.aborted) break;
            const attrStr = insMatch[1] || "";
            const inner = insMatch[2].trim();

            const topicMatch = attrStr.match(/topic=["']([^"']+)["']/i);
            const topic = topicMatch ? topicMatch[1].trim() : 'Architectural Insight';

            const hashMatch = attrStr.match(/hashtags=["']([^"']+)["']/i);
            const hashtags = hashMatch ? hashMatch[1].split(',').map(h => h.trim()) : [];

            const filesMatch = inner.match(/<files>([\s\S]*?)<\/files>/i);
            const files = filesMatch ? filesMatch[1].split(/[\r\n,]+/).map(f => f.trim()).filter(Boolean) : [];

            const contentMatch = inner.match(/<content>([\s\S]*?)<\/content>/i);
            const contentText = contentMatch ? contentMatch[1].trim() : inner.replace(/<files>[\s\S]*?<\/files>/i, '').trim();

            try {
                const { KnowledgeManager } = require('../../knowledgeManager');
                const km = new KnowledgeManager(this._discussionManager.context);
                await km.recordInsight(topic, contentText, files, hashtags);
                this.log(`Ingested insight '${topic}' into unified Knowledge Graph (.lollms/knowledge.ttl).`);
            } catch (insErr: any) {
                this.log(`Failed to record insight: ${insErr.message}`, 'WARN');
            }
        }

        // 0.7. Process Knowledge Graph Ingestion Tags
        const updateKnowledgeRegex = /<update_knowledge\b([^>]*?)>([\s\S]*?)<\/update_knowledge>/gim;
        let updateKnMatch;
        while ((updateKnMatch = updateKnowledgeRegex.exec(tagScanContent)) !== null) {
            if (signal.aborted) break;
            const attrStr = updateKnMatch[1] || "";
            const innerContent = updateKnMatch[2].trim();
            if (!innerContent) continue;

            const pathMatch = attrStr.match(/path=["']([^"']+)["']/i);
            const targetTopic = pathMatch ? pathMatch[1].trim() : "Knowledge Update";

            try {
                const { KnowledgeManager } = require('../../knowledgeManager');
                const km = new KnowledgeManager(this._discussionManager.context);
                await km.recordInsight(targetTopic, innerContent, [], ['#architecture', '#knowledge']);
                this.log(`Ingested knowledge '${targetTopic}' into Knowledge Graph (.lollms/knowledge.ttl).`);
                const rendered = await km.renderContextKnowledge();
                this._panel.webview.postMessage({
                    command: 'updateKnowledgeContent',
                    knowledge: rendered
                });
            } catch (kErr: any) {
                this.log(`Failed to update knowledge: ${kErr.message}`, 'WARN');
            }
        }

        // 0.8. Process Proposed File Deletions during Auto-Apply (if enabled)
        if (this._discussionCapabilities.fileDelete !== false) {
            const deleteTagsRegex = /<(delete_files|delete_file)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gim;
            let delMatch: RegExpExecArray | null;
            const pathsToDelete: string[] = [];
            while ((delMatch = deleteTagsRegex.exec(tagScanContent)) !== null) {
                if (signal.aborted) break;
                const attrStr = delMatch[2] || '';
                const inner = (delMatch[3] || '').trim();
                const singleAttr = attrStr.match(/\bpath=["']([^"']+)["']/i);
                if (singleAttr && isValidFilePath(singleAttr[1].trim())) {
                    pathsToDelete.push(singleAttr[1].trim());
                }
                if (inner) {
                    inner.split(/[\r\n,]+/)
                        .map(p => p.trim().replace(/^['"`]|['"`]$/g, '').replace(/^-\s*/, '').trim())
                        .filter(p => p && isValidFilePath(p))
                        .forEach(p => pathsToDelete.push(p));
                }
            }
            if (pathsToDelete.length > 0 && !signal.aborted) {
                const uniqueDeletePaths = Array.from(new Set(pathsToDelete));
                const safeDeletePaths = uniqueDeletePaths.filter(p => !AgentSecurityGuard.isProtectedPath(p).protected);
                if (safeDeletePaths.length > 0) {
                    let allowDelete = true;
                    if (isAgent && this.agentManager) {
                        const secLevel = this.agentManager.getSecurityLevel();
                        if (secLevel !== 'relaxed') {
                            const decision = await this.agentManager.requestSecurityApproval(
                                `Confirm File Deletion (${safeDeletePaths.length} file${safeDeletePaths.length > 1 ? 's' : ''})`,
                                `Agent proposed deleting:\n${safeDeletePaths.map(p => `• ${p}`).join('\n')}`,
                                'delete_files',
                                safeDeletePaths.join(', '),
                                signal
                            );
                            allowDelete = decision !== 'block';
                        }
                        if (allowDelete) {
                            for (const p of safeDeletePaths) {
                                const res = await this._contextManager.resolveWorkspaceFromPath(p);
                                if (res) {
                                    await this.agentManager.securityGuard.collectFilesForDeletionSnapshot(workspaceFolder, res.uri, res.relativePath, 'delete_files');
                                }
                            }
                            this.syncAgentSecurityState(secLevel, this.agentManager.securityGuard.getActiveMutationCount());
                        }
                    }
                    if (allowDelete) {
                        await vscode.commands.executeCommand('lollms-vs-coder.deleteFile', safeDeletePaths, { silent: true, skipConfirm: true });
                    }
                }
            }
        }

        // 0.9. Automated Context Verification Shield: Check for Blind Patches
        if (!options?.skipContextTools) {
            const contextVerification = await this.verifyGeneratedPatchContext(content);
            if (!contextVerification.valid) {
                this.log(`[Context Verifier] Rejected blind patch on unpossessed files: [${contextVerification.unpossessedFiles.join(', ')}]`, 'WARN');
                await this.handleContextVerifierFailure(contextVerification.unpossessedFiles, isFastMode, signal, processId);
                return {
                    modifiedFiles: [],
                    appliedCount: 0,
                    failedPatches: contextVerification.unpossessedFiles.map(fp => ({ filePath: fp, error: 'File not loaded in active context [C]' }))
                };
            }
        }

        // 1. Process XML <file> Mutation Tags (Normalized with pseudo-tag fallback)
        const scannableContent = stripThinkingTags(content);
        let normalizedContent = normalizePseudoFileBlocks(scannableContent);
        normalizedContent = normalizedContent.replace(/^[ \t]*<delete_code\b([^>]*?)>([\s\S]*?)<\/delete_code>[ \t]*$/gim, (m: string, attrStr: string, body: string) => {
            const attrs = parseFileTagAttributes(attrStr);
            return attrs?.path ? `\n\n<file path="${attrs.path}" action="delete_code">\n${body.trim()}\n</file>\n\n` : m;
        });
        const fileBlocks = extractFileBlocks(normalizedContent);
        const xmlBlockRanges = fileBlocks.map(b => ({ start: b.start, end: b.end }));

        for (const fileBlock of fileBlocks) {
            if (signal.aborted) break;
            const attrStr = fileBlock.attrStr || "";
            const fileBody = fileBlock.rawContent || "";

            const fileAttrs = parseFileTagAttributes(attrStr, fileBody);
            if (!fileAttrs || !fileAttrs.path) continue;

            const filePath = fileAttrs.path;
            const action = fileAttrs.action;
            const symbol = fileAttrs.symbol || "";

            if (!isProjectFile(filePath) || filePath.includes('.lollms/external_files') || (isAgent && AgentSecurityGuard.isProtectedPath(filePath).protected)) {
                this.log(`[Automation Pipeline] Blocked attempt to modify protected or external file: ${filePath}`, 'WARN');
                vscode.window.showWarningMessage(`Blocked modification of '${filePath}': Protected or read-only file.`);
                continue;
            }

            let codeLossAlreadyConfirmed = false;
            if (isAgent && this.agentManager) {
                const res = await this._contextManager.resolveWorkspaceFromPath(filePath);
                if (res) {
                    const secLevel = this.agentManager.getSecurityLevel();
                    let origText: string | null = null;
                    try {
                        const bytes = await vscode.workspace.fs.readFile(res.uri);
                        origText = Buffer.from(bytes).toString('utf8');
                    } catch {}
                    if (action === 'write') {
                        const val = AgentSecurityGuard.validateWriteContent(filePath, origText, fileBody, secLevel, true);
                        if (!val.valid && val.requiresConfirmation) {
                            const reviewDecision = await CodeLossReviewPanel.confirm({
                                filePath,
                                title: `Confirm File Write (Potential Code Loss): ${path.basename(filePath)}`,
                                reason: val.reason || 'Potential code loss detected.',
                                originalContent: origText ?? '',
                                proposedContent: fileBody,
                                allowAskAi: false,
                                signal
                            });
                            if (reviewDecision !== 'accept') {
                                this.agentManager.securityGuard.recordAudit({
                                    verdict: 'blocked',
                                    tool: 'markdown_coding',
                                    target: filePath,
                                    reason: val.reason || 'User rejected potential code loss after reviewing diff.'
                                });
                                continue;
                            }
                            this.agentManager.securityGuard.recordAudit({
                                verdict: 'confirmed',
                                tool: 'markdown_coding',
                                target: filePath,
                                reason: `${val.reason || 'Code loss check'} (accepted after diff review)`
                            });
                            codeLossAlreadyConfirmed = true;
                        } else if (!val.valid) {
                            this.log(`[Security Guard] Blocked unsafe write to ${filePath}: ${val.reason}`, 'WARN');
                            continue;
                        }
                    }
                    await this.agentManager.securityGuard.snapshotFile(
                        workspaceFolder,
                        res.uri,
                        res.relativePath,
                        'markdown_coding',
                        origText !== null ? 'modify' : 'create'
                    );
                    this.syncAgentSecurityState(secLevel, this.agentManager.securityGuard.getActiveMutationCount());
                }
            }

            if ((action as string) === 'delete') {
                if (this._discussionCapabilities.fileDelete !== false) {
                    await vscode.commands.executeCommand('lollms-vs-coder.deleteFile', [filePath], { silent: true, skipConfirm: true });
                }
                continue;
            }

            const currentBlockIndex = xmlLocalIdx++;
            const blockId = `file-mutation-${messageId}-${currentBlockIndex}`;
            modifiedFiles.add(filePath);

            const isPatch = action === 'patch' || (action !== 'write' && action !== 'update_symbol' && action !== ('delete_code' as any) && fileBody.includes('<<<<<<< SEARCH'));

            if ((action as string) === 'delete_code') {
                const result: any = await vscode.commands.executeCommand('lollms-vs-coder.deleteCodeBlock', filePath, fileBody, { silent: true, autoSave: true, messageId, blockIndex: currentBlockIndex, blockId });
                if (result?.success) {
                    appliedCount++;
                    await this.updateAppliedState(messageId, currentBlockIndex);
                    this._panel.webview.postMessage({
                        command: 'fileSavedOnDisk',
                        filePath: filePath,
                        messageId: messageId,
                        blockIndex: currentBlockIndex,
                        blockId
                    });
                    this.auditFileDiagnostics(filePath, messageId, currentBlockIndex, blockId);
                } else {
                    const errMsg = result?.error || 'Could not locate code block to delete.';
                    failedPatches.push({ filePath, error: errMsg });
                    this._panel.webview.postMessage({
                        command: 'applyAllResult',
                        messageId,
                        filePath,
                        blockIndex: currentBlockIndex,
                        blockId,
                        success: false,
                        error: errMsg
                    });
                }
            } else if (isPatch) {
                const normalizedAider = normalizeAiderContent(fileBody);
                const result: any = await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', filePath, normalizedAider, this, messageId, { silent: true, autoSave: true, blockIndex: currentBlockIndex, blockId });
                if (result?.success) {
                    appliedCount++;
                    await this.updateAppliedState(messageId, currentBlockIndex);
                    this._panel.webview.postMessage({
                        command: 'fileSavedOnDisk',
                        filePath: filePath,
                        messageId: messageId,
                        blockIndex: currentBlockIndex,
                        blockId
                    });
                    this.auditFileDiagnostics(filePath, messageId, currentBlockIndex, blockId);
                } else {
                    if (result?.succeededHunks && result.succeededHunks.length > 0) {
                        for (const sIdx of result.succeededHunks) {
                            await this.updateAppliedState(messageId, currentBlockIndex, sIdx);
                            this._panel.webview.postMessage({
                                command: 'applyAllResult',
                                messageId,
                                filePath,
                                blockIndex: currentBlockIndex,
                                hunkIndex: sIdx,
                                blockId,
                                success: true,
                                alreadyApplied: true
                            });
                        }
                    }

                    let failingSnippet = normalizedAider;
                    if (result?.failedHunks && result.failedHunks.length > 0) {
                        const parsedHunks = parseAiderHunks(normalizedAider);
                        const failedSnippets = result.failedHunks
                            .map((fh: any) => parsedHunks[fh.index]?.fullMatch)
                            .filter(Boolean);
                        if (failedSnippets.length > 0) {
                            failingSnippet = failedSnippets.join('\n\n');
                        }
                    }

                    const errMsg = result?.failedHunks?.length
                        ? result.failedHunks.map((fh: any) => fh.error).join('; ')
                        : (result?.error || 'Search block mismatch.');

                    let autoFixed = false;
                    if (enableAutoFix && !isSystemId && !signal.aborted) {
                        this.log(`Patch failed for ${filePath}. Initiating automated AI self-correction...`, 'WARN');
                        autoFixed = await this.triggerSurgicalSelfCorrection(filePath, failingSnippet, errMsg, signal, 1);
                    }

                    if (autoFixed) {
                        appliedCount++;
                        await this.updateAppliedState(messageId, currentBlockIndex);
                        this._panel.webview.postMessage({
                            command: 'fileSavedOnDisk',
                            filePath: filePath,
                            messageId: messageId,
                            blockIndex: currentBlockIndex,
                            blockId
                        });
                        this.auditFileDiagnostics(filePath, messageId, currentBlockIndex, blockId);
                    } else {
                        failedPatches.push({ filePath, error: errMsg });
                        this._panel.webview.postMessage({
                            command: 'applyAllResult',
                            messageId,
                            filePath,
                            blockIndex: currentBlockIndex,
                            blockId,
                            success: false,
                            error: errMsg
                        });
                    }
                }
            } else {
                const targetPath = symbol ? `${filePath}:${symbol}` : filePath;
                const result: any = await vscode.commands.executeCommand('lollms-vs-coder.applyFileContent', targetPath, fileBody, { silent: true, autoSave: true, messageId, blockIndex: currentBlockIndex, blockId, skipCodeLossCheck: codeLossAlreadyConfirmed });
                if (result?.success) {
                    appliedCount++;
                    await this.updateAppliedState(messageId, currentBlockIndex);
                    this._panel.webview.postMessage({
                        command: 'fileSavedOnDisk',
                        filePath: filePath,
                        messageId: messageId,
                        blockIndex: currentBlockIndex,
                        blockId
                    });
                    this.auditFileDiagnostics(filePath, messageId, currentBlockIndex, blockId);
                } else {
                    const errMsg = result?.error || `Failed to apply ${symbol ? `symbol ${symbol}` : 'file'} update.`;
                    let autoFixed = false;
                    if (symbol && enableAutoFix && !isSystemId && !signal.aborted) {
                        this.log(`Symbol update failed for ${targetPath}. Initiating automated AI self-correction...`, 'WARN');
                        autoFixed = await this.triggerSurgicalSelfCorrection(
                            filePath,
                            `<file path="${filePath}" action="update_symbol" symbol="${symbol}">\n${fileBody}\n</file>`,
                            errMsg,
                            signal,
                            1
                        );
                    }

                    if (autoFixed) {
                        appliedCount++;
                        await this.updateAppliedState(messageId, currentBlockIndex);
                        this._panel.webview.postMessage({
                            command: 'fileSavedOnDisk',
                            filePath,
                            messageId,
                            blockIndex: currentBlockIndex,
                            blockId
                        });
                        this.auditFileDiagnostics(filePath, messageId, currentBlockIndex, blockId);
                    } else {
                        failedPatches.push({ filePath, error: errMsg });
                        this._panel.webview.postMessage({
                            command: 'applyAllResult',
                            messageId,
                            filePath,
                            blockIndex: currentBlockIndex,
                            blockId,
                            success: false,
                            error: errMsg
                        });
                    }
                }
            }
        }

        // 2. Process Fenced Code Blocks (Standard, outside XML <file> blocks)
        const blockRegex = /```[\t ]*(?:language:|lang:)?(\w+)[\t ]*:[\t ]*([^\n\r\s]+)[\t ]*[\r\n]+([\s\S]+?)[\r\n]+```/g;
        const fencedRanges: { start: number; end: number }[] = [];
        let match;

        while ((match = blockRegex.exec(normalizedContent)) !== null) {
            if (signal.aborted) break;
            if (xmlBlockRanges.some(r => match!.index >= r.start && match!.index < r.end)) continue;

            fencedRanges.push({ start: match.index, end: match.index + match[0].length });
            let filePath = match[2];
            let blockContent = match[3];

            const currentBlockIndex = fencedLocalIdx++;
            const opts = { silent: true, autoSave: true, blockIndex: currentBlockIndex };

            const isAiderInside = blockContent.includes('<<<<<<< SEARCH') || /^[ \t]*={5,}[ \t]*$/m.test(blockContent);
            const commonLangs = ['makefile', 'python', 'py', 'javascript', 'js', 'typescript', 'ts', 'json', 'bash', 'sh', 'css', 'html'];

            if (isAiderInside && commonLangs.includes(filePath.toLowerCase())) {
                const precedingText = normalizedContent.substring(Math.max(0, match.index - 250), match.index);
                const backticks = [...precedingText.matchAll(/`([^`\n\r]+)`/g)].map(m => m[1].trim());
                const validBacktickPath = backticks.reverse().find(b => isValidFilePath(b));
                if (validBacktickPath) {
                    filePath = validBacktickPath;
                } else {
                    const pathMatch = precedingText.match(/([a-zA-Z0-9._\-\/]+\.[a-zA-Z0-9]+)/);
                    if (pathMatch && isValidFilePath(pathMatch[1])) {
                        filePath = pathMatch[1];
                    }
                }
            }

            if (filePath.includes(':')) {
                const parts = filePath.split(':');
                if (commonLangs.includes(parts[0].toLowerCase())) {
                    filePath = parts.slice(1).join(':');
                }
            }

            if (!isValidFilePath(filePath)) {
                continue;
            }

            modifiedFiles.add(filePath);

            if (isAiderInside) {
                const normalizedAider = normalizeAiderContent(blockContent);
                const result: any = await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', filePath, normalizedAider, this, messageId, { ...opts, autoSave: true });
                if (result?.success) {
                    appliedCount++;
                    await this.updateAppliedState(messageId, currentBlockIndex);
                    this._panel.webview.postMessage({ command: 'fileSavedOnDisk', filePath, messageId, blockIndex: currentBlockIndex });
                    this.auditFileDiagnostics(filePath, messageId, currentBlockIndex);
                } else if (enableAutoFix && !isSystemId && !signal.aborted) {
                    this.log(`Patch failed for ${filePath}. Initiating automated AI self-correction...`, 'WARN');
                    const fixed = await this.triggerSurgicalSelfCorrection(filePath, normalizedAider, result?.error || "Search block mismatch.", signal, 1);
                    if (fixed) {
                        appliedCount++;
                        await this.updateAppliedState(messageId, currentBlockIndex);
                        this._panel.webview.postMessage({ command: 'fileSavedOnDisk', filePath, messageId, blockIndex: currentBlockIndex });
                    } else {
                        failedPatches.push({ filePath, error: result?.error || "Search block mismatch." });
                    }
                } else {
                    failedPatches.push({ filePath, error: result?.error || "Search block mismatch." });
                }
            } else {
                const result: any = await vscode.commands.executeCommand('lollms-vs-coder.applyFileContent', filePath, blockContent, { silent: true, autoSave: true, messageId, blockIndex: currentBlockIndex });
                if (result?.success) {
                    appliedCount++;
                    await this.updateAppliedState(messageId, currentBlockIndex);
                    this._panel.webview.postMessage({
                        command: 'fileSavedOnDisk',
                        filePath: filePath,
                        messageId,
                        blockIndex: currentBlockIndex
                    });
                    this.auditFileDiagnostics(filePath, messageId, currentBlockIndex);
                } else {
                    failedPatches.push({ filePath, error: result?.error || "Failed to apply file content." });
                }
            }
        }

        // 3. Process Naked Aider Blocks (No backtick fences and outside XML <file> blocks)
        const lines = normalizedContent.split('\n');
        let lineOffset = 0;
        for (let i = 0; i < lines.length; i++) {
            const lineLen = lines[i].length + 1;
            const curOffset = lineOffset;
            lineOffset += lineLen;

            if (signal.aborted) break;
            if (xmlBlockRanges.some(r => curOffset >= r.start && curOffset < r.end)) continue;
            if (fencedRanges.some(r => curOffset >= r.start && curOffset < r.end)) continue;

            const line = lines[i].trim();
            if (line.startsWith('<<<<<<< SEARCH')) {
                let endIdx = -1;
                for (let j = i + 1; j < lines.length; j++) {
                    if (lines[j].trim().startsWith('>>>>>>> REPLACE')) {
                        endIdx = j;
                        break;
                    }
                }

                if (endIdx !== -1) {
                    const blockContent = lines.slice(i, endIdx + 1).join('\n');
                    const currentBlockIndex = fencedLocalIdx++;
                    const opts = { silent: true, autoSave: true, blockIndex: currentBlockIndex };

                    let filePath = "";
                    for (let k = i - 1; k >= Math.max(0, i - 15); k--) {
                        const allBackticks = [...lines[k].matchAll(/`([^`\n\r]+)`/g)].map(m => m[1].trim());
                        const best = allBackticks.reverse().find(b => isValidFilePath(b));
                        if (best) {
                            filePath = best;
                            break;
                        }
                        const pathMatch = lines[k].match(/([a-zA-Z0-9._\-\/]+\.[a-zA-Z0-9]+)/);
                        if (pathMatch && isValidFilePath(pathMatch[1])) {
                            filePath = pathMatch[1];
                            break;
                        }
                    }

                    if (isValidFilePath(filePath)) {
                        modifiedFiles.add(filePath);
                        const normalizedAider = blockContent.replace(/^\s*(<<<<<<< SEARCH|=======|>>>>>>> REPLACE)/gm, '$1');
                        const result: any = await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', filePath, normalizedAider, this, messageId, opts);

                        if (result?.success) {
                            appliedCount++;
                            await this.updateAppliedState(messageId, currentBlockIndex);
                            this._panel.webview.postMessage({ command: 'fileSavedOnDisk', filePath, messageId, blockIndex: currentBlockIndex });
                            this.auditFileDiagnostics(filePath, messageId, currentBlockIndex);
                        } else if (enableAutoFix && !isSystemId && !signal.aborted) {
                            this.log(`Naked patch failed for ${filePath}. Initiating automated AI self-correction...`, 'WARN');
                            const fixed = await this.triggerSurgicalSelfCorrection(filePath, normalizedAider, result?.error || "Search block mismatch.", signal, 1);
                            if (fixed) {
                                appliedCount++;
                                await this.updateAppliedState(messageId, currentBlockIndex);
                                this._panel.webview.postMessage({ command: 'fileSavedOnDisk', filePath, messageId, blockIndex: currentBlockIndex });
                            } else {
                                failedPatches.push({ filePath, error: result?.error || "Search block mismatch." });
                            }
                        } else {
                            failedPatches.push({ filePath, error: result?.error || "Search block mismatch." });
                        }
                    }
                    for (let adv = i + 1; adv <= endIdx; adv++) {
                        lineOffset += lines[adv].length + 1;
                    }
                    i = endIdx;
                }
            }
        }

        // Automatically ensure all modified files are unmuted and loaded into active context
        if (modifiedFiles.size > 0) {
            const modPaths = Array.from(modifiedFiles);
            await this.unmuteFiles(modPaths);
            await this._contextManager.getContextStateProvider()?.addFilesToContext(modPaths);
            for (const mf of modPaths) {
                const res = await this._contextManager.resolveWorkspaceFromPath(mf);
                if (res) {
                    this._contextManager.refreshFileInCache(res.uri);
                }
            }
            this.recordCurrentPromptFiles(modPaths);
        }

        // 🛡️ GUARDIAN PROTOCOL: Automated Repair Loop
        if (enableAutoFix && modifiedFiles.size > 0 && !options?.skipGuardianRepairLoop) {
            const urisToFix: vscode.Uri[] = [];
            for (const fp of modifiedFiles) {
                const res = await this._contextManager.resolveWorkspaceFromPath(fp);
                if (res) urisToFix.push(res.uri);
            }
            if (urisToFix.length > 0) {
                await this.repairFilesIteratively(urisToFix, signal, processId, messageId);
            }
        }

        return {
            modifiedFiles: Array.from(modifiedFiles),
            appliedCount,
            failedPatches
        };
    }



    /**
     * Proactive Guardian Audit: Scans files for structural flaws beyond simple diagnostics.
     */
    public async runGuardianAudit(filePaths: string[], signal: AbortSignal, originalMessageId: string) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return;

        this.log(`Guardian: Starting structural audit for ${filePaths.length} files.`);

        const auditPrompt = `### 🛡️ GUARDIAN AUDIT MISSION
I have just applied changes to the following files: [${filePaths.join(', ')}].

**TASK:**
Perform a cold, critical audit of the current state of these files on disk. Look specifically for:
1. **Bad Indentation**: Are there mixed tabs/spaces or broken nesting levels?
2. **Missing Imports**: Did the last edit use a library or local module without importing it?
3. **Missing Definitions**: Are there calls to functions/classes that don't exist in the context?
4. **Structural Malformations**: Are there unclosed braces or leaked Aider markers?

**INSTRUCTIONS:**
- **NEVER WRITE VERY LONG PATCHES**: Provide surgical, very short and focused **AIDER SEARCH/REPLACE** blocks (1-5 lines of change).
- **SYMBOL REPLACEMENT FOR EXTENSIVE CHANGES**: If extensive changes are required for a function or class, use targeted symbol replacement (\`<file path="..." action="update_symbol" symbol="SymbolName">\`) instead of long patching.
- If a file is perfect, do not include it.
- If everything is perfect, respond with "VERIFICATION PASSED".
- Output ONLY the code blocks. No conversational chatter.`;

        try {
            const model = this._currentDiscussion?.model || this._lollmsAPI.getModelName();
            const systemPrompt = await getProcessedSystemPrompt('verifier' as any);

            // Gather the actual content of the files as they sit on disk right now
            const diskContext = await this._contextManager.readSpecificFiles(filePaths);

            const response = await this._lollmsAPI.sendChat([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `${auditPrompt}\n\n### CURRENT DISK STATE:\n${diskContext}` }
            ], null, signal, model);

            const cleanResponse = stripThinkingTags(response);

            if (cleanResponse.includes("VERIFICATION PASSED") && cleanResponse.length < 50) {
                this.addMessageToDiscussion({
                    role: 'system',
                    content: `**🛡️ Guardian Audit**: All ${filePaths.length} files verified structurally sound.`,
                    skipInPrompt: true
                });
                return;
            }

            // If the Guardian found issues: embedded round during an active agent turn; sibling message otherwise
            const verifierMsgId = this._activeAgentAnswerId || ('guardian_fix_' + Date.now());
            if (this._activeAgentAnswerId) {
                await this.updateMessageContent(verifierMsgId, 'APPEND_TAG:<agent_round type="verify" title="Guardian Audit: Structural Issues Detected" status="done">\n' + cleanResponse + '\n</agent_round>');
            } else {
                await this.addMessageToDiscussion({
                    id: verifierMsgId,
                    role: 'assistant',
                    content: `**🛡️ Guardian Audit: Structural Issues Detected**\n\nI've identified indentation or dependency issues in the applied files. Here are the surgical repairs:\n\n${cleanResponse}`,
                    model: model,
                    personalityName: '🛡️ Guardian'
                });
            }

            // If auto-apply is on, we go one step deeper and apply the guardian's own fixes
            if (this._discussionCapabilities.autoApply) {
                const proc = this.processManager.getForDiscussion(this.discussionId);
                if (proc) {
                    await this.executeAutomationPipeline(cleanResponse, verifierMsgId, signal, proc.id);
                }
            }

        } catch (e: any) {
            this.log(`Guardian Audit failed: ${e.message}`, 'ERROR');
        }
    }

    public setAgentManager(agent: AgentManager) {
          this.agentManager = agent;
          ChatPanel.activeAgents.set(this.discussionId, agent);
      }

      /**
       * Spawns an automated AI correction turn when a search/replace patch fails.
       * Supports up to 4 total attempts, but terminates early if a repeated failing approach is detected.
       */
      public async triggerSurgicalSelfCorrection(filePath: string, failingPatch: string, errorMsg: string, signal: AbortSignal, currentAttempt: number = 1): Promise<boolean> {
          const maxAttempts = 4;
          if (currentAttempt > maxAttempts) {
              this.log(`Self-Correction: Reached maximum attempts limit (${maxAttempts}) for ${filePath}. Halting.`, 'WARN');
              return false;
          }

          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          if (!workspaceFolder) return false;

          const resolution = await this._contextManager.resolveWorkspaceFromPath(filePath);
          if (!resolution) return false;

          // Register the initial failure into the duplicate-prevention registry
          if (!this._failedPatchesRegistry.has(filePath)) {
              this._failedPatchesRegistry.set(filePath, new Set());
          }
          const normalizedFailingPatch = failingPatch.replace(/\s+/g, ' ').trim();
          this._failedPatchesRegistry.get(filePath)!.add(normalizedFailingPatch);

          let originalFileContent = "";
          try {
              const document = await vscode.workspace.openTextDocument(resolution.uri);
              originalFileContent = document.getText();
              if (originalFileContent.length > 60000) {
                  originalFileContent = originalFileContent.substring(0, 60000) + `\n... [Truncated at 60000 chars; total ${originalFileContent.length} chars]`;
              }
          } catch (e: any) {
              this.log(`Self-Correction: Could not read original file ${filePath}: ${e.message}`, 'ERROR');
              return false;
          }

          const correctionMsgId = 'self_correction_' + Date.now() + '_' + currentAttempt;
          await this.addMessageToDiscussion({
              id: correctionMsgId,
              role: 'system',
              content: `🛡️ **Sovereign Shield: Patch Application Failed (Attempt ${currentAttempt}/${maxAttempts})**
  File: \`${filePath}\`
  Error: \`${errorMsg}\`
  *Summoning the Synaptic Architect to automatically repair the patch based on actual disk content...*`,
              skipInPrompt: true
          });

          const systemPrompt = "You are a surgical code repair expert. You analyze original files and failing Aider patches, then output a corrected version.";
          const userPrompt = `### 🛑 SEARCH/REPLACE FAILURE REPORT (ATTEMPT ${currentAttempt} of ${maxAttempts})
The following patch failed to apply to \`${filePath}\`.

**CRITICAL ERROR:** 
"${errorMsg}"

**YOUR PREVIOUS ATTEMPT:**
\`\`\`diff
${failingPatch}
\`\`\`

**ACTUAL FILE CONTENT (REFERENCE):**
\`\`\`
${originalFileContent}
\`\`\`

**INSTRUCTIONS FOR REPAIR:**
1. Your SEARCH block was NOT a literal, character-for-character match of the file content.
2. Check for **indentation differences** (spaces vs tabs) and **trailing whitespace**.
3. **DO NOT REPEAT YOUR PREVIOUS ATTEMPT**. It failed because it didn't match. You must write a different search block.
4. **NEVER WRITE VERY LONG PATCHES**: Keep SEARCH/REPLACE blocks very short and focused (1-5 lines of modification).
5. **USE SYMBOL REPLACEMENT FOR EXTENSIVE CHANGES**: If you need to make many changes to a function or class, do NOT output a long patch. Instead, output a targeted symbol replacement: \`<file path="${filePath}" action="update_symbol" symbol="SymbolName">\` (or \`\`\`language:${filePath}:SymbolName\`).
6. Provide the CORRECTED block. Include 1-2 lines of unchanged context in the SEARCH section to ensure a unique match.
7. Output **ONLY** the corrected block. Do not wrap it in other code blocks.`;

          try {
              const model = this._currentDiscussion?.model || this._lollmsAPI.getModelName();
              const response = await this._lollmsAPI.sendChat([
                  { role: 'system', content: systemPrompt },
                  { role: 'user', content: userPrompt }
              ], null, signal, model, { thinking: false });

              if (signal.aborted) return false;

              const cleanResponse = stripThinkingTags(response);

              // Extract the fixed block from <file> tag, Aider block, or fenced block
              const normalizedResp = normalizePseudoFileBlocks(cleanResponse);
              const xmlBlocks = extractFileBlocks(normalizedResp);
              if (xmlBlocks.length > 0) {
                  const firstXml = xmlBlocks[0];
                  const attrs = parseFileTagAttributes(firstXml.attrStr, firstXml.rawContent);
                  if (attrs && (attrs.action === 'update_symbol' || attrs.action === 'write')) {
                      const targetPath = attrs.symbol ? `${filePath}:${attrs.symbol}` : filePath;
                      const applySymRes: any = await vscode.commands.executeCommand('lollms-vs-coder.applyFileContent', targetPath, firstXml.rawContent, { silent: true, autoSave: true });
                      if (applySymRes?.success) {
                          await this.updateMessageContent(correctionMsgId, `🛡️ **Sovereign Shield**: Corrected ${attrs.action} successfully applied to \`${targetPath}\`.`);
                          this._failedPatchesRegistry.delete(filePath);
                          return true;
                      }
                  }
              }

              let fixedBlock = "";
              const startTag = "<<<<<<< SEARCH";
              const endTag = ">>>>>>> REPLACE";
              const startIdx = cleanResponse.indexOf(startTag);
              const endIdx = cleanResponse.indexOf(endTag);

              if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
                  fixedBlock = cleanResponse.substring(startIdx, endIdx + endTag.length);
              } else if (xmlBlocks.length > 0 && xmlBlocks[0].rawContent.includes(startTag)) {
                  fixedBlock = xmlBlocks[0].rawContent;
              } else {
                  const match = cleanResponse.match(/```(?:\w+)?\r?\n([\s\S]*?)\r?\n```/);
                  fixedBlock = match ? match[1].trim() : cleanResponse.trim();
              }

              fixedBlock = normalizeAiderContent(fixedBlock);

              if (fixedBlock && fixedBlock.includes("<<<<<<< SEARCH")) {
                  const normalizedFixedBlock = fixedBlock.replace(/\s+/g, ' ').trim();

                  // 🛑 REPETITION CIRCUIT BREAKER
                  if (this._failedPatchesRegistry.get(filePath)!.has(normalizedFixedBlock)) {
                      this.log(`Repetitive approach detected for ${filePath}. Blocking execution loop to protect token budget.`, 'WARN');
                      await this.addMessageToDiscussion({
                          id: 'repetition_blocked_' + Date.now(),
                          role: 'system',
                          content: `🛡️ **Sovereign Shield: Repetitive thought pattern blocked.** 
  The AI generated a patch that is identical to a previously failing approach. 
  *Self-correction halted to prevent infinite loops. Please edit manually using the Raw Block tool.*`,
                          skipInPrompt: true
                      });
                      return false;
                  }

                  const successMsgId = 'self_correction_applied_' + Date.now() + '_' + currentAttempt;
                  await this.addMessageToDiscussion({
                      id: successMsgId,
                      role: 'system',
                      content: `🛡️ **Sovereign Shield**: Corrected patch generated. Applying to disk...`,
                      skipInPrompt: true
                  });

                  // Apply the newly corrected patch silently
                  const applyResult: any = await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', filePath, fixedBlock, this, successMsgId, { silent: true, autoSave: true });

                  if (applyResult && applyResult.success) {
                      await this.updateMessageContent(successMsgId, `🛡️ **Sovereign Shield**: Corrected patch successfully applied to \`${filePath}\`.`);
                      this._failedPatchesRegistry.delete(filePath);
                      return true;
                  } else {
                      const nextError = applyResult?.error || "Search block mismatch.";
                      await this.updateMessageContent(successMsgId, `🛡️ **Sovereign Shield**: Corrected patch also failed to apply. Retrying...`);
                      return await this.triggerSurgicalSelfCorrection(filePath, fixedBlock, nextError, signal, currentAttempt + 1);
                  }
              } else if (cleanResponse.includes('```')) {
                  const match = cleanResponse.match(/```(?:\w+)?\r?\n([\s\S]*?)\r?\n```/);
                  const block = match ? match[1].trim() : cleanResponse.trim();
                  const applyResult: any = await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', filePath, block, this, correctionMsgId, { silent: true, autoSave: true });
                  if (applyResult?.success) {
                      await this.updateMessageContent(correctionMsgId, `🛡️ **Sovereign Shield**: Corrected patch successfully applied to \`${filePath}\`.`);
                      this._failedPatchesRegistry.delete(filePath);
                      return true;
                  }
              } else {
                  await this.updateMessageContent(correctionMsgId, `🛡️ **Sovereign Shield**: AI repair produced an invalid format. Please resolve the conflict manually.`);
              }
              return false;
          } catch (e: any) {
              this.log(`Automated self-correction failed: ${e.message}`, 'ERROR');
              return false;
          }
      }

  
    public updateGeneratingState() {
        if (this._isDisposed || !this.processManager || !this._panel.webview) return;

        const process = this.processManager.getForDiscussion(this.discussionId);
        const activeGen = ChatPanel.activeGenerations.get(this.discussionId);

        const desc = process?.description || "";
        const isBackgroundProcess = desc.toLowerCase().includes("title") || desc.toLowerCase().includes("counting");

        const isGenerating = !!(((process && !isBackgroundProcess) || !!activeGen) && !this._inputResolver);
        const isAgentActive = !!this.agentManager?.getIsActive();
        const showRaiseHand = !!(isAgentActive && process && !isBackgroundProcess);

        let statusText = "Assistant is thinking...";
        if (process && !isBackgroundProcess) statusText = process.description;
        else if (activeGen) statusText = "Assistant is generating...";
        else if (isGenerating && isAgentActive) statusText = "Agent is executing...";

        let buttonLabel: string | undefined = undefined;
        if (desc.toLowerCase().includes("batch") || desc.toLowerCase().includes("applying batch")) {
            buttonLabel = "Stop Batch Application";
        }

        this._panel.webview.postMessage({ 
            command: 'setGeneratingState', 
            isGenerating,
            statusText,
            showRaiseHand,
            buttonLabel
        });
    }
  
  /**
   * Dispatches a blame directive to the Lead Librarian when the Coder attempts
   * to modify files that were omitted from active context [C].
   */
  public async recallLibrarianWithBlame(unpossessedFiles: string[]): Promise<void> {
      if (this._isDisposed || unpossessedFiles.length === 0) return;
      const unpossessedList = unpossessedFiles.join(', ');

      this.log(`[Librarian Blame] Recalling Librarian with blame for omitted files: [${unpossessedList}]`, 'WARN');

      await this.sendMessage({
          id: 'user_blame_librarian_' + Date.now(),
          role: 'user',
          content: `<ask_librarian>
BLAME DIRECTIVE: The Coder attempted to modify existing files that were NOT in its active context [C]:
${unpossessedFiles.map(f => `- \`${f}\``).join('\n')}

LIBRARIAN BLAME: You are the Lead Architect and Context Librarian. You failed to identify and unmute these essential files in <edit_files> in your previous plan.
As a result, the Coder's patches were blocked by the Context Verifier.

MANDATORY ACTIONS:
1. Immediately inspect these files and analyze their dependencies.
2. Evaluate the context token budget. If adding these files exceeds budget, mute non-essential reference files or partition the task (<MultiSteps_TASK>).
3. Put these files into <edit_files> so they are unmuted with full content [C] for the Coder.
4. Issue an updated architectural directive and plan instructing the Coder to implement the changes.
</ask_librarian>`
      });
  }

  /**
   * Dispatches an automated AI repair turn when one or more updates fail during "Apply All" or "Apply All Steps".
   * Resends all failed updates to the LLM with fresh ground-truth disk contents so it produces corrected patches in a new turn.
   */
  public async handleBatchApplyFailures(
      failedItems: Array<{
          change: any;
          error: string;
          filePath: string;
          diskContent: string;
          failingSnippet: string;
          crossFileNotice?: string;
      }>,
      originalMessageId: string
  ): Promise<void> {
      if (this._isDisposed || failedItems.length === 0) return;

      // In Assistant mode, do not trigger automated repair turns
      if (!this._discussionCapabilities.agentMode) {
          this.log(`[Batch Repair] Automated retry skipped in assistant mode.`, 'INFO');
          return;
      }

      const currentAttempts = this._batchRepairAttempts.get(originalMessageId) || 0;
      const MAX_BATCH_REPAIR_ATTEMPTS = 2;

      if (currentAttempts >= MAX_BATCH_REPAIR_ATTEMPTS) {
          this.log(`[Batch Repair] Reached max automated repair attempts (${MAX_BATCH_REPAIR_ATTEMPTS}) for message ${originalMessageId}. Halting automated retry.`, 'WARN');
          await this.addMessageToDiscussion({
              id: 'batch_repair_halted_' + Date.now(),
              role: 'system',
              content: `🛡️ **Batch Apply Repair Halted**
${failedItems.length} update(s) could not be applied after ${MAX_BATCH_REPAIR_ATTEMPTS} attempts:
${failedItems.map(f => `- \`${f.filePath}\`: *${f.error}*`).join('\n')}

*Automated repair halted to protect your token budget. Please inspect the failed block(s) above or use the Raw Block button for manual stitching.*`,
              skipInPrompt: true
          });
          return;
      }

      this._batchRepairAttempts.set(originalMessageId, currentAttempts + 1);
      this.log(`[Batch Repair] Initiating automated AI repair for ${failedItems.length} failed update(s) (Attempt ${currentAttempts + 1}/${MAX_BATCH_REPAIR_ATTEMPTS})...`, 'WARN');

      const noticeMsgId = `batch_repair_notice_${Date.now()}`;
      await this.addMessageToDiscussion({
          id: noticeMsgId,
          role: 'system',
          content: `🛡️ **Batch Apply Partial Failure (${failedItems.length} failed update${failedItems.length > 1 ? 's' : ''})**
The following update(s) failed to match on disk during Apply All:
${failedItems.map(f => `- \`${f.filePath}\`: *${f.error}*`).join('\n')}

*Resending failed updates with current ground-truth disk contents to the AI for automated repair (Attempt ${currentAttempts + 1}/${MAX_BATCH_REPAIR_ATTEMPTS})...*`,
          skipInPrompt: true
      });

      // Itemize each failed update with its exact error, failing patch, and the actual content currently on disk
      const itemizedReports = failedItems.map((item, idx) => {
          const crossNotice = item.crossFileNotice ? `\n> ⚠️ **${item.crossFileNotice}**\n` : '';
          const diskExcerpt = item.diskContent.length > 6000
              ? item.diskContent.substring(0, 6000) + `\n... [truncated at 6000 chars. Total length: ${item.diskContent.length} chars]`
              : item.diskContent;

          return `#### Failed Update ${idx + 1}: \`${item.filePath}\`
**Error Encountered:** ${item.error}${crossNotice}

**Failing Code/Patch Provided Previously:**
\`\`\`diff
${item.failingSnippet}
\`\`\`

**Actual Ground-Truth Content Currently on Disk for \`${item.filePath}\`:**
\`\`\`
${diskExcerpt || '(File is currently empty)'}
\`\`\``;
      }).join('\n\n---\n\n');

      const repairPrompt = `### 🛑 BATCH APPLICATION FAILURE REPORT (${failedItems.length} update${failedItems.length > 1 ? 's' : ''} failed)
The following code updates failed to apply to disk during the "Apply All" execution.

${itemizedReports}

---
### 🛠️ MANDATORY REPAIR INSTRUCTIONS:
1. **MATCH ACTUAL DISK STATE EXACTLY**:
   - For each failed update, inspect the actual ground-truth file content on disk provided above.
   - Your \`<<<<<<< SEARCH\` block MUST be a literal, character-for-character match of the lines currently on disk, including exact indentation (spaces vs tabs) and trailing whitespace.
2. **KEEP SEARCH/REPLACE BLOCKS VERY SHORT**:
   - Keep SEARCH/REPLACE blocks very short and focused (1 to 5 lines of modification with minimal 1-2 line context).
3. **TARGETED SYMBOL REPLACEMENT**:
   - If extensive changes are needed across a class or function, output a targeted symbol replacement instead of a long patch: \`<file path="path/to/file.ext" action="update_symbol" symbol="SymbolName">\`.
4. **CROSS-FILE MISPLACEMENT**:
   - If a failure notice indicates the code belongs to another file, re-target the patch to the correct file path.
5. **OUTPUT FORMAT**:
   - Deliver the corrected code updates inside standard top-level \`<file path="..." action="write|patch|update_symbol">\` XML tags for all failed files so they can be immediately applied.`;

      // Trigger the repair turn asynchronously after the current process unregisters
      setImmediate(async () => {
          await this.sendMessage({
              id: `user_batch_repair_${Date.now()}`,
              role: 'user',
              content: repairPrompt
          });
      });
  }

  /**
   * Resolves a file path across the workspace with direct and fuzzy matching.
   */
  public async resolveWorkspaceFile(filePath: string): Promise<{ relativePath: string; uri: vscode.Uri } | null> {
      if (!filePath) return null;
      const clean = filePath.replace(/\\/g, '/').replace(/^['"`]|['"`]$/g, '').trim();
      const direct = await this._contextManager.resolveWorkspaceFromPath(clean);
      if (direct) {
          try {
              const stat = await vscode.workspace.fs.stat(direct.uri);
              if (stat) return { relativePath: direct.relativePath, uri: direct.uri };
          } catch {}
      }

      // Fuzzy search across all workspace files if direct resolution failed
      const allFiles = await this._contextManager.getWorkspaceFilePaths();
      const base = path.posix.basename(clean).toLowerCase();
      const matched = allFiles.find(f => {
          const normF = f.replace(/\\/g, '/').toLowerCase();
          return normF === clean.toLowerCase() || 
                 normF.endsWith('/' + clean.toLowerCase()) || 
                 path.posix.basename(normF) === base;
      });

      if (matched) {
          const res = await this._contextManager.resolveWorkspaceFromPath(matched);
          if (res) return { relativePath: res.relativePath, uri: res.uri };
      }
      return null;
  }

  public async handleContextVerifierFailure(
      unpossessedFiles: string[],
      isFastMode: boolean,
      signal: AbortSignal,
      processId?: string
  ): Promise<void> {
      if (this._isDisposed || unpossessedFiles.length === 0) return;
      const unpossessedList = unpossessedFiles.join(', ');

      if (isFastMode) {
          // Fast Mode Handling:
          // Check if unpossessed files fit within context size
          let unpossessedTokens = 0;
          for (const f of unpossessedFiles) {
              const res = await this._contextManager.resolveWorkspaceFromPath(f);
              if (res) {
                  try {
                      const st = await vscode.workspace.fs.stat(res.uri);
                      unpossessedTokens += Math.max(1, Math.ceil(st.size / 3.5));
                  } catch {
                      unpossessedTokens += 500;
                  }
              } else {
                  unpossessedTokens += 500;
              }
          }

          const capacity = this._currentDiscussion?.lastTokenMetrics?.contextSize || 128000;
          const isUnlimitedContext = this._discussionCapabilities.ignoreContextSize === true;
          const wouldExceedCapacity = !isUnlimitedContext && (unpossessedTokens + 4000 > capacity);

          if (!wouldExceedCapacity) {
              this.log(`[Context Verifier - Fast Mode] Adding unpossessed files (~${unpossessedTokens} tok; capacity ${capacity} tok). Unmuting and recalling Coder with blame...`, 'INFO');

              await this.unmuteFiles(unpossessedFiles);
              await this._contextManager.getContextStateProvider()?.addFilesToContext(unpossessedFiles);
              this.recordCurrentPromptFiles(unpossessedFiles);
              this.recordPendingJustAddedFiles(unpossessedFiles);
              await this.updateContextAndTokens({ isBackgroundSync: false });

              await this.addMessageToDiscussion({
                  id: 'verifier_fast_' + Date.now(),
                  role: 'system',
                  content: `🛡️ **Context Verifier (Fast Mode)**\nThe Coder attempted to modify files that were not loaded in active context [C]:\n${unpossessedFiles.map(f => `- \`${f}\``).join('\n')}\n\n*Files fit within context size (~${unpossessedTokens.toLocaleString()} tokens). Files have been automatically loaded [C]. Recalling Coder with blame...*`,
                  skipInPrompt: true
              });

              setImmediate(async () => {
                  await this.sendMessage({
                      id: 'user_blame_coder_' + Date.now(),
                      role: 'user',
                      content: `⚠️ **CONTEXT VERIFIER BLAME**: You attempted to modify the following existing files that were NOT in your active context [C]:
${unpossessedFiles.map(f => `- \`${f}\``).join('\n')}

**PROTOCOL VIOLATION**: Modifying existing files not visible under 'LOADED FILE CONTENTS' [C] is strictly forbidden.
These files have now been loaded into your active context with full source code under [C].
Now that you possess these files, please deliver the verified code modifications using standard \`<file path="..." action="write|patch|update_symbol">\` tags.`
                  });
              });
              return;
          } else {
              this.log(`[Context Verifier - Fast Mode] Adding unpossessed files (~${unpossessedTokens} tok) would exceed context size (${capacity} tok). Prompting Coder to request only essential files...`, 'WARN');

              await this.addMessageToDiscussion({
                  id: 'verifier_exceed_' + Date.now(),
                  role: 'system',
                  content: `🛡️ **Context Verifier (Fast Mode)**\nAdding unpossessed files [${unpossessedList}] (~${unpossessedTokens.toLocaleString()} tokens) would exceed context capacity (~${capacity.toLocaleString()} tokens).\n\n*In Fast Mode, you can only use <unmute_files> or <add_files_to_context> for essential files, or solve the task with active files.*`,
                  skipInPrompt: true
              });

              setImmediate(async () => {
                  await this.sendMessage({
                      id: 'user_capacity_notice_' + Date.now(),
                      role: 'user',
                      content: `⚠️ **CONTEXT CAPACITY NOTICE**: The files you attempted to modify [${unpossessedList}] cannot all be loaded because doing so would exceed context capacity (~${capacity.toLocaleString()} tokens).
You may ONLY modify files currently visible under 'LOADED FILE CONTENTS' [C].
If you need to modify files, privilege using <unmute_files> to recover full content (unmute directly upgrades structure-only [D] or muted [M] files to full code [C]). Only use <load_structure> when context is genuinely bloated or files are strictly reference-only.`
                  });
              });
              return;
          }
      }

      // Standard Mode Handling:
      // Show alert box with interactive "Blame Librarian & Recall" button
      const alertHtml = `
<div class="context-verifier-alert" style="margin: 10px 0; padding: 12px 14px; background: rgba(231, 76, 60, 0.08); border: 1.5px solid var(--vscode-charts-red); border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.15);">
    <div style="font-weight: 800; font-size: 12px; color: var(--vscode-charts-red); display: flex; align-items: center; gap: 6px; margin-bottom: 6px;">
        <i class="codicon codicon-shield"></i>
        <span>Context Verifier: Blind Modification Blocked</span>
    </div>
    <div style="font-size: 11px; opacity: 0.9; margin-bottom: 8px; line-height: 1.45;">
        The Coder attempted to modify existing files that are <strong>NOT in active context [C]</strong>:
        <ul style="margin: 4px 0 8px 16px; padding: 0;">
            ${unpossessedFiles.map(f => `<li><code>${f}</code></li>`).join('')}
        </ul>
        <em>Modifying unseen files is strictly forbidden. The Lead Librarian must evaluate dependencies, verify token budget, and load these files before edits can proceed.</em>
    </div>
    <button class="code-action-btn apply-btn blame-librarian-btn" data-files="${encodeURIComponent(JSON.stringify(unpossessedFiles))}" style="background: var(--vscode-charts-red) !important; color: white !important; font-weight: bold; height: 26px; padding: 0 12px;">
        <i class="codicon codicon-warning"></i> Blame Librarian &amp; Recall
    </button>
</div>`;

      await this.addMessageToDiscussion({
          id: 'verifier_alert_' + Date.now(),
          role: 'system',
          content: alertHtml,
          skipInPrompt: true
      });

      // If auto-apply is enabled in capabilities, automatically recall the librarian
      if (this._discussionCapabilities.autoApply) {
          setImmediate(async () => {
              await this.recallLibrarianWithBlame(unpossessedFiles);
          });
      }
  }


  /**
   * Automatically verifies that all files targeted by the Coder in <file> tags
   * either exist in active unmuted context ([C]) OR are brand-new files being created.
   * Modifying existing unseen files on disk is strictly forbidden.
   */
  public async verifyGeneratedPatchContext(content: string): Promise<{ valid: boolean; unpossessedFiles: string[]; targetFiles: string[] }> {
      const { extractFileBlocks, parseFileTagAttributes, normalizePseudoFileBlocks } = require('../../utils');
      const normalized = normalizePseudoFileBlocks(content);
      const blocks = extractFileBlocks(normalized);

      const targetFiles: string[] = [];
      for (const b of blocks) {
          const attrs = parseFileTagAttributes(b.attrStr, b.rawContent);
          if (attrs?.path) {
              const cleanP = attrs.path.includes(':') && !/^[a-zA-Z]:[\\/]/.test(attrs.path) ? attrs.path.split(':')[0] : attrs.path;
              if (!targetFiles.includes(cleanP)) {
                  targetFiles.push(cleanP);
              }
          }
      }

      if (targetFiles.length === 0) {
          return { valid: true, unpossessedFiles: [], targetFiles: [] };
      }

      const provider = this._contextManager.getContextStateProvider();
      const rawIncluded = provider ? provider.getIncludedFiles().filter(f => f && f.path).map(f => f.path.replace(/\\/g, '/').toLowerCase().trim()) : [];
      const currentMuted = (this._currentDiscussion?.mutedFiles || []).map(m => m.replace(/\\/g, '/').toLowerCase().trim());

      const unpossessedFiles: string[] = [];

      for (const tf of targetFiles) {
          const cleanTf = tf.replace(/\\/g, '/').toLowerCase().trim();

          // Check if file is an external reference document
          const { isProjectFile, arePathsEqual } = require('../../utils');
          if (!isProjectFile(tf) || cleanTf.includes('.lollms/external_files')) {
              unpossessedFiles.push(`${tf} (Read-only external reference document - cannot be modified)`);
              continue;
          }

          const isIncluded = rawIncluded.some(inc => arePathsEqual(inc, tf) || inc === cleanTf);
          const isMuted = currentMuted.some(m => arePathsEqual(m, tf) || m === cleanTf);

          if (!isIncluded || isMuted) {
              // Check if file actually exists on disk with content
              let existsOnDisk = false;
              try {
                  const res = await this._contextManager.resolveWorkspaceFromPath(tf);
                  if (res) {
                      const stat = await vscode.workspace.fs.stat(res.uri).catch(() => null);
                      // Only mark as existing if it is an actual file with content (> 0 bytes)
                      if (stat && stat.type === vscode.FileType.File && stat.size > 0) {
                          existsOnDisk = true;
                      }
                  }
              } catch {}

              // 1. If file does NOT exist on disk as a non-empty file, it is a brand-new file creation: ALLOWED!
              if (!existsOnDisk) {
                  continue;
              }

              // 2. If file was created or added during this active prompt or current session: ALLOWED!
              if (this._currentPromptAddedFiles.has(cleanTf) || this._contextManager.isRecentlyAdded(tf)) {
                  continue;
              }

              // 3. Check if blocks targeting this file are creating or initializing the file
              const blocksForTf = blocks.filter(b => {
                  const attrs = parseFileTagAttributes(b.attrStr, b.rawContent);
                  const p = attrs?.path ? (attrs.path.includes(':') && !/^[a-zA-Z]:[\\/]/.test(attrs.path) ? attrs.path.split(':')[0] : attrs.path) : '';
                  return arePathsEqual(p, tf) || p.replace(/\\/g, '/').toLowerCase().trim() === cleanTf;
              });

              const isCreatingOrDeletingFile = blocksForTf.some(b => {
                  const attrs = parseFileTagAttributes(b.attrStr, b.rawContent);
                  if (attrs?.action === 'write' || (attrs?.action as string) === 'delete') return true;
                  // Aider creation hunk with empty search block
                  if (b.rawContent && /<<<<<<< SEARCH\s*\r?\n\s*=======\s*\r?\n/m.test(b.rawContent)) return true;
                  return false;
              });

              if (isCreatingOrDeletingFile) {
                  continue;
              }

              // Otherwise, this is an existing file on disk that the Coder cannot see: FORBIDDEN!
              unpossessedFiles.push(tf);
          }
      }

      return {
          valid: unpossessedFiles.length === 0,
          unpossessedFiles,
          targetFiles
      };
  }

  public updateAgentMode(isActive: boolean) {
  if (this._isDisposed) return;
  if (this._panel.webview) {
      this._panel.webview.postMessage({ command: 'updateAgentMode', isActive });
      this.syncAgentSecurityState(
          this.agentManager?.getSecurityLevel?.() || (this._discussionCapabilities.agentSecurityLevel || 'guarded'),
          this.agentManager?.securityGuard?.getActiveMutationCount() || 0
      );
  }
  }

  public syncAgentSecurityState(level: AgentSecurityLevel, mutationCount: number) {
      if (this._isDisposed || !this._panel?.webview) return;
      this._panel.webview.postMessage({
          command: 'updateAgentSecurityState',
          level,
          mutationCount
      });
  }

  /**
  * Implementation of IAgentUI.runVerificationAgent
  * Spawns a specialized "Guardian" pass to audit code before application.
  */
  public async runVerificationAgent(content: string, signal: AbortSignal): Promise<string> {
  const verifierMsgId = 'verifier_audit_' + Date.now();
  await this.addMessageToDiscussion({
      id: verifierMsgId,
      role: 'system',
      content: `**🛡️ Verifier**\n*Performing logical audit...*`,
      skipInPrompt: true 
  });

  try {
      const model = this._currentDiscussion?.model || this._lollmsAPI.getModelName();
      const systemPrompt = await getProcessedSystemPrompt('verifier' as any);

      const response = await this._lollmsAPI.sendChat([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Audit the following implementation. Identify any functional errors or missing logic. If no errors exist, return the code exactly as provided. Otherwise, provide the corrected version:\n\n${content}` }
      ], null, signal, model);

      const cleanOrig = stripThinkingTags(content).trim();
      const cleanAudit = stripThinkingTags(response).trim();

      const status = cleanOrig === cleanAudit 
          ? `**🛡️ Verifier**\n*Audit complete. Logic verified successfully (VERIFICATION PASSED).*`
          : `**🛡️ Verifier**\n*Audit complete. Identified and corrected logical flaws in the draft (REPAIR APPLIED).*`;

      await this.updateMessageContent(verifierMsgId, status);
      return stripThinkingTags(response);
      } catch (e: any) {
      this.log(`Verifier Agent failed: ${e.message}`, 'WARN');
      await this.updateMessageContent(verifierMsgId, `**🛡️ Verifier**\n*Audit failed: ${e.message}. Falling back to original draft.*`);
      return content; // Fallback to original content if audit fails
      }
  }

  /**
   * Externally update discussion capabilities and sync with UI/Disk.
   * UPGRADED: Syncs folder settings and muting to global workspace state.
   */
  public async updateCapabilities(partial: Partial<DiscussionCapabilities>) {
    if (this._isDisposed) return;
    const normalizedPartial: Partial<DiscussionCapabilities> = { ...partial };
    if (normalizedPartial.requireExplicitEndTag === true) {
        normalizedPartial.autoApply = true;
        normalizedPartial.autoExecuteScouting = true;
        (normalizedPartial as any).autoExecuteTools = true;
        (normalizedPartial as any).autoMode = true;
    }
    this._discussionCapabilities = { ...this._discussionCapabilities, ...normalizedPartial };
    if (partial.mutedFiles !== undefined && this._currentDiscussion) {
        this._currentDiscussion.mutedFiles = [...partial.mutedFiles];
        this._discussionCapabilities.mutedFiles = [...partial.mutedFiles];
    }

    // --- GLOBAL WORKSPACE SYNC ---
    if (partial.folderSettings !== undefined) {
        await this._discussionManager.context.workspaceState.update('lollms_global_folder_settings', partial.folderSettings);
    }
    // Muting project context is discussion-specific to enable concurrent discussions with unique muting patterns

    // Persist and Notify
    await this.saveCapabilities();
    const { AGENT_MISSION_PROFILES } = require('../../registries/agentProfiles');
    this._panel.webview.postMessage({ 
        command: 'updateDiscussionCapabilities', 
        capabilities: this._discussionCapabilities,
        agentProfiles: AGENT_MISSION_PROFILES
    });
  }
  
  public displayPlan(plan: any | null): void {
      if (this._isDisposed) return;
      if (this._panel.webview) {
        this._panel.webview.postMessage({ command: 'displayPlan', plan: plan });
      }
  }
  
  public showDebugLog() { this.showInternalLog(); }
  public showInternalLog() {
      const content = this._executionLogs.length > 0 ? this._executionLogs.join('\n') : 'No logs available for this session.';
      InfoPanel.createOrShow(this._extensionUri, "Discussion Log", `\`\`\`log\n${content}\n\`\`\``);
  }
  public async updateMessageContent(messageId: string, newContent: string, persist: boolean = true) {
      if (!this._currentDiscussion) return;

      const isAgentStep = !!(this._activeAgentAnswerId && (messageId.startsWith('agent_task_') || messageId.startsWith('agent_step_')));
      const targetId = isAgentStep ? this._activeAgentAnswerId! : messageId;

      const msg = this._currentDiscussion.messages.find(m => m.id === targetId);
      if (msg) {
          if (isAgentStep) {
              const status = newContent.includes('❌') || newContent.includes('Failure') ? 'failed' : 'done';
              const type = newContent.includes('Test Worker') ? 'exec' : (newContent.includes('Audit Worker') ? 'verify' : 'tool');
              const titleMatch = newContent.match(/Step \d+:\s*(?:\[[^\]]*\]\s*)?`?([^`\n(]+)`?/);
              const title = titleMatch ? titleMatch[1].trim() : `Step ${messageId.replace(/agent_(task|step)_/, '')}`;
              const roundTag = `<agent_round type="${type}" title="${title}" status="${status}">\n${newContent}\n</agent_round>`;
              if (typeof msg.content === 'string') {
                  msg.content = msg.content ? `${msg.content}\n\n${roundTag}` : roundTag;
              }
          } else if (typeof newContent === 'string' && newContent.startsWith('APPEND_TAG:')) {
              const tag = newContent.substring(11);
              if (typeof msg.content === 'string' && !msg.content.includes(tag)) {
                  const sep = msg.content.length === 0 ? '' : (msg.content.endsWith('\n\n') ? '' : (msg.content.endsWith('\n') ? '\n' : '\n\n'));
                  msg.content = msg.content + sep + tag.trimStart();
              }
          } else {
              msg.content = newContent;
          }

          if (msg && this._currentDiscussion.llmHistory) {
              const llmMsg = this._currentDiscussion.llmHistory.find(m => m.id === targetId);
              if (llmMsg && llmMsg !== msg) {
                  llmMsg.content = msg.content;
              }
          }
          if (persist && !this._currentDiscussion.id.startsWith('temp-')) {
              await this._discussionManager.saveDiscussion(this._currentDiscussion);
          }
      } else if (messageId) {
          // Materialize the agent round as a new message so it renders in the same chat panel
          const isRoundId = messageId.startsWith('agent_') || messageId.startsWith('verifier_') || messageId.startsWith('debug_') || messageId.startsWith('lib_');
          if (isRoundId) {
              const roundMessage: ChatMessage = {
                  id: messageId,
                  role: 'assistant',
                  content: newContent,
                  model: this._currentDiscussion.model || this._lollmsAPI.getModelName(),
                  personalityName: '🤖 Agent Round',
                  timestamp: Date.now()
              };
              this._currentDiscussion.messages.push(roundMessage);
              if (!this._currentDiscussion.id.startsWith('temp-')) {
                  await this._discussionManager.saveDiscussion(this._currentDiscussion);
              }
          }
      }
      if (this._panel.webview && !this._isDisposed) {
          this._panel.webview.postMessage({ command: 'updateMessage', messageId: targetId, newContent: msg ? msg.content : newContent, isFinal: persist });
      }
  }

  /**
   * Appends an <agent_round> block into the active agent answer message (embedded single-block contract).
   * Falls back to the explicitly provided target id. No-op when no agent turn is active.
   */
  private appendAgentRound(roundBlock: string, targetMessageId?: string): string | undefined {
      const targetId = targetMessageId || this._activeAgentAnswerId;
      if (!targetId) return undefined;
      void this.updateMessageContent(targetId, 'APPEND_TAG:' + roundBlock);
      return targetId;
  }

  /** Resolves a pending inline agent question and records the Q&A as a round in the same answer block. */
  private resolvePendingAgentQuestion(answer: string): void {
      const pending = this._pendingAgentQuestion;
      if (!pending) return;
      this._pendingAgentQuestion = undefined;
      const safeTitle = pending.question.replace(/[\r\n]+/g, ' ').slice(0, 120);
      const roundBlock = `<agent_round type="question" title="${safeTitle}" status="done">\n**Q:** ${pending.question}\n\n**A:** ${answer}\n</agent_round>`;
      this.appendAgentRound(roundBlock, pending.messageId);
      pending.resolve(answer);
      this.updateGeneratingState();
  }

  /** Rejects a pending inline agent question (user stop / abort) and unlocks the webview composer. */
  private cancelPendingAgentQuestion(reason: string): void {
      const pending = this._pendingAgentQuestion;
      if (!pending) return;
      this._pendingAgentQuestion = undefined;
      if (this._panel.webview && !this._isDisposed) {
          this._panel.webview.postMessage({ command: 'agentQuestion', messageId: pending.messageId, canceled: true });
      }
      pending.reject(new Error(reason));
      this.updateGeneratingState();
  }
  public async updateAppliedState(messageId: string, blockIdx: number, hunkIdx?: number, isUndo: boolean = false) {
      if (!this._currentDiscussion || !messageId) return;

      if (!this._currentDiscussion.appliedState) this._currentDiscussion.appliedState = {};
      if (!this._currentDiscussion.appliedState[messageId]) this._currentDiscussion.appliedState[messageId] = {};

      const msgState = this._currentDiscussion.appliedState[messageId];

      if (!msgState[blockIdx]) msgState[blockIdx] = [];

      if (isUndo) {
          const valToRemove = hunkIdx !== undefined ? hunkIdx : -1;
          msgState[blockIdx] = msgState[blockIdx].filter(v => v !== valToRemove);
          // If the block is now empty and was previously marked full (-1), check if we need to remove -1
          if (hunkIdx !== undefined && msgState[blockIdx].includes(-1)) {
               msgState[blockIdx] = msgState[blockIdx].filter(v => v !== -1);
          }
      } else {
          if (hunkIdx !== undefined) {
              if (!msgState[blockIdx].includes(hunkIdx)) msgState[blockIdx].push(hunkIdx);
          } else {
              msgState[blockIdx] = [-1]; 
          }
      }

      if (!this._currentDiscussion.id.startsWith('temp-')) {
          await this._discussionManager.saveDiscussion(this._currentDiscussion);
      }
  }

    public async loadDiscussion(): Promise<void> {
          if (this._isDisposed || !this._panel || !this._panel.webview) return;

          // Immediately display responsive blurry overlay and spinner in webview
          this._panel.webview.postMessage({
              command: 'showDiscussionLoader',
              title: this._currentDiscussion?.title ? `Loading "${this._currentDiscussion.title}"...` : 'Loading discussion...'
          });

          // Guard against accessing properties of a webview panel that is already disposed
          try {
              if ((this._panel as any)._disposed === true || !this._panel.title) {
                  this.dispose();
                  return;
              }
          } catch (e) {
              this.dispose();
              return;
          }

          if (!this._currentDiscussion || this._currentDiscussion.id !== this.discussionId) {
              let discussion: Discussion | null;
              if (this.discussionId.startsWith('temp-')) {
                  if (this._currentDiscussion && Array.isArray(this._currentDiscussion.messages) && this._currentDiscussion.messages.length > 0) {
                      discussion = this._currentDiscussion;
                      discussion.id = this.discussionId;
                  } else {
                  const preciseTokenization = vscode.workspace.getConfiguration('lollmsVsCoder').get<boolean>('preciseTokenization', false);
                  const inheritedMuted = this._discussionManager.getLastMutedFiles();
                  const globalIncluded = this._contextManager?.getContextStateProvider()?.getIncludedFiles() || [];
                  discussion = {
                      id: this.discussionId,
                      title: 'Temporary Discussion',
                      messages: [],
                      timestamp: Date.now(),
                      groupId: null,
                      plan: null,
                      capabilities: { 
                          ...this._discussionCapabilities, 
                          agentMode: false, 
                          preciseTokenization, 
                          useLibrarian: this._discussionCapabilities.useLibrarian === true,
                          mutedFiles: [...inheritedMuted],
                          includedFiles: JSON.parse(JSON.stringify(globalIncluded))
                      } as any, 
                      personalityId: 'default_coder',
                      importedSkills: [],
                      mutedFiles: [...inheritedMuted]
                  };
                  (discussion as any).includedFiles = JSON.parse(JSON.stringify(globalIncluded));
                  }
              } else {
                  discussion = await this._discussionManager.getDiscussion(this.discussionId);
              }

              if (discussion) {
                  if (!discussion.messages || !Array.isArray(discussion.messages)) {
                      discussion.messages = [];
                  }

                  discussion.messages.forEach(msg => {
                      if (!msg.id) {
                          msg.id = Date.now().toString() + Math.random().toString(36).substring(2);
                      }
                  });

                  if (!('plan' in discussion)) {
                      discussion.plan = null;
                  }

                  if (discussion.capabilities) {
                      this._discussionCapabilities = discussion.capabilities;
                  } else {
                      discussion.capabilities = this._discussionCapabilities;
                  }

                  if (!discussion.personalityId) {
                      discussion.personalityId = 'default_coder';
                  }

                  if (!discussion.importedSkills) {
                      discussion.importedSkills = [];
                  }

                  if (!discussion.mutedFiles) {
                      discussion.mutedFiles = [];
                  }
                  if (!discussion.mutedTools) {
                      discussion.mutedTools = [];
                  }
                  if (!discussion.mutedSkills) {
                      discussion.mutedSkills = [];
                  }
                  if (!discussion.mutedDiagrams) {
                      discussion.mutedDiagrams = [];
                  }

                  this._currentDiscussion = discussion;
                  if (Array.isArray(discussion.mutedFiles)) {
                      this._discussionManager.saveLastMutedFiles(discussion.mutedFiles).catch(() => {});
                  }

                  if (this._panel) {
                      this._panel.title = this._currentDiscussion.title;
                  }

                  if (this.agentManager) {
                      const savedAgentMode = !!this._discussionCapabilities.agentMode;
                      if (this.agentManager.getIsActive() !== savedAgentMode) {
                          (this.agentManager as any).isActive = savedAgentMode;
                      }
                  }
              } else {
                  this.log(`Discussion ${this.discussionId} not found.`, 'ERROR');
                  if (this._panel && this._panel.webview && !this._isDisposed) {
                      this._panel.webview.postMessage({ command: 'updateTokenProgress' });
                  }
                  vscode.window.showErrorMessage(`Lollms: Could not load discussion ${this.discussionId}. It may have been deleted.`);
                  this.dispose();
                  return;
              }
          }

          if (this._currentDiscussion) {
              if (!Array.isArray(this._currentDiscussion.mutedFiles)) {
                  this._currentDiscussion.mutedFiles = Array.isArray(this._discussionCapabilities?.mutedFiles)
                      ? [...this._discussionCapabilities.mutedFiles]
                      : [];
              }
              this._discussionCapabilities.mutedFiles = [...this._currentDiscussion.mutedFiles];

              const globalIncluded = this._contextManager?.getContextStateProvider()?.getIncludedFiles() || [];
              if (!(this._currentDiscussion as any).includedFiles) {
                  (this._currentDiscussion as any).includedFiles = JSON.parse(JSON.stringify(globalIncluded));
              } else {
                  (this._currentDiscussion as any).includedFiles = this.reconcileDiscussionFiles(
                      globalIncluded,
                      (this._currentDiscussion as any).includedFiles
                  );
              }
              if (this._discussionCapabilities) {
                  (this._discussionCapabilities as any).includedFiles = (this._currentDiscussion as any).includedFiles;
              }
          }

          if (!this._isWebviewReady) {
              this.log("Webview not ready, queuing load.");
              this._isLoadPending = true;
              return;
          }
          this._isLoadPending = false;

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const isInspectorEnabled = config.get<boolean>('enableCodeInspector', true);
        const visibilityPresets = this._discussionManager.context.workspaceState.get<Record<string, string[]>>('lollms_saved_mute_patterns') || {};

        const { SYSTEM_RESPONSE_PROFILES } = require('../../utils');
        const systemProfiles = Array.isArray(SYSTEM_RESPONSE_PROFILES) ? SYSTEM_RESPONSE_PROFILES : [];
        const rawProfiles = config.get<any[]>('responseProfiles') || [];
        const userProfiles = (Array.isArray(rawProfiles) ? rawProfiles : []).filter((p: any) => p && p.id);
        const allProfiles = [...systemProfiles, ...userProfiles.filter((p: any) => !systemProfiles.some((sp: any) => sp.id === p.id))];

        // --- PHASE 1: IMMEDIATE DISCUSSION MATERIALIZATION (NO BLOCKING I/O) ---
        const currentP = this._personalityManager?.getPersonality(this._currentDiscussion.personalityId || 'default_coder');
        const safeMessages = (this._currentDiscussion.messages || []).map(m => {
            if (!m.id) {
                m.id = 'msg_' + Date.now() + Math.random().toString(36).substring(2, 9);
            }
            return {
                ...m,
                id: m.id,
                personalityName: m.role === 'assistant' 
                    ? (m.personalityName || currentP?.name || 'Lollms Coder (Default)') 
                    : undefined,
                isPastedAsAi: (m as any).isPastedAsAi === true
            };
        });

        const workspaceFolders = (vscode.workspace.workspaceFolders ||[]).map(f => ({
            name: f?.name || "Workspace",
            uri: f?.uri?.toString() || ""
        })).filter(item => item.uri !== "");

        const { AGENT_MISSION_PROFILES } = require('../../registries/agentProfiles');
        const { getUserPreferenceProfiles } = require('../../registries/profiles');
        const userPrefProfiles = getUserPreferenceProfiles(config);

        // Immediately update capabilities and render discussion layout on the main thread
        this._panel.webview.postMessage({
            command: 'updateDiscussionCapabilities',
            capabilities: this._discussionCapabilities,
            userPreferenceProfiles: userPrefProfiles,
            profiles: allProfiles
        });

        if (this._personalityManager) {
            const allPersonalities = this._personalityManager.getPersonalities().map(p => ({
                id: p.id,
                name: p.name,
                description: p.description,
                icon: p.icon,
                category: p.category,
                author: p.author,
                version: p.version,
                tools: this._personalityManager?.getEffectiveTools(p.id) || [],
                skills: this._personalityManager?.getEffectiveSkills(p.id) || []
            }));

            this._panel.webview.postMessage({
                command: 'updatePersonalities',
                personalities: allPersonalities,
                currentPersonalityId: this._currentDiscussion.personalityId || 'default_coder'
            });
        }

        this._panel.webview.postMessage({ 
            command: 'loadDiscussion', 
            messages: safeMessages,
            lastTokenMetrics: this._currentDiscussion.lastTokenMetrics,
            isInspectorEnabled: isInspectorEnabled,
            agentMode: !!this._discussionCapabilities.agentMode,
            appliedState: this._currentDiscussion.appliedState || {},
            currentModel: this._currentDiscussion.model || this._lollmsAPI.getModelName(),
            currentTemperature: this._discussionCapabilities.enableTemperature ? (this._discussionCapabilities.temperature ?? 0.7) : undefined,
            currentMaxTokens: this._discussionCapabilities.enableMaxTokens ? (this._discussionCapabilities.maxTokens ?? 4096) : undefined,
            currentReasoningEffort: this._discussionCapabilities.reasoningEffort || 'none',
            workspaceFolders: workspaceFolders,
            agentProfiles: AGENT_MISSION_PROFILES,
            userPreferenceProfiles: userPrefProfiles,
            profiles: allProfiles,
            visibilityPresets: visibilityPresets,
            mutedFiles: this._currentDiscussion.mutedFiles || [],
            initialPrompt: this._initialPrompt,
            initialImages: this._initialImages
        });
        this._initialPrompt = undefined;
        this._initialImages = undefined;

        const isDiscussionEmpty = !this._currentDiscussion || this._currentDiscussion.messages.length === 0;
        if (this._shouldOpenWizardOnLoad && isDiscussionEmpty) {
            this._shouldOpenWizardOnLoad = false;
            const { getAvailableContextSelections } = require('../contextCommands');
            const savedSelections = await getAvailableContextSelections();
            const provider = this._contextManager?.getContextStateProvider();
            const activeFiles = provider ? provider.getIncludedFiles() : [];
            const activeMuted = this._currentDiscussion?.mutedFiles ?? this._discussionManager.getLastMutedFiles();
            this._panel.webview.postMessage({
                command: 'openNewDiscussionWizard',
                selections: savedSelections,
                files: activeFiles,
                mutedFiles: activeMuted
            });
        }

        // --- PHASE 2: DEFERRED CONTEXT ASSEMBLY & DISK I/O (NON-BLOCKING) ---
        setImmediate(async () => {
            if (this._isDisposed || !this._panel || !this._panel.webview) return;

            if (this._contextManager) {
                const cachedContext = this._contextManager.getLastContext(this.discussionId);
                let includedFiles: string[] = [];
                try {
                    const provider = this._contextManager.getContextStateProvider();
                    const rawFiles = provider ? provider.getIncludedFiles() : [];
                    const reconciledLoadFiles = this.reconcileDiscussionFiles(
                        rawFiles,
                        (this._currentDiscussion as any)?.includedFiles
                    );
                    const filesWithWeights = await Promise.all(reconciledLoadFiles.map(async f => {
                        let bytes = f.bytes || 0;
                        let tokens = f.tokens || 0;
                        let mtime = f.mtime || 0;
                        const cached = (this._contextManager as any)._fileContentCache?.get(f.path);
                        if (cached?.content) {
                            bytes = cached.size || cached.content.length;
                            tokens = Math.ceil(cached.content.length / 3.5);
                            mtime = cached.mtime || mtime;
                        } else if (bytes === 0 || mtime === 0) {
                            const res = await this._contextManager.resolveWorkspaceFromPath(f.path);
                            if (res) {
                                try {
                                    const st = await vscode.workspace.fs.stat(res.uri);
                                    bytes = st.size;
                                    tokens = Math.ceil(st.size / 3.5);
                                    mtime = st.mtime;
                                } catch {}
                            }
                        }
                        if (tokens === 0 && bytes > 0) {
                            tokens = Math.max(1, Math.ceil(bytes / 3.5));
                        }
                        return { path: f.path, bytes, tokens, mtime, state: f.state };
                    }));
                    includedFiles = filesWithWeights as any;
                } catch (e) {
                    Logger.warn("Safeguard caught error reading included files.");
                }
                const projectSkills = await this._contextManager.getActiveProjectSkills();
                const discussionSkills = this._currentDiscussion?.importedSkills || [];

                const allSkillIds = Array.from(new Set([...projectSkills, ...discussionSkills]));
                const UI_PREVIEW_LIMIT = 10000;

                const { getAvailableContextSelections } = require('../contextCommands');
                const savedSelections = (await getAvailableContextSelections()).map((s: any) => s.fileName);
                let workspaceFiles: string[] = [];
                try {
                    workspaceFiles = await this._contextManager.getWorkspaceFilePaths();
                } catch {}

                if (cachedContext) {
                    const contextTextToSend = cachedContext.text.length > UI_PREVIEW_LIMIT 
                        ? cachedContext.text.substring(0, UI_PREVIEW_LIMIT) + `\n\n... [Preview truncated for UI performance. Total: ${cachedContext.text.length} chars]`
                        : cachedContext.text;

                    const isAssistant = !this._discussionCapabilities.agentMode && !this._discussionCapabilities.dynamicMode;
                    const discussionTools = isAssistant ? [] : (this._currentDiscussion?.importedTools || []);
                    const projectTools = isAssistant ? [] : await this._contextManager.getActiveProjectTools();
                    const allEquippedNames = Array.from(new Set([...discussionTools, ...projectTools]));
                    const equippedTools = isAssistant ? [] : this.agentManager.getTools()
                        .filter(t => allEquippedNames.includes(t.name))
                        .map(t => ({ name: t.name, description: t.description }));

                    this._panel.webview.postMessage({ 
                        command: 'updateContext', 
                        context: contextTextToSend,
                        files: includedFiles,
                        projectTree: cachedContext.projectTree || '',
                        skills: cachedContext.importedSkills || [],
                        tools: equippedTools || [],
                        diagrams: cachedContext.diagrams || [],
                        mutedFiles: this._currentDiscussion?.mutedFiles || [],
                        mutedTools: this._currentDiscussion?.mutedTools || [],
                        mutedSkills: this._currentDiscussion?.mutedSkills || [],
                        mutedDiagrams: this._currentDiscussion?.mutedDiagrams || [],
                        briefing: this._contextManager.renderBriefing(this._currentDiscussion),
                        selections: savedSelections,
                        workspaceFiles,
                        governorReport: cachedContext.governorReport || await this._contextManager.getStructureGuide()
                    });
                    this._panel.webview.postMessage({ command: 'updateImageContext', images: cachedContext.images });
                } else {
                    this._panel.webview.postMessage({ 
                        command: 'updateContext', 
                        context: '', 
                        files: includedFiles,
                        skills: allSkillIds.map(id => ({ id, name: '...' })),
                        diagrams: (this._currentDiscussion?.activeDiagrams || []).map(type => ({ type, mermaid: '' })),
                        mutedFiles: this._currentDiscussion?.mutedFiles || [],
                        briefing: this._currentDiscussion?.discussion_data_zone || "",
                        selections: savedSelections,
                        workspaceFiles
                    });
                }

                // Immediate token hydration from file weights so HUD never hangs
                let totalFileTokens = 0;
                const { isProjectFile, arePathsEqual: arePathsEqualHydrate } = require('../../utils');
                const currentMutedHydrate = this._currentDiscussion?.mutedFiles || [];
                includedFiles.forEach((f: any) => {
                    const isMuted = currentMutedHydrate.some(m => arePathsEqualHydrate(m, f.path));
                    if (!isMuted) {
                        totalFileTokens += f.tokens || 0;
                    }
                });

                const finalSize = getContextLimitForModel(this._currentDiscussion?.model || this._lollmsAPI.getModelName());
                let initialCodeTokens = 0;
                let initialExternalTokens = 0;
                includedFiles.forEach((f: any) => {
                    const isMuted = currentMutedHydrate.some(m => arePathsEqualHydrate(m, f.path));
                    if (!isMuted) {
                        const tok = f.tokens || Math.max(1, Math.ceil((f.bytes || 100) / 3.5));
                        if (isProjectFile(f.path)) initialCodeTokens += tok;
                        else initialExternalTokens += tok;
                    }
                });

                const metricsToSend = this._currentDiscussion?.lastTokenMetrics || {
                    total: totalFileTokens + 3500,
                    contextSize: finalSize,
                    segments: {
                        system: 2000,
                        briefing: 0,
                        tree: 1000,
                        skills: 0,
                        memory: 0,
                        diagrams: 0,
                        files: initialCodeTokens,
                        external: initialExternalTokens,
                        history: 500,
                        images: 0
                    }
                };

                this._panel.webview.postMessage({
                    command: 'updateTokenProgress',
                    totalTokens: metricsToSend.total,
                    contextSize: metricsToSend.contextSize,
                    isApproximate: true,
                    segments: metricsToSend.segments,
                    files: includedFiles
                });
            }
        });

        this._panel.webview.postMessage({ 
            command: 'updateDiscussionCapabilities', 
            capabilities: this._discussionCapabilities 
        });

        const activeGen = ChatPanel.activeGenerations.get(this.discussionId);
        if (activeGen) {
            this.log(`Reconnecting to active generation for ${this.discussionId}`);

            const tempMsg: ChatMessage = {
                id: activeGen.messageId,
                role: 'assistant',
                content: activeGen.buffer,
                model: activeGen.model,
                startTime: activeGen.startTime
            };
            this._panel.webview.postMessage({ command: 'addMessage', message: tempMsg });

            if (!this._activeGenerationListener || !activeGen.listeners.has(this._activeGenerationListener)) {
                this.log("Attaching new listeners for active generation");

                const listener = (chunk: string) => {
                    if (!this._isDisposed && this._panel.webview) {
                        this._panel.webview.postMessage({ 
                            command: 'appendMessageChunk', 
                            id: activeGen.messageId, 
                            chunk: chunk 
                        });
                    }
                };

                const completionListener = (fullContent: string) => {
                    if (!this._isDisposed && this._panel.webview) {
                        this._panel.webview.postMessage({ 
                            command: 'finalizeMessage', 
                            id: activeGen.messageId, 
                            fullContent: fullContent 
                        });
                        this.updateGeneratingState();
                        this._activeGenerationListener = undefined;
                        this._activeGenerationCompleteListener = undefined;
                    }
                };

                this._activeGenerationListener = listener;
                this._activeGenerationCompleteListener = completionListener;

                activeGen.listeners.add(listener);
                activeGen.onComplete.add(completionListener);
            }

            this.updateGeneratingState();
        }

        setImmediate(async () => {
            if (this._isDisposed || !this._panel || !this._panel.webview) return;
            let isRepo = false;
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (workspaceFolder && this._gitIntegration) {
                isRepo = await this._gitIntegration.isGitRepo(workspaceFolder);
            }
            if (this._isDisposed || !this._panel || !this._panel.webview) return;
            this._panel.webview.postMessage({ command: 'updateGitRepoStatus', isRepo: isRepo });

            if (this._discussionCapabilities.gitWorkflow && workspaceFolder) {
                this.sendGitBranchState(workspaceFolder);
            }
        });

        if (this._personalityManager) {
            const allPersonalities = this._personalityManager.getPersonalities().map(p => ({
                id: p.id,
                name: p.name,
                description: p.description,
                icon: p.icon,
                category: p.category,
                tools: this._personalityManager?.getEffectiveTools(p.id) || [],
                skills: this._personalityManager?.getEffectiveSkills(p.id) || []
            }));

            this._panel.webview.postMessage({
                command: 'updatePersonalities',
                personalities: allPersonalities,
                currentPersonalityId: this._currentDiscussion.personalityId
            });
        }

        this.displayPlan(this._currentDiscussion.plan);

        const isGenerating = !!this.processManager.getForDiscussion(this.discussionId);
        if (isGenerating) {
            this.updateGeneratingState();
        }

        if (this._currentDiscussion?.lastTokenMetrics) {
            const m = this._currentDiscussion.lastTokenMetrics;

            const provider = this._contextManager.getContextStateProvider();
            const safeFiles = provider ? provider.getIncludedFiles().filter(f => f && f.path) : [];

            this._panel.webview.postMessage({ 
                command: 'updateContext', 
                tools: m.activeTools || [],
                skills: m.activeSkills || [],
                files: safeFiles
            });

            this._panel.webview.postMessage({
                command: 'updateTokenProgress',
                totalTokens: m.total,
                contextSize: m.contextSize,
                isApproximate: false,
                segments: m.segments,
                files: safeFiles
            });

            this._panel.webview.postMessage({ command: 'tokenCalculationFinished' });
        }  

        // Ensure HUD model selector is hydrated on every discussion load/switch
        this._fetchAndSetModels(false).catch(() => {});

        // Fast background sync deferred past initial webview paint
        setTimeout(async () => {
            if (this._panel && this._panel.webview && !this._isDisposed) {
                this.updateContextAndTokens({ isBackgroundSync: true });
            }
        }, 400);
    }

  public recordCurrentPromptFiles(files: string[]) {
      for (const f of files) {
          if (f) {
              this._currentPromptAddedFiles.add(f.replace(/\\/g, '/').toLowerCase().trim());
          }
      }
  }

  public recordPendingJustAddedFiles(files: string[]) {
      for (const f of files) {
          if (f) {
              this._pendingJustAddedFiles.add(f.replace(/\\/g, '/').trim());
          }
      }
  }

  private getCurrentPromptFiles(): Set<string> {
      const files = new Set<string>();
      for (const f of this._currentPromptAddedFiles) {
          files.add(f.replace(/\\/g, '/').toLowerCase().trim());
      }
      if (!this._currentDiscussion) return files;
      const msgs = this._currentDiscussion.messages || [];
      const lastUserIdx = [...msgs].reverse().findIndex(m => 
          m.role === 'user' && 
          !m.skipInPrompt && 
          (typeof m.content === 'string' ? !m.content.startsWith('FORM_SUBMISSION:') && !m.content.startsWith('STOP_REQUESTED') : true)
      );
      const actualUserIdx = lastUserIdx === -1 ? -1 : (msgs.length - 1 - lastUserIdx);

      const searchSlice = actualUserIdx !== -1 ? msgs.slice(actualUserIdx) : msgs.slice(-4);
      for (const m of searchSlice) {
          const text = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(p => p.text || '').join('\n') : '');
          if (!text) continue;
          const addMatch = text.match(/<add_files_to_context\b[^>]*?>([\s\S]*?)<\/add_files_to_context>/gi);
          if (addMatch) {
              for (const match of addMatch) {
                  const inner = match.replace(/<\/?add_files_to_context\b[^>]*?>/gi, '');
                  inner.split(/[\r\n,]+/).map(p => p.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).forEach(p => files.add(p.replace(/\\/g, '/').toLowerCase().trim()));
              }
          }
          const unmuteMatch = text.match(/<unmute_files\b[^>]*?>([\s\S]*?)<\/unmute_files>/gi);
          if (unmuteMatch) {
              for (const match of unmuteMatch) {
                  const inner = match.replace(/<\/?unmute_files\b[^>]*?>/gi, '');
                  inner.split(/[\r\n,]+/).map(p => p.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).forEach(p => files.add(p.replace(/\\/g, '/').toLowerCase().trim()));
              }
          }
      }
      return files;
  }

  private getPreviousTurnFiles(): Set<string> {
      const files = new Set<string>();
      for (const f of this._currentPromptAddedFiles) {
          files.add(f.replace(/\\/g, '/').toLowerCase().trim());
      }
      if (!this._currentDiscussion) return files;
      const msgs = this._currentDiscussion.messages || [];
      const recentMsgs = msgs.slice(-6);
      for (const m of recentMsgs) {
          const text = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(p => p.text || '').join('\n') : '');
          if (!text) continue;
          const addMatch = text.match(/<add_files_to_context\b[^>]*?>([\s\S]*?)<\/add_files_to_context>/gi);
          if (addMatch) {
              for (const match of addMatch) {
                  const inner = match.replace(/<\/?add_files_to_context\b[^>]*?>/gi, '');
                  inner.split(/[\r\n,]+/).map(p => p.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).forEach(p => files.add(p.replace(/\\/g, '/').toLowerCase().trim()));
              }
          }
          const unmuteMatch = text.match(/<unmute_files\b[^>]*?>([\s\S]*?)<\/unmute_files>/gi);
          if (unmuteMatch) {
              for (const match of unmuteMatch) {
                  const inner = match.replace(/<\/?unmute_files\b[^>]*?>/gi, '');
                  inner.split(/[\r\n,]+/).map(p => p.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).forEach(p => files.add(p.replace(/\\/g, '/').toLowerCase().trim()));
              }
          }
          const fileMatch = text.match(/^[ \t]*<file\s+([^>]*?)>/gim);
          if (fileMatch) {
              for (const fm of fileMatch) {
                  const pathMatch = fm.match(/path=["']([^"']+)["']/i);
                  const pVal = pathMatch ? pathMatch[1].trim().replace(/\\/g, '/').toLowerCase() : '';
                  if (pVal && pVal !== '...' && !pVal.startsWith('path/to/') && isValidFilePath(pVal)) {
                      files.add(pVal);
                  }
              }
          }
      }
      return files;
  }

  public async sendGitBranchState(folder: vscode.WorkspaceFolder) {
      if (!this._gitIntegration) return;
      try {
          const branch = await this._gitIntegration.getCurrentBranch(folder);
          this._panel.webview.postMessage({ command: 'updateGitState', branch });
      } catch (e) {
          this.log(`Error fetching git branch: ${e}`, 'WARN');
      }
  }

  private getCurrentPersona(): any {
      if (this._personalityManager && this._currentDiscussion) {
          const pId = this._currentDiscussion.personalityId || 'default_coder';
          return this._personalityManager.getPersonality(pId);
      }
      return null;
  }

  /**
   * Helper to retrieve the active system prompt for the current personality.
   */
  private getCurrentPersonaSystemPrompt(): string {
      const persona = this.getCurrentPersona();
      return persona ? persona.systemPrompt : "";
  }

  private updateThinkTimingsFromBuffer(
      buffer: string,
      timings: Array<{ start: number; end?: number }>,
      firstTokenTime?: number
  ): void {
      if (!buffer) return;
      const scannable = buffer
          .replace(/<file\b[^>]*>[\s\S]*?(?:<\/file>|$)/gi, '')
          .replace(/```[\s\S]*?(?:```|$)|`[^`\r\n]+`/g, '');
      const openCount = (scannable.match(/<(?:think|thinking|thought|analysis|reasoning)\b[^>]*>/gi) || []).length;
      const closeCount = (scannable.match(/<\/(?:think|thinking|thought|analysis|reasoning)\s*>/gi) || []).length;
      const now = Date.now();

      if (closeCount > openCount && timings.length === 0) {
          timings.push({ start: firstTokenTime || now, end: now });
          return;
      }
      while (timings.length < openCount) {
          timings.push({ start: now });
      }
      for (let i = 0; i < Math.min(closeCount, timings.length); i++) {
          if (timings[i].end === undefined) {
              timings[i].end = now;
          }
      }
  }

  private finalizeThinkTimings(timings: Array<{ start: number; end?: number }>): number[] {
      const now = Date.now();
      return timings.map(t => Math.max(0, (t.end ?? now) - t.start));
  }

  private async _fetchAndSetModels(forceRefresh: boolean = false) {
    if (this._isDisposed) return;
    try {
        if (!this._panel.webview) return;
        let models: Array<{ id: string; name?: string; server?: string }> = [];
        let fetchFailed = false;
        try {
            models = await this._lollmsAPI.getModels(forceRefresh);
        } catch (error: any) {
            fetchFailed = true;
            this.log(`Failed to fetch models: ${error.message}`, 'WARN');
        }

        const activeModel = this._currentDiscussion?.model || this._lollmsAPI.getModelName();
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const { isModelVisionCapable } = require('../../utils');
        const modelsWithVision = (models || []).map(m => ({
            ...m,
            hasVision: isModelVisionCapable(m.id, config)
        }));

        const preserveOnEmpty = fetchFailed && this._lollmsAPI.getAllActiveBindings().length > 0;

        this._panel.webview.postMessage({ 
            command: 'updateModels',
            models: modelsWithVision,
            currentModel: activeModel,
            preserveOnEmpty
        });

        if (forceRefresh && modelsWithVision.length > 0) {
            ChatPanel.panels.forEach((panel) => {
                if (panel !== this && !panel._isDisposed && panel._panel?.webview) {
                    panel._panel.webview.postMessage({
                        command: 'updateModels',
                        models: modelsWithVision,
                        currentModel: panel._currentDiscussion?.model || this._lollmsAPI.getModelName(),
                        preserveOnEmpty: true
                    });
                }
            });
        }
    } catch (e: any) {
        this.log(`Unexpected error in _fetchAndSetModels: ${e.message}`, 'ERROR');
    }
  }



private normalizePathKey(p: string): string {
    let clean = String(p || '').replace(/\\/g, '/').trim().replace(/^\.?\/+/, '');
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length > 1) {
        for (const f of folders) {
            const prefix = f.name.toLowerCase() + '/';
            if (clean.toLowerCase().startsWith(prefix)) {
                clean = clean.slice(prefix.length);
                break;
            }
        }
    }
    return process.platform === 'win32' ? clean.toLowerCase() : clean;
}

private reconcileDiscussionFiles(
    providerFiles: { path: string; state?: any; bytes?: number; tokens?: number; mtime?: number }[],
    discFiles?: any[]
): { path: string; state: any; bytes: number; tokens: number; mtime?: number; symbols?: string[] }[] {
    const resultMap = new Map<string, any>();

    for (const pf of (providerFiles || [])) {
        if (!pf || !pf.path) continue;
        const key = this.normalizePathKey(pf.path);
        if (!resultMap.has(key)) {
            resultMap.set(key, {
                path: pf.path.replace(/\\/g, '/').trim(),
                state: pf.state || 'included',
                bytes: pf.bytes || 0,
                tokens: pf.tokens || 0,
                mtime: pf.mtime || 0
            });
        }
    }

    if (Array.isArray(discFiles)) {
        for (const df of discFiles) {
            const dPath = typeof df === 'string' ? df : df?.path;
            if (!dPath) continue;
            const key = this.normalizePathKey(dPath);
            const dState = (typeof df === 'object' && df?.state) ? df.state : 'included';
            const dSymbols = (typeof df === 'object' && Array.isArray(df?.symbols)) ? [...df.symbols] : undefined;

            if (resultMap.has(key)) {
                const existing = resultMap.get(key)!;
                existing.state = dState;
                if (dSymbols) existing.symbols = dSymbols;
            } else {
                resultMap.set(key, {
                    path: dPath.replace(/\\/g, '/').trim(),
                    state: dState,
                    bytes: (typeof df === 'object' ? df.bytes : 0) || 0,
                    tokens: (typeof df === 'object' ? df.tokens : 0) || 0,
                    mtime: (typeof df === 'object' ? df.mtime : 0) || 0,
                    ...(dSymbols ? { symbols: dSymbols } : {})
                });
            }
        }
    }

    return Array.from(resultMap.values());
}

public async addFilesToDiscussionContext(paths: string[], state: any = 'included'): Promise<string[]> {
    if (!this._currentDiscussion || !paths || paths.length === 0) return [];
    const globalIncluded = this._contextManager?.getContextStateProvider()?.getIncludedFiles() || [];
    if (!(this._currentDiscussion as any).includedFiles) {
        (this._currentDiscussion as any).includedFiles = JSON.parse(JSON.stringify(globalIncluded));
    } else {
        (this._currentDiscussion as any).includedFiles = this.reconcileDiscussionFiles([], (this._currentDiscussion as any).includedFiles);
    }
    const discFiles: any[] = (this._currentDiscussion as any).includedFiles;
    const added: string[] = [];

    for (const p of paths) {
        const cleanP = p.replace(/\\/g, '/').trim();
        if (!cleanP) continue;
        const targetKey = this.normalizePathKey(cleanP);
        const existing = discFiles.find(f => {
            const cf = typeof f === 'string' ? f : (f.path || '');
            return this.normalizePathKey(cf) === targetKey;
        });
        if (!existing) {
            discFiles.push({ path: cleanP, state });
            added.push(cleanP);
        } else if (typeof existing === 'object') {
            if (state === 'included' && existing.symbols) {
                delete existing.symbols;
            }
            if (existing.state !== state) {
                existing.state = state;
                added.push(cleanP);
            }
        }
    }

    if (this._currentDiscussion.capabilities) {
        (this._currentDiscussion.capabilities as any).includedFiles = discFiles;
    }
    if (!this._currentDiscussion.id.startsWith('temp-')) {
        await this._discussionManager.saveDiscussion(this._currentDiscussion);
    }
    return added;
}

public async removeFilesFromDiscussionContext(paths: string[]): Promise<string[]> {
    if (!this._currentDiscussion || !paths || paths.length === 0) return [];
    if (!(this._currentDiscussion as any).includedFiles) return [];

    const targetKeys = new Set(paths.map(p => this.normalizePathKey(p)));
    const discFiles: any[] = (this._currentDiscussion as any).includedFiles;
    const removed: string[] = [];

    (this._currentDiscussion as any).includedFiles = discFiles.filter(f => {
        const cf = typeof f === 'string' ? f : f.path || '';
        const matches = targetKeys.has(this.normalizePathKey(cf));
        if (matches) removed.push(cf);
        return !matches;
    });

    if (this._currentDiscussion.capabilities) {
        (this._currentDiscussion.capabilities as any).includedFiles = (this._currentDiscussion as any).includedFiles;
    }
    if (!this._currentDiscussion.id.startsWith('temp-')) {
        await this._discussionManager.saveDiscussion(this._currentDiscussion);
    }
    return removed;
}

public async commitDiscussionFilesToGlobal(): Promise<void> {
    if (!this._currentDiscussion || !this._contextManager) return;
    const discFiles: any[] = JSON.parse(JSON.stringify((this._currentDiscussion as any).includedFiles || []));
    const discMuted = [...(this._currentDiscussion.mutedFiles || [])];

    ChatPanel._globalSyncQueue = ChatPanel._globalSyncQueue.then(async () => {
        const provider = this._contextManager.getContextStateProvider();
        if (provider && discFiles.length > 0) {
            const pathsToAdd = discFiles.map(f => typeof f === 'string' ? f : f.path).filter(Boolean);
            await provider.addFilesToContext(pathsToAdd);
        }
        await this._discussionManager.saveLastMutedFiles(discMuted);
    }).catch(() => {});

    return ChatPanel._globalSyncQueue;
}

  public async updateContextAndTokens(options?: { isBackgroundSync?: boolean, forceFullScan?: boolean }): Promise<void> {
  const self = this;
  if (self._isDisposed || !self._panel || !self._panel.webview) return;

    if (self._isTokenizing) {
        self._tokenizationPendingRerun = true;
        self._tokenizationPendingOptions = options;
        if (self._tokenAbortController) {
            self._tokenAbortController.abort();
        }
        return;
    }

    self.clearTokenDebounce();

    return new Promise<void>((resolvePromise) => {
        (self as any)._tokenDebounceResolver = resolvePromise;
        (self as any)._tokenDebounceTimeout = setTimeout(async () => {
            (self as any)._tokenDebounceTimeout = undefined;
            (self as any)._tokenDebounceResolver = undefined;
            if (self._isDisposed || !self._panel || !self._panel.webview) {
                return resolvePromise();
            }

            if (self._tokenAbortController) {
                self._tokenAbortController.abort();
            }

            self._tokenAbortController = new AbortController();
            const signal = self._tokenAbortController.signal;

            const isBackground = options?.isBackgroundSync === true;
            const forceFull = options?.forceFullScan === true;

            // Scope Hoisting: Move declarations out of the try block so they are safe to use in the catch block on network failures
            let diagramText = "";
            let briefingText = "";
            let systemText = "";

            try {
                if (forceFull) {
                    self._contextManager.clearAllCaches();
                    if (self.contextStateProvider) {
                        self.contextStateProvider.refresh(true);
                        self._panel.webview.postMessage({ command: 'showProjectLoader', projectName: self._currentDiscussion?.title || "Workspace" });
                        self._panel.webview.postMessage({ command: 'updateLoaderStatus', status: 'Librarian: Indexing files. Please stand by...' });

                        await self.contextStateProvider.triggerFullScan((pct: number, status: string) => {
                            if (signal.aborted) return;
                            self._panel.webview.postMessage({ 
                                command: 'updateLoaderStatus', 
                                status: `${status} Please stand by...`,
                                stats: { files: pct, tokens: -1 }
                            });
                        });

                        self._panel.webview.postMessage({ command: 'hideProjectLoader' });
                    }
                }

                if (signal.aborted) return resolvePromise();

                // --- IMMEDIATE INSTANT HYDRATION / REACTION ---
                const provider = self._contextManager.getContextStateProvider();
                const providerIncluded = provider ? provider.getIncludedFiles().filter(f => f && f.path) : [];

                // Reconcile discussion includedFiles with latest provider files and preserve definitions-only structure states without duplicates
                let reconciledFiles = providerIncluded;
                if (self._currentDiscussion) {
                    reconciledFiles = self.reconcileDiscussionFiles(providerIncluded, (self._currentDiscussion as any).includedFiles);
                    (self._currentDiscussion as any).includedFiles = JSON.parse(JSON.stringify(reconciledFiles));
                    if (self._discussionCapabilities) {
                        (self._discussionCapabilities as any).includedFiles = (self._currentDiscussion as any).includedFiles;
                        self._discussionCapabilities.mutedFiles = [...(self._currentDiscussion.mutedFiles || [])];
                    }
                }

                if (forceFull) {
                    self._panel.webview.postMessage({ 
                        command: 'updateContext', 
                        files: reconciledFiles,
                        mutedFiles: self._currentDiscussion?.mutedFiles || [],
                        mutedTools: self._currentDiscussion?.mutedTools || [],
                        mutedSkills: self._currentDiscussion?.mutedSkills || [],
                        mutedDiagrams: self._currentDiscussion?.mutedDiagrams || []
                    });
                }

                self._isTokenizing = true;
                const modelForTokenization = (self._currentDiscussion?.model || self._lollmsAPI.getModelName() || "default").trim();

                try {
                    self.log("Fetching context content...");
                    const importedIds = self._currentDiscussion?.importedSkills || [];
                    const activeDiagramIds = self._currentDiscussion?.activeDiagrams || [];
                    const mutedFiles = self._currentDiscussion?.mutedFiles || [];
                    const mutedSkills = self._currentDiscussion?.mutedSkills || [];
                    const mutedDiagrams = self._currentDiscussion?.mutedDiagrams || [];

                    if (forceFull) {
                        self._panel.webview.postMessage({ command: 'updateLoaderStatus', status: 'Assembling Codebase Map...' });
                    }

                    const discIncluded = (self._currentDiscussion as any)?.includedFiles || (self._discussionCapabilities as any)?.includedFiles;
                    const context = await self._contextManager.getContextContent({ 
                        signal, 
                        discussionId: self.discussionId,
                        capabilities: self._discussionCapabilities,
                        importedSkillIds: importedIds,
                        activeDiagramIds: activeDiagramIds,
                        mutedFiles: mutedFiles,
                        includedFiles: discIncluded,
                        mutedSkills: mutedSkills,
                        mutedDiagrams: mutedDiagrams,
                        modelName: modelForTokenization,
                        onProgress: forceFull ? (progressData: any) => {
                            if (!self._isDisposed) {
                                const pct = typeof progressData === 'object' ? progressData.percentage : progressData;
                                const current = progressData?.current || 0;
                                const total = progressData?.total || 0;
                                const name = progressData?.fileName || '';

                                self._panel.webview.postMessage({ 
                                    command: 'tokenCalculationProgress', 
                                    progress: pct,
                                    current: current,
                                    total: total,
                                    fileName: name
                                });

                                self._panel.webview.postMessage({
                                    command: 'updateLoaderStatus',
                                    status: `Indexing: ${pct}% complete...`,
                                    stats: { 
                                        files: current, 
                                        tokens: -1 
                                    }
                                });
                            }
                        } : undefined,
                        onScanProgress: forceFull ? (pct: number, status: string) => {
                            if (!self._isDisposed && self._panel.webview) {
                                self._panel.webview.postMessage({
                                    command: 'tokenCalculationProgress',
                                    progress: pct,
                                    status: status
                                });
                                self._panel.webview.postMessage({
                                    command: 'updateLoaderStatus',
                                    status: `${status}...`,
                                    stats: { files: -1, tokens: -1 }
                                });
                            }
                        } : undefined
                    });

                    if (signal.aborted) {
                        self.log("token calculation aborted.");
                        return;
                    }

                    if (self._isDisposed) return;

                    let includedFiles: any[] = [];
                    try {
                        const provider = self._contextManager.getContextStateProvider();
                        includedFiles = provider ? provider.getIncludedFiles().filter(f => f && f.path) : [];
                    } catch (e) {}

                    // Aggressive truncation for Webview UI to prevent IPC Channel Closure
                    const UI_PREVIEW_LIMIT = 10000; 
                    const contextTextForUI = context.text.length > UI_PREVIEW_LIMIT
                        ? context.text.substring(0, UI_PREVIEW_LIMIT) + `\n\n... [Preview truncated for UI performance. Total: ${context.text.length} chars]`
                        : context.text;

                    const { estimateImageTokens } = require('../../utils');

                    const historyText = (self._currentDiscussion!.llmHistory || self._currentDiscussion!.messages)
                        .filter(msg => !msg.skipInPrompt)
                        .map(msg => {
                            const content = self.sanitizeMessageContentForPrompt(msg.content);
                            if (typeof content === 'string') return content;
                            if (Array.isArray(content)) return content.filter(item => item.type === 'text').map(item => item.text).join('\n');
                            return '';
                        }).filter(text => text.trim().length > 0).join('\n');

                    // --- Extract Project Memory early for tokenization via fast heuristic ---
                    const memManager = (self as any).projectMemoryManager || self.agentManager?.projectMemoryManager;
                    const projectMemory = (self._discussionCapabilities.projectMemoryEnabled !== false && memManager)
                        ? await memManager.getFormattedMemoryBlock(historyText.slice(-500))
                        : "";

                    await self._contextManager.getMissionBriefingManager().loadStore().catch(() => {});
                    briefingText = self._contextManager.renderBriefing(self._currentDiscussion);

                    const govReport = context.governorReport || await self._contextManager.getStructureGuide();
                    const combinedPersonaPrompt = self.getCurrentPersonaSystemPrompt().trim();

                    systemText = await getProcessedSystemPrompt(
                        'chat', 
                        self._discussionCapabilities, 
                        combinedPersonaPrompt, 
                        undefined, 
                        self._discussionCapabilities.forceFullCode, 
                        { 
                            tree: '', 
                            files: '', 
                            skills: '', 
                            memory: '',
                            suppressLibrarianReport: true
                        } as any
                    );

                    if (!self._isDisposed) {
                        const { getAvailableContextSelections } = require('../contextCommands');
                        const savedSelections = (await getAvailableContextSelections()).map((s: any) => s.fileName);

                        // --- LAZY INGESTION & DELTA STATE CACHE ---
                        const includedFiles = await Promise.all(reconciledFiles.map(async f => {
                            let bytes = f.bytes || 0;
                            let tokens = f.tokens || 0;
                            let mtime = f.mtime || 0;
                            const effectiveState = f.state || 'included';

                            const cached = (self._contextManager as any)._fileContentCache?.get(f.path);
                            if (cached?.content) {
                                bytes = cached.size || cached.content.length;
                                tokens = Math.ceil(cached.content.length / 3.5);
                                mtime = cached.mtime || mtime;
                            } else if (bytes === 0 || mtime === 0) {
                                const res = await self._contextManager.resolveWorkspaceFromPath(f.path);
                                if (res) {
                                    try {
                                        const st = await vscode.workspace.fs.stat(res.uri);
                                        bytes = st.size;
                                        tokens = Math.ceil(st.size / 3.5);
                                        mtime = st.mtime;
                                    } catch {}
                                }
                            }
                            if (tokens === 0 && bytes > 0) {
                                tokens = Math.max(1, Math.ceil(bytes / 3.5));
                            }
                            return {
                                path: f.path,
                                bytes,
                                tokens,
                                mtime,
                                state: effectiveState,
                                hasContent: false
                            };
                        }));
                        const currentSkills = context.importedSkills || []; 

                        const isAssistant = !self._discussionCapabilities.agentMode && !self._discussionCapabilities.dynamicMode;
                        const discussionTools = isAssistant ? [] : (self._currentDiscussion?.importedTools || []);
                        const projectTools = isAssistant ? [] : await self._contextManager.getActiveProjectTools();
                        const allEquippedNames = Array.from(new Set([...discussionTools, ...projectTools]));
                        const equippedTools = isAssistant ? [] : self.agentManager.getTools()
                            .filter(t => allEquippedNames.includes(t.name))
                            .map(t => ({ name: t.name, description: t.description }));

                        const govReport = context.governorReport || await self._contextManager.getStructureGuide();
                        let workspaceFiles: string[] = [];
                        try {
                            workspaceFiles = await self._contextManager.getWorkspaceFilePaths();
                        } catch {}
                        self._panel.webview.postMessage({ 
                            command: 'updateContextDelta', 
                            action: 'sync_all',
                            files: includedFiles,
                            workspaceFiles,
                            projectTree: context.projectTree || '',
                            skills: (currentSkills || []).map(s => ({ id: s.id, name: s.name, description: s.description })),
                            tools: equippedTools || [],
                            mutedFiles: self._currentDiscussion?.mutedFiles || [],
                            mutedTools: self._currentDiscussion?.mutedTools || [],
                            mutedSkills: self._currentDiscussion?.mutedSkills || [],
                            mutedDiagrams: self._currentDiscussion?.mutedDiagrams || [],
                            briefing: briefingText || self._contextManager.renderBriefing(self._currentDiscussion),
                            selections: savedSelections || [],
                            governorReport: govReport
                        });
                    }
                    self._panel.webview.postMessage({ command: 'updateImageContext', images: context.images });

                    const loadedCount = includedFiles.length;
                    self._panel.webview.postMessage({ 
                        command: 'tokenCalculationProgressText', 
                        text: `Tokenizing prompt, history & ${loadedCount} file${loadedCount === 1 ? '' : 's'} for ${modelForTokenization}...` 
                    });
                    self._panel.webview.postMessage({ 
                        command: 'updateStatus', 
                        status: `Tokenizing context for ${modelForTokenization}...`, 
                        type: 'info' 
                    });

                    let imageTokens = 0;
                    const visionEnabled = self._discussionCapabilities.enableImages !== false;

                    if (visionEnabled) {
                        // Determine a base cost per image. 
                        const imgBaseCost = estimateImageTokens(modelForTokenization);
                        const safeImgCost = imgBaseCost > 0 ? imgBaseCost : 600;

                        // Calculate from Context (Included Files)
                        context.images.forEach(img => {
                            imageTokens += safeImgCost;
                        });
                        // Calculate from Discussion History
                        (self._currentDiscussion!.llmHistory || self._currentDiscussion!.messages).forEach(m => {
                            if (Array.isArray(m.content)) {
                                m.content.forEach((p: any) => { 
                                    if (p.type === 'image_url') imageTokens += safeImgCost; 
                                });
                            }
                        });
                    }
                    // 🛡️ INDEPENDENT TOKENIZATION (Heuristic-First with Opt-In Precise Server-Side Calls)
                    const getFastHash = (str: string): string => {
                        let hash = 0;
                        for (let i = 0; i < str.length; i++) {
                            hash = (hash << 5) - hash + str.charCodeAt(i);
                            hash |= 0;
                        }
                        return `${str.length}_${hash}`;
                    };

                    const preciseTokenizationConfig = vscode.workspace.getConfiguration('lollmsVsCoder').get<boolean>('preciseTokenization', false);

                    const getTokenCount = async (text: string) => {
                        if (!text) return { count: 0, isEstimation: false };

                        if (!preciseTokenizationConfig) {
                            // High-speed local estimation completely bypasses network-bound processing
                            return { count: Math.ceil(text.length / 3.5), isEstimation: true };
                        }

                        const cacheKey = `${modelForTokenization}_${getFastHash(text)}`;
                        if (ChatPanel._tokenCountCache.has(cacheKey)) {
                            return { count: ChatPanel._tokenCountCache.get(cacheKey)!, isEstimation: false };
                        }

                        try {
                            const res = await self._lollmsAPI.tokenize(text, modelForTokenization);
                            if (ChatPanel._tokenCountCache.size > 250) {
                                const oldest = ChatPanel._tokenCountCache.keys().next().value;
                                if (oldest) ChatPanel._tokenCountCache.delete(oldest);
                            }
                            ChatPanel._tokenCountCache.set(cacheKey, res.count);
                            return { count: res.count, isEstimation: false };
                        } catch (e) {
                            return { count: Math.ceil(text.length / 3.5), isEstimation: true };
                        }
                    };

                    // --- GRANULAR FOLDER STATS CALCULATION (PARALLEL) ---
                    const folderStats: Record<string, { tree: number, files: number }> = {};
                    const activeFolders = vscode.workspace.workspaceFolders || [];
                    const folderSettings = self._discussionCapabilities.folderSettings || {};
                    const statsPromises: Promise<void>[] = [];

                    // Sync active files list to workspaceState
                    if (self._contextManager) {
                        try {
                            const provider = self._contextManager.getContextStateProvider();
                            const rawFiles = provider ? provider.getIncludedFiles() : [];
                            const activeFilesList = rawFiles.filter(f => f && f.path);
                            await self._discussionManager.context.workspaceState.update('lollms_active_context_files', activeFilesList);
                        } catch (e) {}
                    }

                    const isWin = process.platform === 'win32';
                    const areUrisEqual = (u1?: vscode.Uri, u2?: vscode.Uri) => {
                        if (!u1 || !u2) return false;
                        if (u1.toString() === u2.toString()) return true;
                        if (decodeURIComponent(u1.toString().toLowerCase()) === decodeURIComponent(u2.toString().toLowerCase())) return true;
                        return isWin ? u1.fsPath.toLowerCase() === u2.fsPath.toLowerCase() : u1.fsPath === u2.fsPath;
                    };

                    const getFolderSetting = (folder: vscode.WorkspaceFolder) => {
                        if (self._discussionCapabilities.disableProjectContext) {
                            return { tree: false, content: false };
                        }
                        const uriStr = folder.uri.toString();
                        const uriStrLower = uriStr.toLowerCase();
                        const fsPathLower = folder.uri.fsPath.toLowerCase();

                        const allVals = Object.values(folderSettings);
                        const hasAnyConfiguredActive = allVals.some((v: any) => v && typeof v === 'object' && (v.content || v.tree));
                        if (!hasAnyConfiguredActive && allVals.length > 0) {
                            return { tree: true, content: true };
                        }

                        for (const [key, val] of Object.entries(folderSettings)) {
                            if (!key || typeof val !== 'object') continue;
                            const kLower = key.toLowerCase();
                            if (kLower === uriStrLower || kLower === fsPathLower || decodeURIComponent(kLower) === decodeURIComponent(uriStrLower)) {
                                return val as { tree?: boolean, content?: boolean };
                            }
                        }
                        return { tree: true, content: true };
                    };

                    activeFolders.forEach(folder => {
                        const uriKey = folder.uri.toString();
                        const settings = getFolderSetting(folder);

                        statsPromises.push((async () => {
                            if (signal.aborted) return;
                            try {
                                let treeTokens = 0;
                                let filesTokens = 0;

                                // 1. Tree Weight: Reuse pre-assembled isolated tree from context
                                if (settings.tree !== false) {
                                    const folderTree = context?.isolatedTrees?.[uriKey] || await self._contextManager.generateIsolatedProjectTree(folder, signal, self._discussionCapabilities);
                                    treeTokens = Math.ceil((folderTree || '').length / 3.5);
                                }

                                // 2. Content Weight (Metadata Heuristic from Loaded Files Only, skipping muted files)
                                if (settings.content !== false) {
                                    const provider = self._contextManager.getContextStateProvider();
                                    const included = provider?.getIncludedFiles() || [];

                                    const { arePathsEqual: arePathsEqualStat } = require('../../utils');
                                    for (const file of included) {
                                        const isFileMuted = mutedFiles.some((m: string) => arePathsEqualStat(m, file.path));
                                        if (isFileMuted) continue;

                                        const resolution = await self._contextManager.resolveWorkspaceFromPath(file.path);
                                        if (resolution?.folder && areUrisEqual(resolution.folder.uri, folder.uri)) {
                                            let tok = file.tokens || 0;
                                            if (tok === 0 && file.bytes) tok = Math.ceil(file.bytes / 3.5);
                                            if (tok === 0) {
                                                const cached = (self._contextManager as any)._fileContentCache?.get(file.path);
                                                if (cached?.content) tok = Math.ceil(cached.content.length / 3.5);
                                            }
                                            filesTokens += (tok || 100);
                                        }
                                    }
                                }
                                folderStats[uriKey] = { tree: treeTokens, files: filesTokens };
                            } catch (err) {
                                Logger.warn(`[TokenStats] Error for ${folder.name}: ${err}`);
                                folderStats[uriKey] = { tree: 0, files: 0 };
                            }
                        })());
                    });

                    // --- SYNC WITH MATRIX ---
                    const filteredFilesText = await self._getFilteredFilesContent(context, folderSettings);

                    if (context.diagrams && context.diagrams.length > 0) {
                        context.diagrams.forEach(d => {
                            diagramText += `### ${d.type.replace('_', ' ').toUpperCase()}\n\`\`\`mermaid\n${d.mermaid}\n\`\`\`\n\n`;
                        });
                    }

                    let results;
                    try {
                        const getCachedContextSize = async (model: string): Promise<{ context_size: number; isEstimation?: boolean }> => {
                            if (ChatPanel._contextSizeCache.has(model)) {
                                return { context_size: ChatPanel._contextSizeCache.get(model)!, isEstimation: false };
                            }
                            try {
                                const res = await self._lollmsAPI.getContextSize(model);
                                if (res && res.context_size > 0) {
                                    ChatPanel._contextSizeCache.set(model, res.context_size);
                                    return res;
                                }
                            } catch {}
                            const fallbackSize = getContextLimitForModel(model);
                            ChatPanel._contextSizeCache.set(model, fallbackSize);
                            return { context_size: fallbackSize, isEstimation: true };
                        };

                        results = await Promise.all([
                            getTokenCount(systemText),
                            getTokenCount(historyText),
                            getTokenCount(context.projectTree),
                            getTokenCount(context.skillsContent || ""),
                            getTokenCount(projectMemory || ""),
                            getTokenCount(briefingText || ""),
                            getTokenCount(diagramText),
                            getCachedContextSize(modelForTokenization),
                            Promise.all(statsPromises)
                        ]);
                    } catch (e: any) {
                        if (e.name === 'AbortError' || signal.aborted) {
                            self._panel.webview.postMessage({ command: 'tokenCalculationFinished' });
                            self._panel.webview.postMessage({ command: 'hideProjectLoader' });
                            return resolvePromise();
                        }
                        throw e;
                    }

                    const [systemRes, historyRes, treeRes, skillsRes, memoryRes, briefingRes, diagramRes, contextSizeRes] = results;

                    if (self._isDisposed || signal.aborted) {
                        self._panel.webview.postMessage({ command: 'tokenCalculationFinished' });
                        self._panel.webview.postMessage({ command: 'hideProjectLoader' });
                        return resolvePromise();
                    }

                    // RESOLVE CONTEXT SIZE Authoritatively
                    let finalCtxSize = 128000;
                    let isLimitApproximate = true;
                    let isUserDefined = false;

                    if (contextSizeRes) {
                        finalCtxSize = contextSizeRes.context_size;
                        isLimitApproximate = !!contextSizeRes.isEstimation && !!(contextSizeRes as any).isUserDefined;
                        isUserDefined = !!(contextSizeRes as any).isUserDefined;
                    } else {
                        const { getContextLimitForModel } = require('../../utils');
                        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
                        const manualOverride = config.get<number>('failsafeContextSize') || 0;

                        if (manualOverride > 0) {
                            finalCtxSize = manualOverride;
                            isLimitApproximate = false;
                            isUserDefined = true;
                        } else {
                            finalCtxSize = getContextLimitForModel(modelForTokenization);
                            isLimitApproximate = true;
                        }
                    }

                    const { arePathsEqual: arePathsEqualCtx } = require('../../utils');
                    const unmutedFiles = (includedFiles && includedFiles.length > 0 ? includedFiles : rawIncluded).filter(f => {
                        const isFileMuted = (mutedFiles || []).some((m: string) => arePathsEqualCtx(m, f.path));
                        return !isFileMuted;
                    });

                    let contentTokens = 0;
                    if (unmutedFiles.length > 0 && !self._discussionCapabilities.disableProjectContext) {
                        contentTokens = Math.ceil((filteredFilesText || '').length / 3.5) || 0;
                        if (contentTokens === 0 && context.selectedFilesContent) {
                            contentTokens = Math.ceil(context.selectedFilesContent.length / 3.5) || 0;
                        }
                        if (contentTokens === 0) {
                            contentTokens = unmutedFiles.reduce((sum, f) => {
                                let t = f.tokens || 0;
                                if (t === 0 && f.bytes) t = Math.ceil(f.bytes / 3.5);
                                if (t === 0) {
                                    const cached = (self._contextManager as any)._fileContentCache?.get(f.path);
                                    if (cached?.content) t = Math.ceil(cached.content.length / 3.5);
                                }
                                return sum + (t || 100);
                            }, 0);
                        }
                    }
                    const skillTokens = Number((skillsRes as any)?.count) || 0;
                    const systemTokens = Number((systemRes as any)?.count) || 0;
                    const historyTokens = Number((historyRes as any)?.count) || 0;
                    const treeTokens = Math.max(
                        Number((treeRes as any)?.count) || 0,
                        Math.ceil((context.projectTree || '').length / 3.5)
                    );
                    const memoryTokens = Number((memoryRes as any)?.count) || 0;
                    const briefingTokens = Number((briefingRes as any)?.count) || 0;
                    const diagramTokens = Number((diagramRes as any)?.count) || 0;
                    const safeImageTokens = Number(imageTokens) || 0;

                    const { isProjectFile } = require('../../utils');
                    let codeTokens = 0;
                    let externalTokens = 0;
                    for (const f of unmutedFiles) {
                        let t = f.tokens || 0;
                        if (t === 0 && f.bytes) t = Math.ceil(f.bytes / 3.5);
                        if (t === 0) {
                            const cached = (self._contextManager as any)._fileContentCache?.get(f.path);
                            if (cached?.content) t = Math.ceil(cached.content.length / 3.5);
                        }
                        t = t || 100;
                        if (isProjectFile(f.path)) codeTokens += t;
                        else externalTokens += t;
                    }

                    if (contentTokens > 0 && (codeTokens + externalTokens) !== contentTokens) {
                        const rawSum = codeTokens + externalTokens;
                        if (rawSum > 0) {
                            const ratio = contentTokens / rawSum;
                            codeTokens = Math.round(codeTokens * ratio);
                            externalTokens = Math.max(0, contentTokens - codeTokens);
                        } else {
                            codeTokens = contentTokens;
                            externalTokens = 0;
                        }
                    } else if (contentTokens === 0 && unmutedFiles.length === 0) {
                        codeTokens = 0;
                        externalTokens = 0;
                    }

                    const segments = {
                        system: Number(systemTokens) || 0,
                        briefing: Number(briefingTokens) || 0,
                        tree: Number(treeTokens) || 0,
                        skills: Number(skillTokens) || 0,
                        memory: Number(memoryTokens) || 0,
                        diagrams: Number(diagramTokens) || 0,
                        files: Number(codeTokens) || 0,
                        external: Number(externalTokens) || 0,
                        history: Number(historyTokens) || 0,
                        images: Number(safeImageTokens) || 0
                    };

                    const totalTokens = Object.values(segments).reduce((sum, val) => sum + (Number(val) || 0), 0);

                    if (self._currentDiscussion) {
                        const prevMetrics = self._currentDiscussion.lastTokenMetrics;
                        const metricsChanged = !prevMetrics ||
                            prevMetrics.total !== totalTokens ||
                            prevMetrics.contextSize !== finalCtxSize ||
                            prevMetrics.segments?.files !== segments.files ||
                            prevMetrics.segments?.history !== segments.history ||
                            prevMetrics.segments?.tree !== segments.tree;

                        self._currentDiscussion.lastTokenMetrics = {
                            total: totalTokens,
                            contextSize: finalCtxSize,
                            segments: segments
                        };
                        if (metricsChanged && !self._currentDiscussion.id.startsWith('temp-')) {
                            await self._discussionManager.saveDiscussion(self._currentDiscussion);
                        }
                    }

                    if (self._panel && self._panel.webview) {
                        self._panel.webview.postMessage({
                            command: 'updateTokenProgress',
                            totalTokens: totalTokens,
                            contextSize: finalCtxSize,
                            isApproximate: isLimitApproximate,
                            segments: segments
                        });

                        if (!isBackground) {
                            self._panel.webview.postMessage({
                                command: 'updateLoaderStatus',
                                status: 'Context Grounding Complete',
                                stats: { files: includedFiles.length, tokens: totalTokens }
                            });
                        }
                    }

                    if (isLimitApproximate) {
                        self._panel.webview.postMessage({ command: 'updateStatus', status: 'Ready (Approx)', type: 'warning' });
                    } else {
                        self._panel.webview.postMessage({ command: 'updateStatus', status: 'Ready', type: 'info' });
                    }

                    self._panel.webview.postMessage({ command: 'tokenCalculationFinished' });
                    self._panel.webview.postMessage({ command: 'hideProjectLoader' });
                    resolvePromise();

                } catch (error: any) {
                    const isAborted = signal.aborted || 
                        error?.name === 'AbortError' || 
                        error?.message === 'Operation cancelled' || 
                        error?.message === 'AbortError' || 
                        error?.name === 'Operation cancelled';

                    if (isAborted) {
                        self.log("Context update cancelled.", 'INFO');
                        if (self._panel && self._panel.webview && !self._isDisposed) {
                            self._panel.webview.postMessage({ command: 'tokenCalculationFinished' });
                            self._panel.webview.postMessage({ command: 'hideProjectLoader' });
                        }
                        return resolvePromise();
                    }

                    Logger.warn(`[TokenStats] Context update pipeline notice: ${error.message}`);

                    if (self._isDisposed) return resolvePromise();

                    // Fast non-blocking estimation using in-memory file stats without re-reading disk
                    const provider = self._contextManager.getContextStateProvider();
                    const currentFiles = provider ? provider.getIncludedFiles().filter(f => f && f.path) : [];
                    const currentMuted = self._currentDiscussion?.mutedFiles || [];
                    const { arePathsEqual: arePathsEqualErr } = require('../../utils');
                    let fastFileTokens = 0;
                    currentFiles.forEach(f => {
                        const isMuted = currentMuted.some(m => arePathsEqualErr(m, f.path));
                        if (!isMuted) fastFileTokens += f.tokens || Math.max(1, Math.ceil((f.bytes || 100) / 3.5));
                    });

                    const fallbackTotal = fastFileTokens + 3000;
                    const finalCtxSize = getContextLimitForModel(modelForTokenization);

                    if (self._panel && self._panel.webview && !self._isDisposed) {
                        self._panel.webview.postMessage({
                            command: 'updateTokenProgress',
                            totalTokens: fallbackTotal,
                            contextSize: finalCtxSize,
                            isApproximate: true,
                            segments: { system: 2000, briefing: 0, tree: 500, skills: 0, memory: 0, diagrams: 0, files: fastFileTokens, external: 0, history: 500, images: 0 }
                        });
                        self._panel.webview.postMessage({ command: 'tokenCalculationFinished' });
                        self._panel.webview.postMessage({ command: 'hideProjectLoader' });
                    }
                    resolvePromise();
                } finally {
                    self._isTokenizing = false;
                    if (self._tokenAbortController?.signal === signal) {
                        self._tokenAbortController = null;
                    }
                    if (self._tokenizationPendingRerun && !self._isDisposed) {
                        self._tokenizationPendingRerun = false;
                        const pendingOpts = self._tokenizationPendingOptions;
                        self._tokenizationPendingOptions = null;
                        setTimeout(() => { self.updateContextAndTokens(pendingOpts); }, 50);
                    }
                }
            } catch (outerErr: any) {
                Logger.error(`[TokenStats] Outer API Pipeline error: ${outerErr.message}`);
                self._panel.webview.postMessage({ command: 'tokenCalculationFinished' });
                self._panel.webview.postMessage({ command: 'hideProjectLoader' });
                resolvePromise();
            }
        }, 180); // 180ms debouncing interval to coalesce rapid mute/structure clicks
    });
  }
    /**
    * Helper to return file blocks from context data (already filtered at assembly time by ContextManager).
    */
    private async _getFilteredFilesContent(contextData: ContextResult | undefined | null, _folderSettings: any): Promise<string> {
        if (!contextData || !contextData.selectedFilesContent || contextData.selectedFilesContent.trim() === '') {
            return '';
        }
        return contextData.selectedFilesContent;
    }

    private clearTokenDebounce() {
      if ((this as any)._tokenDebounceTimeout) {
          clearTimeout((this as any)._tokenDebounceTimeout);
          (this as any)._tokenDebounceTimeout = undefined;
      }
      if (typeof (this as any)._tokenDebounceResolver === 'function') {
          const prevResolve = (this as any)._tokenDebounceResolver;
          (this as any)._tokenDebounceResolver = undefined;
          prevResolve();
      }
  }

  private async waitForWebviewReady() { if (this._isWebviewReady) return; return this._viewReadyPromise; }
  
  public async setInputText(text: string, images?: { name: string; data: string }[]) {
      this._initialPrompt = text;
      this._initialImages = images;
      if (this._isDisposed) return;
      await this.waitForWebviewReady();
      if (!this._isDisposed) {
          this._panel.webview.postMessage({ command: 'setInputText', text, images });
      }
  }

  public async openNewDiscussionWizard(selections?: any[]) {
      this._shouldOpenWizardOnLoad = true;
      if (this._isDisposed) return;
      await this.waitForWebviewReady();
      if (!this._shouldOpenWizardOnLoad) return;
      if (!this._isDisposed && this._panel && this._panel.webview) {
          let savedSelections = selections;
          if (!savedSelections) {
              const { getAvailableContextSelections } = require('../contextCommands');
              savedSelections = await getAvailableContextSelections();
          }
          const provider = this._contextManager?.getContextStateProvider();
          const activeFiles = provider ? provider.getIncludedFiles() : [];
          const activeMuted = this._currentDiscussion?.mutedFiles ?? this._discussionManager.getLastMutedFiles();
          let workspaceFiles: string[] = [];
          try {
              workspaceFiles = await this._contextManager.getWorkspaceFilePaths();
          } catch {}
          this._panel.webview.postMessage({
              command: 'openNewDiscussionWizard',
              selections: savedSelections || [],
              files: activeFiles,
              mutedFiles: activeMuted,
              workspaceFiles
          });
          this._shouldOpenWizardOnLoad = false;
      }
  }

  private async saveCapabilities(isGlobalDefault: boolean = false) {
      if (this._currentDiscussion && !this._currentDiscussion.id.startsWith('temp-')) {
          this._currentDiscussion.capabilities = this._discussionCapabilities;
          await this._discussionManager.saveDiscussion(this._currentDiscussion);
      }
      
      // ONLY update global defaults if explicitly requested (e.g. from Settings)
      // Chat badges should only affect the CURRENT discussion.
      if (isGlobalDefault) {
          await this._discussionManager.saveLastCapabilities(this._discussionCapabilities);
      }
  }

  public async openMissionBriefingUI() {
      const disc = this._currentDiscussion;
      let localBriefing = "";
      let globalBriefing = "";

      if (this._contextManager) {
          await this._contextManager.getMissionBriefingManager().loadStore().catch(() => {});
          globalBriefing = this._contextManager.getGlobalBriefing() || "";
      }
      
      if (disc && disc.discussion_data_zone) {
          try {
              const parsed = JSON.parse(disc.discussion_data_zone);
              if (parsed.user_constraints) {
                  localBriefing = parsed.user_constraints;
              } else if (parsed.doctrine) {
                  localBriefing = parsed.doctrine;
              }
          } catch {
              localBriefing = disc.discussion_data_zone;
          }
      }

      const isGlobal = !localBriefing;
      const currentBriefing = isGlobal ? globalBriefing : localBriefing;

      let dna = "";
      if (this.agentManager?.projectMemoryManager) {
          dna = await this.agentManager.projectMemoryManager.getFormattedMemoryBlock();
      }

      this._panel.webview.postMessage({
          command: 'openMissionBriefingModal',
          briefing: currentBriefing,
          localBriefing: localBriefing,
          globalBriefing: globalBriefing,
          isGlobal: isGlobal,
          dna: dna
      });
  }

  public async handleManualAutoContext(userPrompt: string) {
      if (this._isDisposed || !this.processManager || !this._currentDiscussion) return;
      
      if (this._discussionCapabilities.disableProjectContext) {
          vscode.window.showWarningMessage("Auto-Context cannot run while Project Context is muted.");
          return;
      }

      if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
          vscode.window.showWarningMessage("Librarian requires an open workspace folder to scan project structure.");
          return;
      }
    
      const { id: processId, controller } = this.processManager.register(this.discussionId, 'Librarian: Researching project...');
      this.updateGeneratingState();
      try {
          const model = this._currentDiscussion.model || this._lollmsAPI.getModelName();
          let objective = userPrompt.trim();
          
          if (!objective) {
              objective = "Assemble context for current task.";
          }

          const contextAgentMsgId = 'ctx_agent_manual_' + Date.now();
          await this.addMessageToDiscussion({
              id: contextAgentMsgId,
              role: 'system',
              content: `**🧠 Librarian**\n*Scouting for: "${objective}"*\n\n`,
              skipInPrompt: true 
          });

          const result = await this._contextManager.runContextAgent(
                objective, 
                model, 
                controller.signal,
                (newContent) => {
                    this.updateMessageContent(contextAgentMsgId, newContent);
                },
                (status) => {
                    if (!this._isDisposed && this.processManager) {
                        this.processManager.updateDescription(processId, status);
                        this.updateGeneratingState();
                    }
                },
                undefined,       // initialKeywords
                'collaborative', // mode
                this._currentDiscussion,
                this._currentDiscussion.messages
            );

            if (result.analysis) {
                const header = `### 🧠 MANUAL CONTEXT ANALYSIS\n`;
                this._currentDiscussion.discussion_data_zone = (this._currentDiscussion.discussion_data_zone || "") + `\n${header}${result.analysis}\n`;
                
                // Persistence check
                if (!this._currentDiscussion.id.startsWith('temp-')) {
                    await this._discussionManager.saveDiscussion(this._currentDiscussion);
                }
            }

            // Sync context UI but PRESERVE the original prompt
            // The user may want to review selected files before sending
            this.updateContextAndTokens();
            // Note: Intentionally NOT clearing the input - user might want to edit or send after review

      } catch (e: any) {
          if (e.name !== 'AbortError' && e.message !== 'AbortError') {
            this.log(`Manual Auto-Context failed: ${e.message}`, 'ERROR');
            this.addMessageToDiscussion({ role: 'system', content: `❌ Auto-Context Failed: ${e.message}` });
          }
      } finally {
          this.processManager.unregister(processId);
          this.updateGeneratingState();
      }
  }

  // --- REPLACED: NEW HIERARCHICAL IMPORT LOGIC ---

  private async handleInferPrompt(messageId: string) {
      if (!this._currentDiscussion || !this.processManager) return;

      const msgIndex = this._currentDiscussion.messages.findIndex(m => m.id === messageId);
      if (msgIndex === -1) return;

      const nextMsg = this._currentDiscussion.messages[msgIndex + 1];
      if (!nextMsg || nextMsg.role !== 'assistant') {
          vscode.window.showErrorMessage("No assistant response found after this message to infer from.");
          await this.loadDiscussion(); // Reset UI button state
          return;
      }

      const { id: processId, controller } = this.processManager.register(this.discussionId, 'Inferring prompt...');
      this.updateGeneratingState();

      try {
          let assistantContent = "";
          if (typeof nextMsg.content === 'string') {
              assistantContent = nextMsg.content;
          } else if (Array.isArray(nextMsg.content)) {
              assistantContent = nextMsg.content.map(c => c.type === 'text' ? c.text : '[Image]').join('\n');
          }
          
          const systemPrompt = "You are a prompt engineering assistant. Your task is to look at an AI's response and reverse-engineer the most likely, concise user prompt that would have generated this exact response. Output ONLY the inferred user prompt text. Do not add quotes, explanations, or conversational filler.";
          const userPrompt = `AI Response:\n\`\`\`\n${assistantContent.substring(0, 3000)}\n\`\`\`\n\nInfer the user prompt:`;

          const inferredPrompt = await this._lollmsAPI.sendChat([
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
          ], null, controller.signal, this._currentDiscussion.model);

          const cleanPrompt = stripThinkingTags(inferredPrompt).trim();
          
          await this.updateMessageContent(messageId, cleanPrompt);

      } catch (error: any) {
          if (error.name !== 'AbortError') {
              vscode.window.showErrorMessage(`Failed to infer prompt: ${error.message}`);
          }
          await this.loadDiscussion(); // Reset UI
      } finally {
          this.processManager.unregister(processId);
          this.updateGeneratingState();
      }
  }

  private async buildSkillsTreePayload() {
    this._skillsManager.invalidateCache();
    const allSkills = await this._skillsManager.getSkills();
    const projectSkills = await this._contextManager.getActiveProjectSkills();
    const discussionSkills = this._currentDiscussion?.importedSkills || [];

    if (allSkills.length === 0) {
        return { skillsTree: null, discussionSkills, projectSkills };
    }

    const root: any = { id: 'root', label: 'Skills Library', children: [] as any[], isSkill: false };
    const globalRoot: any = { id: 'global-lib', label: 'Global Library', children: [] as any[], isSkill: false, isBundle: true };
    const projectRoot: any = { id: 'project-lib', label: 'Project Library', children: [] as any[], isSkill: false, isBundle: true };
    const zooRoot: any = { id: 'zoo-lib', label: 'Skills Zoo (Git Repos)', children: [] as any[], isSkill: false, isBundle: true };
    root.children.push(globalRoot, projectRoot, zooRoot);

    try {
        const zooRepos = await this._skillsManager.getAllZooSkills();
        zooRepos.forEach(({ repo, skills }) => {
            const repoBranch: any = { id: `zoo-${repo.id}`, label: repo.name, children: [], isSkill: false, isBundle: true };
            zooRoot.children.push(repoBranch);

            skills.forEach(skill => {
                const category = skill.category || 'general';
                const parts = category.replace(/\\/g, '/').split('/').filter(p => p);
                let current = repoBranch;
                let pathSoFar = `zoo-${repo.id}`;

                parts.forEach(part => {
                    pathSoFar = `${pathSoFar}/${part}`;
                    let existing = current.children.find((c: any) => c.label === part && !c.isSkill);
                    if (!existing) {
                        existing = { id: pathSoFar, label: part, children: [], isSkill: false, isBundle: true };
                        current.children.push(existing);
                    }
                    current = existing;
                });

                current.children.push({
                    id: skill.id,
                    label: skill.name,
                    isSkill: true,
                    description: skill.description,
                    skill: skill
                });
            });
        });
    } catch (zooErr) {
        Logger.warn("Failed to load Git Zoo skills into chat picker", zooErr);
    }

    allSkills.forEach(skill => {
        const category = skill.category || 'Uncategorized';
        const parts = category.replace(/\\/g, '/').split('/').filter(p => p);

        let current = skill.scope === 'global' ? globalRoot : projectRoot;
        let pathSoFar: string = skill.scope;

        parts.forEach(part => {
            pathSoFar = `${pathSoFar}/${part}`;
            let existing = current.children.find((c: any) => c.label === part && !c.isSkill);
            if (!existing) {
                existing = { id: pathSoFar, label: part, children: [], isSkill: false, isBundle: true };
                current.children.push(existing);
            }
            current = existing;
        });

        current.children.push({
            id: skill.id,
            label: skill.name,
            isSkill: true,
            description: skill.description,
            skill: skill
        });
    });

    return { skillsTree: root, discussionSkills, projectSkills };
  }

  private async handleImportSkills() {
    this._panel.webview.postMessage({ command: 'showSkillsModal', loading: true });

    const payload = await this.buildSkillsTreePayload();
    if (!payload.skillsTree) {
        this._panel.webview.postMessage({ command: 'closeSkillsModal' });
        vscode.window.showInformationMessage("No saved skills found.");
        return;
    }

    this._panel.webview.postMessage({
        command: 'showSkillsModal',
        skillsTree: payload.skillsTree,
        discussionSkills: payload.discussionSkills,
        projectSkills: payload.projectSkills
    });
  }

  private async verifyAndProcessCodeBlocks(messageId: string, fullContent: string, signal: AbortSignal, onStatusUpdate?: (status: string) => void, dashboardUpdater?: (agent: string, content: string) => void): Promise<string> {
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    const shouldVerify = config.get<boolean>('verifyAndCorrectCodeBlocks') ?? false;
    
    if (!shouldVerify) return fullContent;

    const maxRetries = config.get<number>('agentMaxRetries') || 2;
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return fullContent;

    let currentContent = fullContent;
    
    // Detect all partial blocks (Diff/SearchReplace)
    // Support both \n and \r\n after the language:path header
    const blockRegex = /```(?:language:|lang:)?(\w+):([^\n\s]+)[\r\n]+([\s\S]+?)[\r\n]+```/g;
    let match;
    const blocksToVerify: { type: string, path: string, content: string, originalMatch: string }[] = [];

    while ((match = blockRegex.exec(fullContent)) !== null) {
        const type = match[1].toLowerCase();
        let path = match[2];

        // Strip language hallucination from path if it snuck in (e.g. typescript:src/utils.ts)
        if (path.includes(':')) {
            const parts = path.split(':');
            path = parts.slice(1).join(':');
        }
        const content = match[3];
        if (type === 'diff' || content.includes('<<<<<<< SEARCH')) {
            blocksToVerify.push({ type, path, content, originalMatch: match[0] });
        }
    }

    if (blocksToVerify.length === 0) return fullContent;

    this.log(`Verifying ${blocksToVerify.length} partial code blocks...`);

    for (const block of blocksToVerify) {
        let verifiedFullCode = "";
        let success = false;
        let retryCount = 0;
        let lastError = "";

        const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, block.path);
        let originalFileText = "";
        try {
            const bytes = await vscode.workspace.fs.readFile(fileUri);
            originalFileText = Buffer.from(bytes).toString('utf8');
        } catch (e) {
            this.log(`Verification failed: Could not read ${block.path}`, 'WARN');
            continue; 
        }

        while (!success && retryCount <= maxRetries) {
            if (signal.aborted) break;

            let result: { success: boolean, result: string, error?: string };
            if (block.type === 'diff') {
                result = applyDiffToString(originalFileText, block.content);
            } else {
                const normalizedContent = normalizeAiderContent(block.content);
                const hunks = parseAiderHunks(normalizedContent);

                if (hunks.length > 0) {
                    let currentFileState = originalFileText;
                    let allSuccess = true;
                    let firstError = "";

                    for (const hunk of hunks) {
                        const searchPart = hunk.searchPart || "";
                        const replacePart = hunk.replacePart || "";
                        const srResult = applySearchReplace(currentFileState, searchPart, replacePart);

                        if (srResult.success) {
                            currentFileState = srResult.result;
                        } else {
                            allSuccess = false;
                            firstError = srResult.error || "Search block match failed.";
                            break;
                        }
                    }
                    result = { success: allSuccess, result: currentFileState, error: firstError };
                } else {
                    result = { success: false, result: originalFileText, error: "Invalid Search/Replace block format or markers not at start of line." };
                }
            }
            if (result.success) {
                verifiedFullCode = result.result;
                success = true;
            } else {
                retryCount++;
                lastError = result.error || "Unknown error.";
                if (retryCount > maxRetries) break;

                if (onStatusUpdate) {
                    onStatusUpdate(`Applying self-correction to ${path.basename(block.path)} (Attempt ${retryCount}/${maxRetries})...`);
                }

                const repairPrompt = `The following code update failed to apply to \`${block.path}\`.
**Error:** ${lastError}
**Original File:**
\`\`\`
${originalFileText}
\`\`\`
**Your Attempt:**
\`\`\`${block.type}
${block.content}
\`\`\`
Please provide the **FULL CONTENT** of the file instead using the format:
\`\`\`language:${block.path}
[FULL CODE]
\`\`\`
`;

                try {
                    const repairResponse = await this._lollmsAPI.sendChat([
                        { role: 'system', content: "You are a code repair assistant." },
                        { role: 'user', content: repairPrompt }
                    ], null, signal, this._currentDiscussion?.model);
                    const repairMatch = repairResponse.match(/```(\w+):[^\n]*\n([\s\S]+?)\n```/);
                    if (repairMatch) {
                        verifiedFullCode = repairMatch[2].trim();
                        success = true;
                    }
                } catch (e) { break; }
            }
        }
        // Only replace the block in the chat UI with the full verified content if:
        // 1. We actually had to perform a repair (retryCount > 0)
        // 2. It was a 'diff' block (converts messy diffs to clean full files for easier applying)
        // 3. It was NOT an Aider/Search-Replace block (we want to keep successful Aider blocks as-is)
        const isAider = block.content.includes('<<<<<<< SEARCH');
        if (success && verifiedFullCode && (retryCount > 0 || block.type === 'diff' || !isAider)) {
            const lang = path.extname(block.path).substring(1) || 'plaintext';
            const newBlock = `Verified Full Code for ${block.path}:\n\`\`\`${lang}:${block.path}\n${verifiedFullCode}\n\`\`\``;
            currentContent = currentContent.replace(block.originalMatch, newBlock);
        }
    }
    return currentContent;
  }

  public async copyHistoryToClipboard(draftMessage?: string) {
      if (!this._currentDiscussion) {
          vscode.window.showWarningMessage("No active discussion found.");
          return;
      }

      const msgs = (this._currentDiscussion.messages || []).filter(m => !m.skipInPrompt);
      if (msgs.length === 0 && (!draftMessage || !draftMessage.trim())) {
          vscode.window.showInformationMessage("Chat history is empty.");
          return;
      }

      let historyText = `## 🕒 CHAT HISTORY\n\n`;
      msgs.forEach(m => {
          let raw = Array.isArray(m.content) ? m.content.map((c: any) => c.type === 'text' ? c.text : '[Image]').join('\n') : (m.content || '');
          const cleaned = stripThinkingTags(raw)
              .replace(/<lollms_tool\b[^>]*>[\s\S]*?<\/lollms_tool>/gi, '')
              .replace(/<agent_git_diff\b[^>]*\/?>/gi, '')
              .replace(/<details\s+class=["']processing-block["']>[\s\S]*?<\/details>/gi, '')
              .replace(/<details\s+class=["']lollms-form-block["']>[\s\S]*?<\/details>/gi, '')
              .trim();
          if (cleaned) {
              historyText += `### ${m.role.toUpperCase()}\n${cleaned}\n\n`;
          }
      });

      if (draftMessage && draftMessage.trim()) {
          historyText += `### USER\n${draftMessage.trim()}\n\n`;
      }

      await vscode.env.clipboard.writeText(historyText.trim() + '\n');
      vscode.window.showInformationMessage("✅ Chat history copied to clipboard.");
  }

  private async copyFullPromptToClipboard(draftMessage: string) {
      // 1. Show feedback in Chat Panel immediately with specific Stop label
      this._panel.webview.postMessage({ 
          command: 'setGeneratingState', 
          isGenerating: true, 
          statusText: 'Assembling full prompt...',
          buttonLabel: 'Stop Assembling'
      });

      // 2. Use VS Code standard progress notification for long-running tasks
      await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: "Lollms: Preparing context for clipboard...",
          cancellable: false
      }, async (progress) => {
          try {
              const config = vscode.workspace.getConfiguration('lollmsVsCoder');
              const forceFullCode = this._discussionCapabilities?.forceFullCode || false;

              const importedIds = this._currentDiscussion?.importedSkills || [];
              
              const exportMutedFiles = this._currentDiscussion?.mutedFiles || this._discussionCapabilities?.mutedFiles || [];
              const exportCapabilities: DiscussionCapabilities = {
                  ...this._discussionCapabilities,
                  agentMode: false,
                  dynamicMode: false,
                  sparqlEnabled: false,
                  webSearch: false,
                  projectMemoryEnabled: false,
                  enableImages: false,
                  isExport: true,
                  mutedFiles: exportMutedFiles
              };

              progress.report({ message: "Extracting file contents..." });
              const contextData = await this._contextManager.getContextContent({ 
                  importedSkillIds: importedIds,
                  mutedFiles: exportMutedFiles,
                  modelName: this._currentDiscussion?.model || this._lollmsAPI.getModelName(),
                  capabilities: exportCapabilities
              });
              
              // --- MATRIX FILTERED EXPORT ---
              const folderSettings = this._discussionCapabilities.folderSettings || {};
              const filteredFilesContent = await this._getFilteredFilesContent(contextData, folderSettings);

              // Ensure that if the filtered files content is missing a final closing code fence, we append it
              let safeFilesContent = filteredFilesContent;
              if (safeFilesContent && !safeFilesContent.trim().endsWith('```')) {
                  safeFilesContent = safeFilesContent.trim() + '\n```';
              }

              let treeContent = contextData?.projectTree?.trim() || '';
              if (!treeContent || treeContent.length < 25) {
                  try {
                      treeContent = await this._contextManager.generateProjectTree(undefined, undefined, exportCapabilities);
                  } catch {}
              }
              if (!treeContent || treeContent.length < 25) {
                  const allF = vscode.workspace.workspaceFolders || [];
                  for (const f of allF) {
                      const iso = await this._contextManager.generateIsolatedProjectTree(f, undefined, exportCapabilities);
                      if (iso && iso.trim().length > 10) {
                          treeContent += `### 🌳 ${f.name.toUpperCase()} — FILE STRUCTURE\n${iso}\n`;
                      }
                  }
              }

              const context = {
                  tree: treeContent || contextData?.projectTree || '',
                  files: safeFilesContent || contextData?.selectedFilesContent || '',
                  skills: contextData?.skillsContent || '',
                  toolManager: this.agentManager?.['toolManager']
              };

              let memoryBlock = "";
              const memManager = (this as any).projectMemoryManager || this.agentManager?.projectMemoryManager;
              if (this._discussionCapabilities?.projectMemoryEnabled !== false && memManager) {
                  progress.report({ message: "Reading project memory..." });
                  memoryBlock = await memManager.getFormattedMemoryBlock();
              }

              progress.report({ message: "Processing system prompt..." });
              const personaContent = this.getCurrentPersonaSystemPrompt();
              const exportContext = {
                  ...context,
                  tree: '',
                  files: '',
                  governorReport: (contextData as any)?.governorReport || await this._contextManager.getStructureGuide(),
                  toolManager: undefined
              };
              const systemPrompt = await getProcessedSystemPrompt('chat', exportCapabilities, personaContent, undefined, forceFullCode, exportContext);

              const projectName = contextData?.projectName || "Unknown Project";
              const filesSection = context.files && context.files.trim().length > 0 
                  ? `## 📄 LOADED FILE CONTENTS\n\n${context.files}`
                  : `## 📄 LOADED FILE CONTENTS\nNo files currently loaded in context.`;

              let fullText = `
# 🧊 PROJECT SNAPSHOT: ${projectName.toUpperCase()} FOR EXTERNAL LLM

## 📜 SYSTEM INSTRUCTIONS & PERSONA
${systemPrompt}

## 🌳 PROJECT STRUCTURE
${context.tree || 'No tree provided.'}

${filesSection}

---

## 🕒 CHAT HISTORY
`.trim() + "\n\n";

              if (this._currentDiscussion) {
                  this._currentDiscussion.messages
                      .filter(m => !m.skipInPrompt)
                      .forEach(m => {
                          let raw = Array.isArray(m.content) ? m.content.map(c => c.type === 'text' ? c.text : '[Image]').join('\n') : (m.content || '');
                          // Clean internal tool artifacts and thinking blocks from chat history for external export
                          const cleaned = stripThinkingTags(raw)
                              .replace(/<lollms_tool\b[^>]*>[\s\S]*?<\/lollms_tool>/gi, '')
                              .replace(/<agent_git_diff\b[^>]*\/?>/gi, '')
                              .replace(/<details\s+class=["']processing-block["']>[\s\S]*?<\/details>/gi, '')
                              .replace(/<details\s+class=["']lollms-form-block["']>[\s\S]*?<\/details>/gi, '')
                              .trim();
                          if (cleaned) {
                              fullText += `### ${m.role.toUpperCase()}\n${cleaned}\n\n`;
                          }
                      });
              }

              if (draftMessage && draftMessage.trim()) {
                  fullText += `### USER\n${draftMessage.trim()}\n\n`;
              }

              progress.report({ message: "Writing to clipboard..." });
              await vscode.env.clipboard.writeText(fullText);
              vscode.window.showInformationMessage("✅ Full context and prompt copied to clipboard.");
          } catch (e: any) {
              vscode.window.showErrorMessage(`Failed to copy: ${e.message}`);
          } finally {
              // 3. Dismiss loading states
              this._panel.webview.postMessage({ command: 'setGeneratingState', isGenerating: false });
          }
      });
  }
  
  private async deleteMessage(messageId: string) {
    if (!this._currentDiscussion) {
        this.log("Delete failed: No active discussion.", 'ERROR');
        return;
    }

    // Find the message index
    const index = this._currentDiscussion.messages.findIndex(m => m.id === messageId);
    
    if (index === -1) {
        this.log(`Delete failed: Message ID ${messageId} not found in discussion.`, 'WARN');
        // Fallback: Just reload the UI to sync state
        await this.loadDiscussion();
        return;
    }

    // 1. Ask for confirmation (Ensure this is awaited and modal)
    const confirm = await vscode.window.showWarningMessage(
        `Delete this message and all subsequent messages? This cannot be undone.`,
        { modal: true },
        'Delete All'
    );

    if (confirm !== 'Delete All') {
        this.log("Delete cancelled by user.");
        return;
    }

    // 2. Perform the deletion
    // If it's an attachment, we only remove that specific message
    const targetMsg = this._currentDiscussion.messages[index];
    let removedIds: string[] = [];
    if (targetMsg.id?.startsWith('attachment_') || targetMsg.id?.startsWith('librarian_master_')) {
        if (targetMsg.id) removedIds.push(targetMsg.id);
        this._currentDiscussion.messages.splice(index, 1);
        this.log(`Deleted specific item: ${targetMsg.id}`);
    } else {
        // Otherwise, truncate from index onwards (Standard chat behavior)
        removedIds = this._currentDiscussion.messages
            .slice(index)
            .map(m => m.id)
            .filter((id): id is string => !!id);
        this._currentDiscussion.messages.splice(index);
        this.log(`Deleted messages starting from index ${index}.`);
    }

    // Invalidate dual LLM history cache so next turn regenerates clean context
    this._currentDiscussion.llmHistory = undefined;

    // Explicitly update in-memory caches to align with the deleted state
    this.chatHistory = [...this._currentDiscussion.messages];
    if (this.agentManager) {
        (this.agentManager as any).chatHistory = [...this._currentDiscussion.messages];
    }

    // 3. Immediately update Webview DOM without tearing down & reloading the entire discussion
    if (this._panel.webview && !this._isDisposed && removedIds.length > 0) {
        this._panel.webview.postMessage({ command: 'removeMessages', messageIds: removedIds });
    }

    // 4. Persist to disk
    if (!this._currentDiscussion.id.startsWith('temp-')) {
        await this._discussionManager.saveDiscussion(this._currentDiscussion);
    }
    
    // 5. Refresh sidebar tree
    vscode.commands.executeCommand('lollms-vs-coder.refreshDiscussions');
  }
  
  private async regenerateFromMessage(messageId: string) {
      if (!this._currentDiscussion) return;
      const index = this._currentDiscussion.messages.findIndex(m => m.id === messageId);
      if (index === -1) return;

      // Verify all open documents are saved before regenerating
      try {
          await vscode.workspace.saveAll(false);
      } catch {}

      const messageToResend = { ...this._currentDiscussion.messages[index] };
      if (messageToResend.role !== 'user') return;

      this.processManager.cancelForDiscussion(this.discussionId);
      ChatPanel.activeGenerations.delete(this.discussionId);

      this.clearTokenDebounce();
      if (this._tokenAbortController) {
          this._tokenAbortController.abort();
          this._tokenAbortController = null;
      }

      let waitCount = 0;
      while (this._isSendingMessage && waitCount < 10) {
          await new Promise(r => setTimeout(r, 50));
          waitCount++;
      }
      this._isSendingMessage = false;

      this.ensurePersistentDiscussionId();

      this._currentDiscussion.messages = this._currentDiscussion.messages.slice(0, index);
      this._currentDiscussion.llmHistory = undefined;

      if (!this._currentDiscussion.id.startsWith('temp-')) {
          await this._discussionManager.saveDiscussion(this._currentDiscussion);
      }

      await this.loadDiscussion();

      messageToResend.id = 'user_' + Date.now() + Math.random().toString(36).substring(2);

      await this.sendMessage(messageToResend);
  }
  
  private async insertMessage(afterMessageId: string | null, role: 'user' | 'assistant', content: string, isPastedAsAi?: boolean) {
      if (!this._currentDiscussion) return;
      const currentP = this.getCurrentPersona();
      const personaName = role === 'assistant' ? (currentP?.name || 'Lollms Coder (Default)') : undefined;
      const newMessage: ChatMessage = {
          id: (role === 'assistant' ? 'assistant_' : 'user_') + Date.now(),
          role: role,
          personalityName: personaName,
          isPastedAsAi: role === 'assistant' || isPastedAsAi === true,
          content: content,
          timestamp: Date.now()
      } as any;
      if (afterMessageId) {
          const index = this._currentDiscussion.messages.findIndex(m => m.id === afterMessageId);
          if (index !== -1) {
              this._currentDiscussion.messages.splice(index + 1, 0, newMessage);
          } else {
              this._currentDiscussion.messages.push(newMessage);
          }
      } else {
          this._currentDiscussion.messages.push(newMessage);
      }
      this.ensurePersistentDiscussionId();
      this._shouldOpenWizardOnLoad = false;
      await this._discussionManager.saveDiscussion(this._currentDiscussion);
      await this.loadDiscussion();
  }
  
  private async updateMessage(messageId: string, newContent: string) {
      if (!this._currentDiscussion) return;
      const msg = this._currentDiscussion.messages.find(m => m.id === messageId);
      if (msg) {
          msg.content = newContent;
          if (!this._currentDiscussion.id.startsWith('temp-')) {
              await this._discussionManager.saveDiscussion(this._currentDiscussion);
          }
      }
  }

  public adoptDiscussion(discussion: Discussion): void {
      if (this._isDisposed) return;
      const oldId = this.discussionId;
      const newId = discussion.id;

      if (oldId && oldId !== newId) {
          ChatPanel.panels.delete(oldId);
          ChatPanel.activeGenerations.delete(oldId);
          if (ChatPanel.activeAgents.has(oldId)) {
              const agent = ChatPanel.activeAgents.get(oldId)!;
              ChatPanel.activeAgents.delete(oldId);
              ChatPanel.activeAgents.set(newId, agent);
          }
      }

      this.discussionId = newId;
      this._currentDiscussion = discussion;
      if (discussion.capabilities) {
          this._discussionCapabilities = discussion.capabilities;
      } else {
          discussion.capabilities = this._discussionCapabilities;
      }
      this._shouldOpenWizardOnLoad = false;

      ChatPanel.panels.set(newId, this);
      ChatPanel.currentPanel = this;

      if (this._panel) {
          this._panel.title = discussion.title || 'New Discussion';
      }

      if (this.agentManager) {
          const savedAgentMode = !!this._discussionCapabilities.agentMode;
          if (this.agentManager.getIsActive() !== savedAgentMode) {
              (this.agentManager as any).isActive = savedAgentMode;
          }
      }
  }

  public ensurePersistentDiscussionId(): void {
      if (!this._currentDiscussion) return;
      if (this._currentDiscussion.id.startsWith('temp-') || this.discussionId.startsWith('temp-')) {
          const oldId = this.discussionId;
          const newId = 'disc-' + Date.now().toString() + Math.random().toString(36).substring(2);
          ChatPanel.panels.delete(oldId);
          ChatPanel.activeGenerations.delete(oldId);
          if (ChatPanel.activeAgents.has(oldId)) {
              const agent = ChatPanel.activeAgents.get(oldId)!;
              ChatPanel.activeAgents.delete(oldId);
              ChatPanel.activeAgents.set(newId, agent);
          }
          this.discussionId = newId;
          this._currentDiscussion.id = newId;
          if (this._currentDiscussion.capabilities) {
              (this._currentDiscussion.capabilities as any).discussionId = newId;
          }
          ChatPanel.panels.set(newId, this);
      }
  }

  private async handleSaveAndSendMessage(messageId: string, newContent: any, role: string) {
      if (!this._currentDiscussion) return;

      try {
          await vscode.workspace.saveAll(false);
      } catch {}

      let index = this._currentDiscussion.messages.findIndex(m => m.id === messageId);
      if (index === -1 && this._currentDiscussion.messages.length > 0) {
          index = this._currentDiscussion.messages.findIndex(m => {
              const text = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.find((p: any) => p.type === 'text')?.text : '');
              return text && typeof newContent === 'string' && (text === newContent || newContent.startsWith(text.substring(0, 30)));
          });
      }

      if (index === -1) {
          await this.sendMessage({
              id: 'user_' + Date.now() + Math.random().toString(36).substring(2),
              role: 'user',
              content: newContent,
              timestamp: Date.now()
          });
          return;
      }

      this.processManager.cancelForDiscussion(this.discussionId);
      ChatPanel.activeGenerations.delete(this.discussionId);

      this.clearTokenDebounce();
      if (this._tokenAbortController) {
          this._tokenAbortController.abort();
          this._tokenAbortController = null;
      }

      let waitCount = 0;
      while (this._isSendingMessage && waitCount < 10) {
          await new Promise(r => setTimeout(r, 50));
          waitCount++;
      }
      this._isSendingMessage = false;

      this.ensurePersistentDiscussionId();
      this._shouldOpenWizardOnLoad = false;

      const targetMsg = this._currentDiscussion.messages[index];
      const isUser = (role === 'user') || (targetMsg && targetMsg.role === 'user');

      if (isUser) {
          targetMsg.content = newContent;
          targetMsg.timestamp = Date.now();

          this._currentDiscussion.messages = this._currentDiscussion.messages.slice(0, index + 1);

          await this._discussionManager.saveDiscussion(this._currentDiscussion);
          await this.loadDiscussion();

          const messageToSend: ChatMessage = {
              id: targetMsg.id || ('user_' + Date.now() + Math.random().toString(36).substring(2)),
              role: 'user',
              content: newContent,
              timestamp: targetMsg.timestamp
          };
          this._currentDiscussion.messages.pop();

          try {
              await this.sendMessage(messageToSend);
          } catch (sendErr: any) {
              this.log(`Error resending edited message: ${sendErr.message}`, 'ERROR');
              if (!this._currentDiscussion.messages.some(m => m.id === messageToSend.id)) {
                  this._currentDiscussion.messages.push(messageToSend);
                  await this._discussionManager.saveDiscussion(this._currentDiscussion);
                  await this.loadDiscussion();
              }
              vscode.window.showErrorMessage(`Failed to send edited message: ${sendErr.message}`);
          }
      } else {
          targetMsg.content = newContent;
          targetMsg.timestamp = Date.now();

          this._currentDiscussion.messages = this._currentDiscussion.messages.slice(0, index + 1);

          await this._discussionManager.saveDiscussion(this._currentDiscussion);
          await this.loadDiscussion();

          await this.sendMessage({
              id: 'user_continue_' + Date.now(),
              role: 'user',
              content: "Please proceed with the next step based on the response above."
          });
      }
  }
  
  /**
   * Processes an external file (PDF, DOCX, Image) and adds it specifically
   * to the current discussion as an attachment metadata block.
   */
  private async extractPdfImagesViaWebview(base64Data: string): Promise<string[]> {
      return new Promise((resolve, reject) => {
          const requestId = Date.now().toString() + Math.random().toString(36).substring(2);
          
          const timeout = setTimeout(() => {
              delete this.pdfExtractionPromises[requestId];
              reject(new Error("PDF rendering timed out."));
          }, 60000);

          this.pdfExtractionPromises[requestId] = { resolve, reject, timeout };

          this._panel.webview.postMessage({
              command: 'extractPdfPages',
              requestId: requestId,
              base64Data: base64Data
          });
      });
  }

  private async _handleFileAttachment(name: string, content: string, isImage: boolean, mode?: string) {
      try {
          // Note: We DO NOT add to ContextStateProvider here. 
          // These files are discussion-local "Imported Data".
          const isSvg = name.toLowerCase().endsWith('.svg');
          if (isImage && !isSvg) {
              const msg: ChatMessage = {
                  id: 'user_img_' + Date.now() + Math.random().toString(36).substring(2),
                  role: 'user',
                  content:[
                      { type: 'text', text: `Attached image: ${name}` },
                      { type: 'image_url', image_url: { url: content } }
                  ]
              };
              await this.addMessageToDiscussion(msg);
          } else if (isSvg) {
              // SVGs are text XML files - decode base64 or read raw content and save as text so the LLM can understand and edit it
              let svgText = "";
              if (content.includes('base64,')) {
                  const base64 = content.split('base64,')[1];
                  svgText = Buffer.from(base64, 'base64').toString('utf8');
              } else if (content.startsWith('data:image/svg+xml')) {
                  svgText = decodeURIComponent(content.replace(/^data:image\/svg\+xml;?(?:utf8)?,/, ''));
              } else {
                  svgText = content;
              }

              const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
              if (workspaceFolder && svgText.trim().length > 0) {
                  const cacheDir = vscode.Uri.joinPath(workspaceFolder.uri, '.lollms', 'external_files');
                  await vscode.workspace.fs.createDirectory(cacheDir).then(undefined, () => {});

                  const safeName = name.replace(/[^a-zA-Z0-9.]/g, '_');
                  const fileUri = vscode.Uri.joinPath(cacheDir, safeName);

                  await vscode.workspace.fs.writeFile(fileUri, Buffer.from(svgText, 'utf8'));

                  const relativePath = path.join('.lollms', 'external_files', safeName).replace(/\\/g, '/');
                  await this._contextManager.getContextStateProvider()?.addFilesToContext([relativePath]);
                  await this.addFilesToDiscussionContext([relativePath]);
                  this.recordCurrentPromptFiles([relativePath]);
              }

              const systemMsg: ChatMessage = {
                  id: 'attachment_' + Date.now() + Math.random().toString(36).substring(2),
                  role: 'system',
                  content: `Attached SVG file: **${name}**\n\`\`\`xml:${name}\n${svgText}\n\`\`\``,
                  attachmentData: {
                      name,
                      text: svgText,
                      images: []
                  }
              } as any;
              await this.addMessageToDiscussion(systemMsg);
          } else {
              const base64 = content.split(',')[1];
              const extractedImages: { filePath: string; data: string }[] =[];
              let text = "";
              
              // Local Webview PDF Page Rendering
              if (name.toLowerCase().endsWith('.pdf') && (mode === 'images' || mode === 'mixed')) {
                  this._panel.webview.postMessage({ command: 'setGeneratingState', isGenerating: true, statusText: 'Rendering PDF pages locally...' });
                  try {
                      const pageImages = await this.extractPdfImagesViaWebview(base64);
                      pageImages.forEach((imgDataUrl, idx) => {
                          extractedImages.push({
                              filePath: `${name}#page_${idx+1}`,
                              data: imgDataUrl
                          });
                      });
                      if (mode === 'images') {
                          text = ""; // Visuals only
                      } else {
                          // Mixed mode requires text extraction as well
                          text = await this._contextManager.processFile(name, base64,[]);
                      }
                  } catch (e: any) {
                      throw new Error(`Failed to render PDF pages locally: ${e.message}`);
                  } finally {
                      this._panel.webview.postMessage({ command: 'setGeneratingState', isGenerating: false });
                  }
              } else {
                  // Standard text extraction
                  text = await this._contextManager.processFile(name, base64, extractedImages, mode);
              }

              // --- UNIFIED EXTERNAL INGESTION PIPELINE ---
              // Write the parsed document to .lollms/external_files so it is cleanly segregated from project source code
              const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
              if (workspaceFolder && text.trim().length > 0) {
                  const gateRes = await this._contextManager.evaluateWithPoisoningGate(text, `attachment://${name}`, {
                      capabilities: this._discussionCapabilities
                  });
                  if (gateRes.verdict === 'blocked') {
                      vscode.window.showWarningMessage(gateRes.reason || `Blocked attachment '${name}' at Context Poisoning Gate.`);
                      return;
                  }
                  text = gateRes.sanitizedContent;

                  const cacheDir = vscode.Uri.joinPath(workspaceFolder.uri, '.lollms', 'external_files');
                  await vscode.workspace.fs.createDirectory(cacheDir).then(undefined, () => {});

                  const safeName = name.replace(/[^a-zA-Z0-9.]/g, '_');
                  const fileUri = vscode.Uri.joinPath(cacheDir, safeName);

                  await vscode.workspace.fs.writeFile(fileUri, Buffer.from(text, 'utf8'));

                  const relativePath = path.join('.lollms', 'external_files', safeName).replace(/\\/g, '/');
                  await this._contextManager.getContextStateProvider()?.addFilesToContext([relativePath]);
                  await this.addFilesToDiscussionContext([relativePath]);
                  this.recordCurrentPromptFiles([relativePath]);
              }

              const systemMsg: ChatMessage = {
                  id: 'attachment_' + Date.now() + Math.random().toString(36).substring(2),
                  role: 'system',
                  // We embed metadata in the message object so the renderer can build the rich collapsible
                  content: `Attached file: **${name}**`,
                  // @ts-ignore - custom metadata for the renderer
                  attachmentData: {
                      name,
                      text,
                      images: extractedImages
                  }
              };
              await this.addMessageToDiscussion(systemMsg);
          }
      } catch (e: any) {
          this.log(`File attachment failed: ${e.message}`, 'ERROR');
          vscode.window.showErrorMessage(`Failed to attach ${name}: ${e.message}`);
      } finally {
          // CRITICAL: Stop the spinner in the UI
          this._panel.webview.postMessage({ command: 'setGeneratingState', isGenerating: false });
          // Update tokens as context has changed
          this.updateContextAndTokens();
      }
  }
  
  public async requestUserInput(question: string, signal: AbortSignal, options?: { isAgentZone?: boolean }): Promise<string> {
      // Ensure webview is ready before trying to send the form
      if (!this._isWebviewReady) {
          await this.waitForWebviewReady();
      }

      return new Promise((resolve, reject) => {
          this._inputResolver = resolve;

          // Always display the prompt or form directly in the chat discussion stream
          this.addMessageToDiscussion({
              id: 'agent_request_' + Date.now(),
              role: 'assistant',
              content: question,
              model: this._currentDiscussion?.model || this._lollmsAPI.getModelName()
          });

          this.updateGeneratingState();

          signal.addEventListener('abort', () => {
              if (this._inputResolver === resolve) {
                  this._inputResolver = null;
                  reject(new Error("Input request aborted."));
              }
          }, { once: true });
      });
  }


  public async sendMessage(message: ChatMessage, autoContext: boolean = false) {
    if (this._isDisposed || !this._currentDiscussion || !this.processManager) return;

    if (this._isSendingMessage) {
        this.log("sendMessage blocked: another message is actively being dispatched", "WARN");
        return;
    }
    this._isSendingMessage = true;

    try {
        await this._executeSendMessage(message, autoContext);
    } finally {
        this._isSendingMessage = false;
    }
  }

private async _executeSendMessage(message: ChatMessage, autoContext: boolean = false) {
    if (this._isDisposed || !this._currentDiscussion || !this.processManager) return;

    // 0. Ensure all modified files and open editors are saved before reading context or generating
    let batchWaitLimit = 0;
    while (ChatPanel.isBatchApplying && batchWaitLimit < 50) {
        await new Promise(r => setTimeout(r, 40));
        batchWaitLimit++;
    }
    ChatPanel.isBatchApplying = false;
    try {
        await vscode.workspace.saveAll(false);
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.isDirty && !doc.isUntitled) {
                await doc.save();
            }
        }
    } catch (saveErr) {
        this.log(`Warning: Failed to flush open editors: ${saveErr}`, 'WARN');
    }

    // Intercept input resolver if waiting for user decision (e.g. Git Safeguard or interactive forms)
    if (this._inputResolver) {
        const resolver = this._inputResolver;
        this._inputResolver = null;
        const text = typeof message.content === 'string' 
            ? message.content 
            : (Array.isArray(message.content) 
                ? (message.content.find((p: any) => p.type === 'text')?.text || '')
                : '');

        if (this._activeAgentAnswerId && this._currentDiscussion) {
            const activeMsg = this._currentDiscussion.messages.find(m => m.id === this._activeAgentAnswerId);
            if (activeMsg && typeof activeMsg.content === 'string' && /<(?:lollms_form|form)\b/i.test(activeMsg.content)) {
                let summaryText = text;
                if (text.startsWith('FORM_SUBMISSION:')) {
                    try {
                        const parsed = JSON.parse(text.substring(16));
                        summaryText = Object.entries(parsed).map(([k, v]) => `**${k}**: \`${v}\``).join(', ');
                    } catch {}
                }
                activeMsg.content = activeMsg.content.replace(
                    /<(?:lollms_form|form)\b[\s\S]*?<\/(?:lollms_form|form)>/gi,
                    `\n> ✅ **Decision Confirmed:** ${summaryText}\n`
                );
                if (!this._currentDiscussion.id.startsWith('temp-')) {
                    await this._discussionManager.saveDiscussion(this._currentDiscussion);
                }
                if (this._panel.webview && !this._isDisposed) {
                    this._panel.webview.postMessage({
                        command: 'updateMessage',
                        messageId: this._activeAgentAnswerId,
                        newContent: activeMsg.content,
                        isFinal: false
                    });
                }
            }
        }

        resolver(text);
        this.updateGeneratingState();
        return;
    }

    await this.waitForWebviewReady();

    // Force strict alignment of conversation state caches before building prompts
    this.chatHistory = [...this._currentDiscussion.messages];
    if (this.agentManager) {
        (this.agentManager as any).chatHistory = [...this._currentDiscussion.messages];
    }

    const { 
        isModelVisionCapable,
        isValidFilePath = () => true,
        ensureStrictAlternatingRoles = (msgs: ChatMessage[]) => msgs,
        normalizePseudoFileBlocks = (t: string) => t,
        stripThinkingTags = (text: string) => text.replace(/<think>[\s\S]*?<\/think>/gi, '')
    } = require('../../utils');

    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    const targetModel = this._currentDiscussion?.model || this._lollmsAPI.getModelName();
    const folders = vscode.workspace.workspaceFolders;

    const currentP = this.getCurrentPersona();
    const personaContent = currentP?.systemPrompt || "";
    const personaName = currentP?.name || "Lollms";

    const generationStartTime = Date.now();
    const proc = this.processManager.register(this.discussionId, 'Lollms: Preparing workspace context...');
    const processId = proc.id;
    let controller = proc.controller;

    this._discussionCapabilities = this._currentDiscussion.capabilities || this._discussionCapabilities;

    const autoSuppress = config.get<boolean>('autoSuppressImagesForNonVisionModels', true);
    const visionSupported = this._discussionCapabilities.enableImages !== false && 
        (!autoSuppress || isModelVisionCapable(targetModel, config));

    let userContent = message.content;
    if (Array.isArray(userContent)) {
        if (!visionSupported) {
            userContent = userContent.map((part: any) => {
                if (part.type === 'image_url') {
                    return { ...part, isMuted: true };
                }
                return part;
            });
        }
    }

    // 1. Preserve user message immediately
    const userMessage: ChatMessage = { 
        ...message, 
        content: userContent,
        id: message.id || 'user_' + Date.now() + Math.random().toString(36).substring(2),
        timestamp: Date.now()
    };

    const justAddedFromCaller = Array.from(this._pendingJustAddedFiles);
    this._pendingJustAddedFiles.clear();

    const isNewUserPrompt = userMessage.role === 'user' && 
        (typeof userMessage.content === 'string' 
            ? !userMessage.content.startsWith('FORM_SUBMISSION:') && !userMessage.content.startsWith('STOP_REQUESTED')
            : true);
    if (isNewUserPrompt && !(message as any).isMultiPartContinuation) {
        this._currentPromptAddedFiles.clear();
        this._activeMultiPartPlan = undefined;
    }
    if (justAddedFromCaller.length > 0) {
        this.recordCurrentPromptFiles(justAddedFromCaller);
    }

    await this.addMessageToDiscussion(userMessage);

    const useLibrarianEarly = this._discussionCapabilities.useLibrarian === true && this._discussionCapabilities.contextGovernorEnabled !== false;
    this.processManager.updateDescription(processId, !useLibrarianEarly ? "Coding..." : "Preparing workspace context...");
    this.updateGeneratingState();

    // Auto-title discussion on the first user prompt if untitled
    const isUntitled = !this._currentDiscussion.title || 
                       this._currentDiscussion.title === 'New Discussion' || 
                       this._currentDiscussion.title === 'Untitled Discussion' ||
                       this._currentDiscussion.title.startsWith('New Discussion');

    if (isUntitled && !this._currentDiscussion.id.startsWith('temp-')) {
        setImmediate(async () => {
            try {
                const generatedTitle = await this._discussionManager.generateDiscussionTitle(this._currentDiscussion!);
                if (generatedTitle && generatedTitle.trim()) {
                    const cleanTitle = generatedTitle.trim();
                    this._currentDiscussion!.title = cleanTitle;
                    await this._discussionManager.saveDiscussion(this._currentDiscussion!);
                    if (this._panel && !this._isDisposed) {
                        this._panel.title = cleanTitle;
                    }
                    vscode.commands.executeCommand('lollms-vs-coder.refreshDiscussions');
                }
            } catch (titlingErr) {
                this.log(`Auto-titling background error: ${titlingErr}`, 'WARN');
            }
        });
    }

    // Route to Agent Manager if Agent Mode is active
    if (this._discussionCapabilities.agentMode && folders && folders.length > 0) {
        const objectiveText = typeof message.content === 'string' 
            ? message.content 
            : (Array.isArray(message.content) 
                ? message.content.find((p: any) => p.type === 'text')?.text || "Run task"
                : "Run task");

        if (processId) {
            this.processManager.unregister(processId);
        }

        // EMBEDDED AGENT MODE: bind this turn to ONE assistant answer block in the same transcript.
        // All agent rounds (plan → tool → exec → verify → question) accumulate inside this block.
        const agentAnswerId = 'assistant_agent_' + Date.now().toString() + Math.random().toString(36).substring(2);
        this._activeAgentAnswerId = agentAnswerId;
        const currentPersona = this.getCurrentPersona();
        await this.addMessageToDiscussion({
            id: agentAnswerId,
            role: 'assistant',
            content: '',
            startTime: Date.now(),
            model: targetModel,
            personalityName: currentPersona?.name || 'Lollms',
            timestamp: Date.now()
        }, true);

        setImmediate(async () => {
            try {
                await this.agentManager.handleUserMessage(
                    objectiveText,
                    this._currentDiscussion,
                    folders[0]
                );
            } catch (agentErr: any) {
                this.log(`Agent execution error: ${agentErr?.message || agentErr}`, 'ERROR');
                if (this._activeAgentAnswerId) {
                    await this.updateMessageContent(this._activeAgentAnswerId, `❌ **Agent Execution Error:** ${agentErr?.message || agentErr}`);
                }
            } finally {
                const targetId = agentAnswerId;
                if (this._activeAgentAnswerId === agentAnswerId) {
                    this._activeAgentAnswerId = undefined;
                }
                const targetMsg = this._currentDiscussion?.messages.find(m => m.id === targetId);
                if (targetMsg) {
                    if (!targetMsg.content || (typeof targetMsg.content === 'string' && targetMsg.content.trim() === '')) {
                        const idx = this._currentDiscussion!.messages.findIndex(m => m.id === targetId);
                        if (idx !== -1) {
                            this._currentDiscussion!.messages.splice(idx, 1);
                        }
                        if (this._panel.webview && !this._isDisposed) {
                            this._panel.webview.postMessage({ command: 'removeMessage', messageId: targetId });
                        }
                    } else {
                        if (this._panel.webview && !this._isDisposed) {
                            this._panel.webview.postMessage({ command: 'finalizeMessage', id: targetId, fullContent: targetMsg.content });
                        }
                    }
                }
                this.updateGeneratingState();
            }
        });
        return;
    }

    // Debug sandbox branch creation
    if (this._discussionCapabilities.debugMode && message.role !== 'system') {
        this.processManager.updateDescription(processId, "🐞 Creating Debug Sandbox...");
        this.updateGeneratingState();
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            const isClean = await this._gitIntegration.isClean(workspaceFolder);
            if (isClean) {
                const debugBranch = `debug/sandbox-${Date.now()}`;
                await this._gitIntegration.createAndCheckoutBranch(workspaceFolder, debugBranch);
                await this.addMessageToDiscussion({ 
                    role: 'system', 
                    content: `🛡️ **Debugger Sandbox**: Switched to branch \`${debugBranch}\`. I can now safely run instrumentation.` 
                });
            } else {
                await this.addMessageToDiscussion({ 
                    role: 'system', 
                    content: `⚠️ **Debugger Warning**: Workspace has uncommitted changes. Proceeding without creating a sandbox branch.` 
                });
            }
        }
    }

    await new Promise(resolve => setTimeout(resolve, 30));

    // Multi-Agent Herd Mode execution
    if (this._discussionCapabilities.herdMode && this.herdManager) {
        this.processManager.updateDescription(processId, "🐂 Planning herd...");
        this.updateGeneratingState();

        try {
            const promptText = typeof message.content === 'string' ? message.content : 'User rich content.';
            const herdMessageId = 'herd_log_' + Date.now();
            const orchestrator = this._discussionCapabilities.herdOrchestratorModel 
                || this._currentDiscussion.model 
                || this._lollmsAPI.getModelName();

            const modelPool = config.get<any[]>('herdDynamicModelPool') || [];
            const maxRounds = this._discussionCapabilities.herdRounds || 3;

            await this.addMessageToDiscussion({ 
                id: herdMessageId, 
                role: 'system', 
                content: `### 🐂 Herd Discussion\n\n*Planning team...*`, 
                skipInPrompt: true 
            });

            this.processManager.updateDescription(processId, "🐂 Assembling team...");
            const plan = modelPool.length > 0
                ? await this.herdManager.planDynamicHerd(
                    promptText,
                    modelPool,
                    orchestrator,
                    controller.signal,
                    this._discussionCapabilities
                )
                : null;

            if (!plan) {
                await this.updateMessageContent(herdMessageId, 
                    `### 🐂 Herd Discussion\n\n❌ No model pool configured. Add models to \`lollmsVsCoder.herdDynamicModelPool\` in settings.`
                );
                this.processManager.unregister(processId);
                this.updateGeneratingState();
                return;
            }

            this.processManager.updateDescription(processId, "🐂 Herd thinking...");

            const importedIds = this._currentDiscussion?.importedSkills || [];
            const isContextMuted = this._discussionCapabilities?.disableProjectContext === true;
            const contextData = await this._contextManager.getContextContent({
                importedSkillIds: importedIds,
                includeTree: !isContextMuted,
                modelName: targetModel,
                signal: controller.signal
            });

            const synthesisResult = await this.herdManager.run(
                promptText,
                plan.pre,
                plan.post,
                maxRounds,
                orchestrator,
                contextData.text,
                (status: string) => {
                    this.processManager.updateDescription(processId, status);
                    this.updateGeneratingState();
                },
                async (newContent: string) => { 
                    await this.updateMessageContent(herdMessageId, newContent); 
                },
                controller.signal,
                this._currentDiscussion.messages,
                this._discussionCapabilities
            );

            if (!controller.signal.aborted && synthesisResult) {
                const assistantMessageId = 'assistant_' + Date.now().toString();
                await this.addMessageToDiscussion({ 
                    id: assistantMessageId, 
                    role: 'assistant', 
                    content: synthesisResult, 
                    model: orchestrator 
                }, true);

                if (!this._isDisposed) {
                    this._panel.webview.postMessage({ 
                        command: 'finalizeMessage', 
                        id: assistantMessageId, 
                        fullContent: synthesisResult 
                    });
                }
            }
        } catch (error: any) { 
            if (error.name !== 'AbortError') {
                this.addMessageToDiscussion({ 
                    role: 'system', 
                    content: `Herd Error: ${error.message}` 
                }); 
            }
        } finally { 
            this.processManager.unregister(processId); 
            this.updateGeneratingState(); 
            this.updateContextAndTokens(); 
        }
        return;
    }

    let assistantMessageId = '';
    let fullResponse = "";
    let currentFullResponseBuffer = "";

    try {
        if (controller?.signal.aborted) {
            if (processId) this.processManager.unregister(processId);
            this.updateGeneratingState();
            return;
        }

        const forceFullCode = this._discussionCapabilities?.forceFullCode || false;
        const importedIds = this._currentDiscussion?.importedSkills || [];
        const isContextMuted = this._discussionCapabilities?.disableProjectContext === true;

        const allMessages = (this._currentDiscussion.llmHistory || this._currentDiscussion.messages || []).filter(m => !m.skipInPrompt);
        const lastUserIdx = [...allMessages].reverse().findIndex(m => m.role === 'user');
        const actualLastUserIdx = lastUserIdx === -1 ? -1 : (allMessages.length - 1 - lastUserIdx);

        let history: ChatMessage[] = [];
        let currentPromptMessage: ChatMessage | undefined;

        if (actualLastUserIdx !== -1) {
            currentPromptMessage = { ...allMessages[actualLastUserIdx] };
            history = allMessages.filter((_, idx) => idx !== actualLastUserIdx);
        } else {
            history = allMessages;
        }

        let rawUserPromptText = "";
        if (typeof message.content === 'string') {
            rawUserPromptText = message.content;
        } else if (Array.isArray(message.content)) {
            rawUserPromptText = message.content
                .filter((part: any) => part && part.type === 'text' && typeof part.text === 'string')
                .map((part: any) => part.text)
                .join('\n');
        } else {
            rawUserPromptText = String(message.content || '');
        }
        rawUserPromptText = rawUserPromptText.replace(/data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=]{100,}/g, '[Attached Image]').trim();

        // Detect plan confirmation
        const lastAssistantMsg = [...history]
            .filter(m => m.role === 'assistant' && !m.skipInPrompt)
            .pop();

        const userPromptLower = rawUserPromptText.toLowerCase().trim();
        const isConfirmationText = /^(?:yes|yep|y|ok|okay|confirm|confirmed|proceed|go ahead|validate|validated|approved|approve|do it|sure|apply|apply it|lgtm|continue)\b/i.test(userPromptLower) ||
            rawUserPromptText.startsWith('FORM_SUBMISSION:') ||
            userPromptLower.includes('i confirm') ||
            userPromptLower.includes('i validate') ||
            userPromptLower.includes('go ahead') ||
            userPromptLower.includes('proceed');

        const lastAssistantContent = typeof lastAssistantMsg?.content === 'string' 
            ? lastAssistantMsg.content 
            : (Array.isArray(lastAssistantMsg?.content) ? lastAssistantMsg.content.map((p: any) => p.text || '').join('\n') : '');

        const useLibrarianPre = this._discussionCapabilities.useLibrarian === true && this._discussionCapabilities.contextGovernorEnabled !== false;

        const lastAssistantHadPlan = useLibrarianPre && (
            lastAssistantContent.includes('<librarian_off>') ||
            lastAssistantContent.toLowerCase().includes('stage 2') ||
            lastAssistantContent.toLowerCase().includes('phase 2') ||
            lastAssistantContent.toLowerCase().includes('confirm') ||
            lastAssistantContent.toLowerCase().includes('plan')
        );

        const isFormSubmission = typeof rawUserPromptText === 'string' && rawUserPromptText.startsWith('FORM_SUBMISSION:');
        const isPlanConfirmation = useLibrarianPre && isConfirmationText && lastAssistantHadPlan;

        // ── UNIFIED SINGLE ASSISTANT MESSAGE INITIALIZATION ──
        // Everything for this turn (Librarian directive + Coder implementation) lives in this ONE message!
        assistantMessageId = 'assistant_' + Date.now().toString() + Math.random().toString(36).substring(2);
        currentFullResponseBuffer = "";

        const memManager = (this as any).projectMemoryManager || this.agentManager?.projectMemoryManager;
        const projectMemory = (this._discussionCapabilities.projectMemoryEnabled !== false && memManager)
            ? await memManager.getFormattedMemoryBlock(rawUserPromptText)
            : "";

        const initialAssistantMessage: ChatMessage = {
            id: assistantMessageId,
            role: 'assistant',
            content: '',
            startTime: Date.now(),
            model: targetModel,
            personalityName: personaName,
            timestamp: Date.now()
        };

        await this.addMessageToDiscussion(initialAssistantMessage, true);

        // ── STEP 1: LIBRARIAN MASTER ARCHITECTURAL DIRECTIVE (CONTROLLED BY AUTOMATION TOGGLE) ──
        const useLibrarian = this._discussionCapabilities.useLibrarian === true && this._discussionCapabilities.contextGovernorEnabled !== false;
        const isFastMode = !useLibrarian;
        const isMultiPartCont = !!(message as any).isMultiPartContinuation || !!userMessage.isMultiPartContinuation;

        const isGreetingOnly = /^(?:hi|hello|hey|greetings|good\s+(?:morning|afternoon|evening)|thanks|thank\s+you)\b/i.test(rawUserPromptText.trim()) && rawUserPromptText.trim().split(/\s+/).length <= 4;

        // When Librarian is enabled via automation toggles, run the 3-phase workflow:
        // Phase 0: Fast inspection of current context
        // If sufficient: Call Coder directly as if there were no librarian
        // Else: Free context files (mute all), Phase 1 scouting, Phase 2 understanding, Phase 3 planning
        const shouldRunMasterLibrarian = useLibrarian &&
            !isPlanConfirmation && 
            !isFormSubmission &&
            !isMultiPartCont && 
            !this._discussionCapabilities.disableProjectContext &&
            folders && folders.length > 0 &&
            !isGreetingOnly;

        let librarianMasterReport = "";

        if (shouldRunMasterLibrarian) {
            this.processManager.updateDescription(processId, "📚 Librarian: Phase 0 fast inspection of context...");
            this.updateGeneratingState();

            const phase0StartHtml = `### 📚 **Lead Librarian: Phase 0 — Fast Context Inspection**\n\n<div class="waiting-animation" style="display:flex; align-items:center; gap:8px; opacity:0.85; padding:6px 0;"><div class="spinner"></div> <span>Evaluating active context files against your request...</span></div>`;
            await this.updateMessageContent(assistantMessageId, phase0StartHtml, false);

            // Phase 0: Fast inspection
            const fastInspectionRes = await ContextLibrarian.fastInspection({
                lollmsAPI: this._lollmsAPI,
                contextManager: this._contextManager,
                discussionManager: this._discussionManager,
                currentDiscussion: this._currentDiscussion!,
                targetModel,
                userPrompt: rawUserPromptText,
                signal: controller.signal,
                history: history,
                recalledMemories: projectMemory
            });

            // Capture files originally active in context before Phase 0 inspection
            const providerAtStart = this._contextManager.getContextStateProvider();
            const originallyIncluded = providerAtStart ? providerAtStart.getIncludedFiles().filter(f => f && f.path).map(f => f.path) : [];
            const originallyMutedSet = new Set((this._currentDiscussion.mutedFiles || []).map(m => m.replace(/\\/g, '/').toLowerCase().trim()));
            const originalActiveFiles = originallyIncluded.filter(f => !originallyMutedSet.has(f.replace(/\\/g, '/').toLowerCase().trim()));

            if (fastInspectionRes.sufficient) {
                // If original files in context are ok, use them directly as if there were no librarian
                this.log(`[Librarian Phase 0] Context is sufficient: "${fastInspectionRes.rationale}". Calling Coder directly.`);
                this.processManager.updateDescription(processId, "⚡ Context verified sufficient. Calling Coder directly...");
                this.updateGeneratingState();
                await this.updateMessageContent(assistantMessageId, `✅ **Phase 0**: Context verified sufficient (${fastInspectionRes.rationale || 'all required files active'}). Starting Coder...\n\n`, false);
            } else {
                this.log(`[Librarian Phase 0] Context not sufficient: "${fastInspectionRes.rationale}". Freeing context and starting Phase 1 scouting.`);
                
                // Free the context from code files content (keep external research documents, tree, and files from previous turn active)
                const { isProjectFile } = require('../../utils');
                const prevTurnFiles = this.getPreviousTurnFiles();
                const currentPromptFiles = this.getCurrentPromptFiles();
                const projectFilesToMute = originallyIncluded.filter(p => {
                    if (!isProjectFile(p)) return false;
                    const normP = p.replace(/\\/g, '/').toLowerCase().trim();
                    return !prevTurnFiles.has(normP) && !currentPromptFiles.has(normP) && !this._currentPromptAddedFiles.has(normP);
                });
                if (projectFilesToMute.length > 0) {
                    await this.muteFiles(projectFilesToMute);
                }

                // Phase 1 Scouting & Phase 2/3 Understanding & Planning
                this.processManager.updateDescription(processId, "📚 Librarian: Scouting codebase & dependencies...");
                this.updateGeneratingState();

                const liveScoutPlaceholder = `### 📚 **Lead Librarian: Scouting & Architecture**\n\n<div class="waiting-animation" style="display:flex; align-items:center; gap:8px; opacity:0.85; padding:6px 0;"><div class="spinner"></div> <span>Inspecting codebase, AST &amp; dependencies...</span></div>`;
                await this.updateMessageContent(assistantMessageId, liveScoutPlaceholder, false);

                try {
                    const libRes = await ContextLibrarian.filterFilesByPrompt({
                        lollmsAPI: this._lollmsAPI,
                        contextManager: this._contextManager,
                        discussionManager: this._discussionManager,
                        currentDiscussion: this._currentDiscussion!,
                        targetModel,
                        prompt: rawUserPromptText,
                        userPrompt: rawUserPromptText,
                        history: history,
                        signal: controller.signal,
                        currentMutedFiles: this._currentDiscussion?.mutedFiles || [],
                        pruneMsgId: assistantMessageId,
                        projectMemoryManager: this.projectMemoryManager || this.agentManager?.projectMemoryManager,
                        ignoreContextSize: this._discussionCapabilities.ignoreContextSize === true,
                        onUpdateMessage: async (_msgId, liveContent) => {
                            await this.updateMessageContent(assistantMessageId, liveContent, false);
                        },
                        onStatusUpdate: (st) => {
                            this.processManager.updateDescription(processId, st);
                            this.updateGeneratingState();
                        }
                    });

                    // GUARANTEE: The Librarian MUST ALWAYS add files to context!
                    // Determine phase 1 target files from multiPartPlan or keptFiles
                    let rawTargetFiles: string[] = [];
                    if (libRes.multiPartPlan && libRes.multiPartPlan.parts.length > 0) {
                        this._activeMultiPartPlan = libRes.multiPartPlan;
                        rawTargetFiles = [...(libRes.multiPartPlan.parts[0].editFiles || [])];
                    } else if (libRes.keptFiles?.length) {
                        rawTargetFiles = [...libRes.keptFiles];
                    }

                    // Fallback: If still empty, use any newly added files or top original files
                    if (rawTargetFiles.length === 0 && libRes.addedFiles?.length) {
                        rawTargetFiles = [...libRes.addedFiles];
                    }
                    if (rawTargetFiles.length === 0 && originalActiveFiles.length > 0) {
                        rawTargetFiles = [...originalActiveFiles];
                    }

                    // Resolve every target file to its verified workspace relative path
                    const resolvedTargetFiles: string[] = [];
                    for (const rtf of rawTargetFiles) {
                        const resolved = await this.resolveWorkspaceFile(rtf);
                        const finalPath = resolved ? resolved.relativePath : rtf;
                        if (!resolvedTargetFiles.includes(finalPath)) {
                            resolvedTargetFiles.push(finalPath);
                        }
                        if (resolved) {
                            this._contextManager.refreshFileInCache(resolved.uri);
                        }
                    }

                    // Unmute and add resolved target files to active context
                    if (resolvedTargetFiles.length > 0) {
                        await this.unmuteFiles(resolvedTargetFiles);
                        await this._contextManager.getContextStateProvider()?.addFilesToContext(resolvedTargetFiles);
                        await this.addFilesToDiscussionContext(resolvedTargetFiles);
                        this.recordCurrentPromptFiles(resolvedTargetFiles);

                        // Apply Librarian's granular symbol / structure viewing modes to avoid context bloat
                        if (Array.isArray(libRes.fileModes) && libRes.fileModes.length > 0) {
                            const provider = this._contextManager.getContextStateProvider();
                            const defOnlyUris: vscode.Uri[] = [];
                            for (const fm of libRes.fileModes) {
                                const res = await this.resolveWorkspaceFile(fm.path);
                                const finalPath = res ? res.relativePath : fm.path;
                                if (fm.mode === 'symbols' && Array.isArray(fm.symbols) && fm.symbols.length > 0) {
                                    await this.applySymbolBatchUpdate(finalPath, fm.symbols, [], 'replace', { skipTokenUpdate: true });
                                } else if (fm.mode === 'structure') {
                                    await this.addFilesToDiscussionContext([finalPath], 'definitions-only');
                                    if (res) {
                                        defOnlyUris.push(res.uri);
                                        this._contextManager.refreshFileInCache(res.uri);
                                    }
                                }
                            }
                            if (provider && defOnlyUris.length > 0) {
                                await provider.setStateForUris(defOnlyUris, 'definitions-only');
                            }
                        }

                        // Ensure multiPartPlan part 0 targets reflect the resolved paths
                        if (this._activeMultiPartPlan?.parts?.[0]) {
                            this._activeMultiPartPlan.parts[0].editFiles = [...resolvedTargetFiles];
                        }
                    }

                    if (libRes.addedFiles?.length) {
                        await this._contextManager.getContextStateProvider()?.addFilesToContext(libRes.addedFiles);
                    }
                    await this.upgradeLibrarianFindings(libRes, rawUserPromptText, libRes.advice || libRes.rationale || '');

                    let findingsText = (libRes.advice || libRes.rationale || "").trim();
                    if (libRes.governorReport && !findingsText.includes(libRes.governorReport)) {
                        findingsText = findingsText ? `${findingsText}\n\n${libRes.governorReport}` : libRes.governorReport;
                    }
                    findingsText = findingsText.replace(/^(?:Librarian agent report:\s*)+/gi, '').trim();

                    // Generate complete plan XML tag (rendered in webview as collapsible plan with collapsible findings & phases)
                    const parts = this._activeMultiPartPlan?.parts || [{
                        partIndex: 0,
                        totalParts: 1,
                        editFiles: resolvedTargetFiles,
                        partInstruction: "Implement the required modifications."
                    }];

                    // ── 🛡️ LIBRARIAN FINAL CHECK OF LOADED FILES BEFORE CODER START ──
                    const finalCheckResult = typeof (ContextLibrarian as any).finalCheckLoadedFiles === 'function'
                        ? await ContextLibrarian.finalCheckLoadedFiles({
                            contextManager: this._contextManager,
                            discussionManager: this._discussionManager,
                            currentDiscussion: this._currentDiscussion!,
                            targetModel,
                            userPrompt: rawUserPromptText,
                            targetFiles: resolvedTargetFiles,
                            planFindings: findingsText,
                            planPhases: parts,
                            signal: controller.signal,
                            onStatusUpdate: (st) => {
                                this.processManager.updateDescription(processId, st);
                                this.updateGeneratingState();
                            }
                        })
                        : {
                            verifiedTargetFiles: resolvedTargetFiles,
                            finalCheckNotice: `> 🛡️ **LIBRARIAN FINAL CHECK**: ${resolvedTargetFiles.length} file(s) verified and locked into active context [C].`,
                            isSufficient: resolvedTargetFiles.length > 0
                        };

                    const verifiedFiles = finalCheckResult.verifiedTargetFiles.length > 0
                        ? finalCheckResult.verifiedTargetFiles
                        : resolvedTargetFiles;

                    this.recordCurrentPromptFiles(verifiedFiles);
                    await this.addFilesToDiscussionContext(verifiedFiles);

                    if (this._activeMultiPartPlan?.parts?.[0]) {
                        this._activeMultiPartPlan.parts[0].editFiles = [...verifiedFiles];
                    }

                    const phasesXml = parts.map((p, idx) => {
                        const targetList = idx === 0 && verifiedFiles.length > 0 ? verifiedFiles : (p.editFiles || []);
                        const filesListStr = targetList.map((f: string) => `            ${f}`).join('\n');
                        const instStr = (p.partInstruction || 'Implement the required modifications for this phase.').trim();
                        return `    <phase id="${idx + 1}">\n        <instruction>${instStr}</instruction>\n        <files_list>\n${filesListStr}\n        </files_list>\n    </phase>`;
                    }).join('\n');

                    const planXmlBlock = `<plan>\n    <findings>\n${findingsText || 'Codebase dependencies and architecture analyzed.'}\n    </findings>\n${phasesXml}\n</plan>\n\n`;

                    currentFullResponseBuffer = planXmlBlock;
                    fullResponse = currentFullResponseBuffer;
                    await this.updateMessageContent(assistantMessageId, currentFullResponseBuffer, false);
                    this._panel.webview.postMessage({
                        command: 'syncStreamBuffer',
                        id: assistantMessageId,
                        buffer: currentFullResponseBuffer
                    });

                    // Inject the plan directive AND Librarian Final Check Certificate into Coder's prompt history
                    history.push({
                        role: 'user',
                        content: `### 📋 ARCHITECTURAL PLAN (LEAD LIBRARIAN)\n${planXmlBlock}\n\n${finalCheckResult.finalCheckNotice}`
                    });

                    this.log(`Librarian master evaluation & final check complete (${parts.length} phase(s), ${verifiedFiles.length} file(s) verified & locked into [C]).`);
                } catch (libErr: any) {
                    this.log(`Librarian master evaluation warning: ${libErr.message}`, 'WARN');
                    // Guarantee: Restore original active files on warning
                    if (originalActiveFiles.length > 0) {
                        await this.unmuteFiles(originalActiveFiles);
                        await this._contextManager.getContextStateProvider()?.addFilesToContext(originalActiveFiles);
                    }
                    currentFullResponseBuffer = `⚠️ **Librarian Notice**: ${libErr.message}\n\n`;
                    await this.updateMessageContent(assistantMessageId, currentFullResponseBuffer, false);
                }
            }
        }

        // Phase 1: Context & File Ingestion for Worker
        this.processManager.updateDescription(processId, isFastMode ? "Coding..." : `Reading context files & workspace tree...`);
        this.updateGeneratingState();

        // Ensure personality matches user's chosen active personality on this discussion
        if (this._currentDiscussion && this._personalityManager) {
            const activePid = this._currentDiscussion.personalityId || 
                              this._discussionManager.context.workspaceState.get<string>('lollms_project_active_personality_id') ||
                              'default_coder';
            this._currentDiscussion.personalityId = activePid;
        }

        this._contextManager.clearRenderedTreeCache();

        const mutedFiles = this._currentDiscussion.mutedFiles || [];
        const mutedSkills = this._currentDiscussion.mutedSkills || [];
        const mutedDiagrams = this._currentDiscussion.mutedDiagrams || [];
        const providerForSend = this._contextManager.getContextStateProvider();
        const rawProviderFiles = providerForSend ? providerForSend.getIncludedFiles().filter(f => f && f.path) : [];
        const reconciledForSend = this.reconcileDiscussionFiles(rawProviderFiles, (this._currentDiscussion as any)?.includedFiles);
        (this._currentDiscussion as any).includedFiles = JSON.parse(JSON.stringify(reconciledForSend));
        this._discussionCapabilities.mutedFiles = [...mutedFiles];
        (this._discussionCapabilities as any).includedFiles = (this._currentDiscussion as any).includedFiles;

        let contextData = await this._contextManager.getContextContent({
            importedSkillIds: importedIds,
            includeTree: true,
            leanMode: false,
            discussionId: this.discussionId,
            mutedFiles: mutedFiles,
            includedFiles: reconciledForSend,
            mutedSkills: mutedSkills,
            mutedDiagrams: mutedDiagrams,
            modelName: targetModel,
            signal: controller.signal,
            capabilities: this._discussionCapabilities
        });

        // Pre-generation context reduction pipeline (runs whenever outbound context is bloated)
        const activePhaseTargetFiles = this._activeMultiPartPlan?.parts?.[this._activeMultiPartPlan.currentPartIndex]?.editFiles || [];
        const initialProtectedFiles = Array.from(new Set([...activePhaseTargetFiles, ...justAddedFromCaller]));
        const budgetOptimization = await this.enforceContextBudgetProtection(
            contextData,
            rawUserPromptText,
            targetModel,
            controller.signal,
            history,
            initialProtectedFiles,
            assistantMessageId,
            processId
        );
        contextData = budgetOptimization.contextData;
        history = budgetOptimization.history;

        const isAssistantMode = !this._discussionCapabilities.agentMode && !this._discussionCapabilities.dynamicMode;

        const thinkTimings: Array<{ start: number; end?: number }> = [];
        let firstTokenTimestamp: number | undefined;

        let currentTurnIndex = 0;
        const maxTurnsLimit = (this._discussionCapabilities as any).autoMaxRounds || 12;
        const completedDynamicActions: string[] = [];

        let consecutiveFailsCount = 0;
        const maxFailsAllowed = 3;
        let lastExecutedFingerprint = "";
        const executedFingerprintCounts = new Map<string, number>();
        const fileActivationCounts = new Map<string, number>();
        const cutByCompressionFiles = new Set<string>();
        let consecutiveCompressionLoopCount = 0;
        let forceFinalAnswerNoTools = false;
        let patchesAppliedInLoop = false;
        let formDetectedInTurn = false;
        let userInteractionDemandedInTurn = false;
        let endedByTagInTurn = false;
        let requestedMultiPhaseSplit = false;
        let multiPhaseStartedFromCoderPlan = false;

        interface TurnRoundSummary {
            round: number;
            messageId: string;
            patchesApplied: Array<{ filePath: string }>;
            patchesFailed: Array<{ filePath: string; error: string }>;
            appliedCount: number;
            blockedFiles: string[];
            scoutingActions: Array<{ tag: string; name: string; detail: string; success: boolean }>;
            notes: string[];
        }
        const roundSummaries: TurnRoundSummary[] = [];
        let multiTurnSummaryEmitted = false;

        const isAutoModeActive =
            this._discussionCapabilities.autoExecuteTools === true ||
            (this._discussionCapabilities as any).autoExecuteScouting === true ||
            (this._discussionCapabilities as any).autoExecuteCode === true ||
            this._currentDiscussion?.capabilities?.autoExecuteTools === true ||
            (this._currentDiscussion?.capabilities as any)?.autoExecuteScouting === true ||
            (this._currentDiscussion?.capabilities as any)?.autoExecuteCode === true ||
            (this._discussionCapabilities as any).autoMode === true ||
            this._discussionCapabilities.agentMode === true;

        const countCodeBlocksInBuffer = (bufferText: string): { xmlCount: number; fencedCount: number } => {
            if (!bufferText) return { xmlCount: 0, fencedCount: 0 };
            const scannable = stripThinkingTags(bufferText);
            let norm = normalizePseudoFileBlocks(scannable);
            norm = norm.replace(/^[ \t]*<delete_code\b([^>]*?)>([\s\S]*?)<\/delete_code>[ \t]*$/gim, (m: string, attrStr: string, body: string) => {
                const attrs = parseFileTagAttributes(attrStr);
                return attrs?.path ? `\n\n<file path="${attrs.path}" action="delete_code">\n${body.trim()}\n</file>

\n\n` : m;
            });
            const xmlBlocks = extractFileBlocks(norm).filter(b => {
                const attrs = parseFileTagAttributes(b.attrStr, b.rawContent);
                return !!(attrs && attrs.path);
            });
            const xmlRanges = xmlBlocks.map(b => ({ start: b.start, end: b.end }));

            let fencedCount = 0;
            const blockRe = /```[\t ]*(?:language:|lang:)?(\w+)[\t ]*:[\t ]*([^\n\r\s]+)[\t ]*[\r\n]+([\s\S]+?)[\r\n]+```/g;
            const fencedRanges: { start: number; end: number }[] = [];
            let fm: RegExpExecArray | null;
            while ((fm = blockRe.exec(norm)) !== null) {
                if (xmlRanges.some(r => fm!.index >= r.start && fm!.index < r.end)) continue;
                fencedRanges.push({ start: fm.index, end: fm.index + fm[0].length });
                if (isValidFilePath(fm[2])) fencedCount++;
            }

            const linesArr = norm.split('\n');
            let off = 0;
            for (let li = 0; li < linesArr.length; li++) {
                const curOff = off;
                off += linesArr[li].length + 1;
                if (xmlRanges.some(r => curOff >= r.start && curOff < r.end)) continue;
                if (fencedRanges.some(r => curOff >= r.start && curOff < r.end)) continue;
                if (linesArr[li].trim().startsWith('<<<<<<< SEARCH')) {
                    for (let lj = li + 1; lj < linesArr.length; lj++) {
                        if (linesArr[lj].trim().startsWith('>>>>>>> REPLACE')) {
                            fencedCount++;
                            for (let adv = li + 1; adv <= lj; adv++) off += linesArr[adv].length + 1;
                            li = lj;
                            break;
                        }
                    }
                }
            }

            return { xmlCount: xmlBlocks.length, fencedCount };
        };

        const parseCoderMultiPhasePlan = (text: string): {
            parts: Array<{ partIndex: number; totalParts: number; editFiles: string[]; partInstruction: string; fileModes?: Array<{ path: string; mode: 'full' | 'structure' | 'symbols'; symbols?: string[] }> }>;
        } | null => {
            if (!text) return null;
            const planMatch = text.match(/<plan\b[^>]*>([\s\S]*?)<\/plan>/i);
            if (!planMatch) return null;
            const planBody = planMatch[1];

            const phaseRegex = /<phase\b[^>]*(?:id|number)=["']?(\d+)["']?[^>]*>([\s\S]*?)<\/phase>/gi;
            let pm: RegExpExecArray | null;
            const parsedParts: Array<{ partIndex: number; totalParts: number; editFiles: string[]; partInstruction: string; fileModes?: Array<{ path: string; mode: 'full' | 'structure' | 'symbols'; symbols?: string[] }> }> = [];

            while ((pm = phaseRegex.exec(planBody)) !== null) {
                const phaseBody = pm[2] || '';
                const instMatch = phaseBody.match(/<(?:instruction|instructions)>([\s\S]*?)<\/(?:instruction|instructions)>/i);
                const partInstruction = (instMatch ? instMatch[1] : phaseBody.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '')).trim();

                const filesMatch = phaseBody.match(/<(?:files_list|target_files|edit_files|files|filesList)>([\s\S]*?)<\/(?:files_list|target_files|edit_files|files|filesList)>/i);
                const rawFilesText = filesMatch ? filesMatch[1] : '';
                const editFiles: string[] = [];
                const fileModes: Array<{ path: string; mode: 'full' | 'structure' | 'symbols'; symbols?: string[] }> = [];

                rawFilesText.split(/[\r\n,]+/).forEach(l => {
                    const clean = l.replace(/^[\s*#\-`'"]+|[\s*#\-`'"]+$/g, '').trim();
                    if (!clean || clean.startsWith('<')) return;

                    const structureMatch = clean.match(/^([^\s()]+)\s*\((?:structure|definitions)\)/i);
                    const symbolsMatch = clean.match(/^([^\s()]+)\s*\((?:symbols?|code):\s*([^)]+)\)/i);
                    const fullMatch = clean.match(/^([^\s()]+)\s*\((?:full|complete)\)/i);

                    if (symbolsMatch) {
                        const p = symbolsMatch[1].trim();
                        const syms = symbolsMatch[2].split(/[,;]+/).map(s => s.trim()).filter(Boolean);
                        if (isValidFilePath(p)) {
                            if (!editFiles.includes(p)) editFiles.push(p);
                            fileModes.push({ path: p, mode: 'symbols', symbols: syms });
                        }
                    } else if (structureMatch) {
                        const p = structureMatch[1].trim();
                        if (isValidFilePath(p)) {
                            if (!editFiles.includes(p)) editFiles.push(p);
                            fileModes.push({ path: p, mode: 'structure' });
                        }
                    } else if (fullMatch) {
                        const p = fullMatch[1].trim();
                        if (isValidFilePath(p)) {
                            if (!editFiles.includes(p)) editFiles.push(p);
                            fileModes.push({ path: p, mode: 'full' });
                        }
                    } else {
                        const p = clean.split(/\s+/)[0].replace(/^['"`]|['"`]$/g, '');
                        if (p && isValidFilePath(p) && !editFiles.includes(p)) {
                            editFiles.push(p);
                            fileModes.push({ path: p, mode: 'full' });
                        }
                    }
                });

                if (editFiles.length > 0 || partInstruction) {
                    parsedParts.push({
                        partIndex: parsedParts.length,
                        totalParts: 0,
                        editFiles,
                        partInstruction: partInstruction || `Implement Phase ${parsedParts.length + 1}`,
                        fileModes
                    });
                }
            }

            if (parsedParts.length === 0) return null;
            parsedParts.forEach((p, idx) => {
                p.partIndex = idx;
                p.totalParts = parsedParts.length;
            });
            return { parts: parsedParts };
        };

        if (budgetOptimization.cutFiles && budgetOptimization.cutFiles.length > 0) {
            budgetOptimization.cutFiles.forEach(cf => cutByCompressionFiles.add(cf));
        }

        const isLibrarianInactive = isFastMode || this._discussionCapabilities.contextGovernorEnabled === false;
        const buildLoopMessages = (activeContextData: ContextResult, isLeanStage1: boolean = false): ChatMessage[] => {
            const knowledgeText = isLibrarianInactive ? "" : (activeContextData.governorReport || "");
            const missionBriefingText = this._contextManager.renderBriefing(this._currentDiscussion);
            const leanNotice = isLeanStage1 ? `
> ⚡ **STAGE 1 STRIPPED SIGNATURES NOTICE**:
> Files tagged \`[C]\` below are currently presented with **stripped signatures, interfaces, and contracts** for your Stage 1 assessment.
> In Stage 3, the **100% complete, full raw source code** of all declared target edit files will be automatically loaded into your prompt.
> Do NOT hallucinate that you need to reopen, reload, or ask to unmute files tagged \`[C]\`!
` : "";
            const memoryBlockInState = projectMemory ? `\n${projectMemory}\n` : "";
            const compressionNotice = activeContextData.compressionReport
                ? `\n### 🗜️ CONTEXT COMPRESSION NOTICE\n${activeContextData.compressionReport}\n`
                : "";

            const stateText = `
### 📂 ATTACHED PROJECT CONTEXT (CURRENT GROUND TRUTH)
${compressionNotice}
I am providing you with the real-time, ground-truth state of my project files on disk and in my editor.
NOTE: This loaded content is your SOLE source of truth. Do NOT assume that patches or changes you suggested in previous turns are applied unless they appear in the file content below.

#### 📜 FILE MODIFICATION & STRUCTURE RULES:
1. **FULL CONTENT OR LOADED SYMBOLS ALLOWED FOR EDITS**: You can modify any file loaded in full under 'LOADED FILE CONTENTS' [C], **OR** directly update any symbol whose implementation is already loaded in \`mode="symbols"\` using \`<file path="..." action="update_symbol" symbol="SymbolName">\` or \`<file path="..." action="patch">\` (you do NOT need the full file to update already-loaded symbols).
2. **PRIVILEGE UNMUTE (FULL CODE) OVER STRUCTURE WHEN BUDGET ALLOWS**: Generating structure from code takes extra time. When you are not constrained by token budget, **privilege using \`<unmute_files>\\npath/to/file.ext\\n</unmute_files>\` to get full code directly**.
3. **UPGRADE STRUCTURE TO FULL CODE VIA UNMUTE**: Calling \`<unmute_files>\\npath/to/file.ext\\n</unmute_files>\` automatically transitions files from **structure-only [D]** directly to **full code [C]**, as well as unmuting [M] files to full code [C].
4. **USE STRUCTURE / SYMBOLS WHEN RESOURCE-CONSTRAINED**: When context budget is tight, use \`<manage_symbols path="..." activate="Sym1, Sym2" />\` or \`<load_structure path="..." />\` to keep only the few needed symbols in full while compacting the rest. Never attempt to patch a file in bare structure-only mode without its target symbol loaded.
${leanNotice}
${missionBriefingText ? `#### 🎯 MISSION BRIEFING & PROJECT-WIDE MEMORY\n${missionBriefingText}\n` : ""}
${memoryBlockInState}
${knowledgeText ? `#### 🏛️ CODE KNOWLEDGE (KNOWLEDGE.md)\n${knowledgeText}\n` : ""}
#### 🌳 PROJECT STRUCTURE
${activeContextData.projectTree || "```text\n./: [Workspace root]\n```"}

${activeContextData.selectedFilesContent ? `#### 📄 LOADED FILE CONTENTS\n${activeContextData.selectedFilesContent}` : "*(No files currently selected)*"}
--------------------------------------------------`.trim();

            let userContentPayload: any = stateText;
            if (currentPromptMessage?.content) {
                const promptStr = typeof currentPromptMessage.content === 'string' 
                    ? currentPromptMessage.content 
                    : (Array.isArray(currentPromptMessage.content) ? currentPromptMessage.content.map((p: any) => p.text || '').join('\n') : '');

                let effectivePromptStr = promptStr;
                if (promptStr.startsWith('FORM_SUBMISSION:')) {
                    try {
                        const parsedForm = JSON.parse(promptStr.substring(16).trim());
                        const entries = Object.entries(parsedForm).map(([k, v]) => `- **${k}**: ${v}`).join('\n');
                        effectivePromptStr = `### ✅ USER FORM SUBMISSION\nThe user submitted the requested form with these answers:\n${entries}\n\nProceed immediately using these answers.`;
                    } catch {}
                }
                
                const confirmationNudge = isPlanConfirmation ? `
\n\n### 🚀 PLAN CONFIRMED: MANDATORY STAGE 3 CODE IMPLEMENTATION
The user has CONFIRMED and VALIDATED your plan.
- **STAGE 3 IS ACTIVE NOW**: You MUST immediately implement the verified code.
- **DO NOT REPEAT STAGE 2**: Do NOT restate the plan, do NOT ask for confirmation again.
- **MANDATORY <file> MUTATION TAGS**: You MUST output the actual code updates using \`<file path="..." action="write|patch|update_symbol">\` tags for every file you planned to change.
- **NEVER CLAIM TO FINISH WITHOUT CODE**: Saying "Stage 3 is complete" or describing changes without outputting <file> tags is strictly forbidden. All updates must be delivered in real <file> code blocks.` : '';

                userContentPayload = `${stateText}\n\n${effectivePromptStr}${confirmationNudge}`.trim();
            }

            if (this._discussionCapabilities.enableImages !== false && activeContextData.images && activeContextData.images.length > 0) {
                userContentPayload = [
                    { type: 'text', text: userContentPayload },
                    ...activeContextData.images.map(img => ({ type: 'image_url', image_url: { url: img.data } }))
                ];
            }

            const updatedUserMessage: ChatMessage = {
                role: 'user',
                content: userContentPayload
            };

            const cleanHistory = isLibrarianInactive
                ? history.filter(m => {
                    if (m.skipInPrompt) return false;
                    const pName = (m.personalityName || '').toLowerCase();
                    const id = m.id || '';
                    if (pName.includes('librarian') || pName.includes('governor')) return false;
                    if (id.startsWith('librarian_') || id.startsWith('lib_') || id.startsWith('governor_')) return false;
                    return true;
                }).map(m => {
                    if (m.id?.startsWith('compressed_history_')) return m;
                    let content = m.content;
                    if (typeof content === 'string') {
                        content = stripLibrarianReferences(content);
                    } else if (Array.isArray(content)) {
                        content = content.map((p: any) => p && p.type === 'text' && typeof p.text === 'string' ? { ...p, text: stripLibrarianReferences(p.text) } : p);
                    }
                    return { ...m, content };
                }).filter(m => {
                    if (typeof m.content === 'string') return m.content.trim().length > 0;
                    if (Array.isArray(m.content)) return m.content.some((p: any) => p && (p.type !== 'text' || (p.text && p.text.trim().length > 0)));
                    return true;
                })
                : history.filter(m => !m.skipInPrompt);

            const rawMsgs: ChatMessage[] = [
                { role: 'system', content: '' },
                ...cleanHistory,
                updatedUserMessage
            ];
            return ensureStrictAlternatingRoles(rawMsgs);
        };

        let currentContextPayload = contextData;
        let loopTransientTurns: ChatMessage[] = [];
        let loopMessages: ChatMessage[] = buildLoopMessages(currentContextPayload, false);
        let librarianTurnsCount = 0;
        const maxLibrarianTurns = this._discussionCapabilities.librarianDebateTurns ?? 2;

        const runTurn = async (isInsideMultiPhaseExecution: boolean = false) => {
            if (controller?.signal.aborted || currentTurnIndex >= maxTurnsLimit) {
                if (currentTurnIndex >= maxTurnsLimit && !controller?.signal.aborted) {
                    const limitNotice = `🛑 **AUTO-MODE ROUND LIMIT REACHED** (${maxTurnsLimit} rounds). Automation halted. Review the results above and continue manually if needed.`;
                    const limitMsgId = 'assistant_limit_' + Date.now().toString();
                    await this.addMessageToDiscussion({
                        id: limitMsgId,
                        role: 'assistant',
                        content: limitNotice,
                        model: targetModel,
                        personalityName: personaName,
                        timestamp: Date.now()
                    }, true);
                    if (!this._isDisposed && !this._activeMultiPartPlan) {
                        this._panel.webview.postMessage({ command: 'finalizeMessage', id: limitMsgId, fullContent: limitNotice });
                    }
                }
                return;
            }
            currentTurnIndex++;

            if (currentTurnIndex > 1) {
                assistantMessageId = 'assistant_' + Date.now().toString() + Math.random().toString(36).substring(2);
                currentFullResponseBuffer = "";
                fullResponse = "";
                thinkTimings.length = 0;
                firstTokenTimestamp = undefined;
                await this.addMessageToDiscussion({
                    id: assistantMessageId,
                    role: 'assistant',
                    content: '',
                    startTime: Date.now(),
                    model: targetModel,
                    personalityName: personaName,
                    timestamp: Date.now()
                }, true);
            }

            const roundEntry: TurnRoundSummary = {
                round: currentTurnIndex,
                messageId: assistantMessageId,
                patchesApplied: [],
                patchesFailed: [],
                appliedCount: 0,
                blockedFiles: [],
                scoutingActions: [],
                notes: []
            };
            roundSummaries.push(roundEntry);

            if (consecutiveFailsCount >= maxFailsAllowed) {
                const finalErrorMsg = `\n\n🛑 **ASSISTANT TERMINATED**: Exceeded maximum self-correction retries (${maxFailsAllowed}). Please adjust your prompt.`;
                currentFullResponseBuffer += finalErrorMsg;
                fullResponse = currentFullResponseBuffer;
                await this.updateMessageContent(assistantMessageId, currentFullResponseBuffer);
                return;
            }

            this.processManager.updateDescription(processId, isFastMode ? "Coding..." : `Connecting to ${targetModel} (waiting for response)...`);
            this.updateGeneratingState();

            const scratchpadBlock = completedDynamicActions.length > 0 
                ? `\n### 🧠 MEMORY SCRATCHPAD (YOUR COMPLETED RESEARCH STEPS)\n` + 
                  completedDynamicActions.map((a, i) => `${i+1}. ${a}`).join('\n')
                : "";

            const finalBaseInstructions = await getProcessedSystemPrompt(
                'chat', 
                this._discussionCapabilities, 
                personaContent + (scratchpadBlock ? `\n\n${scratchpadBlock}` : ''), 
                undefined, 
                forceFullCode, 
                { 
                    tree: !isContextMuted ? currentContextPayload.projectTree : '', 
                    files: currentContextPayload.selectedFilesContent, 
                    skills: currentContextPayload.skillsContent,
                    memory: projectMemory,
                    projectName: currentContextPayload.projectName || folders?.[0]?.name || "Workspace",
                    toolManager: isAssistantMode ? undefined : this.agentManager?.['toolManager'],
                    suppressLibrarianReport: true // Prevent sending duplicate findings in both system prompt and user state
                } as any
            );

            loopMessages[0] = { role: 'system', content: finalBaseInstructions };

            if (currentFullResponseBuffer.length > 0 && !currentFullResponseBuffer.endsWith('\n\n')) {
                const pad = currentFullResponseBuffer.endsWith('\n') ? '\n' : '\n\n';
                currentFullResponseBuffer += pad;
                fullResponse = currentFullResponseBuffer;
                this._panel.webview.postMessage({
                    command: 'appendMessageChunk',
                    id: assistantMessageId,
                    chunk: pad
                });
            }
            const bufferBeforeTurn = currentFullResponseBuffer;

            let turnResponse = "";
            let turnEndedByTag = false;
            let detectedEndTagStr = "";
            const turnStreamController = new AbortController();
            const onParentAbort = () => turnStreamController.abort();
            if (controller.signal.aborted) {
                turnStreamController.abort();
            } else {
                controller.signal.addEventListener('abort', onParentAbort, { once: true });
            }

            this.processManager.updateDescription(processId, isFastMode ? "Coding..." : `Assistant Turn ${currentTurnIndex}: Reasoning & Evaluating...`);
            this.updateGeneratingState();

            try {
                await this._lollmsAPI.sendChat(loopMessages, (chunk) => {
                    if (controller?.signal.aborted || turnStreamController.signal.aborted) return;
                    if (firstTokenTimestamp === undefined) {
                        firstTokenTimestamp = Date.now();
                    }
                    const prevLen = turnResponse.length;
                    turnResponse += chunk;

                    if (chunk.includes('>')) {
                        const endMatch = findExplicitEndTag(turnResponse);
                        if (endMatch) {
                            turnEndedByTag = true;
                            detectedEndTagStr = endMatch.tag;
                            const acceptedChunk = turnResponse.slice(prevLen, endMatch.endIndex);
                            turnResponse = turnResponse.slice(0, endMatch.endIndex);
                            currentFullResponseBuffer = bufferBeforeTurn + turnResponse;
                            fullResponse = currentFullResponseBuffer;
                            this.updateThinkTimingsFromBuffer(currentFullResponseBuffer, thinkTimings, firstTokenTimestamp);
                            if (acceptedChunk) {
                                this._panel.webview.postMessage({
                                    command: 'appendMessageChunk',
                                    id: assistantMessageId,
                                    chunk: acceptedChunk
                                });
                            }
                            turnStreamController.abort();
                            return;
                        }
                    }

                    currentFullResponseBuffer += chunk;
                    fullResponse = currentFullResponseBuffer;
                    this.updateThinkTimingsFromBuffer(currentFullResponseBuffer, thinkTimings, firstTokenTimestamp);

                    this._panel.webview.postMessage({ 
                        command: 'appendMessageChunk', 
                        id: assistantMessageId, 
                        chunk: chunk 
                    });
                }, turnStreamController.signal, this._currentDiscussion!.model, {
                    capabilities: this._discussionCapabilities,
                    temperature: this._discussionCapabilities.enableTemperature ? this._discussionCapabilities.temperature : undefined,
                    maxTokens: this._discussionCapabilities.enableMaxTokens ? this._discussionCapabilities.maxTokens : undefined
                });
            } catch (err: any) {
                if (turnEndedByTag && !controller?.signal.aborted) {
                    this.log(`[Turn ${currentTurnIndex}] Stream stopped immediately upon explicit end tag.`, 'INFO');
                } else {
                    throw err;
                }
            } finally {
                controller.signal.removeEventListener('abort', onParentAbort);
            }

            if (controller?.signal.aborted) {
                const abortErr = new Error('AbortError');
                abortErr.name = 'AbortError';
                throw abortErr;
            }

            // Close any unclosed/malformed tags from this round and normalize mid-line tags onto clean lines
            // so a mistake in Round N cannot poison or corrupt subsequent rounds.
            const roundRepair = this.repairAndNormalizeRoundOutput(turnResponse);
            if (roundRepair.wasRepaired) {
                this.log(`[Round ${currentTurnIndex} Tag Guard] Repaired round output: ${roundRepair.repairs.join('; ')}`, 'WARN');
                turnResponse = roundRepair.repaired;
                currentFullResponseBuffer = bufferBeforeTurn + turnResponse;
                fullResponse = currentFullResponseBuffer;
                this.updateThinkTimingsFromBuffer(currentFullResponseBuffer, thinkTimings, firstTokenTimestamp);
                this._panel.webview.postMessage({
                    command: 'syncStreamBuffer',
                    id: assistantMessageId,
                    buffer: currentFullResponseBuffer
                });
            }

            const finalizeAndSaveTurn = async (textToPersist?: string) => {
                const finalThinkDurations = this.finalizeThinkTimings(thinkTimings);
                const cleanFinalText = (textToPersist !== undefined ? textToPersist : stripThinkingTags(currentFullResponseBuffer)).trim();
                const finalAssistantMessage: ChatMessage = {
                    id: assistantMessageId,
                    role: 'assistant',
                    content: cleanFinalText,
                    model: targetModel,
                    personalityName: personaName,
                    timestamp: Date.now(),
                    ...(finalThinkDurations.length > 0 ? { thinkDurations: finalThinkDurations } : {})
                };

                const msgIdx = this._currentDiscussion!.messages.findIndex(m => m.id === assistantMessageId);
                if (msgIdx !== -1) {
                    this._currentDiscussion!.messages[msgIdx] = finalAssistantMessage;
                }
                if (this._currentDiscussion!.llmHistory) {
                    const llmIdx = this._currentDiscussion!.llmHistory.findIndex(m => m.id === assistantMessageId);
                    if (llmIdx !== -1) {
                        this._currentDiscussion!.llmHistory[llmIdx] = finalAssistantMessage;
                    }
                }
                if (!this._currentDiscussion!.id.startsWith('temp-')) {
                    await this._discussionManager.saveDiscussion(this._currentDiscussion!);
                }

                if (!this._isDisposed) {
                    if (!this._activeMultiPartPlan) {
                        this._panel.webview.postMessage({ 
                            command: 'finalizeMessage', 
                            id: assistantMessageId, 
                            fullContent: currentFullResponseBuffer,
                            appliedState: this._currentDiscussion?.appliedState?.[assistantMessageId],
                            ...(finalThinkDurations.length > 0 ? { thinkDurations: finalThinkDurations } : {})
                        });
                    }
                    this._panel.webview.postMessage({ command: 'collapseLibrarianMessages' });
                }
            };

            const requiresEndTagCap = (this._discussionCapabilities as any).requireExplicitEndTag === true ||
                (this._currentDiscussion?.capabilities as any)?.requireExplicitEndTag === true;
            const endTagMatchAfterRepair = findExplicitEndTag(turnResponse);
            const turnEndTagged = turnEndedByTag || endTagMatchAfterRepair !== null;
            if (turnEndTagged) {
                endedByTagInTurn = true;
            }

            // Rule 2: If Auto Mode is OFF (and explicit end tag is not required), do a single round and let the user decide what to do and manually press buttons.
            if ((!isAutoModeActive && !requiresEndTagCap && !this._discussionCapabilities.autoApply) || forceFinalAnswerNoTools) {
                await finalizeAndSaveTurn();
                return;
            }

            let strippedTurn = stripThinkingTags(turnResponse);
            // Guard against dangling </think> when the model omitted the opening <think> tag
            const danglingThinkClose = strippedTurn.match(/^[ \t]*<\/(?:think|thinking|thought|analysis|reasoning)>[ \t]*$/im);
            if (danglingThinkClose && danglingThinkClose.index !== undefined) {
                strippedTurn = strippedTurn.substring(danglingThinkClose.index + danglingThinkClose[0].length).trimStart();
            }
            const scannableTurn = normalizePseudoFileBlocks(strippedTurn);
            const protectedRanges = this.getProtectedContentRanges(scannableTurn, { keepToolWrapperFences: true });

            const isIndexInsideFence = (index: number) => {
                return protectedRanges.some(r => index >= r.start && index < r.end);
            };

            const patterns = [
                { tag: 'add_files_to_context', pattern: /<add_files_to_context\b([^>]*?)(?:\/>|>([\s\S]*?)<\/add_files_to_context>)/gim },
                { tag: 'remove_files_from_context', pattern: /<remove_files_from_context\b([^>]*?)(?:\/>|>([\s\S]*?)<\/remove_files_from_context>)/gim },
                { tag: 'mute_files', pattern: /<mute_files\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mute_files>)/gim },
                { tag: 'unmute_files', pattern: /<unmute_files\b([^>]*?)(?:\/>|>([\s\S]*?)<\/unmute_files>)/gim },
                { tag: 'load_knowledge', pattern: /<load_knowledge\b([^>]*?)>([\s\S]*?)<\/load_knowledge>/gim },
                { tag: 'update_knowledge', pattern: /<update_knowledge\b([^>]*?)>([\s\S]*?)<\/update_knowledge>/gim },
                { tag: 'unpack_directory', pattern: /<unpack_directory\b([^>]*?)(?:\/>|>([\s\S]*?)<\/unpack_directory>)/gim },
                { tag: 'load_structure', pattern: /<(?:load_structure|read_definitions)\b([^>]*?)(?:\/>|>(?:([\s\S]*?)<\/(?:load_structure|read_definitions)>)?)/gim },
                { tag: 'show_symbol', pattern: /<(?:show_symbol|get_symbol_code|read_symbol)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:show_symbol|get_symbol_code|read_symbol)>)/gim },
                { tag: 'peek_files', pattern: /<peek_files\b([^>]*?)(?:\/>|>(?:([\s\S]*?)<\/peek_files>)?)/gim },
                { tag: 'read_full_file', pattern: /<(?:read_full_file|read_file)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:read_full_file|read_file)>)/gim },
                { tag: 'read_external_file', pattern: /<read_external_file\b([^>]*?)(?:\/>|>(?:([\s\S]*?)<\/read_external_file>)?)/gim },
                { tag: 'grep', pattern: /<(?:grep|grep_search|search_files)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:grep|grep_search|search_files)>)/gim },
                { tag: 'manage_symbols', pattern: /<manage_symbols\b([^>]*?)(?:\/>|>([\s\S]*?)<\/manage_symbols>)/gim },
                { tag: 'query_architecture', pattern: /<query_architecture\b([^>]*?)>([\s\S]*?)<\/query_architecture>/gim },
                { tag: 'sparql', pattern: /<sparql\b([^>]*?)(?:\/>|>([\s\S]*?)<\/sparql>)/gim },
                { tag: 'run_tests', pattern: /<run_tests\b([^>]*?)(?:\/>|>(?:([\s\S]*?)<\/run_tests>)?)/gim },
                { tag: 'lollms_tool', pattern: /<lollms_tool\b([^>]*?)(?:\/>|>([\s\S]*?)<\/lollms_tool>)/gim },
                { tag: 'execute_code', pattern: /<execute_code\b([^>]*?)(?:\/>|>([\s\S]*?)<\/execute_code>)/gim }
            ].filter(p => {
                if (p.tag !== 'execute_code') return true;
                const allowCodeExec = this._discussionCapabilities.allowCodeExecution === true || (this._currentDiscussion?.capabilities as any)?.allowCodeExecution === true;
                const autoExecCode = this._discussionCapabilities.autoExecuteCode === true || (this._currentDiscussion?.capabilities as any)?.autoExecuteCode === true;
                return allowCodeExec && autoExecCode;
            });

            interface DiscoveredAction {
                index: number;
                tag: string;
                params: string;
                attrStr?: string;
            }

            const discoveredActions: DiscoveredAction[] = [];

            for (const item of patterns) {
                item.pattern.lastIndex = 0;
                let pMatch;
                while ((pMatch = item.pattern.exec(scannableTurn)) !== null) {
                    if (!isIndexInsideFence(pMatch.index)) {
                        const rawParams = ((pMatch[2] !== undefined && pMatch[2].trim()) ? pMatch[2] : (pMatch[1] || '')).trim();
                        discoveredActions.push({
                            index: pMatch.index,
                            tag: item.tag,
                            params: rawParams,
                            attrStr: pMatch[1] || ""
                        });
                    }
                }
            }

            discoveredActions.sort((a, b) => a.index - b.index);

            const prefixBufferBeforeTurn = currentFullResponseBuffer.slice(0, Math.max(0, currentFullResponseBuffer.length - turnResponse.length));
            const priorBlockOffsets = countCodeBlocksInBuffer(prefixBufferBeforeTurn);
            const turnBlockCounts = countCodeBlocksInBuffer(scannableTurn);
            const deleteFileCheckRe = /<(?:delete_files|delete_file)\b/gim;
            let hasDeleteFilesInTurn = false;
            if (this._discussionCapabilities.fileDelete !== false) {
                let dfMatch: RegExpExecArray | null;
                while ((dfMatch = deleteFileCheckRe.exec(scannableTurn)) !== null) {
                    if (!isIndexInsideFence(dfMatch.index)) {
                        hasDeleteFilesInTurn = true;
                        break;
                    }
                }
            }
            const turnHasFileUpdates = turnBlockCounts.xmlCount > 0 || turnBlockCounts.fencedCount > 0 || hasDeleteFilesInTurn;

            const turnHasForm = detectInteractiveForm(scannableTurn, isIndexInsideFence);

            // Stop Cause 1: If the LLM issues a form, stop running immediately and wait for the user to answer
            if (turnHasForm) {
                formDetectedInTurn = true;
                roundEntry.notes.push('Interactive form presented — waiting for user answer');
                this.log(`[Auto Mode] Interactive form detected: stopping rounds and waiting for user answer.`, 'INFO');
                forceFinalAnswerNoTools = true;
                await finalizeAndSaveTurn(currentFullResponseBuffer);
                return;
            }

            // If <delete_files> was demanded, halt auto execution to prompt the user and stop there
            if (hasDeleteFilesInTurn) {
                userInteractionDemandedInTurn = true;
                roundEntry.notes.push('File deletion proposed — waiting for user confirmation');
                this.log(`[Auto Mode] <delete_files> detected: halting auto execution to prompt user.`, 'INFO');
                forceFinalAnswerNoTools = true;
                await finalizeAndSaveTurn();
                return;
            }

            const userInteractionCheck = detectUserInteractionDemand(scannableTurn, {
                isProtected: isIndexInsideFence,
                hasPendingTools: discoveredActions.length > 0 && isAutoModeActive,
                allowDeleteFiles: this._discussionCapabilities.fileDelete !== false,
                discoveredActions
            });

            // Rule 1.5 continuation: If the coder responded with a multi-phase <plan> (and no patches/tools/stop signals), spin off multi-phase execution
            if (!isInsideMultiPhaseExecution && !turnHasFileUpdates && discoveredActions.length === 0 && !turnEndTagged && !userInteractionCheck.demanded) {
                const coderPlan = parseCoderMultiPhasePlan(scannableTurn);
                if (coderPlan && coderPlan.parts.length > 0) {
                    this.log(`[Auto Mode - Rule 1.5] Coder generated a ${coderPlan.parts.length}-phase execution plan. Starting sequential phases...`, 'INFO');
                    this._activeMultiPartPlan = {
                        totalParts: coderPlan.parts.length,
                        currentPartIndex: 0,
                        parts: coderPlan.parts
                    };
                    multiPhaseStartedFromCoderPlan = true;
                    roundEntry.notes.push(`Split into ${coderPlan.parts.length}-phase execution plan`);
                    await this.updateMessage(assistantMessageId, currentFullResponseBuffer);
                    return;
                }
            }

            // Rule 1.4 & 1.2: Whenever there are file updates and Auto-Apply (or Agent Mode) is ON, apply & auto-fix them FIRST
            let turnPatchReport = "";
            const shouldAutoApplyTurn = this._discussionCapabilities.autoApply === true || this._discussionCapabilities.agentMode === true;
            if (turnHasFileUpdates && shouldAutoApplyTurn) {
                const verification = await this.verifyGeneratedPatchContext(turnResponse);
                if (!verification.valid) {
                    roundEntry.blockedFiles.push(...verification.unpossessedFiles);
                    if (discoveredActions.length === 0 && !turnEndTagged && !userInteractionCheck.demanded) {
                        this.log(`[Auto Mode - Rule 1.2] Blind patch blocked on unseen files: [${verification.unpossessedFiles.join(', ')}]`, 'WARN');
                        await this.handleContextVerifierFailure(verification.unpossessedFiles, isFastMode, controller.signal, processId);
                        patchesAppliedInLoop = true;
                        return;
                    } else {
                        turnPatchReport = `⚠️ **Patch Notice**: Skipped file updates for unseen file(s) [${verification.unpossessedFiles.join(', ')}] until they are loaded into active context [C].\n`;
                    }
                } else {
                    this.processManager.updateDescription(processId, `Auto Mode: Applying & verifying file updates...`);
                    this.updateGeneratingState();
                    const pipeRes = await this.executeAutomationPipeline(turnResponse, assistantMessageId, controller.signal, processId, {
                        xmlBlockIndexOffset: priorBlockOffsets.xmlCount,
                        fencedBlockIndexOffset: priorBlockOffsets.fencedCount,
                        skipContextTools: discoveredActions.length > 0,
                        autoFix: this._discussionCapabilities.autoFix !== false,
                        skipGuardianRepairLoop: isInsideMultiPhaseExecution || discoveredActions.length > 0 || turnEndTagged || userInteractionCheck.demanded
                    });
                    patchesAppliedInLoop = true;
                    roundEntry.appliedCount += pipeRes.appliedCount;
                    pipeRes.modifiedFiles.forEach(fp => roundEntry.patchesApplied.push({ filePath: fp }));
                    pipeRes.failedPatches.forEach(fp => roundEntry.patchesFailed.push(fp));
                    if (pipeRes.modifiedFiles.length > 0) {
                        const failedDesc = pipeRes.failedPatches.length > 0
                            ? ` Failed patches: ${pipeRes.failedPatches.map(fp => `${fp.filePath} (${fp.error})`).join('; ')}.`
                            : '';
                        turnPatchReport = `✅ **Patches Applied (${pipeRes.appliedCount})**: [${pipeRes.modifiedFiles.join(', ')}] saved on disk and refreshed in your \`LOADED FILE CONTENTS\` context (including symbol updates). You do not need to run a script to verify the patch text.${failedDesc}\n`;
                    }
                }
            } else if (turnHasFileUpdates && !shouldAutoApplyTurn) {
                roundEntry.notes.push('Code patches proposed (manual apply mode)');
            }

            // Stop Cause 4: Explicit end tag emitted -> stop immediately without continuing tool/re-prompt loops
            if (turnEndTagged) {
                endedByTagInTurn = true;
                const finalEndTagStr = detectedEndTagStr || endTagMatchAfterRepair?.tag || '</end>';
                roundEntry.notes.push(`Completed with explicit end tag (${finalEndTagStr})`);
                this.log(`[Auto Mode] Explicit end tag (${finalEndTagStr}) detected: stopping immediately.`, 'INFO');
                forceFinalAnswerNoTools = true;
                const safeTag = finalEndTagStr.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const endBadgeHtml = `\n\n<div class="end-tag-indicator" style="display:inline-flex; align-items:center; gap:6px; margin-top:8px; padding:3px 10px; border-radius:12px; font-size:10.5px; font-weight:600; background:rgba(46, 204, 113, 0.12); border:1px solid rgba(46, 204, 113, 0.35); color:var(--vscode-charts-green);"><i class="codicon codicon-pass-filled"></i> <span>Explicit end tag received (<code>${safeTag}</code>)</span></div>\n`;
                currentFullResponseBuffer += endBadgeHtml;
                fullResponse = currentFullResponseBuffer;
                await finalizeAndSaveTurn(currentFullResponseBuffer);
                return;
            }

            // Stop Cause 2: LLM demands user interaction -> stop running and wait for user
            if (userInteractionCheck.demanded) {
                userInteractionDemandedInTurn = true;
                roundEntry.notes.push('Waiting for user input / response');
                this.log(`[Auto Mode] User interaction demanded (${userInteractionCheck.reason}): stopping loop.`, 'INFO');
                forceFinalAnswerNoTools = true;
                await finalizeAndSaveTurn(currentFullResponseBuffer);
                return;
            }

            if (discoveredActions.length > 0 && isAutoModeActive) {
                const batchFingerprint = discoveredActions.map(a => `${a.tag}:${a.params}`).join('|');
                const priorFingerprintCount = executedFingerprintCounts.get(batchFingerprint) || 0;
                const isDuplicateRepetition = (batchFingerprint === lastExecutedFingerprint) || priorFingerprintCount >= 1;
                lastExecutedFingerprint = batchFingerprint;
                executedFingerprintCounts.set(batchFingerprint, priorFingerprintCount + 1);

                await this.updateMessage(assistantMessageId, currentFullResponseBuffer);

                interface ExecutedResult {
                    tag: string;
                    name: string;
                    output: string;
                    success: boolean;
                }

                const executedResults: ExecutedResult[] = [];
                const turnJustAddedFiles: string[] = [];
                let toolModifiedContext = false;
                let anySuccess = false;

                for (let aIdx = 0; aIdx < discoveredActions.length; aIdx++) {
                    if (controller?.signal.aborted) break;
                    const action = discoveredActions[aIdx];

                    this.processManager.updateDescription(processId, `Executing action ${aIdx + 1}/${discoveredActions.length}: ${action.tag}...`);
                    this.updateGeneratingState();

                    let toolResult = "";
                    let isSuccess = true;
                    let toolDisplayName = action.tag;

                    try {
                        if (isDuplicateRepetition) {
                            isSuccess = false;
                            toolResult = `Error: REPETITIVE CALL DETECTED. You already executed this exact set of actions with identical parameters. Change your approach.`;
                            completedDynamicActions.push(`Attempted duplicate action ${action.tag} (BLOCKED).`);
                        } else if (action.tag === 'add_files_to_context' || action.tag === 'unmute_files') {
                            const attrFiles: string[] = [];
                            const attrRegex = /(?:path|paths|files|target)=["']([^"']+)["']/gi;
                            let afm: RegExpExecArray | null;
                            while ((afm = attrRegex.exec(action.attrStr || "")) !== null) {
                                afm[1].split(/[\s\r\n,;]+/).map(f => f.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).forEach(f => attrFiles.push(f));
                            }
                            const bodyFiles = action.attrStr && action.params === action.attrStr.trim()
                                ? []
                                : action.params.split(/[\s\r\n,]+/).map(f => f.trim().replace(/^['"]|['"]$/g, '')).filter(f => f && !f.startsWith('<') && !/^(?:path|paths|files|target)=/i.test(f));
                            const filesToAdd = Array.from(new Set([...attrFiles, ...bodyFiles]));
                            if (filesToAdd.length > 0) {
                                const provider = this._contextManager.getContextStateProvider();
                                const rawInc = provider ? provider.getIncludedFiles() : [];
                                const reconciledInc = this.reconcileDiscussionFiles(rawInc, (this._currentDiscussion as any)?.includedFiles);
                                const currentInc = reconciledInc
                                    .filter(fi => fi && fi.path && fi.state !== 'definitions-only' && (fi.state as string) !== 'structure')
                                    .map(fi => fi.path.replace(/\\/g, '/').toLowerCase());
                                const currentMuted = (this._currentDiscussion?.mutedFiles || []).map(m => m.replace(/\\/g, '/').toLowerCase());

                                const { arePathsEqual: arePathsEqualTurn } = require('../../utils');
                                const alreadyActive = filesToAdd.filter(f => {
                                    return currentInc.some(inc => arePathsEqualTurn(inc, f)) && !currentMuted.some(m => arePathsEqualTurn(m, f));
                                });

                                const hasFreedSpaceThisTurn = discoveredActions.some(a => a.tag === 'mute_files' || a.tag === 'remove_files_from_context');
                                const thrashingFiles = filesToAdd.filter(f => {
                                    if (alreadyActive.some(af => arePathsEqualTurn(af, f))) return false;
                                    const normF = f.replace(/\\/g, '/').toLowerCase().trim();
                                    const wasCutByCompression = Array.from(cutByCompressionFiles).some(cf => arePathsEqualTurn(cf, f));
                                    const actCount = fileActivationCounts.get(normF) || 0;
                                    return (wasCutByCompression && !hasFreedSpaceThisTurn) || actCount >= 2;
                                });

                                const allowedToLoad = filesToAdd.filter(f => !thrashingFiles.some(tf => arePathsEqualTurn(tf, f)));

                                if (alreadyActive.length === filesToAdd.length) {
                                    toolResult = `⚠️ PROTOCOL REMINDER: All requested files [${filesToAdd.join(', ')}] are ALREADY active in your context [C] under 'LOADED FILE CONTENTS'.\nDo NOT output <add_files_to_context> or <unmute_files> for them again. Proceed DIRECTLY to code implementation using <file path="..." action="write|patch|update_symbol"> tags now.`;
                                    isSuccess = false;
                                    completedDynamicActions.push(`Attempted redundant file reload for [${filesToAdd.join(', ')}] (already in [C]).`);
                                } else if (allowedToLoad.length === 0 && thrashingFiles.length > 0) {
                                    consecutiveCompressionLoopCount++;
                                    isSuccess = false;
                                    const curTotalTok = this._currentDiscussion?.lastTokenMetrics?.total || 0;
                                    const curMaxTok = this._currentDiscussion?.lastTokenMetrics?.contextSize || 128000;
                                    toolResult = `Error: CONTEXT THRASHING BLOCKED for [${thrashingFiles.join(', ')}]. These files were recently compacted/muted by the Context Manager due to token budget limits (~${curTotalTok.toLocaleString()} / ${curMaxTok.toLocaleString()} tokens) or requested repeatedly without freeing space.\n\n**PLEASE OPTIMIZE YOUR CONTEXT FIRST:**\n1. **Mute or Remove Useless/Finished Files**: Call \`<mute_files>\\npath/to/finished_or_irrelevant.ext\\n</mute_files>\` or \`<remove_files_from_context>\` on files you no longer need.\n2. **Collapse Large Files into Symbols**: Use \`<manage_symbols path="path/to/large_file.ext" activate="SymA, SymB" />\` to collapse bloated files into structure while keeping only the few symbols you need intact (you can directly update loaded symbols with \`action="update_symbol"\` without loading the full file).\n3. **Targeted Lookups**: Use \`<show_symbol target="file:SymbolName" />\` or \`<peek_files path="file" lines="30" />\` instead of loading entire files.`;
                                    completedDynamicActions.push(`Blocked context thrashing loop on [${thrashingFiles.join(', ')}].`);
                                } else {
                                    if (thrashingFiles.length > 0) {
                                        consecutiveCompressionLoopCount++;
                                    } else {
                                        consecutiveCompressionLoopCount = 0;
                                    }

                                    const targetsToActivate = allowedToLoad.filter(f => !alreadyActive.some(af => arePathsEqualTurn(af, f)));
                                    let added: string[] = [];
                                    if (targetsToActivate.length > 0) {
                                        await this.unmuteFiles(targetsToActivate);
                                        added = await this._contextManager.getContextStateProvider()?.addFilesToContext(targetsToActivate) || [];
                                        this.recordCurrentPromptFiles(targetsToActivate);
                                        turnJustAddedFiles.push(...targetsToActivate);
                                        for (const tf of targetsToActivate) {
                                            const normF = tf.replace(/\\/g, '/').toLowerCase().trim();
                                            fileActivationCounts.set(normF, (fileActivationCounts.get(normF) || 0) + 1);
                                        }
                                    }

                                    const skippedNote = thrashingFiles.length > 0
                                        ? `\n\n⚠️ Skipped [${thrashingFiles.join(', ')}] (previously cut by Context Compression or repeated without \`<mute_files>\`). Work in phases or use \`<show_symbol>\` / \`<peek_files>\`.`
                                        : '';
                                    toolResult = `Success: Activated ${Math.max(added.length, targetsToActivate.length)} file(s) into context with full source code ([C]): [${targetsToActivate.join(', ')}].${skippedNote}\nNow proceed directly to code implementation (or mute finished files before loading the next phase).`;
                                    isSuccess = targetsToActivate.length > 0;
                                    completedDynamicActions.push(`Activated ${targetsToActivate.length} files.`);
                                }
                            } else {
                                toolResult = "Notice: No file paths specified in unmute tag.";
                                isSuccess = true;
                            }
                        } else if (action.tag === 'remove_files_from_context' || action.tag === 'mute_files') {
                            const attrFiles: string[] = [];
                            const attrRegex = /(?:path|paths|files|target)=["']([^"']+)["']/gi;
                            let afm: RegExpExecArray | null;
                            while ((afm = attrRegex.exec(action.attrStr || "")) !== null) {
                                afm[1].split(/[\s\r\n,;]+/).map(f => f.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).forEach(f => attrFiles.push(f));
                            }
                            const bodyFiles = action.attrStr && action.params === action.attrStr.trim()
                                ? []
                                : action.params.split(/[\s\r\n,]+/).map(f => f.trim().replace(/^['"]|['"]$/g, '')).filter(f => f && !/^(?:path|paths|files|target)=/i.test(f));
                            const filesToMute = Array.from(new Set([...attrFiles, ...bodyFiles]));
                            if (filesToMute.length > 0) {
                                await this.muteFiles(filesToMute);
                                toolResult = `Success: Muted content for [${filesToMute.join(', ')}]. Reference preserved in tree at 0 tokens [M].`;
                                isSuccess = true;
                                completedDynamicActions.push(`Muted ${filesToMute.length} files.`);
                            } else {
                                toolResult = "Notice: No file paths specified in mute tag.";
                                isSuccess = true;
                            }
                        } else if (action.tag === 'load_structure') {
                            const rawAttr = action.attrStr || "";
                            const rawParams = action.params || "";
                            const targetFiles: string[] = [];
                            const addF = (p: string) => {
                                const clean = p.trim().replace(/^['"`]|['"`]$/g, '').replace(/^-\s*/, '').trim();
                                if (clean && !targetFiles.includes(clean)) targetFiles.push(clean);
                            };

                            const attrRegex = /(?:path|paths|files|target)=["']([^"']+)["']/gi;
                            let am: RegExpExecArray | null;
                            while ((am = attrRegex.exec(rawAttr + " " + rawParams)) !== null) {
                                am[1].split(/[\r\n,;\s]+/).forEach(addF);
                            }
                            rawParams.split(/[\r\n,;]+/).forEach(l => l.trim().split(/\s+/).forEach(addF));

                            if (targetFiles.length > 0) {
                                await this.unmuteFiles(targetFiles);
                                await this.addFilesToDiscussionContext(targetFiles, 'definitions-only');
                                const provider = this._contextManager.getContextStateProvider();
                                if (provider) {
                                    const urisToSet: vscode.Uri[] = [];
                                    for (const tf of targetFiles) {
                                        const res = await this._contextManager.resolveWorkspaceFromPath(tf);
                                        if (res) {
                                            urisToSet.push(res.uri);
                                            this._contextManager.refreshFileInCache(res.uri);
                                        }
                                    }
                                    if (urisToSet.length > 0) {
                                        await provider.setStateForUris(urisToSet, 'definitions-only');
                                    }
                                }
                                this.recordCurrentPromptFiles(targetFiles);

                                const defsLog: string[] = [];
                                for (const tf of targetFiles) {
                                    const res = await this._contextManager.resolveWorkspaceFromPath(tf);
                                    if (res) {
                                        const defs = await this._contextManager.extractDefinitions(res.uri);
                                        defsLog.push(`### 📋 Definitions & Signatures for \`${tf}\`:\n${this.wrapInSafeCodeFence(defs, 'typescript')}`);
                                    }
                                }
                                toolResult = `Success: Loaded structure & signatures into context for [${targetFiles.join(', ')}].\nNote: Structure is for reference only. Whenever you need full source code or plan to edit these files, privilege using \`<unmute_files>\` to upgrade them directly from structure to full code.\n\n${defsLog.join('\n\n')}`;
                                isSuccess = true;
                                completedDynamicActions.push(`Loaded structure for ${targetFiles.length} file(s).`);
                            } else {
                                toolResult = "Notice: No valid file paths found in <load_structure>.";
                                isSuccess = false;
                            }
                        } else if (action.tag === 'unpack_directory') {
                            const rawDirs = action.params.split(/[\s\r\n,]+/).map((d: string) => d.trim().replace(/^['"]|['"]$/g, '')).filter((d: string) => d && !d.startsWith('<'));
                            if (rawDirs.length === 0) {
                                toolResult = "Error: No directory path provided in <unpack_directory>.";
                                isSuccess = false;
                            } else {
                                const outMsgs: string[] = [];
                                let allOk = true;
                                for (const dir of rawDirs) {
                                    const res = await this._contextManager.unpackDirectory(dir);
                                    outMsgs.push(res.message);
                                    if (!res.success) allOk = false;
                                }
                                toolResult = outMsgs.join('\n\n');
                                isSuccess = allOk;
                                completedDynamicActions.push(allOk ? `Unpacked directory: ${rawDirs.join(', ')}.` : `Failed to unpack: ${rawDirs.join(', ')}.`);
                            }
                        } else if (action.tag === 'peek_files') {
                            toolResult = "Error: <peek_files> is disabled for the Coder. Use <load_structure path=\"...\" /> to inspect file structure and <show_symbol target=\"file:SymbolName\" /> or <manage_symbols> to expand specific symbols.";
                            isSuccess = false;
                            completedDynamicActions.push(`Blocked <peek_files> (use <load_structure> / <show_symbol>).`);
                        } else if (false && action.tag === 'peek_files') {
                            const rawAttr = action.attrStr || "";
                            const rawInner = action.params || "";
                            const rawPaths: string[] = [];
                            const attrRegex = /(?:path|paths|file|files|target)=["']([^"']+)["']/gi;
                            let am: RegExpExecArray | null;
                            while ((am = attrRegex.exec(rawAttr)) !== null) {
                                am[1].split(/[\r\n,;\s]+/).forEach(p => {
                                    const clean = p.trim().replace(/^['"]|['"]$/g, '');
                                    if (clean && !clean.startsWith('<') && !rawPaths.includes(clean)) rawPaths.push(clean);
                                });
                            }
                            if (rawInner && rawInner !== rawAttr) {
                                rawInner.split(/[\s\r\n,]+/).forEach((p: string) => {
                                    const clean = p.trim().replace(/^['"]|['"]$/g, '');
                                    if (clean && !clean.startsWith('<') && !rawPaths.includes(clean)) rawPaths.push(clean);
                                });
                            }

                            if (rawPaths.length === 0) {
                                toolResult = "Error: No file path provided in <peek_files>.";
                                isSuccess = false;
                            } else {
                                const linesMatch = rawAttr.match(/lines=["']?(\d+)["']?/i);
                                const wordsMatch = rawAttr.match(/words=["']?(\d+)["']?/i);
                                const offsetMatch = rawAttr.match(/offset=["']?(\d+)["']?/i);
                                const fromMatch = rawAttr.match(/from=["']?(top|bottom)["']?/i);
                                const regexMatch = rawAttr.match(/regex=["']([^"']+)["']/i);
                                const peekOpts: any = {};
                                if (linesMatch) peekOpts.lines = parseInt(linesMatch[1], 10);
                                if (wordsMatch) peekOpts.words = parseInt(wordsMatch[1], 10);
                                if (offsetMatch) peekOpts.offset = parseInt(offsetMatch[1], 10);
                                if (fromMatch) peekOpts.from = fromMatch[1].toLowerCase();
                                if (regexMatch) peekOpts.regex = regexMatch[1];

                                const peekPayload = rawPaths.map(p => ({ path: p, ...peekOpts }));
                                const peekRes = await this._contextManager.peekFiles(peekPayload);
                                const outMsgs: string[] = [];
                                let anyOk = false;
                                for (const pr of peekRes) {
                                    if (pr.error) {
                                        outMsgs.push(`❌ ${pr.path}: ${pr.error}`);
                                    } else {
                                        anyOk = true;
                                        const preview = pr.content.length > 3000 ? pr.content.substring(0, 3000) + '\n... [truncated]' : pr.content;
                                        outMsgs.push(`### 📄 PEEK: \`${pr.path}\`\n\`\`\`\n${preview}\n\`\`\``);
                                    }
                                }
                                toolResult = outMsgs.join('\n\n');
                                isSuccess = anyOk;
                                completedDynamicActions.push(`Peeked at ${rawPaths.length} file(s).`);
                            }
                        } else if (action.tag === 'show_symbol') {
                            const attrStr = (action as any).attrStr || action.params || "";
                            const rawContent = action.params || "";

                            const targetMatch = attrStr.match(/target=["']([^"']+)["']/i);
                            const pathMatch = attrStr.match(/(?:path|file)=["']([^"']+)["']/i);
                            const symMatch = attrStr.match(/(?:symbol|symbols)=["']([^"']+)["']/i);

                            let filePath = pathMatch ? pathMatch[1].trim() : "";
                            const symbolsList: string[] = [];

                            if (targetMatch) {
                                const rawT = targetMatch[1].trim();
                                if (rawT.includes(':') && !/^[a-zA-Z]:[\\/]/.test(rawT)) {
                                    const col = rawT.indexOf(':');
                                    if (!filePath) filePath = rawT.substring(0, col).trim();
                                    rawT.substring(col + 1).split(/[\r\n,;]+/).forEach(s => {
                                        const c = s.trim(); if (c && !symbolsList.includes(c)) symbolsList.push(c);
                                    });
                                } else if (!filePath) {
                                    filePath = rawT;
                                }
                            }

                            if (symMatch) {
                                symMatch[1].split(/[\r\n,;]+/).forEach(s => {
                                    const c = s.trim(); if (c && !symbolsList.includes(c)) symbolsList.push(c);
                                });
                            }

                            if (rawContent && rawContent.trim()) {
                                rawContent.split(/[\r\n,;]+/).forEach(s => {
                                    const c = s.trim().replace(/^-\s*/, '').trim();
                                    if (c && !c.startsWith('<') && !symbolsList.includes(c)) symbolsList.push(c);
                                });
                            }

                            if (!filePath && symbolsList.length > 0 && symbolsList[0].includes(':')) {
                                const col = symbolsList[0].indexOf(':');
                                filePath = symbolsList[0].substring(0, col).trim();
                                symbolsList[0] = symbolsList[0].substring(col + 1).trim();
                            }

                            const { showSymbolTool } = require('../../tools/builtins/showSymbol');
                            const env = {
                                contextManager: this._contextManager,
                                lollmsApi: this._lollmsAPI,
                                workspaceRoot: folders?.[0],
                                currentPlan: null
                            };
                            const symRes = await showSymbolTool.execute({
                                target: filePath,
                                symbols: symbolsList
                            }, env as any, controller.signal);

                            toolResult = symRes.output;
                            isSuccess = symRes.success;
                            completedDynamicActions.push(`Showed symbols for ${filePath}: [${symbolsList.join(', ')}]`);
                        } else if (action.tag === 'read_full_file') {
                            const attrStr = `${action.attrStr || ''} ${action.params || ''}`.trim();
                            const pMatch = attrStr.match(/(?:path|file)=["']([^"']+)["']/i);
                            const reqPath = (pMatch ? pMatch[1] : (action.params || '').split(/[\r\n\s]+/)[0]).replace(/^['"]|['"]$/g, '').trim();
                            if (!reqPath) {
                                toolResult = "Error: No file path specified in <read_full_file>.";
                                isSuccess = false;
                            } else {
                                const res = await this._contextManager.resolveWorkspaceFromPath(reqPath);
                                if (res) {
                                    try {
                                        const fileBytes = await vscode.workspace.fs.readFile(res.uri);
                                        const text = Buffer.from(fileBytes).toString('utf8');
                                        toolResult = `### 📄 FULL FILE: \`${reqPath}\` (${text.split('\n').length} lines, ~${Math.ceil(text.length / 3.5)} tokens)\n${this.wrapInSafeCodeFence(text)}`;
                                        isSuccess = true;
                                        completedDynamicActions.push(`Read file: ${reqPath}`);
                                    } catch (e: any) {
                                        toolResult = `Error reading file ${reqPath}: ${e.message}`;
                                        isSuccess = false;
                                    }
                                } else {
                                    toolResult = `Error: Could not resolve path "${reqPath}" on disk.`;
                                    isSuccess = false;
                                }
                            }
                        } else if (action.tag === 'read_external_file') {
                            const attrStr = action.attrStr || "";
                            const rawInner = action.params && action.params !== attrStr.trim() ? action.params.trim() : "";
                            const pMatch = attrStr.match(/(?:path|file|file_path|filePath)=["']([^"']+)["']/i);
                            const startMatch = attrStr.match(/start_line=["']?(\d+)["']?/i);
                            const endMatch = attrStr.match(/end_line=["']?(\d+)["']?/i);
                            const reqPath = (pMatch ? pMatch[1] : rawInner.split(/[\r\n]+/)[0] || '').replace(/^['"]|['"]$/g, '').trim();

                            const { readExternalFileTool } = require('../../tools/builtins/readExternalFile');
                            const env = {
                                agentManager: this.agentManager,
                                workspaceRoot: folders?.[0],
                                contextManager: this._contextManager,
                                lollmsApi: this._lollmsAPI,
                                currentPlan: (this.agentManager as any)?.currentPlan || null
                            };
                            const extRes = await readExternalFileTool.execute({
                                path: reqPath || undefined,
                                start_line: startMatch ? parseInt(startMatch[1], 10) : undefined,
                                end_line: endMatch ? parseInt(endMatch[1], 10) : undefined
                            }, env as any, controller.signal);
                            toolResult = extRes.output;
                            isSuccess = extRes.success;
                            toolDisplayName = reqPath || 'list linked external files';
                            completedDynamicActions.push(`Read external file: ${toolDisplayName}`);
                        } else if (action.tag === 'grep') {
                            if (this._discussionCapabilities.grepEnabled === false) {
                                toolResult = "Error: <grep> is currently disabled in the HUD. Enable GREP in HUD options to use it.";
                                isSuccess = false;
                                completedDynamicActions.push(`Blocked <grep> (disabled in HUD).`);
                            } else {
                            const attrStr = `${action.attrStr || ''} ${action.params || ''}`.trim();
                            const pMatch = attrStr.match(/(?:pattern|query)=["']([^"']+)["']/i);
                            const pattern = (pMatch ? pMatch[1] : (action.params || '').split(/[\r\n]+/)[0]).replace(/^['"]|['"]$/g, '').trim();
                            const pathSubMatch = attrStr.match(/(?:path|include)=["']([^"']+)["']/i);
                            const subPath = pathSubMatch ? pathSubMatch[1].trim() : undefined;

                            if (!pattern) {
                                toolResult = "Error: No search pattern specified in <grep>.";
                                isSuccess = false;
                            } else {
                                const searchRes = await this._contextManager.searchWorkspaceContent(
                                    pattern,
                                    { matchCase: false, wholeWord: false, include: subPath, bypassGate: true },
                                    controller.signal
                                );
                                if (searchRes.length > 0) {
                                    const snippet = searchRes.slice(0, 15).map(r => `${r.path}:${r.line} - ${r.snippet}`).join('\n');
                                    toolResult = `### 🔍 GREP RESULTS FOR "${pattern}" (${searchRes.length} hits):\n${this.wrapInSafeCodeFence(snippet)}`;
                                    isSuccess = true;
                                    completedDynamicActions.push(`Grepped for: "${pattern}" (${searchRes.length} hits)`);
                                } else {
                                    toolResult = `### 🔍 GREP RESULTS FOR "${pattern}":\nNo matches found in workspace.`;
                                    isSuccess = true;
                                    completedDynamicActions.push(`Grepped for: "${pattern}" (0 hits)`);
                                }
                            }
                            }
                        } else if (action.tag === 'load_knowledge') {
                            const secPath = action.params.trim();
                            try {
                                const { KnowledgeManager } = require('../../knowledgeManager');
                                const km = new KnowledgeManager(this._discussionManager.context);
                                const newScore = await km.incrementAccessCount(secPath);
                                const secContent = await km.readSectionKnowledge(secPath);
                                toolResult = `### 📖 KNOWLEDGE SECTION LOADED: \`${secPath}\` [${newScore}]\n\`\`\`markdown\n${secContent || '(Section content empty)'}\n\`\`\``;
                                isSuccess = true;
                                completedDynamicActions.push(`Loaded knowledge section: ${secPath} [${newScore}]`);
                                const rendered = await km.renderContextKnowledge();
                                this._panel.webview.postMessage({ command: 'updateKnowledgeContent', knowledge: rendered });
                            } catch (e: any) {
                                toolResult = `Error loading knowledge section: ${e.message}`;
                                isSuccess = false;
                            }
                        } else if (action.tag === 'update_knowledge') {
                            const attrStr = (action as any).attrStr || action.params || "";
                            const pathMatch = attrStr.match(/path=["']([^"']+)["']/i);
                            const secPath = pathMatch ? pathMatch[1].trim() : "";
                            const cleanContent = action.params.replace(/^[^\n]*\n/, '').trim();
                            try {
                                const { KnowledgeManager } = require('../../knowledgeManager');
                                const km = new KnowledgeManager(this._discussionManager.context);
                                await km.updateKnowledge(secPath, cleanContent || action.params);
                                toolResult = `Successfully updated knowledge for \`${secPath || 'root'}\`.`;
                                isSuccess = true;
                                completedDynamicActions.push(`Updated knowledge: ${secPath || 'root'}`);
                                const rendered = await km.renderContextKnowledge();
                                this._panel.webview.postMessage({ command: 'updateKnowledgeContent', knowledge: rendered });
                            } catch (e: any) {
                                toolResult = `Error updating knowledge: ${e.message}`;
                                isSuccess = false;
                            }
                        } else if (action.tag === 'manage_symbols') {
                            const attrStr = action.attrStr || "";
                            const inner = action.params || "";
                            const pathMatch = attrStr.match(/(?:path|file|target)=["']([^"']+)["']/i);
                            const filePath = pathMatch ? pathMatch[1].trim() : "";

                            const parseList = (raw?: string): string[] => {
                                if (!raw) return [];
                                return raw.split(/[\r\n,;]+/).map(s => s.trim().replace(/^['"`-]\s*|['"`]$/g, '')).filter(Boolean);
                            };

                            const actAttr = attrStr.match(/activate=["']([^"']+)["']/i);
                            const deactAttr = attrStr.match(/deactivate=["']([^"']+)["']/i);
                            const modeAttr = attrStr.match(/mode=["'](all|none)["']/i);

                            let toActivate = parseList(actAttr?.[1]);
                            let toDeactivate = parseList(deactAttr?.[1]);

                            if (inner && inner !== attrStr) {
                                const actLine = inner.match(/activate\s*:\s*([^\r\n]+)/i);
                                const deactLine = inner.match(/deactivate\s*:\s*([^\r\n]+)/i);
                                if (actLine) toActivate.push(...parseList(actLine[1]));
                                if (deactLine) toDeactivate.push(...parseList(deactLine[1]));
                            }

                            if (!filePath) {
                                toolResult = "Error: No file path specified in <manage_symbols>.";
                                isSuccess = false;
                            } else {
                                const res = await this.applySymbolBatchUpdate(
                                    filePath,
                                    toActivate,
                                    toDeactivate,
                                    modeAttr ? (modeAttr[1].toLowerCase() as 'all' | 'none') : undefined
                                );
                                toolResult = res.message;
                                isSuccess = res.success;
                                completedDynamicActions.push(`Updated symbol visibility for ${filePath}`);
                            }
                        } else if (action.tag === 'query_architecture' || action.tag === 'sparql') {
                            if (this._discussionCapabilities.sparqlEnabled === false) {
                                toolResult = "Error: <sparql> / <query_architecture> is currently disabled in the HUD. Enable SPARQL in HUD options to use it.";
                                isSuccess = false;
                                completedDynamicActions.push(`Blocked <sparql> (disabled in HUD).`);
                            } else {
                                const combinedSparql = `${action.attrStr || ''}`.match(/query=["']([\s\S]*?)["']/i)?.[1] || action.params;
                                const sparql = combinedSparql.trim();
                                const rawResult = await (this.agentManager as any).codeGraphManager.executeSparql(sparql);
                                toolResult = rawResult || "No matches.";
                                isSuccess = !rawResult.includes("Error");
                                completedDynamicActions.push(`Executed SPARQL query`);
                            }
                        } else if (action.tag === 'run_tests') {
                            const attrStr = action.attrStr || "";
                            const rawInner = action.params || "";
                            const targets: string[] = [];
                            const addT = (v: string) => {
                                const c = v.trim().replace(/^['"`]|['"`]$/g, '').replace(/^-\s*/, '').trim();
                                if (c && !c.startsWith('<') && !targets.includes(c)) targets.push(c);
                            };
                            const tAttrRegex = /(?:targets|files|paths|path|file)=["']([^"']+)["']/gi;
                            let tm: RegExpExecArray | null;
                            while ((tm = tAttrRegex.exec(attrStr)) !== null) {
                                const val = tm[1].trim();
                                if (val.startsWith('[') && val.endsWith(']')) {
                                    try {
                                        const arr = JSON.parse(val.replace(/'/g, '"'));
                                        if (Array.isArray(arr)) arr.forEach(x => addT(String(x)));
                                    } catch { val.slice(1, -1).split(/[\r\n,]+/).forEach(addT); }
                                } else {
                                    val.split(/[\r\n,;]+/).forEach(addT);
                                }
                            }
                            if (rawInner && rawInner !== attrStr.trim()) {
                                rawInner.split(/[\r\n,;]+/).forEach(addT);
                            }
                            const runnerMatch = attrStr.match(/\brunner=["']([^"']+)["']/i);
                            const filterMatch = attrStr.match(/\bfilter=["']([^"']+)["']/i);
                            const timeoutMatch = attrStr.match(/\btimeout_s=["']?(\d+)["']?/i);

                            toolDisplayName = targets.join(', ') || 'tests';
                            const { runTestsTool } = require('../../tools/builtins/runTests');
                            const env = {
                                agentManager: this.agentManager,
                                workspaceRoot: folders?.[0],
                                contextManager: this._contextManager,
                                lollmsApi: this._lollmsAPI,
                                currentPlan: (this.agentManager as any)?.currentPlan || null
                            };
                            const testRes = await runTestsTool.execute({
                                targets,
                                runner: runnerMatch ? runnerMatch[1].trim() : undefined,
                                filter: filterMatch ? filterMatch[1].trim() : undefined,
                                timeout_s: timeoutMatch ? parseInt(timeoutMatch[1], 10) : undefined
                            }, env as any, controller.signal);
                            toolResult = testRes.output;
                            isSuccess = testRes.success;
                            completedDynamicActions.push(`Ran tests on [${targets.join(', ')}]: ${isSuccess ? 'PASSED' : 'FAILED'}`);
                        } else if (action.tag === 'execute_code') {
                            const langMatch = (action.attrStr || '').match(/\blang=["']?([\w\-\+#.]+)["']?/i);
                            const lang = (langMatch ? langMatch[1] : 'bash').toLowerCase();
                            const codeBody = action.params.trim();
                            toolDisplayName = lang;

                            if (!codeBody) {
                                toolResult = "Error: Empty <execute_code> body — nothing to execute.";
                                isSuccess = false;
                            } else if (!folders || folders.length === 0) {
                                toolResult = "🛑 SECURITY VIOLATION: An open workspace folder is required for <execute_code>.";
                                isSuccess = false;
                            } else {
                                const workspaceRoots = folders.map(f => f.uri.fsPath);
                                const secLevel = this.agentManager?.getSecurityLevel?.() || (this._discussionCapabilities.agentSecurityLevel || 'guarded');
                                const validation = AgentSecurityGuard.validateExecution(codeBody, lang, {
                                    workspaceRoots,
                                    level: secLevel
                                });

                                let executionPermitted = validation.allowed;
                                let denyReason = validation.reason;

                                // If shell invokes a workspace script file (e.g. python foo.py / node bar.js / bash run.sh), scan its content too
                                if (validation.decision !== 'block') {
                                    const scriptInvokeMatch = codeBody.match(/\b(?:python3?|node|bash|sh|pwsh|powershell)\s+([^\r\n;&|]+\.(?:py|js|mjs|cjs|ts|sh|ps1))\b/i);
                                    if (scriptInvokeMatch) {
                                        const candidateScript = scriptInvokeMatch[1].trim().replace(/^['"]|['"]$/g, '');
                                        const pathCheck = AgentSecurityGuard.validateWorkspacePath(candidateScript, folders[0]);
                                        if (!pathCheck.valid) {
                                            executionPermitted = false;
                                            denyReason = pathCheck.reason || 'Script path outside workspace.';
                                        } else {
                                            const resolved = await this._contextManager.resolveWorkspaceFromPath(candidateScript);
                                            if (resolved) {
                                                try {
                                                    const bytes = await vscode.workspace.fs.readFile(resolved.uri);
                                                    const scriptText = Buffer.from(bytes).toString('utf8');
                                                    const scriptScan = AgentSecurityGuard.analyzeScriptContent(scriptText, resolved.relativePath, secLevel, workspaceRoots);
                                                    if (scriptScan.decision === 'block') {
                                                        executionPermitted = false;
                                                        denyReason = scriptScan.reason;
                                                    } else if (scriptScan.decision === 'confirm' && validation.decision === 'allow') {
                                                        validation.decision = 'confirm';
                                                        denyReason = scriptScan.reason;
                                                    }
                                                } catch {}
                                            }
                                        }
                                    }
                                }

                                if (validation.decision === 'block' || (!executionPermitted && validation.decision !== 'confirm')) {
                                    toolResult = `🛑 SECURITY VIOLATION: Execution blocked.\nReason: ${denyReason}`;
                                    isSuccess = false;
                                    completedDynamicActions.push(`Blocked unsafe ${lang} execution: ${denyReason}`);
                                } else {
                                    if (validation.decision === 'confirm' && !(this._currentDiscussion as any)?.allowAllExecuteCodeForDiscussion) {
                                        const safeReason = String(denyReason || 'Requires user confirmation').replace(/"/g, '&quot;');
                                        const confirmPrompt = `### 🛡️ Security Confirmation Required (\`<execute_code lang="${lang}">\`)
**Reason:** ${denyReason}

${this.wrapInSafeCodeFence(codeBody, lang)}

<lollms_form title="Approve Code Execution" id="exec_confirm_${Date.now()}">
  <radio name="decision" label="Choose how to proceed:" required="true">
    <option value="allow_once">✅ Accept Once (Run this script)</option>
    <option value="allow_discussion">🔓 Accept for Whole Discussion (Auto-approve future scripts)</option>
    <option value="refuse">🛑 Refuse / Block</option>
  </radio>
</lollms_form>

`;
                                        let decisionVal = 'refuse';
                                        try {
                                            const rawDecision = await this.requestUserInput(confirmPrompt, controller.signal);
                                            if (rawDecision && rawDecision.startsWith('FORM_SUBMISSION:')) {
                                                const parsed = JSON.parse(rawDecision.substring(16).trim());
                                                const d = String(parsed.decision || '').toLowerCase();
                                                if (d.includes('allow_discussion') || d.includes('whole discussion')) decisionVal = 'allow_discussion';
                                                else if (d.includes('allow_once') || d.includes('accept once')) decisionVal = 'allow_once';
                                            } else if (rawDecision && /allow_discussion|whole discussion/i.test(rawDecision)) {
                                                decisionVal = 'allow_discussion';
                                            } else if (rawDecision && /allow_once|accept once/i.test(rawDecision)) {
                                                decisionVal = 'allow_once';
                                            }
                                        } catch {
                                            decisionVal = 'refuse';
                                        }

                                        if (decisionVal === 'allow_discussion') {
                                            if (this._currentDiscussion) {
                                                (this._currentDiscussion as any).allowAllExecuteCodeForDiscussion = true;
                                            }
                                            executionPermitted = true;
                                        } else if (decisionVal === 'allow_once') {
                                            executionPermitted = true;
                                        } else {
                                            executionPermitted = false;
                                            toolResult = `🛑 SECURITY BLOCK: Execution cancelled by user (${safeReason}).`;
                                            isSuccess = false;
                                            completedDynamicActions.push(`User blocked ${lang} execution.`);
                                        }
                                    }

                                    if (executionPermitted) {
                                        const { execFile } = require('child_process');
                                        const pathMod = require('path');
                                        const fsMod = require('fs');
                                        const tempDir = pathMod.join(folders[0].uri.fsPath, '.lollms', 'temp_scripts');
                                        if (!fsMod.existsSync(tempDir)) {
                                            fsMod.mkdirSync(tempDir, { recursive: true });
                                        }
                                        const stamp = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
                                        let scriptPath = '';
                                        let cmd = '';
                                        let cmdArgs: string[] = [];
                                        let isInlineShell = false;

                                        try {
                                            if (lang === 'python' || lang === 'python3' || lang === 'py') {
                                                scriptPath = pathMod.join(tempDir, `lollms_exec_${stamp}.py`);
                                                fsMod.writeFileSync(scriptPath, codeBody, 'utf8');
                                                cmd = process.platform === 'win32' ? 'python' : 'python3';
                                                cmdArgs = [scriptPath];
                                            } else if (lang === 'node' || lang === 'nodejs' || lang === 'javascript' || lang === 'js') {
                                                scriptPath = pathMod.join(tempDir, `lollms_exec_${stamp}.js`);
                                                fsMod.writeFileSync(scriptPath, codeBody, 'utf8');
                                                cmd = 'node';
                                                cmdArgs = [scriptPath];
                                            } else {
                                                cmd = process.platform === 'win32' ? 'powershell' : 'bash';
                                                if (process.platform === 'win32') {
                                                    cmdArgs = ['-NoProfile', '-NonInteractive', '-Command', codeBody];
                                                    isInlineShell = true;
                                                } else {
                                                    scriptPath = pathMod.join(tempDir, `lollms_exec_${stamp}.sh`);
                                                    fsMod.writeFileSync(scriptPath, codeBody, 'utf8');
                                                    cmdArgs = [scriptPath];
                                                }
                                            }

                                            const execRes = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
                                                execFile(cmd, cmdArgs, { cwd: folders[0].uri.fsPath, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 }, (err: any, stdout: string, stderr: string) => {
                                                    resolve({ stdout: stdout || '', stderr: stderr || '', code: err ? (typeof err.code === 'number' ? err.code : 1) : 0 });
                                                });
                                            });

                                            const trim = (s: string, n: number) => {
                                                if (s.length <= n) return s;
                                                const head = Math.floor(n * 0.2);
                                                const tail = n - head;
                                                return s.slice(0, head) + `\n... [${s.length - n} chars truncated] ...\n` + s.slice(s.length - tail);
                                            };
                                            const rawOut = trim(execRes.stdout, 20000);
                                            const rawErr = trim(execRes.stderr, 6000);

                                            const outGate = await ContextPoisoningGate.sanitizeExecutionOutput(rawOut, `execute_code://${lang}/stdout`, { signal: controller.signal });
                                            const errGate = await ContextPoisoningGate.sanitizeExecutionOutput(rawErr, `execute_code://${lang}/stderr`, { signal: controller.signal });

                                            const out = outGate.sanitizedOutput;
                                            const errOut = errGate.sanitizedOutput;
                                            isSuccess = execRes.code === 0 && !outGate.blocked && !errGate.blocked;
                                            toolResult = `### ⚡ EXECUTE_CODE (${lang}) — Exit Code: ${execRes.code}\n**stdout:**\n${this.wrapInSafeCodeFence(out || '(empty)')}\n${errOut ? `**stderr:**\n${this.wrapInSafeCodeFence(errOut)}\n` : ''}`;
                                            completedDynamicActions.push(`Executed ${lang} code (exit ${execRes.code}).`);
                                        } catch (execErr: any) {
                                            toolResult = `Error executing <execute_code lang="${lang}">: ${execErr.message}`;
                                            isSuccess = false;
                                            completedDynamicActions.push(`Crashed executing ${lang} code.`);
                                        } finally {
                                            try { if (scriptPath && !isInlineShell && fsMod.existsSync(scriptPath)) fsMod.unlinkSync(scriptPath); } catch {}
                                        }
                                    }
                                }
                            }
                        } else if (action.tag === 'lollms_tool') {
                            const attrStr = action.attrStr || "";
                            const rawJson = action.params.trim();
                            let parsedCall: any = {};
                            const nameAttrMatch = attrStr.match(/\bname=["']([^"']+)["']/i);
                            const paramsAttrMatch = attrStr.match(/\b(?:params|arguments)=["']([\s\S]*?)["'](?=\s+\w+=|\s*$)/i);

                            if (nameAttrMatch && (paramsAttrMatch || !rawJson.startsWith('{'))) {
                                let argsObj: any = {};
                                if (paramsAttrMatch?.[1]) {
                                    try { argsObj = JSON.parse(paramsAttrMatch[1]); } catch { argsObj = {}; }
                                } else if (rawJson.startsWith('{')) {
                                    try { argsObj = JSON.parse(rawJson); } catch { argsObj = {}; }
                                }
                                parsedCall = { name: nameAttrMatch[1].trim(), arguments: argsObj };
                            } else {
                                try {
                                    parsedCall = JSON.parse(rawJson);
                                } catch (e: any) {
                                    try {
                                        const repaired = rawJson.replace(/\\`/g, '`').replace(/[\r\n\t]/g, ' ').replace(/,\s*([\]}])/g, '$1');
                                        parsedCall = JSON.parse(repaired);
                                    } catch (e2: any) {
                                        const preview = rawJson.length > 300 ? rawJson.substring(0, 300) + '...' : rawJson;
                                        throw new Error(`Invalid JSON in <lollms_tool>: ${e2?.message || e?.message}. Received: ${preview}`);
                                    }
                                }
                            }
                            const name = parsedCall.name || "unknown_tool";
                            toolDisplayName = name;
                            const parsedParams = parsedCall.arguments || parsedCall.params || {};

                            if (name === 'manage_file_symbols' || name === 'manage_symbols') {
                                const targetPath = parsedParams.path || parsedParams.file || '';
                                const toActivate = Array.isArray(parsedParams.activate) ? parsedParams.activate : (typeof parsedParams.activate === 'string' ? parsedParams.activate.split(',').map((s: string) => s.trim()).filter(Boolean) : []);
                                const toDeactivate = Array.isArray(parsedParams.deactivate) ? parsedParams.deactivate : (typeof parsedParams.deactivate === 'string' ? parsedParams.deactivate.split(',').map((s: string) => s.trim()).filter(Boolean) : []);
                                const mode = parsedParams.mode === 'all' || parsedParams.mode === 'none' ? parsedParams.mode : undefined;
                                if (!targetPath) {
                                    toolResult = 'Error: Missing "path" parameter.';
                                    isSuccess = false;
                                } else {
                                    const res = await this.applySymbolBatchUpdate(targetPath, toActivate, toDeactivate, mode);
                                    toolResult = res.message;
                                    isSuccess = res.success;
                                    completedDynamicActions.push(`Managed symbols for ${targetPath}`);
                                }
                            } else if (!this._discussionCapabilities.agentMode && (name === 'read_file' || name === 'read_files' || name === 'peek_at_context')) {
                                toolResult = `Error: Tool '${name}' is disabled in non-agent mode. You must exclusively use <add_files_to_context>\npath/to/file\n</add_files_to_context> to add files from the project tree.`;
                                isSuccess = false;
                                completedDynamicActions.push(`Attempted ${name} in non-agent mode (BLOCKED).`);
                            } else {
                                const toolDef = this.agentManager.getTools().find((t: any) => t.name === name);
                                if (toolDef) {
                                    const env = { 
                                        agentManager: this.agentManager, 
                                        workspaceRoot: folders?.[0], 
                                        contextManager: this._contextManager, 
                                        lollmsApi: this._lollmsAPI,
                                        skillsManager: this._skillsManager,
                                        codeGraphManager: this._codeGraphManager,
                                        personalityManager: this._personalityManager,
                                        currentPlan: (this.agentManager as any)?.currentPlan || null
                                    };
                                    const result = await toolDef.execute(parsedParams, env, controller.signal);
                                    toolResult = result.output;
                                    isSuccess = result.success;
                                    if (isSuccess && (name === 'add_files_to_context' || name === 'remove_files_from_context')) {
                                        toolModifiedContext = true;
                                        if (name === 'add_files_to_context') {
                                            const rawP = parsedParams?.paths ?? parsedParams?.files ?? parsedParams?.path;
                                            const addedList = Array.isArray(rawP) ? rawP : (typeof rawP === 'string' ? [rawP] : []);
                                            const cleanList = addedList.map((p: any) => String(p || '').trim()).filter(Boolean);
                                            if (cleanList.length > 0) {
                                                this.recordCurrentPromptFiles(cleanList);
                                                turnJustAddedFiles.push(...cleanList);
                                            }
                                        }
                                    }
                                    completedDynamicActions.push(`Executed tool: ${name}`);
                                } else {
                                    toolResult = `Error: Tool '${name}' is not equipped or does not exist.`;
                                    isSuccess = false;
                                    completedDynamicActions.push(`Tool ${name} not found.`);
                                }
                            }
                        }
                    } catch (executionErr: any) {
                        isSuccess = false;
                        toolResult = `Runtime Error: ${executionErr.message}`;
                        completedDynamicActions.push(`Crashed executing ${action.tag}.`);
                    }

                    if (isSuccess) anySuccess = true;

                    const summaryColor = isSuccess ? '' : 'color:var(--vscode-charts-red);';
                    const headerPrefix = isSuccess ? 'Action Complete' : 'Action Failed';
                    const safeToolResult = this.formatSafeToolResult(toolResult);
                    const escSummary = (s: string) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    const safeToolDisplayName = escSummary(toolDisplayName);
                    let blockWidgetHtml = "";

                    if (action.tag === 'add_files_to_context') {
                        const filesToAdd = action.params.split(/[\s\r\n,]+/).map(f => f.trim()).filter(f => f);
                        blockWidgetHtml = `\n\n<details open class="processing-block"><summary style="${summaryColor}"><i class="codicon ${isSuccess ? 'codicon-cloud-download' : 'codicon-error'}"></i> ${isSuccess ? 'Loaded Files Context' : 'File Loading Notice'}: ${filesToAdd.join(', ')}</summary><div class="processing-body">\n${safeToolResult}\n</div></details>\n\n`;
                    } else if (action.tag === 'mute_files') {
                        const files = action.params.split(/[\s\r\n,]+/).map(f => f.trim()).filter(Boolean);
                        blockWidgetHtml = `\n\n<details open class="processing-block"><summary style="${summaryColor}"><i class="codicon codicon-eye-closed"></i> Muted Files: ${files.join(', ')}</summary><div class="processing-body">\n${safeToolResult}\n</div></details>\n\n`;
                    } else if (action.tag === 'unmute_files') {
                        const files = action.params.split(/[\s\r\n,]+/).map(f => f.trim()).filter(Boolean);
                        blockWidgetHtml = `\n\n<details open class="processing-block"><summary style="${summaryColor}"><i class="codicon codicon-eye"></i> Unmuted Files: ${files.join(', ')}</summary><div class="processing-body">\n${safeToolResult}\n</div></details>\n\n`;
                    } else if (action.tag === 'load_knowledge') {
                        blockWidgetHtml = `\n\n<details open class="processing-block"><summary style="${summaryColor}"><i class="codicon codicon-book"></i> Knowledge Loaded: ${action.params}</summary><div class="processing-body">\n${safeToolResult}\n</div></details>\n\n`;
                    } else if (action.tag === 'update_knowledge') {
                        blockWidgetHtml = `\n\n<details open class="processing-block"><summary style="${summaryColor}"><i class="codicon codicon-pass-filled"></i> Knowledge Synchronized: ${action.params.substring(0, 30)}</summary><div class="processing-body">\n${safeToolResult}\n</div></details>\n\n`;
                    } else if (action.tag === 'remove_files_from_context') {
                        const filesToRemove = action.params.split(/[\s\r\n,]+/).map(f => f.trim()).filter(f => f);
                        blockWidgetHtml = `\n\n<details open class="processing-block"><summary style="${summaryColor}"><i class="codicon ${isSuccess ? 'codicon-trash' : 'codicon-error'}"></i> ${isSuccess ? 'Pruned Files Context' : 'Pruning Failed'}: ${filesToRemove.join(', ')}</summary><div class="processing-body">\n${safeToolResult}\n</div></details>\n\n`;
                    } else if (action.tag === 'load_structure') {
                        blockWidgetHtml = `\n\n<details open class="processing-block"><summary style="${summaryColor}"><i class="codicon ${isSuccess ? 'codicon-symbol-class' : 'codicon-error'}"></i> ${isSuccess ? 'Structure &amp; Signatures Loaded' : 'Structure Request Failed'}: ${action.params.substring(0, 60)}</summary><div class="processing-body">\n${safeToolResult}\n</div></details>\n\n`;
                    } else if (action.tag === 'unpack_directory') {
                        const dirs = action.params.split(/[\s\r\n,]+/).map((f: string) => f.trim()).filter((f: string) => f);
                        blockWidgetHtml = `\n\n<details open class="processing-block"><summary style="${summaryColor}"><i class="codicon ${isSuccess ? 'codicon-folder-opened' : 'codicon-error'}"></i> ${isSuccess ? 'Unpacked Directory' : 'Directory Unpack Notice'}: ${dirs.join(', ')}</summary><div class="processing-body">\n${safeToolResult}\n</div></details>\n\n`;
                    } else if (action.tag === 'peek_files') {
                        const files = action.params.split(/[\s\r\n,]+/).map((f: string) => f.trim()).filter((f: string) => f);
                        blockWidgetHtml = `\n\n<details open class="processing-block"><summary style="${summaryColor}"><i class="codicon ${isSuccess ? 'codicon-eye' : 'codicon-error'}"></i> ${isSuccess ? 'Inspected Files (Live)' : 'Peek Notice'}: ${files.join(', ')}</summary><div class="processing-body">\n${safeToolResult}\n</div></details>\n\n`;
                    } else if (action.tag === 'read_full_file') {
                        blockWidgetHtml = `\n\n<details open class="processing-block"><summary style="${summaryColor}"><i class="codicon ${isSuccess ? 'codicon-file' : 'codicon-error'}"></i> Read File: ${action.params.substring(0, 50)}</summary><div class="processing-body">\n${safeToolResult}\n</div></details>\n\n`;
                    } else if (action.tag === 'read_external_file') {
                        blockWidgetHtml = `\n\n<details open class="processing-block"><summary style="${summaryColor}"><i class="codicon ${isSuccess ? 'codicon-link' : 'codicon-error'}"></i> Read External File: ${toolDisplayName}</summary><div class="processing-body">\n${safeToolResult}\n</div></details>\n\n`;
                    } else if (action.tag === 'grep') {
                        blockWidgetHtml = `\n\n<details open class="processing-block"><summary style="${summaryColor}"><i class="codicon ${isSuccess ? 'codicon-search' : 'codicon-error'}"></i> Grep Code Search: ${action.params.substring(0, 50)}</summary><div class="processing-body">\n${safeToolResult}\n</div></details>\n\n`;
                    } else if (action.tag === 'query_architecture' || action.tag === 'sparql') {
                        const sparql = action.params.trim();
                        blockWidgetHtml = `\n\n<details open class="processing-block"><summary style="${summaryColor}"><i class="codicon codicon-graph"></i> ${isSuccess ? 'Architecture Query (SPARQL)' : 'SPARQL Query Failed'}</summary><div class="processing-body">\`\`\`sparql\n${sparql}\n\`\`\`\n\n**Result:**\n${safeToolResult}</div></details>\n\n`;
                    } else if (action.tag === 'run_tests') {
                        blockWidgetHtml = `\n\n<details open class="processing-block"><summary style="${summaryColor}"><i class="codicon codicon-beaker"></i> ${isSuccess ? 'Tests Passed' : 'Tests Failed'}: ${toolDisplayName}</summary><div class="processing-body">\n${safeToolResult}\n</div></details>\n\n`;
                    } else {
                        blockWidgetHtml = `\n\n<details open class="processing-block"><summary style="${summaryColor}"><i class="codicon codicon-tools"></i> ${headerPrefix}: ${safeToolDisplayName}</summary><div class="processing-body">**Output:**\n${safeToolResult}</div></details>

\n\n`;
                    }

                    // Ensure any dangling unclosed code fence or think tag from turnResponse does not swallow blockWidgetHtml
                    const danglingFence = this.findUnclosedMarkdownFence(aIdx === 0 ? turnResponse : '');
                    if (danglingFence) {
                        currentFullResponseBuffer += `\n${danglingFence.char.repeat(danglingFence.len)}\n`;
                    }
                    const openThinkMatches = turnResponse.match(/<(think|thinking|thought|analysis|reasoning)\b[^>]*>/gi) || [];
                    const closeThinkMatches = turnResponse.match(/<\/(think|thinking|thought|analysis|reasoning)>/gi) || [];
                    if (aIdx === 0 && openThinkMatches.length > closeThinkMatches.length) {
                        currentFullResponseBuffer += '\n</think>\n';
                    }

                    currentFullResponseBuffer += blockWidgetHtml;
                    fullResponse = currentFullResponseBuffer;

                    const actionDetail = (() => {
                        const rawDetail = action.tag === 'lollms_tool'
                            ? toolDisplayName
                            : (action.params || action.attrStr || toolDisplayName);
                        return String(rawDetail || '').replace(/\s+/g, ' ').trim().slice(0, 110);
                    })();
                    roundEntry.scoutingActions.push({
                        tag: action.tag,
                        name: toolDisplayName,
                        detail: actionDetail,
                        success: isSuccess
                    });

                    executedResults.push({
                        tag: action.tag,
                        name: toolDisplayName,
                        output: toolResult,
                        success: isSuccess
                    });
                }

                if (anySuccess) {
                    consecutiveFailsCount = 0;
                    // Dynamically refresh context payload so next turn sees the newly added files
                    const hasContextChanges = toolModifiedContext || discoveredActions.some(a => 
                        a.tag === 'add_files_to_context' || 
                        a.tag === 'unmute_files' || 
                        a.tag === 'remove_files_from_context' || 
                        a.tag === 'load_structure' ||
                        a.tag === 'manage_symbols' ||
                        a.tag === 'mute_files' ||
                        a.tag === 'unpack_directory'
                    );

                    if (hasContextChanges) {
                        currentContextPayload = await this._contextManager.getContextContent({
                            importedSkillIds: importedIds,
                            includeTree: true,
                            leanMode: false,
                            discussionId: this.discussionId,
                            mutedFiles: this._currentDiscussion?.mutedFiles || [],
                            includedFiles: (this._currentDiscussion as any)?.includedFiles,
                            modelName: targetModel,
                            signal: controller.signal,
                            capabilities: this._discussionCapabilities
                        });
                        loopTransientTurns = [];
                    }
                } else {
                    consecutiveFailsCount++;
                }

                await finalizeAndSaveTurn(currentFullResponseBuffer);

                const assistantTurnMsg: ChatMessage = { role: 'assistant', content: stripThinkingTags(turnResponse).trim() };

                const batchResultsFormatted = executedResults.map((r, i) => {
                    const icon = r.success ? '✅' : '❌';
                    return `#### Action ${i + 1} [${r.tag}: ${r.name}] - ${icon}\n${r.output}`;
                }).join('\n\n---\n\n');

                const batchUserMsg: ChatMessage = { 
                    role: 'user', 
                    content: `### 📋 BATCH EXECUTION RESULTS (${executedResults.length} actions executed in order)\n\n${batchResultsFormatted}\n\nReview all results above, adjust your reasoning, and proceed with the next logical step of the user request.` 
                };
                loopTransientTurns.push(assistantTurnMsg, batchUserMsg);

                const getTransientChars = (msgs: ChatMessage[]) => msgs.reduce((sum, m) => {
                    const txt = typeof m.content === 'string'
                        ? m.content
                        : (Array.isArray(m.content) ? m.content.map((p: any) => p?.type === 'text' ? (p.text || '') : '').join('\n') : '');
                    return sum + txt.length;
                }, 0);

                if (loopTransientTurns.length > 2 && getTransientChars(loopTransientTurns.slice(0, -2)) > 6000) {
                    const olderTransient = loopTransientTurns.slice(0, -2).map(m => {
                        if (typeof m.content === 'string' && m.content.length > 600) {
                            return { ...m, content: `${m.content.substring(0, 400)}\n... [Earlier turn tool output compacted to save context tokens]` };
                        }
                        return m;
                    });
                    loopTransientTurns = [...olderTransient, ...loopTransientTurns.slice(-2)];
                }

                if (turnPatchReport && typeof batchUserMsg.content === 'string') {
                    batchUserMsg.content = `${turnPatchReport}\n${batchUserMsg.content}`;
                }

                const roundsRemaining = Math.max(0, maxTurnsLimit - currentTurnIndex);
                if (typeof batchUserMsg.content === 'string') {
                    let roundBudgetNotice = `\n\n🔄 **Auto-Mode Round Budget**: ${roundsRemaining} of ${maxTurnsLimit} round(s) remaining (next is Round ${currentTurnIndex + 1}/${maxTurnsLimit}).`;
                    if (roundsRemaining === 1) {
                        roundBudgetNotice += `\n🛑 **LAST AUTO-MODE ROUND**: This is your FINAL automatic turn. Wrap up, clean up any temporary instrumentation/scratch files, deliver your final report, and ask the user if they want you to continue.`;
                    } else if (roundsRemaining <= 3) {
                        roundBudgetNotice += `\n⚠️ **APPROACHING ROUND LIMIT**: Prepare to conclude, clean up any temporary instrumentation/scratch files, and either emit your final summary or ask the user for more rounds if additional work is needed.`;
                    }
                    batchUserMsg.content += roundBudgetNotice;
                }

                const hasContextExpandingTools = discoveredActions.some(a =>
                    a.tag === 'add_files_to_context' ||
                    a.tag === 'unmute_files' ||
                    a.tag === 'load_structure' ||
                    a.tag === 'manage_symbols' ||
                    a.tag === 'read_full_file' ||
                    a.tag === 'show_symbol' ||
                    a.tag === 'peek_files' ||
                    a.tag === 'unpack_directory'
                );

                const transientTokens = Math.ceil(getTransientChars(loopTransientTurns) / 3.5);
                const turnProtectedFiles = Array.from(new Set([...activePhaseTargetFiles, ...turnJustAddedFiles]));
                const turnBudgetOpt = await this.enforceContextBudgetProtection(
                    currentContextPayload,
                    rawUserPromptText,
                    targetModel,
                    controller.signal,
                    history,
                    turnProtectedFiles,
                    assistantMessageId,
                    processId,
                    transientTokens
                );
                currentContextPayload = turnBudgetOpt.contextData;
                history = turnBudgetOpt.history;

                const contextExploded = !this._discussionCapabilities.ignoreContextSize &&
                    hasContextExpandingTools &&
                    (turnBudgetOpt.exploded || (turnBudgetOpt.cutFiles && turnBudgetOpt.cutFiles.length > 0));

                if (contextExploded && !isInsideMultiPhaseExecution && !requestedMultiPhaseSplit) {
                    // Rule 1.5: Context size exploded -> ask the coder to split work into phases (Librarian <plan> format)
                    requestedMultiPhaseSplit = true;
                    if (turnBudgetOpt.cutFiles) {
                        turnBudgetOpt.cutFiles.forEach(cf => cutByCompressionFiles.add(cf));
                    }

                    // Compact any huge tool outputs in batchUserMsg so the planning turn fits comfortably in budget (preserving tail where test summaries live)
                    if (typeof batchUserMsg.content === 'string' && batchUserMsg.content.length > 10000) {
                        batchUserMsg.content = batchUserMsg.content.substring(0, 2500) + '\n... [Middle tool output compacted to fit multi-phase planning budget] ...\n' + batchUserMsg.content.slice(-7500);
                    }

                    const requestedTargetsList = Array.from(new Set([...turnJustAddedFiles, ...(turnBudgetOpt.cutFiles || [])]));
                    if (typeof batchUserMsg.content === 'string') {
                        batchUserMsg.content += `\n\n### ⚠️ CONTEXT SIZE EXCEEDED — SPLIT WORK INTO PHASES (MANDATORY)
The requested context/tool operations pushed the total context size to ~${turnBudgetOpt.initialTotalTokens.toLocaleString()} tokens (exceeding the safe threshold of ~${turnBudgetOpt.triggerBudget.toLocaleString()} / ${turnBudgetOpt.maxTokens.toLocaleString()} tokens).
To prevent infinite pruning/unmuting loops, **split your work into sequential phases** using the exact \`<plan>\` format below.

**MANDATORY NEXT RESPONSE FORMAT:**
Output **ONLY** a \`<plan>\` block (do NOT emit \`<unmute_files>\`, \`<add_files_to_context>\`, or \`<file>\` tags in this planning response):
\`\`\`xml
<plan>
    <findings>
        Briefly summarize what is known so far and why the work is divided into these phases.
    </findings>
    <phase id="1">
        <instruction>Exact tasks and edits to perform in Phase 1</instruction>
        <files_list>
            path/to/phase1_file1.ext
            path/to/phase1_file2.ext
        </files_list>
    </phase>
    <phase id="2">
        <instruction>Exact tasks and edits to perform in Phase 2</instruction>
        <files_list>
            path/to/phase2_file1.ext
        </files_list>
    </phase>
</plan>
\`\`\`
Keep each phase focused on a small subset (1–3 files${requestedTargetsList.length > 0 ? ` from: ${requestedTargetsList.map(f => `\`${f}\``).join(', ')}` : ''}) so every phase fits comfortably inside the ~${turnBudgetOpt.triggerBudget.toLocaleString()} token budget.`;
                    }
                } else {
                    if (turnBudgetOpt.cutFiles && turnBudgetOpt.cutFiles.length > 0) {
                        turnBudgetOpt.cutFiles.forEach(cf => cutByCompressionFiles.add(cf));
                        if (typeof batchUserMsg.content === 'string') {
                            batchUserMsg.content += `\n\n> ⚠️ **Context Budget Notice**: To fit the model's context window, the Context Manager compacted/muted: ${turnBudgetOpt.cutFiles.map(f => `\`${f}\``).join(', ')}.\n> **Work in Phases**: Do NOT re-request all cut files at once. Complete your edits/analysis on the currently loaded [C] subset first, call \`<mute_files>\` on finished files before loading the next subset, or use \`<show_symbol>\` / \`<peek_files>\` for targeted lookups.`;
                        }
                    }

                    if (consecutiveCompressionLoopCount >= 2 || (isDuplicateRepetition && !anySuccess)) {
                        forceFinalAnswerNoTools = true;
                        if (typeof batchUserMsg.content === 'string') {
                            batchUserMsg.content += `\n\n### 🛑 CONTEXT LOOP PROTECTION ENGAGED\nAuto Mode tool execution is paused for your next response to prevent an infinite context-activation loop.\nRespond directly NOW using your currently loaded files: deliver the \`<file>\` edits for this phase, summarize what remains for the next phase, or emit a \`<user_instruction>\` block telling the user what to run or verify.`;
                        }
                    }
                }

                loopMessages = ensureStrictAlternatingRoles([
                    ...buildLoopMessages(currentContextPayload, false),
                    ...loopTransientTurns
                ]);

                await runTurn(isInsideMultiPhaseExecution);
            } else if (requiresEndTagCap && !turnEndTagged && !forceFinalAnswerNoTools) {
                const canAutoExecCode = this._discussionCapabilities.allowCodeExecution === true && this._discussionCapabilities.autoExecuteCode === true;
                const toolExamples = canAutoExecCode
                    ? '(<execute_code>, <unmute_files>, <load_structure>, etc.)'
                    : '(<unmute_files>, <load_structure>, <show_symbol>, etc.)';
                loopMessages.push({ role: 'assistant', content: stripThinkingTags(turnResponse).trim() });
                const roundsRemainingEndTag = Math.max(0, maxTurnsLimit - currentTurnIndex);
                const endTagBudgetWarning = roundsRemainingEndTag === 1
                    ? `\n🛑 **LAST AUTO-MODE ROUND (1/${maxTurnsLimit} remaining)**: This is your FINAL automatic turn. Deliver your final report, clean up any temporary files, and end with \`</end>\` (or ask the user for more rounds).`
                    : (roundsRemainingEndTag <= 3
                        ? `\n⚠️ **APPROACHING ROUND LIMIT (${roundsRemainingEndTag}/${maxTurnsLimit} remaining)**: Prepare to wrap up, clean up temporary files, and end with \`</end>\` or ask the user for more rounds.`
                        : `\n🔄 **Auto-Mode Round Budget**: ${roundsRemainingEndTag} of ${maxTurnsLimit} round(s) remaining.`);
                loopMessages.push({
                    role: 'user',
                    content: `${turnPatchReport ? `${turnPatchReport}\n` : ''}### ⏳ CONTINUATION REQUIRED — EXPLICIT END TAG MISSING
"Require Explicit End Tag" is enabled and your response did not contain the completion marker.${endTagBudgetWarning}
- If work remains, continue IMMEDIATELY: use tool tags ${toolExamples} or \`<file path="..." action="write|patch|update_symbol">\` mutation tags.
- Do NOT wait for the user to say "continue".
- When the task is fully complete, end your final response with the tag \`</end>\` (or \`</done>\`).

Respond immediately.`
                });
                loopMessages = ensureStrictAlternatingRoles(loopMessages);
                await runTurn(isInsideMultiPhaseExecution);
                return;
            } else {
                // Stop Cause 3: No pending tool call / no further continuation required when requireExplicitEndTag is off -> stop cleanly
                roundEntry.notes.push(roundEntry.appliedCount > 0 ? 'Final changes applied' : 'Final response delivered');
                this.log(`[Auto Mode] Stopping cleanly (discoveredActions=${discoveredActions.length}, turnHasFileUpdates=${turnHasFileUpdates}, requireExplicitEndTag=${requiresEndTagCap}).`, 'INFO');
                await finalizeAndSaveTurn(currentFullResponseBuffer);
            }
        };

        const emitMultiTurnSummaryIfNeeded = async () => {
            if (multiTurnSummaryEmitted || roundSummaries.length <= 1 || controller?.signal.aborted) {
                return;
            }
            multiTurnSummaryEmitted = true;

            const totalApplied = roundSummaries.reduce((acc, r) => acc + r.appliedCount, 0);
            const totalScouting = roundSummaries.reduce((acc, r) => acc + r.scoutingActions.length, 0);
            const totalFailed = roundSummaries.reduce((acc, r) => acc + r.patchesFailed.length, 0);

            const roundSections = roundSummaries.map(r => {
                const badges: string[] = [];
                if (r.patchesApplied.length > 0) badges.push(`📝 ${r.patchesApplied.length} file(s) patched`);
                if (r.patchesFailed.length > 0) badges.push(`❌ ${r.patchesFailed.length} patch(es) failed`);
                if (r.blockedFiles.length > 0) badges.push(`🛡️ ${r.blockedFiles.length} blocked`);
                if (r.scoutingActions.length > 0) badges.push(`🔍 ${r.scoutingActions.length} scouting/tool action(s)`);
                if (badges.length === 0 && r.notes.length > 0) badges.push(r.notes[0]);

                const lines: string[] = [];
                lines.push(`#### Round ${r.round}${badges.length > 0 ? ` — ${badges.join(' · ')}` : ''}`);

                if (r.patchesApplied.length > 0) {
                    lines.push(`- **Applied Patches (${r.appliedCount} block(s))**: ${r.patchesApplied.map(p => `✅ \`${p.filePath}\``).join(', ')}`);
                }
                if (r.patchesFailed.length > 0) {
                    r.patchesFailed.forEach(fp => {
                        lines.push(`- ❌ **Patch Failed** (\`${fp.filePath}\`): ${fp.error}`);
                    });
                }
                if (r.blockedFiles.length > 0) {
                    lines.push(`- 🛡️ **Blocked Blind Patch**: ${r.blockedFiles.map(bf => `\`${bf}\``).join(', ')}`);
                }
                if (r.scoutingActions.length > 0) {
                    r.scoutingActions.forEach(act => {
                        const icon = act.success ? '✅' : '❌';
                        const detailText = act.detail ? `: \`${act.detail.replace(/`/g, "'")}\`` : '';
                        lines.push(`- ${icon} **Scouting / Action** (\`${act.tag}\`)${detailText}`);
                    });
                }
                if (r.notes.length > 0 && (r.patchesApplied.length > 0 || r.scoutingActions.length > 0)) {
                    lines.push(`- *Outcome*: ${r.notes.join('; ')}`);
                } else if (r.notes.length > 0 && badges.length === 0) {
                    lines.push(`- ${r.notes.join('; ')}`);
                }
                return lines.join('\n');
            }).join('\n\n');

            const statsSummary = [
                `**${roundSummaries.length} Rounds**`,
                `${totalApplied} Patch${totalApplied === 1 ? '' : 'es'} Applied`,
                `${totalScouting} Scouting/Tool Action${totalScouting === 1 ? '' : 's'}`,
                totalFailed > 0 ? `${totalFailed} Failed` : ''
            ].filter(Boolean).join(' · ');

            const summaryBody = `> 👁️ **User-Only Multi-Turn Summary** *(This block is displayed only for you and is excluded from AI prompts)*\n\n${roundSections}`;

            const summaryCardContent = `<details open class="processing-block"><summary><i class="codicon codicon-layers"></i> Multi-Turn Execution Summary (${statsSummary})</summary><div class="processing-body">\n\n${summaryBody}\n\n</div></details>

`;

            await this.addMessageToDiscussion({
                id: 'multi_turn_summary_' + Date.now(),
                role: 'system',
                skipInPrompt: true,
                personalityName: '📊 Multi-Turn Summary (User Only)',
                content: summaryCardContent,
                timestamp: Date.now()
            });
        };

        await runTurn();

        if (!this._isDisposed && this._panel.webview) {
            this._panel.webview.postMessage({ command: 'collapseLibrarianMessages' });
        }

        if (this._currentDiscussion && !this._currentDiscussion.id.startsWith('temp-')) {
            await this._discussionManager.saveDiscussion(this._currentDiscussion);
        }

        await this.processKnowledgeUpdates(currentFullResponseBuffer);
        await this.processStructureTags(currentFullResponseBuffer);
        if (this._discussionCapabilities.projectMemoryEnabled !== false && !controller?.signal.aborted) {
            await this.processProjectMemoryTags(currentFullResponseBuffer);
        }
        if (!controller?.signal.aborted) {
            await this.processMissionBriefingTags(currentFullResponseBuffer);
        }

        const normalizedBuffer = normalizePseudoFileBlocks(currentFullResponseBuffer);
        const hasCodeBlocks = normalizedBuffer.includes('<file') || normalizedBuffer.includes('<<<<<<< SEARCH');

        // End-of-Generation Context Verification Check
        if (!formDetectedInTurn && hasCodeBlocks && !controller?.signal.aborted) {
            const verification = await this.verifyGeneratedPatchContext(normalizedBuffer);
            if (!verification.valid) {
                const unpossessedList = verification.unpossessedFiles.join(', ');
                this.log(`[End-of-Generation Verifier] Coder attempted to modify existing unseen files: [${unpossessedList}]`, 'WARN');
                await this.handleContextVerifierFailure(verification.unpossessedFiles, isFastMode, controller.signal, processId);
                patchesAppliedInLoop = true;
                await emitMultiTurnSummaryIfNeeded();
                return;
            }

            const hasDeleteFilesInBuffer = this._discussionCapabilities.fileDelete !== false &&
                /(?:^[ \t]*|(?<=>)[ \t]*)<(?:delete_files|delete_file)\b/im.test(normalizedBuffer);
            if (this._discussionCapabilities.autoApply && processId && !patchesAppliedInLoop && !hasDeleteFilesInBuffer) {
                const postPipeRes = await this.executeAutomationPipeline(normalizedBuffer, assistantMessageId, controller.signal, processId);
                const lastRound = roundSummaries[roundSummaries.length - 1];
                if (lastRound && postPipeRes) {
                    lastRound.appliedCount += postPipeRes.appliedCount;
                    postPipeRes.modifiedFiles.forEach(fp => lastRound.patchesApplied.push({ filePath: fp }));
                    postPipeRes.failedPatches.forEach(fp => lastRound.patchesFailed.push(fp));
                }
            }
        }

        if (!this._activeMultiPartPlan) {
            await emitMultiTurnSummaryIfNeeded();
        }

        // ── CONCATENATE ALL STEPS INTO A SINGLE UNIFIED MESSAGE ──
        if (!formDetectedInTurn && !userInteractionDemandedInTurn && !endedByTagInTurn && this._activeMultiPartPlan && Array.isArray(this._activeMultiPartPlan.parts) && !controller?.signal.aborted) {
            const totalParts = this._activeMultiPartPlan.totalParts || this._activeMultiPartPlan.parts.length;
            while (this._activeMultiPartPlan.currentPartIndex + 1 < totalParts && !controller?.signal.aborted) {
                const currentIdx = this._activeMultiPartPlan.currentPartIndex;
                const nextPartIdx = currentIdx + 1;
                this._activeMultiPartPlan.currentPartIndex = nextPartIdx;

                const prevPhase = this._activeMultiPartPlan.parts[currentIdx];
                const nextPhase = this._activeMultiPartPlan.parts[nextPartIdx];

                this.log(`[MultiSteps_TASK] Concatenating Phase ${nextPartIdx + 1}/${totalParts} into message ${assistantMessageId}...`);

                // 1. Next Phase Files Selection (Load without unloading prior phase files)
                if (nextPhase?.editFiles?.length) {
                    await this.unmuteFiles(nextPhase.editFiles);
                    await this.addFilesToDiscussionContext(nextPhase.editFiles);
                    this.recordCurrentPromptFiles(nextPhase.editFiles);
                }

                // 2. Second round of Librarian evaluation & scouting for Phase N in non-fast mode
                let phaseFindings = nextPhase.partInstruction || `Implement modifications for Phase ${nextPartIdx + 1}.`;

                if (!isFastMode) {
                    this.processManager.updateDescription(processId, `📚 Librarian: Scouting codebase for Phase ${nextPartIdx + 1} of ${totalParts}...`);
                    this.updateGeneratingState();

                    const phaseQuery = `Phase ${nextPartIdx + 1} of ${totalParts}:
Target files: [${(nextPhase.editFiles || []).join(', ')}]
Objective: ${nextPhase.partInstruction || rawUserPromptText}`;

                    const bufferBeforeScout = currentFullResponseBuffer;
                    const phaseScoutLiveHtml = `\n\n---\n### 🐾 Phase ${nextPartIdx + 1} of ${totalParts}\n\n<div class="waiting-animation" style="display:flex; align-items:center; gap:8px; opacity:0.85; padding:6px 0;"><div class="spinner"></div> <span>Inspecting Phase ${nextPartIdx + 1} dependencies &amp; contracts...</span></div>`;

                    await this.updateMessageContent(assistantMessageId, bufferBeforeScout + phaseScoutLiveHtml, false);

                    try {
                        const phaseLibRes = await ContextLibrarian.filterFilesByPrompt({
                            lollmsAPI: this._lollmsAPI,
                            contextManager: this._contextManager,
                            discussionManager: this._discussionManager,
                            currentDiscussion: this._currentDiscussion!,
                            targetModel,
                            prompt: phaseQuery,
                            userPrompt: rawUserPromptText,
                            history: history,
                            signal: controller.signal,
                            currentMutedFiles: this._currentDiscussion?.mutedFiles || [],
                            projectMemoryManager: this.projectMemoryManager,
                            ignoreContextSize: this._discussionCapabilities.ignoreContextSize === true,
                            onStatusUpdate: (st) => {
                                this.processManager.updateDescription(processId, `Phase ${nextPartIdx + 1}/${totalParts}: ${st}`);
                                this.updateGeneratingState();
                            }
                        });

                        if (phaseLibRes.keptFiles?.length) {
                            await this.unmuteFiles(phaseLibRes.keptFiles);
                            await this.addFilesToDiscussionContext(phaseLibRes.keptFiles);
                            this.recordCurrentPromptFiles(phaseLibRes.keptFiles);
                        }

                        const cleanPhaseFindings = (phaseLibRes.advice || phaseLibRes.rationale || nextPhase.partInstruction || '').trim();
                        const phaseSigs = phaseLibRes.signatures ? `\n### 📋 Reference Contracts & Signatures\n${phaseLibRes.signatures}\n\n` : '';
                        const targetFilesList = phaseLibRes.keptFiles.length > 0 ? phaseLibRes.keptFiles : (nextPhase.editFiles || []);
                        const phaseTargets = `### 📂 Target Files [C]\n${targetFilesList.map((f: string) => '- `' + f + '`').join('\n')}\n\n`;

                        phaseFindings = `### 🏛️ Architecture Findings (Phase ${nextPartIdx + 1} of ${totalParts})
${cleanPhaseFindings}

${phaseSigs}${phaseTargets}> 🎯 **Instructions for Implementation**:
> ${nextPhase.partInstruction || 'Implement the required modifications for this phase.'}`;
                    } catch (phaseLibErr: any) {
                        this.log(`Phase ${nextPartIdx + 1} Librarian scouting error: ${phaseLibErr.message}`, 'WARN');
                    }
                }

                // 3. Replace the live scouting block with the compressed Phase findings card
                const phaseCardHtml = `\n\n---\n### 🐾 Phase ${nextPartIdx + 1} of ${totalParts}
<details open class="processing-block librarian-compressed-directive" style="border-left: 3px solid var(--vscode-charts-orange); background: rgba(214, 122, 13, 0.08); margin: 8px 0 12px 0; border-radius: 6px;">
<summary style="color: var(--vscode-charts-orange); font-weight: bold; cursor: pointer; padding: 6px 10px; display: flex; align-items: center; gap: 6px;">
    <i class="codicon codicon-library"></i> <span>Librarian Directive (Phase ${nextPartIdx + 1} Findings &amp; Instructions)</span>
</summary>
<div class="processing-body markdown-body" style="padding: 6px 14px 10px 14px; font-size: 11.5px; line-height: 1.5; white-space: normal; min-height: 90px; max-height: 500px; overflow-y: auto;">${phaseFindings.trim()}</div>
</details>\n\n`;

                currentFullResponseBuffer += phaseCardHtml;
                fullResponse = currentFullResponseBuffer;
                await this.updateMessageContent(assistantMessageId, currentFullResponseBuffer, false);
                this._panel.webview.postMessage({
                    command: 'syncStreamBuffer',
                    id: assistantMessageId,
                    buffer: currentFullResponseBuffer
                });

                // 4. Stream Coder implementation for this phase into the SAME message
                currentContextPayload = await this._contextManager.getContextContent({
                    importedSkillIds: importedIds,
                    includeTree: true,
                    leanMode: false,
                    discussionId: this.discussionId,
                    mutedFiles: this._currentDiscussion?.mutedFiles || [],
                    includedFiles: (this._currentDiscussion as any)?.includedFiles,
                    modelName: targetModel,
                    signal: controller.signal,
                    capabilities: this._discussionCapabilities
                });

                this.processManager.updateDescription(processId, `Phase ${nextPartIdx + 1} of ${totalParts}: Implementing code...`);
                this.updateGeneratingState();

                const targetFilesJoined = (nextPhase.editFiles || []).map((f: string) => '`' + f + '`').join(', ');
                const stepUserPrompt: ChatMessage = {
                    role: 'user',
                    content: `### 🐾 Phase ${nextPartIdx + 1} of ${totalParts} Implementation\nFollow the Lead Librarian's instructions for this phase:\n${phaseFindings}\n\nTarget files: ${targetFilesJoined}\nOutput the code modifications inside \`<file path="..." action="write|patch|update_symbol">\` tags.`
                };

                const phaseMessages = buildLoopMessages(currentContextPayload, false);
                phaseMessages.push({ role: 'assistant', content: stripThinkingTags(currentFullResponseBuffer).trim() });
                phaseMessages.push(stepUserPrompt);
                const strictPhaseMsgs = ensureStrictAlternatingRoles(phaseMessages);

                let phaseResponse = "";
                let phaseEndedByTag = false;
                const phaseStreamCtrl = new AbortController();
                const onPhaseParentAbort = () => phaseStreamCtrl.abort();
                if (controller.signal.aborted) {
                    phaseStreamCtrl.abort();
                } else {
                    controller.signal.addEventListener('abort', onPhaseParentAbort, { once: true });
                }

                try {
                    await this._lollmsAPI.sendChat(
                        strictPhaseMsgs,
                        (chunk) => {
                            if (controller?.signal.aborted || phaseStreamCtrl.signal.aborted) return;
                            const prevLen = phaseResponse.length;
                            phaseResponse += chunk;
                            if (chunk.includes('>')) {
                                const endMatch = findExplicitEndTag(phaseResponse);
                                if (endMatch) {
                                    phaseEndedByTag = true;
                                    const accepted = phaseResponse.slice(prevLen, endMatch.endIndex);
                                    phaseResponse = phaseResponse.slice(0, endMatch.endIndex);
                                    if (accepted) {
                                        currentFullResponseBuffer += accepted;
                                        fullResponse = currentFullResponseBuffer;
                                        this._panel.webview.postMessage({
                                            command: 'appendMessageChunk',
                                            id: assistantMessageId,
                                            chunk: accepted
                                        });
                                    }
                                    phaseStreamCtrl.abort();
                                    return;
                                }
                            }
                            currentFullResponseBuffer += chunk;
                            fullResponse = currentFullResponseBuffer;
                            this._panel.webview.postMessage({
                                command: 'appendMessageChunk',
                                id: assistantMessageId,
                                chunk
                            });
                        },
                        phaseStreamCtrl.signal,
                        targetModel,
                        {
                            capabilities: this._discussionCapabilities,
                            temperature: this._discussionCapabilities.enableTemperature ? this._discussionCapabilities.temperature : undefined,
                            maxTokens: this._discussionCapabilities.enableMaxTokens ? this._discussionCapabilities.maxTokens : undefined
                        }
                    );
                } catch (stepErr: any) {
                    if (phaseEndedByTag && !controller?.signal.aborted) {
                        this.log(`Multi-step part ${nextPartIdx + 1} stopped immediately on explicit end tag.`, 'INFO');
                    } else if (stepErr.name !== 'AbortError') {
                        this.log(`Multi-step part ${nextPartIdx + 1} error: ${stepErr.message}`, 'WARN');
                        break;
                    } else {
                        break;
                    }
                } finally {
                    controller.signal.removeEventListener('abort', onPhaseParentAbort);
                }

                if (phaseEndedByTag || detectInteractiveForm(phaseResponse) || detectUserInteractionDemand(phaseResponse, { allowDeleteFiles: this._discussionCapabilities.fileDelete !== false }).demanded) {
                    break;
                }
            }

            this._activeMultiPartPlan = undefined;
            const cleanFinal = stripThinkingTags(currentFullResponseBuffer).trim();
            await this.updateMessageContent(assistantMessageId, cleanFinal);
            if (!this._isDisposed && this._panel.webview) {
                this._panel.webview.postMessage({
                    command: 'finalizeMessage',
                    id: assistantMessageId,
                    fullContent: currentFullResponseBuffer
                });
            }
            await emitMultiTurnSummaryIfNeeded();
        }

        this.processManager.unregister(processId);
        this.updateGeneratingState();
        await this.commitDiscussionFilesToGlobal();
        this.updateContextAndTokens({ isBackgroundSync: false });

        if (!controller?.signal.aborted && (Date.now() - generationStartTime) >= 5000) {
            const discTitle = this._currentDiscussion?.title || 'Discussion';
            vscode.window.showInformationMessage(
                `✅ Lollms: Generation complete for "${discTitle}".`,
                'Focus Chat'
            ).then(choice => {
                if (choice === 'Focus Chat' && !this._isDisposed) {
                    this._panel.reveal();
                }
            });
        }

    } catch (error: any) { 
        ChatPanel.activeGenerations.delete(this.discussionId);

        if (controller?.signal.aborted || error.name === 'AbortError' || error.message === 'AbortError' || error.message === 'Operation cancelled') {
            const accumulated = fullResponse.trim() ? fullResponse : currentFullResponseBuffer;
            if (accumulated.trim()) {
                // Auto-close any unclosed tags, Aider hunks, and markdown code fences so Apply All / Execute All render cleanly
                const closedResponse = this.repairAndNormalizeRoundOutput(accumulated).repaired.trimEnd();

                const stoppedText = closedResponse + "\n\n*(Generation stopped by user)*";
                const targetMsgId = assistantMessageId || ('assistant_' + Date.now());

                const existingIdx = this._currentDiscussion?.messages.findIndex(m => m.id === targetMsgId) ?? -1;
                if (existingIdx !== -1 && this._currentDiscussion) {
                    this._currentDiscussion.messages[existingIdx] = {
                        ...this._currentDiscussion.messages[existingIdx],
                        content: stoppedText
                    };
                    if (this._currentDiscussion.llmHistory) {
                        const llmIdx = this._currentDiscussion.llmHistory.findIndex(m => m.id === targetMsgId);
                        if (llmIdx !== -1) {
                            this._currentDiscussion.llmHistory[llmIdx].content = stoppedText;
                        }
                    }
                    if (!this._currentDiscussion.id.startsWith('temp-')) {
                        await this._discussionManager.saveDiscussion(this._currentDiscussion);
                    }
                } else {
                    await this.addMessageToDiscussion({ 
                        id: targetMsgId, 
                        role: 'assistant', 
                        content: stoppedText, 
                        model: targetModel,
                        personalityName: personaName,
                        timestamp: Date.now()
                    }, false);
                }

                if (!this._isDisposed && this._panel.webview) {
                    this._panel.webview.postMessage({ 
                        command: 'finalizeMessage', 
                        id: targetMsgId, 
                        fullContent: stoppedText,
                        personalityName: personaName
                    });
                    this._panel.webview.postMessage({ command: 'collapseLibrarianMessages' });
                }
            } else {
                await this.loadDiscussion();
            }
        } else {
            const errorDetails = error?.stack || error?.message || String(error);
            this.log(`Message delivery failed: ${error.message}\nStack: ${errorDetails}`, 'ERROR');
            Logger.error(`Message delivery failed: ${error.message}`, error);

            const stackBlock = error?.stack ? `\n\n<details class="processing-block"><summary><i class="codicon codicon-bug"></i> Diagnostic Details (Stack Trace)</summary><div class="processing-body"><pre style="margin:0; padding:8px; font-family:var(--vscode-editor-font-family); font-size:10.5px; white-space:pre-wrap;">${error.stack}</pre></div></details>` : '';

            const isConnectionRefused = error?.code === 'ECONNREFUSED' || error?.message?.includes('ECONNREFUSED');
            const errorTitle = isConnectionRefused ? '🔌 Connection Error' : '⚠️ Execution Error';

            const errorMessage = `### ${errorTitle}
${isConnectionRefused ? `Lollms could not complete the request to \`${(this._lollmsAPI as any).config.apiUrl}\`.` : `An error occurred while preparing or executing the request.`}

**Reason:** ${error.message}${stackBlock}

*${isConnectionRefused ? 'Please check if your server is running and try again.' : 'Check the diagnostic details above or check if your model is configured.'}*`;

            // CRITICAL: Do NOT overwrite the current assistant message!
            // If the current assistant message has content (e.g. librarian findings/plan or partial text), finalize and preserve it.
            if (assistantMessageId) {
                const targetMsg = this._currentDiscussion?.messages.find(m => m.id === assistantMessageId);
                const hasContent = targetMsg && typeof targetMsg.content === 'string' && targetMsg.content.trim().length > 0;
                if (hasContent) {
                    await this.updateMessageContent(assistantMessageId, targetMsg.content, true);
                    if (!this._isDisposed && this._panel.webview) {
                        this._panel.webview.postMessage({
                            command: 'finalizeMessage',
                            id: assistantMessageId,
                            fullContent: targetMsg.content
                        });
                    }
                } else {
                    // Remove empty assistant placeholder from discussion and webview so it doesn't linger
                    const idx = this._currentDiscussion?.messages.findIndex(m => m.id === assistantMessageId) ?? -1;
                    if (idx !== -1) {
                        this._currentDiscussion!.messages.splice(idx, 1);
                    }
                    if (!this._isDisposed && this._panel.webview) {
                        this._panel.webview.postMessage({ command: 'removeMessage', messageId: assistantMessageId });
                    }
                }
            }

            // Always add the error in a separate system message
            await this.addMessageToDiscussion({ 
                id: 'error_' + Date.now(),
                role: 'system', 
                content: errorMessage,
                timestamp: Date.now()
            });
        }
    } finally { 
        ChatPanel.activeGenerations.delete(this.discussionId); 
        
        this._activeGenerationListener = undefined;
        this._activeGenerationCompleteListener = undefined;

        if (processId) {
            this.processManager.unregister(processId); 
        }
        
        if (!this._isDisposed && this._panel.webview) {
            this._panel.webview.postMessage({
                command: 'updateGenerationMetrics',
                tps: "0.0",
                count: 0,
                reset: true
            });
            this._panel.webview.postMessage({ command: 'collapseLibrarianMessages' });
        }

        this.commitDiscussionFilesToGlobal().catch(() => {});
        this.updateGeneratingState(); 
        this.updateContextAndTokens(); 
    }
  }

  private async handleAutomatedSearch(query: string, messageId: string) {
      this.log(`Automated search triggered: ${query}`);
      const searchTool = this.agentManager.getTools().find(t => t.name === 'search_web');
      if (searchTool && !this._isDisposed) {
          this._panel.webview.postMessage({ command: 'finalizeMessage', id: messageId, fullContent: `*Thinking... Need more info. Pausing to search the web for: "${query}"...*` });

          try {
            const result = await searchTool.execute({ query }, { 
                lollmsApi: this._lollmsAPI, contextManager: this._contextManager, currentPlan: null 
            }, new AbortController().signal);

            const resultMsg: ChatMessage = { 
                role: 'system', 
                content: `**AUTOMATED SEARCH RESULTS:**\n\n${result.output}\n\n*Results injected. Please proceed with the user's objective using this information.*` 
            };
            await this.addMessageToDiscussion(resultMsg);

            this.sendMessage({ role: 'system', content: "Continue your response based on the search results provided above." } as any);
          } catch (e: any) {
              this.addMessageToDiscussion({ role: 'system', content: `Search failed: ${e.message}` });
          }
      }
  }

  public async handleInspectCode(args: { code: string, language: string }) {
      const config = vscode.workspace.getConfiguration('lollmsVsCoder');
      const model = config.get<string>('inspectorModelName') || this._currentDiscussion?.model || this._lollmsAPI.getModelName();
      const systemPrompt = await getProcessedSystemPrompt('inspector');
      const userPrompt = `Review the following ${args.language} code for bugs, security vulnerabilities, and logic errors. Provide a detailed report.\n\n\`\`\`${args.language}\n${args.code}\n\`\`\`\n\n`;

      await this.sendIsolatedMessage(systemPrompt, userPrompt, model);
  }

  public async sendIsolatedMessage(systemPrompt: string, userPrompt: string, model: string) {
      await this.waitForWebviewReady();
      if (this._isDisposed) return;
      const { id: processId, controller } = this.processManager.register(this.discussionId, 'Running isolated task...');
      this.updateGeneratingState();
      const assistantMessageId = 'assistant_' + Date.now() + Math.random().toString(36).substring(2);
      this._panel.webview.postMessage({
          command: 'addMessage',
          message: { id: assistantMessageId, role: 'assistant', content: '', startTime: Date.now(), model: model }
      });
      try {
          const messages: ChatMessage[] = [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
          ];
          let fullResponse = '';
          await this._lollmsAPI.sendChat(messages, (chunk) => {
              fullResponse += chunk;
              if (!this._isDisposed) this._panel.webview.postMessage({ command: 'appendMessageChunk', id: assistantMessageId, chunk: chunk });
          }, controller.signal, model);
          if (!this._isDisposed) this._panel.webview.postMessage({ command: 'finalizeMessage', id: assistantMessageId, fullContent: fullResponse });
      } catch (error: any) {
          if (!this._isDisposed) this._panel.webview.postMessage({ command: 'error', content: error.message });
      } finally {
          this.processManager.unregister(processId);
          this.updateGeneratingState();
      }
  }

  private async handleInspectPatch(msg: any) {
      const { messageId, blockIndex, filePath, content, type, isApplied } = msg;
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
          vscode.window.showErrorMessage("No workspace folder found.");
          return;
      }

      // 1. Resolve Dependencies via Graph
      const graph = (this.agentManager as any).codeGraphManager;
      if (graph.getBuildState() !== 'ready') {
          await graph.buildGraph();
      }

      const targetNode = graph.getGraphData().nodes.find(n => n.filePath === filePath);
      let dependencyContent = "";
      if (targetNode) {
          const depFiles = graph.getGraphData().edges
              .filter(e => e.source === targetNode.id && e.label === 'imports')
              .map(e => graph.getGraphData().nodes.find(n => n.id === e.target)?.filePath)
              .filter((path): path is string => !!path);

          if (depFiles.length > 0) {
              dependencyContent = await this._contextManager.readSpecificFiles(depFiles);
              this.log(`Inspector: Including ${depFiles.length} dependencies for grounding.`);
          }
      }

      const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
      let currentContent = "";
      try {
          const doc = await vscode.workspace.openTextDocument(fileUri);
          currentContent = doc.getText();
      } catch (e) {
          vscode.window.showErrorMessage(`File not found: ${filePath}`);
          return;
      }

      let targetContent = currentContent;

      if (!isApplied) {
          // Apply in memory
          if (type === 'replace' || content.includes('<<<<<<< SEARCH')) {
              const normalizedContent = normalizeAiderContent(content);
              const hunks = parseAiderHunks(normalizedContent);
              if (hunks.length > 0) {
                  let tempContent = currentContent;
                  for (const hunk of hunks) {
                      const result = applySearchReplace(tempContent, hunk.searchPart, hunk.replacePart);
                      if (result.success) {
                          tempContent = result.result;
                      } else {
                          vscode.window.showErrorMessage(`Patch application failed: ${result.error}. Cannot inspect.`);
                          return;
                      }
                  }
                  targetContent = tempContent;
              }
          } else if (type === 'file') {
              targetContent = content;
          } else if (type === 'diff') {
              const result = applyDiffToString(currentContent, content);
              if (result.success) {
                  targetContent = result.result;
              } else {
                  vscode.window.showErrorMessage(`Diff application failed: ${result.error}. Cannot inspect.`);
                  return;
              }
          }
      }

      // If we are inspecting a specific hunk, construct a focused audit prompt
      const hunkPrompt = type === 'replace' ? `
We are inspecting a SPECIFIC AIDER HUNK proposed for this file.
Verify that:
1. All variables used inside this hunk are defined in either the hunk context, the file, or its imports.
2. All functions or modules called inside this hunk are correctly imported or declared.
3. If any imports are missing or variables are undefined, generate the Aider patch to add the imports or fix the variables.
` : `
Please perform a deep structural audit of the code for \`${filePath}\`. 
Check specifically for:
1. **Indentation errors**: Mixed whitespace or broken blocks.
2. **Missing imports**: Usage of external or local symbols without declarations.
3. **Logic holes**: Unfinished functions or placeholders.
4. **Integration**: Does this code align with the rest of the project context?
`;

      const prompt = `### 🔍 SURGICAL INSPECTION: ${filePath}
      ${hunkPrompt}

      **STRICT REQUIREMENT:**
      - Provide fixes using **AIDER SEARCH/REPLACE** blocks.
      - If the code is structurally sound, respond with "FILE VERIFIED CLEAN".

Original block type: ${type === 'file' ? 'FULL FILE' : 'AIDER PATCH'}

Here is the code to inspect:
\`\`\`${path.extname(filePath).substring(1) || 'plaintext'}
${targetContent}
\`\`\`
`;

      const { id: processId, controller } = this.processManager.register(this.discussionId, `Inspecting ${filePath}...`);
      this.updateGeneratingState();

      try {
          const systemPrompt = await getProcessedSystemPrompt('surgical_agent');

          const inspectionMessageId = 'inspection_' + Date.now();
          await this.addMessageToDiscussion({
              id: inspectionMessageId,
              role: 'user',
              content: `Inspect File: \`${filePath}\``,
              skipInPrompt: true // Keep history clean
          });

          const assistantMessageId = 'assistant_insp_' + Date.now();
          this._panel.webview.postMessage({ 
              command: 'addMessage', 
              message: { 
                  id: assistantMessageId, 
                  role: 'assistant', 
                  content: '', 
                  startTime: Date.now(), 
                  model: this._currentDiscussion?.model,
                  personalityName: '🔍 Code Inspector',
                  timestamp: Date.now()
              } 
          });

          // 2. Perform Initial Run
          let fullResponse = "";
          const messages: ChatMessage[] = [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: `${prompt}\n\n### DEPENDENCY REFERENCE CONTEXT:\n${dependencyContent}` }
          ];

          await this._lollmsAPI.sendChat(messages, (chunk) => {
              fullResponse += chunk;
              this._panel.webview.postMessage({ command: 'appendMessageChunk', id: assistantMessageId, chunk });
          }, controller.signal);

          const processedResponse = await this.verifyAndProcessCodeBlocks(
              assistantMessageId, 
              fullResponse, 
              controller.signal
          );

          // 3. Handle Second Run (Keyword Escalation)
          // If the AI suggests it needs to search the whole project
          const searchMatch = processedResponse.match(/```json\s*(\{[\s\S]*?"tool"\s*:\s*"grep_search"[\s\S]*?\})\s*```/);
          if (searchMatch) {
              const toolCall = JSON.parse(searchMatch[1]);
              const keyword = toolCall.params.pattern;

              this.processManager.updateDescription(processId, `Inspector: Expanding search for "${keyword}"...`);
              this.updateGeneratingState();

              const searchResults = await this._contextManager.searchWorkspaceContent(keyword, { matchCase: false, wholeWord: false });
              const uniquePaths = Array.from(new Set(searchResults.map(r => r.path)));
              const expandedContext = await this._contextManager.readSpecificFiles(uniquePaths);

              // Perform the Second Run
              messages.push({ role: 'assistant', content: fullResponse });
              messages.push({ role: 'user', content: `### EXPANDED PROJECT CONTEXT (Keyword: "${keyword}")\n${expandedContext}\n\nNow provide your final inspection report based on this new data.` });

              let secondRunResponse = "";
              await this._lollmsAPI.sendChat(messages, (chunk) => {
                  secondRunResponse += chunk;
                  this._panel.webview.postMessage({ command: 'appendMessageChunk', id: assistantMessageId, chunk: chunk });
              }, controller.signal);

              fullResponse = secondRunResponse;
          }

          await this.addMessageToDiscussion({
              id: assistantMessageId,
              role: 'assistant',
              content: processedResponse,
              model: this._currentDiscussion?.model,
              personalityName: '🔍 Code Inspector',
              timestamp: Date.now()
          }, false);

          this._panel.webview.postMessage({ 
              command: 'finalizeMessage', 
              id: assistantMessageId, 
              fullContent: processedResponse,
              personalityName: '🔍 Code Inspector'
          });

          if (!isApplied && type === 'file') {
              const codeBlockRegex = /```(?:\w+)?[\r\n]+([\s\S]*?)[\r\n]+```/;
              const newCodeMatch = processedResponse.match(codeBlockRegex);
              if (newCodeMatch && newCodeMatch[1]) {
                  const currentDiscussion = this.getCurrentDiscussion();
                  if (currentDiscussion) {
                      const origMsg = currentDiscussion.messages.find(m => m.id === msg.messageId);
                      if (origMsg && typeof origMsg.content === 'string') {
                          const newContent = origMsg.content.replace(content, newCodeMatch[1].trim());
                          await this.updateMessageContent(msg.messageId, newContent);
                          vscode.window.showInformationMessage(`Original message block updated with fixed code.`);
                      }
                  }
              }
          }

      } catch (e: any) {
          vscode.window.showErrorMessage(`Inspection failed: ${e.message}`);
      } finally {
          this.processManager.unregister(processId);
          this.updateGeneratingState();
      }
  }

  /**
   * Discovers the project test runner and folders (e.g. pytest, npm test, cargo test).
   */
  private async detectTestCommand(folder: vscode.WorkspaceFolder): Promise<{ command: string; framework: string }> {
      // 1. Python detection: inspect test directories
      const testDirs = ['tests', 'test', 'src/tests', 'testing'];
      let foundTestDir: string | undefined;

      for (const d of testDirs) {
          try {
              const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, d));
              if (stat.type === vscode.FileType.Directory) {
                  foundTestDir = d;
                  break;
              }
          } catch {}
      }

      const hasPyFiles = (await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.py'), '**/node_modules/**', 1)).length > 0;
      const hasPyConfig = (await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '{pyproject.toml,setup.py,pytest.ini,setup.cfg,requirements.txt}'), '**/node_modules/**', 1)).length > 0;

      if (hasPyFiles || hasPyConfig || foundTestDir) {
          const target = foundTestDir ? foundTestDir : "";
          return {
              command: target ? `python -m pytest ${target} -v` : `python -m pytest -v`,
              framework: 'pytest'
          };
      }

      // 2. Node.js detection
      try {
          const pkgUri = vscode.Uri.joinPath(folder.uri, 'package.json');
          const pkgBytes = await vscode.workspace.fs.readFile(pkgUri);
          const pkg = JSON.parse(Buffer.from(pkgBytes).toString('utf8'));
          if (pkg.scripts && pkg.scripts.test && !pkg.scripts.test.includes('no test specified')) {
              return { command: 'npm test', framework: 'npm' };
          }
      } catch {}

      // 3. Rust detection
      try {
          await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, 'Cargo.toml'));
          return { command: 'cargo test', framework: 'cargo' };
      } catch {}

      // 4. Go detection
      try {
          await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, 'go.mod'));
          return { command: 'go test -v ./...', framework: 'go' };
      } catch {}

      // Default fallback
      return {
          command: foundTestDir ? `pytest ${foundTestDir}` : 'pytest',
          framework: 'pytest'
      };
  }

  /**
   * Upgrades the Librarian's findings in .lollms/structure.md and the discussion data zone.
   */
  public async upgradeLibrarianFindings(
      result: { governorReport?: string; advice?: string; rationale?: string; signatures?: string; keptFiles?: string[]; mutedFiles?: string[] },
      objective: string,
      analysis: string
  ): Promise<void> {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) return;

      try {
          // A. Upgrade .lollms/structure.md on disk (patching stale sections)
          const existingStructure = await ContextLibrarian.getStructureGuide();
          const cleanReport = (result.governorReport || result.signatures || "").trim();

          if (cleanReport.includes('<<<<<<< SEARCH')) {
              await ContextLibrarian.updateStructureGuide(cleanReport, 'patch');
          } else {
              const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
              const findingsHeader = `## 📝 Latest Verified Findings [${timestamp}]`;
              const findingsBlock = `${findingsHeader}\n**Task**: ${objective}\n\n**Analysis**:\n${analysis}\n\n${cleanReport ? `### Contracts & Signatures:\n${cleanReport}\n\n` : ''}`.trim();

              if (!existingStructure.trim()) {
                  await ContextLibrarian.saveStructureGuide(`# 🏛️ Codebase Architecture & Structure Guide\n\n${findingsBlock}`);
              } else {
                  // Purge older duplicate entries for the same objective to prevent stale stacking
                  const objSnippet = objective.substring(0, 35).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                  const existingObjRegex = new RegExp(`## 📝 Latest Verified Findings[\\s\\S]*?\\*\\*Task\\*\\*: [^\\n]*${objSnippet}[\\s\\S]*?(?=\\n## |$)`, 'i');

                  if (existingObjRegex.test(existingStructure)) {
                      const updated = existingStructure.replace(existingObjRegex, findingsBlock);
                      await ContextLibrarian.saveStructureGuide(updated);
                  } else {
                      await ContextLibrarian.saveStructureGuide(`${existingStructure.trim()}\n\n${findingsBlock}`);
                  }
              }
          }

          // Findings route strictly to Neural Memory. Clean out any legacy findings keys from discussion_data_zone.
          if (this._currentDiscussion && this._currentDiscussion.discussion_data_zone) {
              try {
                  const parsed = JSON.parse(this._currentDiscussion.discussion_data_zone);
                  let changed = false;
                  Object.keys(parsed).forEach(k => {
                      if (k.startsWith('librarian_findings_') || k.startsWith('findings_')) {
                          delete parsed[k];
                          changed = true;
                      }
                  });
                  if (changed) {
                      this._currentDiscussion.discussion_data_zone = Object.keys(parsed).length > 0 ? JSON.stringify(parsed, null, 2) : "";
                      if (!this._currentDiscussion.id.startsWith('temp-')) {
                          await this._discussionManager.saveDiscussion(this._currentDiscussion);
                      }
                  }
              } catch {}
          }
          this.log("Librarian findings recorded to memory and structure guide.");
      } catch (err: any) {
          this.log(`Failed to upgrade Librarian findings: ${err.message}`, 'WARN');
      }
  }

  /**
   * Immediately recalls the worker to act upon the freshly scouted files and findings.
   */
  public async recallWorkerAfterLibrarian(
      result: { keptFiles?: string[]; mutedFiles?: string[]; governorReport?: string },
      objective: string,
      analysis: string
  ): Promise<void> {
      if (this._isDisposed) return;

      await new Promise(r => setTimeout(r, 100));

      // Dispatch only the direct objective so the worker receives a clean prompt without librarian artifacts
      await this.sendMessage({
          id: 'user_direct_' + Date.now(),
          role: 'user',
          content: objective
      });
  }

  /**
   * Executes the project entry point, captures output/logs, and initiates a Run / View / Fix loop.
   * In Assistant mode, human validation is required at each coding step via diff review cards.
   */
  public async handleRunAndDebugLoop() {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
          vscode.window.showErrorMessage("Active workspace required to debug.");
          return;
      }

      // 1. Detect Entry Point or Launch Configuration
      let defaultCmd = "";
      try {
          const launchPath = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'launch.json');
          const bytes = await vscode.workspace.fs.readFile(launchPath);
          const launch = JSON.parse(Buffer.from(bytes).toString('utf8'));
          if (launch?.configurations?.[0]?.program) {
              const prog = vscode.workspace.asRelativePath(launch.configurations[0].program);
              const ext = path.extname(prog).toLowerCase();
              if (ext === '.py') defaultCmd = `python -u "${prog}"`;
              else if (ext === '.js') defaultCmd = `node "${prog}"`;
              else if (ext === '.ts') defaultCmd = `npx ts-node "${prog}"`;
          }
      } catch {}

      if (!defaultCmd) {
          const pyEntries = ['main.py', 'app.py', 'run.py', 'server.py'];
          for (const pe of pyEntries) {
              try {
                  const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(workspaceFolder.uri, pe));
                  if (stat.type === vscode.FileType.File) {
                      defaultCmd = `python -u "${pe}"`;
                      break;
                  }
              } catch {}
          }
      }

      if (!defaultCmd) {
          try {
              const pkgUri = vscode.Uri.joinPath(workspaceFolder.uri, 'package.json');
              const pkgBytes = await vscode.workspace.fs.readFile(pkgUri);
              const pkg = JSON.parse(Buffer.from(pkgBytes).toString('utf8'));
              if (pkg.scripts && (pkg.scripts.dev || pkg.scripts.start)) {
                  defaultCmd = pkg.scripts.dev ? 'npm run dev' : 'npm start';
              } else if (pkg.main) {
                  defaultCmd = `node "${pkg.main}"`;
              }
          } catch {}
      }

      if (!defaultCmd) {
          try {
              await vscode.workspace.fs.stat(vscode.Uri.joinPath(workspaceFolder.uri, 'Cargo.toml'));
              defaultCmd = 'cargo run';
          } catch {}
      }

      const folderKey = workspaceFolder.uri.toString();
      const wsState = this._discussionManager?.context?.workspaceState;
      const lastSavedDebugCmd = wsState?.get<string>(`lollms_last_debug_cmd_${folderKey}`)
          || wsState?.get<string>('lollms_last_debug_cmd')
          || (this._currentDiscussion as any)?.lastDebugCommand;

      let initialDebugCmd = (lastSavedDebugCmd && lastSavedDebugCmd.trim()) ? lastSavedDebugCmd.trim() : defaultCmd;
      if (!initialDebugCmd) {
          initialDebugCmd = 'python -u main.py';
      }

      const isFast = !(this._discussionCapabilities.useLibrarian === true && this._discussionCapabilities.contextGovernorEnabled !== false);
      const isAssistant = !this._discussionCapabilities.agentMode;

      const commandInput = await vscode.window.showInputBox({
          prompt: `Confirm command to run & debug for ${workspaceFolder.name} (${isAssistant ? 'Assistant Mode: Human validation required for each fix' : 'Autonomous Mode'}):`,
          value: initialDebugCmd,
          placeHolder: "e.g. python -u main.py, npm start, cargo run"
      });

      if (!commandInput || !commandInput.trim()) return;
      const finalCmd = commandInput.trim();

      // Persist the user's confirmed command so subsequent runs remember it
      try {
          await wsState?.update(`lollms_last_debug_cmd_${folderKey}`, finalCmd);
          await wsState?.update('lollms_last_debug_cmd', finalCmd);
          if (this._currentDiscussion) {
              (this._currentDiscussion as any).lastDebugCommand = finalCmd;
              if (!this._currentDiscussion.id.startsWith('temp-')) {
                  await this._discussionManager.saveDiscussion(this._currentDiscussion);
              }
          }
      } catch (err) {
          this.log(`Failed to save last debug command: ${err}`, 'WARN');
      }

      const { id: procId, controller } = this.processManager.register(this.discussionId, `Debugging: ${finalCmd}...`);
      this.updateGeneratingState();

      await this.addMessageToDiscussion({
          id: 'debug_run_launch_' + Date.now(),
          role: 'system',
          content: `🐞 **Debug Loop Initiated**
- **Command**: \`${finalCmd}\`
- **Mode**: ${isAssistant ? '👤 Assistant Mode (Human validation at each step)' : '🤖 Agent Mode (Autonomous)'}
- *Running project in background, capturing output and logs...*`,
          skipInPrompt: true
      });

      try {
          const { runCommandInTerminal } = require('../../extensionState');
          let res: { success: boolean; output: string };

          if (this.agentManager && !isAssistant) {
              res = await this.agentManager.runCommand(finalCmd, controller.signal, { timeoutMs: 180000 });
          } else {
              res = await runCommandInTerminal(finalCmd, workspaceFolder.uri.fsPath, "Debug Runner", controller.signal, { stealth: true, timeoutMs: 180000 });
          }

          const disc = this._currentDiscussion;
          const monitoredLogPaths = (disc?.capabilities as any)?.monitoredLogPaths || [];
          let extraLogs = "";
          for (const lp of monitoredLogPaths) {
              try {
                  const logUri = vscode.Uri.joinPath(workspaceFolder.uri, lp);
                  const logBytes = await vscode.workspace.fs.readFile(logUri);
                  const logText = Buffer.from(logBytes).toString('utf8');
                  if (logText.trim().length > 0) {
                      extraLogs += `\n\n--- MONITORED LOG: ${lp} ---\n${logText.substring(0, 3000)}`;
                  }
              } catch {}
          }

          const { stripAnsiCodes } = require('../../utils');
          const cleanOutput = stripAnsiCodes((res.output || "") + extraLogs).trim();

          const timestamp = new Date().toISOString();
          const logFileName = 'debug_run.log';
          const logUri = vscode.Uri.joinPath(workspaceFolder.uri, logFileName);
          const logReport = `======================================================================
DEBUG RUN LOG
Timestamp: ${timestamp}
Command: ${finalCmd}
Success: ${res.success}
OUTPUT:
${cleanOutput || '(No output recorded)'}
`;
          await vscode.workspace.fs.writeFile(logUri, Buffer.from(logReport, 'utf8'));

          // Add debug_run.log to context
          await this._contextManager.getContextStateProvider()?.addFilesToContext([logFileName]);
          this._contextManager.recordRecentlyAddedFiles([logFileName]);
          this.recordCurrentPromptFiles([logFileName]);
          await this.updateContextAndTokens({ isBackgroundSync: false });

          const hasError = !res.success || 
                           cleanOutput.toLowerCase().includes('error:') || 
                           cleanOutput.toLowerCase().includes('traceback') || 
                           cleanOutput.toLowerCase().includes('exception:') || 
                           cleanOutput.toLowerCase().includes('failed');

          let debugPrompt = "";
          if (hasError) {
              debugPrompt = `### 🐞 RUN/VIEW/FIX DEBUG LOOP: ISSUE DETECTED
I executed the project using \`${finalCmd}\` and an issue was detected. The full log was written to \`${logFileName}\` and added to your context.

**EXECUTION SUMMARY / LOG EXCERPT:**
\`\`\`
${cleanOutput.substring(0, 3000) || '(Process exited with error)'}
\`\`\`

**DEBUGGING MANDATE (${isAssistant ? 'ASSISTANT MODE - HUMAN VALIDATION REQUIRED' : 'AGENT MODE'}):**
1. **View & Analyze**: Diagnose the exact root cause from the traceback, exception, or unexpected output.
${isFast ? '2. **Request Missing Files**: If you need to inspect additional files from the project tree, request them using `<unmute_files>` or `<add_files_to_context>`.' : '2. **Consult Librarian if needed**: If you need to inspect or locate files, summon the Librarian using `<ask_librarian>`.'}
3. **Propose Surgical Fix**: Provide the surgical fix using \`<file path="..." action="patch">\` (or targeted symbol replacement \`<file path="..." action="update_symbol">\`).
${isAssistant ? '4. **Human Validation Gate**: Because we are in Assistant Mode, do not assume changes are applied automatically. Present the changes clearly for the user to review in the diff editor and apply. Explain how the fix resolves the issue.' : '4. Apply the fix and verify.'}`;
          } else {
              debugPrompt = `### 🐞 RUN/VIEW/FIX DEBUG LOOP: CLEAN RUN
I executed the project using \`${finalCmd}\` and it ran without errors (Exit Code 0). Output was saved to \`${logFileName}\`.

**OUTPUT EXCERPT:**
\`\`\`
${cleanOutput.substring(0, 2000) || '(No errors reported)'}
\`\`\`

Please review the output to verify if the application state behaved as expected or if there are any subtle warnings/leaks to optimize.`;
          }

          this.processManager.unregister(procId);
          this.updateGeneratingState();

          await this.sendMessage({
              id: 'user_debug_loop_' + Date.now(),
              role: 'user',
              content: debugPrompt
          });

      } catch (err: any) {
          this.processManager.unregister(procId);
          this.updateGeneratingState();
          if (err.name !== 'AbortError') {
              vscode.window.showErrorMessage(`Debug execution failed: ${err.message}`);
              await this.addMessageToDiscussion({
                  role: 'system',
                  content: `❌ **Debug Execution Error:** ${err.message}`,
                  skipInPrompt: true
              });
          }
      }
  }

  /**
   * Executes project tests, captures output to test_run.log, adds the log to context,
   * and dispatches a prompt to the LLM to inspect results and fix failures.
   */
  public async handleRunTestsAndReport() {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
          vscode.window.showErrorMessage("Active workspace required to run tests.");
          return;
      }

      const folderKey = workspaceFolder.uri.toString();
      const wsState = this._discussionManager?.context?.workspaceState;
      const lastSavedTestCmd = wsState?.get<string>(`lollms_last_test_cmd_${folderKey}`)
          || wsState?.get<string>('lollms_last_test_cmd')
          || (this._currentDiscussion as any)?.lastTestCommand;

      let initialTestCmd = (lastSavedTestCmd && lastSavedTestCmd.trim()) ? lastSavedTestCmd.trim() : "";
      if (!initialTestCmd) {
          const detected = await this.detectTestCommand(workspaceFolder);
          initialTestCmd = detected.command;
      }

      const isAgent = this._discussionCapabilities.agentMode === true;
      const promptLabel = isAgent
          ? `Confirm test command for ${workspaceFolder.name} (🤖 Agent Mode: will loop test/code/auto-apply until tests pass):`
          : `Confirm or customize the test command for ${workspaceFolder.name}:`;

      const commandInput = await vscode.window.showInputBox({
          prompt: promptLabel,
          value: initialTestCmd,
          placeHolder: "e.g. python -m pytest tests -v, npm test, cargo test"
      });

      if (!commandInput || !commandInput.trim()) return;

      const finalCmd = commandInput.trim();

      // Persist the user's confirmed command so subsequent runs remember it
      try {
          await wsState?.update(`lollms_last_test_cmd_${folderKey}`, finalCmd);
          await wsState?.update('lollms_last_test_cmd', finalCmd);
          if (this._currentDiscussion) {
              (this._currentDiscussion as any).lastTestCommand = finalCmd;
              if (!this._currentDiscussion.id.startsWith('temp-')) {
                  await this._discussionManager.saveDiscussion(this._currentDiscussion);
              }
          }
      } catch (err) {
          this.log(`Failed to save last test command: ${err}`, 'WARN');
      }

      // In Agent Mode: Execute autonomous looping test-driven development (TDD) until tests succeed
      if (isAgent && this.agentManager) {
          const { id: procId, controller } = this.processManager.register(this.discussionId, `TDD Loop: ${finalCmd}...`);
          this.updateGeneratingState();

          await this.addMessageToDiscussion({
              id: 'test_loop_launch_' + Date.now(),
              role: 'system',
              content: `🧪 **Autonomous TDD Loop Engaged (Agent Mode)**
- **Command**: \`${finalCmd}\`
- **Protocol**: \`Test -> Code -> Auto-Apply -> Test -> ...\` until all tests pass.
- *Running test suite and beginning autonomous resolution...*`,
              skipInPrompt: true
          });

          try {
              const loopResult = await this.agentManager.runTestDrivenLoop(finalCmd, controller.signal);
              const gitDiffTag = await this.agentManager.buildEndOfWorkGitDiffTag(workspaceFolder);
              const diffSuffix = gitDiffTag ? `\n\n${gitDiffTag}` : '';
              if (loopResult.success) {
                  await this.addMessageToDiscussion({
                      id: 'test_loop_success_' + Date.now(),
                      role: 'assistant',
                      content: `🎉 **All Tests Passed Successfully!** (Resolved in ${loopResult.iterations} round${loopResult.iterations === 1 ? '' : 's'})

**Test Command**: \`${finalCmd}\`
**Final Test Output**:
\`\`\`
${loopResult.output.substring(0, 2000)}
\`\`\`
All code modifications have been verified and applied to disk.${diffSuffix}`
                  });
              } else {
                  await this.addMessageToDiscussion({
                      id: 'test_loop_fail_' + Date.now(),
                      role: 'assistant',
                      content: `🛑 **Test Loop Concluded with Failures** (Reached ${loopResult.iterations} round${loopResult.iterations === 1 ? '' : 's'})

**Last Test Output**:
\`\`\`
${loopResult.output.substring(0, 2000)}
\`\`\`
Please inspect the remaining failures above or adjust your test command.${diffSuffix}`
                  });
              }
          } finally {
              this.processManager.unregister(procId);
              this.updateGeneratingState();
              this.updateContextAndTokens({ isBackgroundSync: false });
          }
          return;
      }

      const { id: procId, controller } = this.processManager.register(this.discussionId, `Running tests: ${finalCmd}...`);
      this.updateGeneratingState();

      await this.addMessageToDiscussion({
          id: 'test_run_launch_' + Date.now(),
          role: 'system',
          content: `🧪 **Executing Project Tests**\nCommand: \`${finalCmd}\`\n*Running tests in background, capturing output to \`test_run.log\`...*`,
          skipInPrompt: true
      });

      try {
          const { runCommandInTerminal } = require('../../extensionState');
          let res: { success: boolean; output: string };

          if (this.agentManager) {
              res = await this.agentManager.runCommand(finalCmd, controller.signal, { timeoutMs: 180000 });
          } else {
              res = await runCommandInTerminal(finalCmd, workspaceFolder.uri.fsPath, "Test Runner", controller.signal, { stealth: true, timeoutMs: 180000 });
          }

          const timestamp = new Date().toISOString();
          const isPassed = res.success && !res.output.toLowerCase().includes('failed,') && !res.output.toLowerCase().includes('errors=');
          const statusText = isPassed ? 'PASSED (Exit Code: 0)' : 'FAILED (Exit Code: 1)';

          const logContent = `======================================================================
TEST RUN EXECUTION REPORT
Timestamp: ${timestamp}
Project: ${workspaceFolder.name}
Command: ${finalCmd}
Status: ${statusText}
OUTPUT:
${res.output || '(No output recorded)'}
`;

          const logFileName = 'test_run.log';
          const logUri = vscode.Uri.joinPath(workspaceFolder.uri, logFileName);
          await vscode.workspace.fs.writeFile(logUri, Buffer.from(logContent, 'utf8'));

          // Add test_run.log to active context
          await this._contextManager.getContextStateProvider()?.addFilesToContext([logFileName]);
          this._contextManager.recordRecentlyAddedFiles([logFileName]);
          this.recordCurrentPromptFiles([logFileName]);
          await this.updateContextAndTokens({ isBackgroundSync: false });

          vscode.window.showInformationMessage(`Tests ${isPassed ? 'passed' : 'failed'}. Output saved to ${logFileName} and added to context.`);

          let userPrompt = "";
          if (isPassed) {
              userPrompt = `I executed the project tests using \`${finalCmd}\`. The output has been saved to \`${logFileName}\` and added to your context.\n\nAll tests passed successfully! Please review the test results in \`${logFileName}\` and provide a brief confirmation.`;
          } else {
              userPrompt = `I executed the project tests using \`${finalCmd}\` and tests failed. The execution output has been saved to \`${logFileName}\` and added to your context.\n\nPlease inspect the failures in \`${logFileName}\`, locate the source files responsible, and provide surgical search/replace patches to fix the issues.`;
          }

          this.processManager.unregister(procId);
          this.updateGeneratingState();

          await this.sendMessage({
              id: 'user_test_run_' + Date.now(),
              role: 'user',
              content: userPrompt
          });

      } catch (err: any) {
          this.processManager.unregister(procId);
          this.updateGeneratingState();
          if (err.name !== 'AbortError') {
              vscode.window.showErrorMessage(`Test run failed: ${err.message}`);
              await this.addMessageToDiscussion({
                  role: 'system',
                  content: `❌ **Test Execution Error:** ${err.message}`,
                  skipInPrompt: true
              });
          }
      }
  }

  public async applySymbolBatchUpdate(
      filePath: string,
      activate: string[],
      deactivate: string[],
      mode?: 'all' | 'none' | 'replace',
      options?: { skipTokenUpdate?: boolean }
  ): Promise<{ success: boolean; message: string; activeSymbols: string[] }> {
      if (!this._currentDiscussion || !this._contextManager) {
          return { success: false, message: 'No active discussion.', activeSymbols: [] };
      }

      const res = await this._contextManager.resolveWorkspaceFromPath(filePath);
      if (!res) {
          return { success: false, message: `Could not resolve path: ${filePath}`, activeSymbols: [] };
      }

      const resolvedPath = res.relativePath;
      if (!(this._currentDiscussion as any).includedFiles) {
          const globalIncluded = this._contextManager.getContextStateProvider()?.getIncludedFiles() || [];
          (this._currentDiscussion as any).includedFiles = JSON.parse(JSON.stringify(globalIncluded));
      }

      const discFiles: any[] = (this._currentDiscussion as any).includedFiles;
      const { arePathsEqual } = require('../../utils');

      let entry = discFiles.find(f => {
          const cf = typeof f === 'string' ? f : (f.path || '');
          return arePathsEqual(cf, resolvedPath) || arePathsEqual(cf, filePath);
      });

      if (!entry) {
          entry = { path: resolvedPath, state: 'definitions-only', symbols: [] };
          discFiles.push(entry);
      } else if (typeof entry === 'string') {
          const idx = discFiles.indexOf(entry);
          entry = { path: resolvedPath, state: 'definitions-only', symbols: [] };
          discFiles[idx] = entry;
      }

      let currentSymbols: string[] = Array.isArray(entry.symbols) ? [...entry.symbols] : [];
      if (mode === 'replace') {
          currentSymbols = [...activate];
      } else if (mode === 'all') {
          const allSyms = await this._contextManager.extractSymbolList(res.uri);
          currentSymbols = allSyms.map(s => s.name);
      } else if (mode === 'none') {
          currentSymbols = [];
      } else {
          for (const s of activate) {
              if (s && !currentSymbols.includes(s)) currentSymbols.push(s);
          }
          if (deactivate.length > 0) {
              const deactSet = new Set(deactivate.map(d => d.toLowerCase()));
              currentSymbols = currentSymbols.filter(s => !deactSet.has(s.toLowerCase()));
          }
      }

      entry.state = 'definitions-only';
      entry.symbols = Array.from(new Set(currentSymbols));

      if (this._currentDiscussion.capabilities) {
          (this._currentDiscussion.capabilities as any).includedFiles = discFiles;
      }

      const provider = this._contextManager.getContextStateProvider();
      if (provider) {
          await provider.setStateForUris([res.uri], 'definitions-only');
          this._contextManager.refreshFileInCache(res.uri);
      }

      if (this._currentDiscussion.mutedFiles) {
          this._currentDiscussion.mutedFiles = this._currentDiscussion.mutedFiles.filter(m => !arePathsEqual(m, filePath) && !arePathsEqual(m, resolvedPath));
          this._discussionCapabilities.mutedFiles = [...this._currentDiscussion.mutedFiles];
      }

      if (!this._currentDiscussion.id.startsWith('temp-')) {
          await this._discussionManager.saveDiscussion(this._currentDiscussion);
      }

      if (!options?.skipTokenUpdate) {
          await this.updateContextAndTokens({ isBackgroundSync: false });
      }

      return {
          success: true,
          message: `Updated structure for \`${resolvedPath}\`: ${entry.symbols.length} symbol(s) active, remaining symbols compacted.`,
          activeSymbols: entry.symbols
      };
  }

  public async processStructureTags(content: string): Promise<string[]> {
      if (!content) return [];
      const scanContent = this.stripProtectedRegionsForTagScan(content);
      const structRegex = /<(?:load_structure|read_definitions)\b([^>]*?)(?:\/>|>(?:([\s\S]*?)<\/(?:load_structure|read_definitions)>)?)/gim;
      const targetPaths: string[] = [];
      const addTarget = (p: string) => {
          const clean = p.trim().replace(/^['"`]|['"`]$/g, '').replace(/^-\s*/, '').trim();
          if (clean && !targetPaths.includes(clean)) targetPaths.push(clean);
      };

      let structMatch: RegExpExecArray | null;
      while ((structMatch = structRegex.exec(scanContent)) !== null) {
          const attrStr = structMatch[1] || "";
          const inner = (structMatch[2] || "").trim();

          const attrRegex = /(?:path|paths|files|target)=["']([^"']+)["']/gi;
          let am: RegExpExecArray | null;
          while ((am = attrRegex.exec(attrStr)) !== null) {
              am[1].split(/[\r\n,;\s]+/).forEach(addTarget);
          }
          if (inner) {
              inner.split(/[\r\n,;]+/).forEach(l => l.trim().split(/\s+/).forEach(addTarget));
          }
      }

      if (targetPaths.length > 0) {
          if (this._currentDiscussion?.mutedFiles) {
              const { arePathsEqual } = require('../../utils');
              this._currentDiscussion.mutedFiles = this._currentDiscussion.mutedFiles.filter(m =>
                  !targetPaths.some(t => arePathsEqual(m, t))
              );
              this._discussionCapabilities.mutedFiles = [...this._currentDiscussion.mutedFiles];
          }

          await this.addFilesToDiscussionContext(targetPaths, 'definitions-only');
          const provider = this._contextManager.getContextStateProvider();
          if (provider) {
              const urisToSet: vscode.Uri[] = [];
              for (const tp of targetPaths) {
                  const res = await this._contextManager.resolveWorkspaceFromPath(tp);
                  if (res) {
                      urisToSet.push(res.uri);
                      this._contextManager.refreshFileInCache(res.uri);
                  }
              }
              if (urisToSet.length > 0) {
                  await provider.setStateForUris(urisToSet, 'definitions-only');
              }
          }
          this.recordCurrentPromptFiles(targetPaths);
          if (this._currentDiscussion && !this._currentDiscussion.id.startsWith('temp-')) {
              await this._discussionManager.saveDiscussion(this._currentDiscussion);
          }
          this.log(`[Structure Ingestion] Ingested structure for ${targetPaths.length} file(s) into context (definitions-only).`);
          await this.updateContextAndTokens({ isBackgroundSync: false });
      }
      return targetPaths;
  }

  public async processKnowledgeUpdates(content: string): Promise<void> {
      if (!content) return;
      const scanContent = this.stripProtectedRegionsForTagScan(content);
      const updateKnRegex = /<update_knowledge\b([^>]*?)>([\s\S]*?)<\/update_knowledge>/gi;
      let match: RegExpExecArray | null;
      let updatedAny = false;

      while ((match = updateKnRegex.exec(scanContent)) !== null) {
          const attrStr = match[1] || "";
          const innerContent = match[2].trim();
          if (!innerContent) continue;
          const pathMatch = attrStr.match(/path=["']([^"']+)["']/i);
          const secPath = pathMatch ? pathMatch[1].trim() : "";
          try {
              const { KnowledgeManager } = require('../../knowledgeManager');
              const km = new KnowledgeManager(this._discussionManager.context);
              await km.updateKnowledge(secPath, innerContent);
              updatedAny = true;
              this.log(`Knowledge base updated for section: '${secPath || 'root'}'`);
          } catch (e: any) {
              this.log(`Failed to update knowledge base: ${e.message}`, 'WARN');
          }
      }

      const structRegex = /<(?:structure|findings|update_findings)\b([^>]*?)>([\s\S]*?)<\/(?:structure|findings|update_findings)>/gi;
      while ((match = structRegex.exec(scanContent)) !== null) {
          const attrStr = match[1] || "";
          const inner = match[2].trim();
          if (inner) {
              const isPatch = attrStr.includes('action="patch"') || inner.includes('<<<<<<< SEARCH');
              try {
                  await ContextLibrarian.updateStructureGuide(inner, isPatch ? 'patch' : 'write');
                  updatedAny = true;
                  this.log(`Structure findings guide updated on disk.`);
              } catch (e: any) {
                  this.log(`Failed to update structure guide: ${e.message}`, 'WARN');
              }
          }
      }

      if (updatedAny) {
          const { KnowledgeManager } = require('../../knowledgeManager');
          const km = new KnowledgeManager(this._discussionManager.context);
          const rendered = await km.renderContextKnowledge();
          this._panel.webview.postMessage({
              command: 'updateKnowledgeContent',
              knowledge: rendered
          });
      }
  }

  public async muteFiles(paths: string[], options?: { skipTokenUpdate?: boolean }): Promise<number> {
      if (!this._currentDiscussion || !Array.isArray(paths) || paths.length === 0) return 0;
      if (!this._currentDiscussion.mutedFiles) this._currentDiscussion.mutedFiles = [];

      const { arePathsEqual } = require('../../utils');
      let addedCount = 0;
      for (const rawP of paths) {
          const targetPath = String(rawP).replace(/\\/g, '/').trim();
          if (!targetPath) continue;
          const alreadyMuted = this._currentDiscussion.mutedFiles.some(p =>
              arePathsEqual(p, targetPath) || this.normalizePathKey(p) === this.normalizePathKey(targetPath)
          );
          if (!alreadyMuted) {
              this._currentDiscussion.mutedFiles.push(targetPath);
              addedCount++;
          }
      }

      this._discussionCapabilities.mutedFiles = [...this._currentDiscussion.mutedFiles];
      this._discussionManager.saveLastMutedFiles(this._currentDiscussion.mutedFiles).catch(() => {});

      if (!this._currentDiscussion.id.startsWith('temp-')) {
          await this._discussionManager.saveDiscussion(this._currentDiscussion);
      }
      this.contextStateProvider?.updateContextKeys();
      if (!options?.skipTokenUpdate) {
          this.updateContextAndTokens({ isBackgroundSync: true });
      }
      return addedCount;
  }

  public async unmuteFiles(paths: string[], options?: { skipTokenUpdate?: boolean }): Promise<number> {
      if (!this._currentDiscussion || !Array.isArray(paths) || paths.length === 0) return 0;
      if (!this._currentDiscussion.mutedFiles) this._currentDiscussion.mutedFiles = [];

      const { arePathsEqual } = require('../../utils');
      const targetPaths = paths.map((rawP: string) => String(rawP).replace(/\\/g, '/').trim());
      const initialCount = this._currentDiscussion.mutedFiles.length;

      this._currentDiscussion.mutedFiles = this._currentDiscussion.mutedFiles.filter(p => {
          return !targetPaths.some((t: string) =>
              arePathsEqual(p, t) || this.normalizePathKey(p) === this.normalizePathKey(t)
          );
      });

      this._discussionCapabilities.mutedFiles = [...this._currentDiscussion.mutedFiles];
      this._discussionManager.saveLastMutedFiles(this._currentDiscussion.mutedFiles).catch(() => {});

      // Restore full content ('included') for any files that were in definitions-only/structure mode
      if (this._contextManager) {
          this._contextManager.recordRecentlyAddedFiles(paths);
          const provider = this._contextManager.getContextStateProvider();
          const urisToInclude: vscode.Uri[] = [];
          for (const rawP of paths) {
              const res = await this._contextManager.resolveWorkspaceFromPath(rawP);
              if (res) {
                  urisToInclude.push(res.uri);
                  this._contextManager.refreshFileInCache(res.uri);
              }
          }
          if (provider && urisToInclude.length > 0) {
              await provider.setStateForUris(urisToInclude, 'included');
          }
      }

      await this.addFilesToDiscussionContext(paths, 'included');

      const removedCount = initialCount - this._currentDiscussion.mutedFiles.length;

      if (!this._currentDiscussion.id.startsWith('temp-')) {
          await this._discussionManager.saveDiscussion(this._currentDiscussion);
      }
      this.contextStateProvider?.updateContextKeys();
      if (!options?.skipTokenUpdate) {
          this.updateContextAndTokens({ isBackgroundSync: true });
      }
      return removedCount;
  }

  public handleProjectExecutionResult(output: string, success: boolean) {
      const message: ChatMessage = {
          id: 'execution_result_' + Date.now() + Math.random().toString(36).substring(2),
          role: 'user',
          content: success 
            ? `✅ **Project Executed Successfully**\n\`\`\`\n${output}\n\`\`\`\n`
            : `❌ **Project Execution Failed**\n\`\`\`\n${output}\n\`\`\`\n`
      };
      this.addMessageToDiscussion(message);
      this.analyzeExecutionResult(null, null, output, success ? 0 : 1);
  }

  public async analyzeExecutionResult(code: string | null, language: string | null, output: string, exitCode: number) {
      if (exitCode === 0 && !output.trim()) return;

      await this.waitForWebviewReady();
      if (this._isDisposed) return;

      const importedIds = this._currentDiscussion?.importedSkills || [];
      const contextData = await this._contextManager.getContextContent({ 
          importedSkillIds: importedIds,
          modelName: this._currentDiscussion?.model || this._lollmsAPI.getModelName()
      });
      const context = {
          tree: contextData.projectTree,
          files: contextData.selectedFilesContent,
          skills: contextData.skillsContent
      };
      
      const personaContent = this.getCurrentPersonaSystemPrompt();
      const systemPrompt = await getProcessedSystemPrompt('chat', this._discussionCapabilities, personaContent, undefined, false, context);
      
      let userPrompt = "";

      if (code && language) {
          if (exitCode !== 0) {
              userPrompt = `I executed the following ${language} script and it failed with exit code ${exitCode}.\n\n**Script:**\n\`\`\`${language}\n${code}\n\`\`\`\n\n**Output/Error:**\n\`\`\`\n${output}\n\`\`\`\n\nPlease analyze the error and provide a fixed version of the code.`;
          } else {
              userPrompt = `I executed the following ${language} script and it finished with exit code 0.\n\n**Script:**\n\`\`\`${language}\n${code}\n\`\`\`\n\n**Output:**\n\`\`\`\n${output}\n\`\`\`\n\nPlease analyze the output. If there are any warnings, errors, or unexpected behaviors in the text output, please explain them and suggest a fix. If everything looks good, just say "Execution successful."`;
          }
      } else {
          if (exitCode !== 0) {
               userPrompt = `I executed the project and it failed with exit code ${exitCode}.\n\n**Output/Error:**\n\`\`\`\n${output}\n\`\`\`\n\nPlease analyze the error and suggest a fix.`;
          } else {
               userPrompt = `I executed the project and it finished with exit code 0.\n\n**Output:**\n\`\`\`\n${output}\n\`\`\`\n\nPlease analyze the output. If there are any warnings or issues in the logs, please explain them and suggest fixes. If it looks clean, just confirm it was successful.`;
          }
      }

      const { id: processId, controller } = this.processManager.register(this.discussionId, 'Analyzing output...');
      this.updateGeneratingState();

      try {
          const userMsg: ChatMessage = { 
              id: 'user_analyze_' + Date.now(),
              role: 'user', 
              content: userPrompt 
          };
          await this.addMessageToDiscussion(userMsg);

          const messages: ChatMessage[] = [
              { role: 'system', content: systemPrompt },
              ...this._currentDiscussion!.messages
          ];

          const assistantMessageId = 'assistant_' + Date.now();
          if (!this._isDisposed) {
              this._panel.webview.postMessage({
                  command: 'addMessage',
                  message: { id: assistantMessageId, role: 'assistant', content: '', startTime: Date.now(), model: this._currentDiscussion?.model }
              });
          }

          let fullResponse = '';
          await this._lollmsAPI.sendChat(messages, (chunk) => {
              fullResponse += chunk;
              if (!this._isDisposed) this._panel.webview.postMessage({ command: 'appendMessageChunk', id: assistantMessageId, chunk: chunk });
          }, controller.signal, this._currentDiscussion?.model);

          const responseMsg: ChatMessage = {
              id: assistantMessageId,
              role: 'assistant',
              content: fullResponse,
              model: this._currentDiscussion?.model
          };
          await this.addMessageToDiscussion(responseMsg, false);
          if (!this._isDisposed) this._panel.webview.postMessage({ command: 'finalizeMessage', id: assistantMessageId, fullContent: fullResponse });

      } catch (error: any) {
          if (!this._isDisposed) this._panel.webview.postMessage({ command: 'error', content: error.message });
      } finally {
          this.processManager.unregister(processId);
          this.updateGeneratingState();
      }
  }
      /**
     * Completes the generation workflow after background context assembly finishes.
     */
    private async proceedWithGeneration(
        messagesToSend: ChatMessage[],
        context: { tree: string; files: string; skills: string; memory: string },
        processId: string,
        controller: any,
        targetModel: string,
        reqTemperature: number | undefined,
        personaName: string
    ) {
        if (controller.signal.aborted) return;

        // Force clear any active progress states in the loader
        this._panel.webview.postMessage({ command: 'tokenCalculationFinished' });

        this.processManager.updateDescription(processId, `Connecting to ${targetModel} (waiting for first token)...`);
        this.updateGeneratingState();

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        let assistantMessageId = 'assistant_' + Date.now().toString() + Math.random().toString(36).substring(2);
        let fullResponse = "";

        const generationSession: ActiveGeneration = {
            messageId: assistantMessageId, 
            buffer: '', 
            model: targetModel,
            startTime: Date.now(), 
            tokenCount: 0,
            listeners: new Set(), 
            onComplete: new Set()
        };

        const panelListener = (chunk: string) => { 
            if (!this._isDisposed && this._panel.webview) {
                this._panel.webview.postMessage({ command: 'appendMessageChunk', id: assistantMessageId, chunk }); 
            }
        };

        this._activeGenerationListener = panelListener;
        generationSession.listeners.add(panelListener);
        ChatPanel.activeGenerations.set(this.discussionId, generationSession);

        const configTimeout = config.get<number>('requestTimeout') || 180000;
        const ttftTimeoutValue = this._discussionCapabilities.ttftTimeout || configTimeout;

        if (!this._isDisposed) {
            this._panel.webview.postMessage({ 
                command: 'addMessage', 
                message: { 
                    id: assistantMessageId, 
                    role: 'assistant', 
                    content: '', 
                    startTime: Date.now(), 
                    model: generationSession.model,
                    personalityName: personaName,
                    timestamp: Date.now()
                } 
            });
            this._panel.webview.postMessage({
                command: 'startCountdown',
                id: assistantMessageId,
                timeoutMs: ttftTimeoutValue
            });
        }

        let firstTokenReceived = false;
        let lastMetricsPostTime = 0;
        const thinkTimings: Array<{ start: number; end?: number }> = [];
        let firstTokenTimestamp: number | undefined;
        try {
            await this._lollmsAPI.sendChat(messagesToSend, (chunk) => {
                if (controller.signal.aborted) return;
                if (!firstTokenReceived) {
                    firstTokenReceived = true;
                    firstTokenTimestamp = Date.now();
                    if (processId) this.processManager.updateDescription(processId, `Streaming response from ${targetModel}...`);
                    this.updateGeneratingState();
                }

                fullResponse += chunk;
                generationSession.buffer += chunk;
                generationSession.tokenCount++;
                this.updateThinkTimingsFromBuffer(fullResponse, thinkTimings, firstTokenTimestamp);

                const now = Date.now();
                if (now - lastMetricsPostTime >= 250) {
                    lastMetricsPostTime = now;
                    const elapsed = Math.max(0.001, (now - generationSession.startTime) / 1000);
                    const tps = (generationSession.tokenCount / elapsed).toFixed(1);

                    this._panel.webview.postMessage({
                        command: 'updateGenerationMetrics',
                        tps: tps,
                        count: generationSession.tokenCount
                    });
                }

                generationSession.listeners.forEach(listener => listener(chunk));
            }, controller.signal, targetModel, { 
                thinking: this._discussionCapabilities.thinkingMode && this._discussionCapabilities.reasoningEffort !== 'none',
                capabilities: this._discussionCapabilities,
                temperature: reqTemperature,
                reasoningEffort: (this._discussionCapabilities.reasoningEffort || config.get<string>('reasoningEffort') || 'none') as any
            });

            if (controller.signal.aborted) return;

            // --- THE VERIFIER (GUARDIAN) ---
            let inspectedResponse = fullResponse;
            if (this._discussionCapabilities.verifierMode && processId) {
                this.processManager.updateDescription(processId, "Verifier: Performing logical audit & linting...");
                this.updateGeneratingState();

                const auditedResponse = await this.runVerificationAgent(fullResponse, controller.signal);
                const cleanOrig = stripThinkingTags(fullResponse).trim();
                const cleanAudit = stripThinkingTags(auditedResponse).trim();

                if (cleanOrig !== cleanAudit) {
                    this.log("Verifier detected flaws in the initial draft.");
                    const verifiedMsgId = 'assistant_verified_' + Date.now();
                    inspectedResponse = auditedResponse;

                    await this.addMessageToDiscussion({
                        id: verifiedMsgId,
                        role: 'assistant',
                        content: auditedResponse,
                        model: generationSession.model,
                        personalityName: '🛡️ Verifier (Guardian)',
                        timestamp: Date.now()
                    });

                    if (!this._isDisposed) {
                        this._panel.webview.postMessage({ 
                            command: 'finalizeMessage', 
                            id: verifiedMsgId, 
                            fullContent: auditedResponse,
                            personalityName: '🛡️ Verifier (Guardian)'
                        });
                    }
                    assistantMessageId = verifiedMsgId;
                }
            }

            if (processId) this.processManager.updateDescription(processId, "Verifying code block integrity...");
            this.updateGeneratingState();

            const processedResponse = await this.verifyAndProcessCodeBlocks(
                assistantMessageId, 
                inspectedResponse, 
                controller.signal,
                (status) => {
                    if (processId) this.processManager.updateDescription(processId, status);
                    this.updateGeneratingState();
                }
            );

            // --- PROJECT MEMORY PROCESSING ---
            if (this._discussionCapabilities.projectMemoryEnabled !== false && !controller.signal.aborted) {
                await this.processProjectMemoryTags(processedResponse);
            }

            // --- AUTOMATION PIPELINE ---
            if (this._discussionCapabilities.autoApply && !controller.signal.aborted && processId) {
                await this.executeAutomationPipeline(processedResponse, assistantMessageId, controller.signal, processId);
                this.updateContextAndTokens();
            }

            const elapsed = (Date.now() - generationSession.startTime) / 1000;
            const finalTps = (generationSession.tokenCount / elapsed).toFixed(1);
            const finalThinkDurations = this.finalizeThinkTimings(thinkTimings);

            const assistantMessage: ChatMessage = { 
                id: assistantMessageId, 
                role: 'assistant', 
                content: processedResponse, 
                model: generationSession.model,
                personalityName: personaName,
                timestamp: Date.now(),
                ...(finalThinkDurations.length > 0 ? { thinkDurations: finalThinkDurations } : {})
            };
            await this.addMessageToDiscussion(assistantMessage, false);

            if (!this._isDisposed) {
                this._panel.webview.postMessage({ 
                    command: 'finalizeMessage', 
                    id: assistantMessageId, 
                    fullContent: processedResponse,
                    tps: finalTps,
                    personalityName: personaName,
                    ...(finalThinkDurations.length > 0 ? { thinkDurations: finalThinkDurations } : {})
                });
                this._panel.webview.postMessage({ command: 'collapseLibrarianMessages' });
            }

            // --- PHASE 6: DEBUGGER (THE ITERATIVE LOOP) ---
            if (this._discussionCapabilities.debugMode && !controller.signal.aborted && processId) {
                this.processManager.updateDescription(processId, "Debugger: Starting runtime validation...");
                this.updateGeneratingState();
                const lastMsgContent = messagesToSend[messagesToSend.length - 1]?.content;
                const debugObjective = typeof lastMsgContent === 'string' ? lastMsgContent : "Verify.";
                await this.agentManager.runDebuggerAgent(debugObjective, controller.signal);
                this.updateContextAndTokens();
            }

        } catch (err: any) {
            throw err;
        } finally {
            ChatPanel.activeGenerations.delete(this.discussionId);
            this._activeGenerationListener = undefined;
            if (processId) this.processManager.unregister(processId);
            this.updateGeneratingState();
            this.updateContextAndTokens();
        }
    }

  public async addMessageToDiscussion(message: ChatMessage, updateWebview: boolean = true) {
      if (this._currentDiscussion) {
          if (message.id && this._currentDiscussion.messages.some(m => m.id === message.id)) {
              this.log(`Duplicate message ignored: ${message.id}`, 'WARN');
              return;
          }

          // If an active embedded agent answer block is waiting, fold final assistant responses directly into it!
          if (this._activeAgentAnswerId && message.role === 'assistant' && message.id !== this._activeAgentAnswerId) {
              const activeMsg = this._currentDiscussion.messages.find(m => m.id === this._activeAgentAnswerId);
              if (activeMsg) {
                  const text = typeof message.content === 'string' 
                      ? message.content 
                      : (Array.isArray(message.content) ? message.content.map((p: any) => p.text || '').join('\n') : '');
                  activeMsg.content = activeMsg.content ? `${activeMsg.content}\n\n${text}` : text;
                  if (!this._currentDiscussion.id.startsWith('temp-')) {
                      await this._discussionManager.saveDiscussion(this._currentDiscussion);
                  }
                  if (updateWebview && this._panel.webview && !this._isDisposed) {
                      this._panel.webview.postMessage({ command: 'updateMessage', messageId: this._activeAgentAnswerId, newContent: activeMsg.content, isFinal: true });
                      this._panel.webview.postMessage({ command: 'finalizeMessage', id: this._activeAgentAnswerId, fullContent: activeMsg.content });
                  }
                  return;
              }
          }

          this._currentDiscussion.messages.push(message);
          if (this._currentDiscussion.llmHistory) {
              this._currentDiscussion.llmHistory.push(message);
          }
          if (!this._currentDiscussion.id.startsWith('temp-')) {
              await this._discussionManager.saveDiscussion(this._currentDiscussion);
          }
      }
      if (updateWebview && this._panel.webview && !this._isDisposed) {
          this._panel.webview.postMessage({ command: 'addMessage', message: message });
      }
  }
  
  private async handleSaveSkill(content: string) {
      const name = await vscode.window.showInputBox({ prompt: "Enter a name for the new skill" });
      if (!name) return;
      const description = await vscode.window.showInputBox({ prompt: "Enter a brief description of the skill" });
      if (!description) return;
      
      const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Date.now();
      
      await this._skillsManager.addSkill({ 
          id,
          name, 
          description, 
          content,
          scope: 'local',
          language: 'markdown' 
      });

      vscode.window.showInformationMessage(`Skill '${name}' saved successfully!`);
      vscode.commands.executeCommand('lollms-vs-coder.refreshSkills'); 
  }
  
  public dispose() {
    this._isDisposed = true;
    ChatPanel.isBatchApplying = false;

    // Clear any active context and token calculation timeouts immediately to prevent disposed webview crashes
    this.clearTokenDebounce();
    if (this._tokenAbortController) {
        this._tokenAbortController.abort();
        this._tokenAbortController = null;
    }

    if (this._activeRepairController) {
        this._activeRepairController.abort();
        this._activeRepairController = null;
    }

    if (this._activeInterProjectController) {
        this._activeInterProjectController.abort();
        this._activeInterProjectController = null;
    }

    this._activeMultiPartPlan = undefined;

    // Unregister any active background loading tasks to release the Extension Host thread instantly
    if (this.processManager) {
        this.processManager.cancelForDiscussion(this.discussionId);
    }

    ChatPanel.activeGenerations.delete(this.discussionId);
    ChatPanel.panels.delete(this.discussionId);
    if (ChatPanel.currentPanel === this) {
        ChatPanel.currentPanel = undefined;
    }

    // Release memory buffers immediately
    this._executionLogs = [];
    this.chatHistory = [];
    this._failedPatchesRegistry.clear();
    this._batchRepairAttempts.clear();
    this._diagnosticWatchUris.clear();
    this._currentPromptAddedFiles.clear();

    if (this._panel) {
        try {
            this._panel.dispose();
        } catch (e) {}
    }
  }
  
private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(async (message) => {
        
        switch (message.command) {
            case 'webview-bootstrap-ok':
                console.log(`[Lollms Debug:Handshake] Webview bootstrap script active.`);
                break;
            case 'webview-html-loaded':
            case 'webview-ready':
                console.log(`[Lollms Debug:Handshake] Processing webview bootstrap handshake: ${message.command}`);
                this._isWebviewReady = true;

                if (this.agentManager) {
                    const plan = (this.agentManager as any).currentPlan;
                    if (plan) {
                        this.displayPlan(plan);
                    }
                }

                // Force load discussion on startup/handshake before waking queued callers
                console.log("[Lollms Debug:Handshake] Handshake complete. Force loading discussion history...");
                await this.loadDiscussion();

                if (typeof this._viewReadyResolver === 'function') {
                    this._viewReadyResolver();
                }
                break;
            case 'showError':
                vscode.window.showErrorMessage(message.message);
                break;
            case 'sendMessage':
                const userMsg = message.message;
                if (!userMsg.id) {
                    userMsg.id = 'user_' + Date.now() + Math.random().toString(36).substring(2);
                }
                await this.sendMessage(userMsg, message.autoContext);
                break;
            case 'runAutoContext':
                await this.handleManualAutoContext(message.prompt);
                break;
            case 'addMessage':
                await this.addMessageToDiscussion(message.message);
                break;
            case 'copyFullPrompt':
                await this.copyFullPromptToClipboard(message.draftMessage);
                break;
            case 'copyHistory':
                await this.copyHistoryToClipboard(message.draftMessage);
                break;
            case 'copySystemPrompt':
                await this.copySystemPromptToClipboard();
                break;
            case 'copyTreeAndContent':
                vscode.commands.executeCommand('lollms-vs-coder.copyTreeAndContent');
                break;
            case 'verifyAllChanges':
                {
                    const results: any = await vscode.commands.executeCommand('lollms-vs-coder.verifyHunks', message.changes);
                    webview.postMessage({
                        command: 'verifyAllResult',
                        messageId: message.messageId,
                        results: results
                    });
                }
                break;
            case 'requestFileContentForDiff':
                {
                    const res = await this._contextManager.resolveWorkspaceFromPath(message.path);
                    if (res) {
                        try {
                            const doc = await vscode.workspace.openTextDocument(res.uri);
                            webview.postMessage({ 
                                command: 'provideFileContentForDiff', 
                                currentContent: doc.getText(),
                                changeIndex: message.changeIndex
                            });
                        } catch(e) {
                            webview.postMessage({ command: 'provideFileContentForDiff', currentContent: "(File not found)", changeIndex: message.changeIndex });
                        }
                    }
                }
                break;
            case 'applyAllChanges':
                {
                    const changesBatch = message.changes;
                    const messageId = message.messageId;

                    const { id: applyProcId, controller: applyCtrl } = this.processManager.register(this.discussionId, `Applying batch changes...`);
                    this.updateGeneratingState();

                    interface FailedBatchItem {
                        change: any;
                        error: string;
                        filePath: string;
                        diskContent: string;
                        failingSnippet: string;
                        crossFileNotice?: string;
                    }
                    const failedBatchItems: FailedBatchItem[] = [];
                    const isUndoMode = message.undo === true;

                    // SEQUENTIAL HIGH-SPEED BATCH APPLY ENGINE (ORDER-PRESERVING)
                    const runBatch = async () => {
                        ChatPanel.isBatchApplying = true;
                        try {
                            for (let i = 0; i < changesBatch.length; i++) {
                                if (applyCtrl.signal.aborted || !ChatPanel.isBatchApplying) {
                                    this.log("Batch apply aborted by user.");
                                    break;
                                }

                                const change = changesBatch[i];
                                const fileName = path.basename(change.path);

                                // 1. Notify UI: Item processing started
                                this._panel.webview.postMessage({ 
                                    command: 'applyAllStart', 
                                    messageId: messageId, 
                                    blockIndex: change.blockIndex,
                                    hunkIndex: change.hunkIndex,
                                    currentIndex: i,
                                    totalCount: changesBatch.length
                                });

                                let result: any = { success: false };

                                try {
                                    const opts = { 
                                        silent: true, 
                                        blockIndex: change.blockIndex, 
                                        hunkIndex: change.hunkIndex,
                                        autoSave: true, // Forces file to save on disk immediately [2]
                                        isBatch: true,
                                        undo: isUndoMode
                                    };

                                    if (change.type === 'file') {
                                        result = await vscode.commands.executeCommand('lollms-vs-coder.applyFileContent', change.path, change.content, opts);
                                    } else if (change.type === 'delete_code') {
                                        result = await vscode.commands.executeCommand('lollms-vs-coder.deleteCodeBlock', change.path, change.content, opts);
                                    } else if (change.type === 'replace') {
                                        result = await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', change.path, change.content, this, messageId, opts);
                                    } else if (change.type === 'diff') {
                                        result = await vscode.commands.executeCommand('lollms-vs-coder.applyPatchContent', change.path, change.content, opts);
                                    }

                                    if (result && result.success) {
                                        await this.updateAppliedState(messageId, change.blockIndex, change.hunkIndex, isUndoMode);

                                        const cleanAuditPath = change.path.includes(':') && !/^[a-zA-Z]:[\\/]/.test(change.path) ? change.path.split(':')[0] : change.path;

                                        this._panel.webview.postMessage({
                                            command: 'fileSavedOnDisk',
                                            filePath: cleanAuditPath,
                                            messageId: messageId,
                                            blockIndex: change.blockIndex,
                                            hunkIndex: change.hunkIndex,
                                            blockId: change.blockId
                                        });

                                        if (!isUndoMode) {
                                            this.auditFileDiagnostics(cleanAuditPath, messageId, change.blockIndex, change.blockId);
                                        }
                                    } else if (result?.succeededHunks && result.succeededHunks.length > 0) {
                                        for (const sIdx of result.succeededHunks) {
                                            await this.updateAppliedState(messageId, change.blockIndex, sIdx, isUndoMode);
                                            this._panel.webview.postMessage({
                                                command: 'applyAllResult',
                                                messageId: messageId,
                                                filePath: change.path,
                                                blockIndex: change.blockIndex,
                                                hunkIndex: sIdx,
                                                blockId: change.blockId,
                                                success: true,
                                                alreadyApplied: !isUndoMode,
                                                undo: isUndoMode
                                            });
                                        }
                                        this._panel.webview.postMessage({
                                            command: 'fileSavedOnDisk',
                                            filePath: change.path,
                                            messageId: messageId,
                                            blockIndex: change.blockIndex,
                                            blockId: change.blockId
                                        });

                                        if (!isUndoMode) {
                                            this.auditFileDiagnostics(change.path, messageId, change.blockIndex, change.blockId);
                                        }
                                    }
                                } catch (e: any) {
                                    result = { success: false, error: e.message };
                                    this.log(`Batch failure on ${change.path}: ${e.message}`, 'ERROR');
                                }

                                const isSuccess = (result?.success === true);

                                // If application failed, collect details for automated LLM batch repair pass
                                if (!isSuccess && !isUndoMode && !applyCtrl.signal.aborted) {
                                    const cleanP = change.path.includes(':') && !/^[a-zA-Z]:[\\/]/.test(change.path) ? change.path.split(':')[0] : change.path;
                                    let diskText = "";
                                    try {
                                        const res = await this._contextManager.resolveWorkspaceFromPath(cleanP);
                                        if (res) {
                                            const fileBytes = await vscode.workspace.fs.readFile(res.uri);
                                            diskText = Buffer.from(fileBytes).toString('utf8');
                                        }
                                    } catch (readErr: any) {
                                        diskText = `(Could not read file: ${readErr.message})`;
                                    }

                                    let crossNotice = "";
                                    try {
                                        const { findHunkInWorkspace } = require('../../utils');
                                        const searchPart = (change.content?.match(/<<<<<<< SEARCH([\s\S]*?)=======/) || [])[1] || change.content || "";
                                        const crossFile = await findHunkInWorkspace(searchPart, cleanP, this._contextManager);
                                        if (crossFile) {
                                            crossNotice = `MISPLACED HUNK DETECTED: This search block does not exist in '${cleanP}', but was located in '${crossFile.filePath}' around line ${crossFile.line}.`;
                                        }
                                    } catch {}

                                    failedBatchItems.push({
                                        change,
                                        error: result?.error || "Search block mismatch or block application failed.",
                                        filePath: cleanP,
                                        diskContent: diskText,
                                        failingSnippet: change.content || "",
                                        crossFileNotice: crossNotice
                                    });
                                }

                                // 2. Notify UI: Item result with explicit alreadyApplied state
                                this._panel.webview.postMessage({
                                    command: 'applyAllResult',
                                    messageId: messageId,
                                    filePath: change.path,
                                    blockIndex: change.blockIndex,
                                    hunkIndex: change.hunkIndex,
                                    blockId: change.blockId,
                                    success: isSuccess,
                                    alreadyApplied: isSuccess && !isUndoMode,
                                    error: isSuccess ? undefined : (result?.error || "Symbol or block application failed."),
                                    currentIndex: i,
                                    totalCount: changesBatch.length,
                                    undo: isUndoMode
                                });
                            }

                            // Save all open documents and ensure applied files are unmuted and active in context
                            try {
                                await vscode.workspace.saveAll(false);
                            } catch {}

                            if (!message.undo && this._contextManager) {
                                const appliedPaths = changesBatch.map((c: any) => c.path).filter(Boolean);
                                if (appliedPaths.length > 0) {
                                    try {
                                        await this.unmuteFiles(appliedPaths);
                                        await this._contextManager.getContextStateProvider()?.addFilesToContext(appliedPaths);
                                    } catch (ctxErr) {
                                        this.log(`Failed to add applied batch files to context: ${ctxErr}`, 'WARN');
                                    }
                                }
                            }

                            if (this._currentDiscussion && !this._currentDiscussion.id.startsWith('temp-')) {
                                await this._discussionManager.saveDiscussion(this._currentDiscussion);
                            }
                        } finally {
                            ChatPanel.isBatchApplying = false;
                        }

                        this.processManager.unregister(applyProcId);
                        this.updateGeneratingState();
                        // Final context refresh to show new state in HUD
                        this.updateContextAndTokens({ isBackgroundSync: true });

                        // 🛑 AUTOMATED AI BATCH REPAIR DISPATCH
                        // Only trigger autonomous batch repair in Agent Mode with autoFix enabled.
                        // In Assistant Mode, do not automatically retry; the user retains manual control.
                        const isAutonomousAgent = this._discussionCapabilities.agentMode === true;
                        if (isAutonomousAgent && this._discussionCapabilities.autoFix && failedBatchItems.length > 0 && !isUndoMode && !applyCtrl.signal.aborted) {
                            await this.handleBatchApplyFailures(failedBatchItems, messageId);
                        } else if (failedBatchItems.length > 0) {
                            this.log(`[Batch Apply] ${failedBatchItems.length} update(s) failed to apply. Skipping automatic retry in assistant mode.`, 'INFO');
                        }
                    };

                    runBatch();
                    break;
                }
            case 'renameFile':
                vscode.commands.executeCommand('lollms-vs-coder.renameFile', message.originalPath, message.newPath);
                break;
            case 'deleteFile':
                {
                    const pathsToDelete = Array.isArray(message.filePaths)
                        ? message.filePaths
                        : String(message.filePaths || '').split(/[\r\n,]+/).map((p: string) => p.trim()).filter(Boolean);

                    if (this._discussionCapabilities.fileDelete === false) {
                        vscode.window.showWarningMessage('File deletion is disabled in Discussion Settings.');
                        webview.postMessage({
                            command: 'deleteFilesResult',
                            blockId: message.blockId,
                            rowId: message.rowId,
                            deletedPaths: [],
                            failedPaths: pathsToDelete,
                            cancelled: false
                        });
                        break;
                    }

                    const delResult: any = await vscode.commands.executeCommand('lollms-vs-coder.deleteFile', pathsToDelete, { skipConfirm: false });
                    webview.postMessage({
                        command: 'deleteFilesResult',
                        blockId: message.blockId,
                        rowId: message.rowId,
                        deletedPaths: delResult?.deletedPaths || [],
                        failedPaths: delResult?.failedPaths || [],
                        cancelled: !!delResult?.cancelled
                    });
                }
                break;
            case 'insertCode':
                vscode.commands.executeCommand('lollms-vs-coder.insertCode', message.filePath, message.content);
                break;
            case 'replaceCode':
                try {
                    const normalizedContent = normalizeAiderContent(message.content);
                    const isUndo = message.options?.undo === true;
                    const isManual = !message.options?.silent && !isUndo;
                    const opts = {
                        silent: !isManual,
                        autoSave: !isManual,
                        undo: isUndo,
                        messageId: message.messageId,
                        blockIndex: message.blockIndex,
                        hunkIndex: message.hunkIndex,
                        blockId: message.blockId || message.options?.blockId,
                        ...(message.options || {})
                    };

                    const res: any = await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', message.filePath, normalizedContent, this, message.messageId, opts);

                    if (res && res.success) {
                        if (message.filePath) {
                            await this.unmuteFiles([message.filePath]);
                            await this._contextManager.getContextStateProvider()?.addFilesToContext([message.filePath]);
                            const resPath = await this._contextManager.resolveWorkspaceFromPath(message.filePath);
                            if (resPath) this._contextManager.refreshFileInCache(resPath.uri);
                        }
                        if (opts.silent || isUndo) {
                            if (message.blockIndex !== undefined && message.messageId) {
                                await this.updateAppliedState(message.messageId, message.blockIndex, message.hunkIndex, isUndo);
                            }
                            webview.postMessage({
                                command: 'applyAllResult',
                                messageId: message.messageId,
                                filePath: message.filePath,
                                blockIndex: message.blockIndex,
                                hunkIndex: message.hunkIndex,
                                blockId: message.blockId || message.options?.blockId,
                                success: true,
                                alreadyApplied: !isUndo,
                                undo: isUndo
                            });
                            if (!isUndo) {
                                this.auditFileDiagnostics(message.filePath, message.messageId, message.blockIndex, message.blockId || message.options?.blockId);
                            }
                        } else {
                            webview.postMessage({
                                command: 'applyAllResult',
                                messageId: message.messageId,
                                filePath: message.filePath,
                                blockIndex: message.blockIndex,
                                hunkIndex: message.hunkIndex,
                                blockId: message.blockId || message.options?.blockId,
                                success: true,
                                reviewingDiff: true
                            });
                        }
                    } else if (res && res.succeededHunks && res.succeededHunks.length > 0) {
                        // Apply and persist succeeded hunks immediately to discussion state and disk
                        for (const sIdx of res.succeededHunks) {
                            if (message.blockIndex !== undefined && message.messageId) {
                                await this.updateAppliedState(message.messageId, message.blockIndex, sIdx, isUndo);
                            }
                            webview.postMessage({
                                command: 'applyAllResult',
                                messageId: message.messageId,
                                filePath: message.filePath,
                                blockIndex: message.blockIndex,
                                hunkIndex: sIdx,
                                blockId: message.blockId || message.options?.blockId,
                                success: true,
                                alreadyApplied: !isUndo,
                                undo: isUndo
                            });
                        }
                        for (const f of (res.failedHunks || [])) {
                            webview.postMessage({
                                command: 'applyAllResult',
                                messageId: message.messageId,
                                filePath: message.filePath,
                                blockIndex: message.blockIndex,
                                hunkIndex: f.index,
                                blockId: message.blockId || message.options?.blockId,
                                success: false,
                                error: f.error,
                                undo: isUndo
                            });
                        }
                    } else {
                        webview.postMessage({
                            command: 'applyAllResult',
                            messageId: message.messageId,
                            filePath: message.filePath,
                            blockIndex: message.blockIndex,
                            hunkIndex: message.hunkIndex,
                            blockId: message.blockId || message.options?.blockId,
                            success: false,
                            error: res?.error
                        });
                    }
                } catch (e: any) {
                    this.log(`Command replaceCode failed: ${e.message}`, 'ERROR');
                    webview.postMessage({ 
                        command: 'applyAllResult', 
                        messageId: message.messageId, 
                        blockIndex: message.blockIndex, 
                        hunkIndex: message.hunkIndex, 
                        blockId: message.blockId || message.options?.blockId, 
                        filePath: message.filePath, 
                        success: false, 
                        error: e.message 
                    });
                }
                break;
            case 'deleteCodeBlock':
                try {
                    const isManual = !message.options?.silent;
                    const opts = {
                        silent: !isManual,
                        autoSave: !isManual,
                        messageId: message.messageId,
                        blockIndex: message.blockIndex,
                        hunkIndex: message.hunkIndex,
                        blockId: message.blockId || message.options?.blockId,
                        ...(message.options || {})
                    };
                    const res: any = await vscode.commands.executeCommand('lollms-vs-coder.deleteCodeBlock', message.filePath, message.content, opts);
                    if (res && res.success) {
                        if (message.filePath) {
                            await this.unmuteFiles([message.filePath]);
                            const resPath = await this._contextManager.resolveWorkspaceFromPath(message.filePath);
                            if (resPath) this._contextManager.refreshFileInCache(resPath.uri);
                        }
                        if (opts.silent) {
                            if (message.blockIndex !== undefined && message.messageId) {
                                await this.updateAppliedState(message.messageId, message.blockIndex);
                            }
                            webview.postMessage({
                                command: 'applyAllResult',
                                messageId: message.messageId,
                                filePath: message.filePath,
                                blockIndex: message.blockIndex,
                                blockId: opts.blockId,
                                success: true,
                                alreadyApplied: true
                            });
                            this.auditFileDiagnostics(message.filePath, message.messageId, message.blockIndex, opts.blockId);
                        } else {
                            webview.postMessage({
                                command: 'applyAllResult',
                                messageId: message.messageId,
                                filePath: message.filePath,
                                blockIndex: message.blockIndex,
                                blockId: opts.blockId,
                                success: true,
                                reviewingDiff: true
                            });
                        }
                    } else {
                        webview.postMessage({
                            command: 'applyAllResult',
                            messageId: message.messageId,
                            filePath: message.filePath,
                            blockIndex: message.blockIndex,
                            blockId: opts.blockId,
                            success: false,
                            error: res?.error || 'Could not locate code to delete.'
                        });
                    }
                } catch (e: any) {
                    webview.postMessage({
                        command: 'applyAllResult',
                        messageId: message.messageId,
                        filePath: message.filePath,
                        blockIndex: message.blockIndex,
                        blockId: message.blockId || message.options?.blockId,
                        success: false,
                        error: e.message
                    });
                }
                break;
            case 'copyFilesToClipboard':
                {
                    const filesToCopy = Array.isArray(message.files) ? message.files : [];
                    if (filesToCopy.length > 0) {
                        vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: "Lollms: Copying files to clipboard...",
                            cancellable: false
                        }, async (progress) => {
                            try {
                                const content = await this._contextManager.readSpecificFiles(filesToCopy);
                                if (content) {
                                    await vscode.env.clipboard.writeText(content);
                                    vscode.window.showInformationMessage(`✅ Copied ${filesToCopy.length} files to clipboard.`);
                                } else {
                                    vscode.window.showErrorMessage("Failed to read any of the requested files.");
                                }
                            } catch (e: any) {
                                vscode.window.showErrorMessage(`Copy failed: ${e.message}`);
                            }
                        });
                    }
                }
                break;
            case 'copyAllMessageActions':
                {
                    const actions = Array.isArray(message.actions) ? message.actions : [];
                    if (actions.length === 0) break;

                    vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: "Lollms: Copying requested context & scouting outputs to clipboard...",
                        cancellable: false
                    }, async () => {
                        try {
                            const chunks: string[] = [];
                            const seenFullFiles = new Set<string>();
                            const { showSymbolTool } = require('../../tools/builtins/showSymbol');
                            const { readExternalFileTool } = require('../../tools/builtins/readExternalFile');
                            const env = {
                                agentManager: this.agentManager,
                                contextManager: this._contextManager,
                                lollmsApi: this._lollmsAPI,
                                workspaceRoot: vscode.workspace.workspaceFolders?.[0],
                                currentPlan: (this.agentManager as any)?.currentPlan || null
                            };

                            for (const act of actions) {
                                if (act.type === 'add_context' || act.type === 'unmute' || act.type === 'read_full_file') {
                                    const rawPaths = Array.isArray(act.payload) ? act.payload : (act.payload?.path ? [act.payload.path] : []);
                                    const toRead = rawPaths.filter((p: string) => {
                                        const norm = String(p || '').replace(/\\/g, '/').toLowerCase().trim();
                                        if (!norm || seenFullFiles.has(norm)) return false;
                                        seenFullFiles.add(norm);
                                        return true;
                                    });
                                    if (toRead.length > 0) {
                                        const filesContent = await this._contextManager.readSpecificFiles(toRead);
                                        if (filesContent) chunks.push(filesContent.trim());
                                    }
                                } else if (act.type === 'show_symbol' && act.payload) {
                                    const res = await showSymbolTool.execute(
                                        {
                                            target: act.payload.target,
                                            symbol: act.payload.symbol,
                                            symbols: act.payload.symbols
                                        },
                                        env as any,
                                        new AbortController().signal
                                    );
                                    if (res?.output) chunks.push(res.output.trim());
                                } else if (act.type === 'load_structure') {
                                    const files = Array.isArray(act.payload) ? act.payload : [act.payload];
                                    for (const p of files) {
                                        if (!p) continue;
                                        const res = await this._contextManager.resolveWorkspaceFromPath(p);
                                        if (res) {
                                            const defs = await this._contextManager.extractDefinitions(res.uri);
                                            chunks.push(`### 📋 Definitions & Signatures for \`${p}\`:\n\`\`\`typescript\n${defs}\n\`\`\``);
                                        }
                                    }
                                } else if (act.type === 'manage_symbols' && act.payload?.path) {
                                    const res = await this._contextManager.resolveWorkspaceFromPath(act.payload.path);
                                    if (res) {
                                        const syms = Array.isArray(act.payload.activate) ? act.payload.activate : [];
                                        const symText = syms.length > 0
                                            ? await this._contextManager.extractDefinitionsAndSymbols(res.uri, syms)
                                            : await this._contextManager.extractDefinitions(res.uri);
                                        chunks.push(`### 🧩 Symbols for \`${act.payload.path}\`:\n\`\`\`typescript\n${symText}\n\`\`\``);
                                    }
                                } else if (act.type === 'peek' && Array.isArray(act.payload)) {
                                    const peekResults = await this._contextManager.peekFiles(act.payload);
                                    const text = peekResults
                                        .map(r => r.error ? `// ${r.path}: ${r.error}` : `// --- ${r.path} ---\n${r.content}`)
                                        .join('\n\n');
                                    if (text) chunks.push(text.trim());
                                } else if (act.type === 'read_external_file') {
                                    const extRes = await readExternalFileTool.execute(act.payload || {}, env as any, new AbortController().signal);
                                    if (extRes?.output) chunks.push(extRes.output.trim());
                                } else if (act.type === 'grep' && act.payload?.pattern) {
                                    const searchRes = await this._contextManager.searchWorkspaceContent(
                                        act.payload.pattern,
                                        { matchCase: false, wholeWord: false, include: act.payload.path, bypassGate: true }
                                    );
                                    const snippet = searchRes.length > 0
                                        ? searchRes.slice(0, 25).map(r => `${r.path}:${r.line} - ${r.snippet}`).join('\n')
                                        : 'No matches found.';
                                    chunks.push(`### 🔍 GREP RESULTS FOR "${act.payload.pattern}":\n\`\`\`\n${snippet}\n\`\`\``);
                                } else if (act.type === 'sparql' && act.payload?.query) {
                                    const { KnowledgeManager } = require('../../knowledgeManager');
                                    const km = new KnowledgeManager(this._discussionManager.context);
                                    const sparqlOut = await km.executeSparql(act.payload.query, vscode.workspace.workspaceFolders?.[0]);
                                    chunks.push(`### 📊 SPARQL RESULT:\n${sparqlOut}`);
                                } else if (act.type === 'unpack_directory') {
                                    const dirs = Array.isArray(act.payload?.dirs) ? act.payload.dirs : (Array.isArray(act.payload) ? act.payload : []);
                                    for (const dir of dirs) {
                                        const res = await this._contextManager.unpackDirectory(dir);
                                        if (res?.message) chunks.push(res.message);
                                    }
                                } else if (act.type === 'load_knowledge' && act.payload?.path) {
                                    const { KnowledgeManager } = require('../../knowledgeManager');
                                    const km = new KnowledgeManager(this._discussionManager.context);
                                    const secContent = await km.readSectionKnowledge(act.payload.path);
                                    chunks.push(`### 📖 KNOWLEDGE SECTION \`${act.payload.path}\`:\n\`\`\`markdown\n${secContent || '(Section content empty)'}\n\`\`\``);
                                } else if (act.type === 'mute' || act.type === 'remove_context') {
                                    const paths = Array.isArray(act.payload) ? act.payload : [];
                                    if (paths.length > 0) {
                                        chunks.push(`<!-- ${act.type === 'mute' ? 'Mute' : 'Remove from context'}: ${paths.join(', ')} -->`);
                                    }
                                }
                            }

                            const combined = chunks.filter(Boolean).join('\n\n');
                            if (combined) {
                                await vscode.env.clipboard.writeText(combined);
                                vscode.window.showInformationMessage(`✅ Copied ${actions.length} scouting/context item(s) in order to clipboard.`);
                            } else {
                                vscode.window.showWarningMessage("No content could be extracted from the requested actions.");
                            }
                        } catch (e: any) {
                            vscode.window.showErrorMessage(`Copy All failed: ${e.message}`);
                        }
                    });
                }
                break;
            case 'checkFilesStatus':
                {
                    const { files, blockId } = message;
                    const fileList: string[] = Array.isArray(files) ? files : [];
                    const statuses: Record<string, 'in_context' | 'not_in_context' | 'not_found' | 'muted'> = {};

                    if (this._contextManager) {
                        const provider = this._contextManager.getContextStateProvider();
                        const includedSet = new Set(
                            provider ? provider.getIncludedFiles().map(f => f.path.replace(/\\/g, '/').toLowerCase()) : []
                        );
                        const mutedFiles = this._currentDiscussion?.mutedFiles || [];
                        const { arePathsEqual: arePathsEqualCheck } = require('../../utils');

                        for (const filePath of fileList) {
                            const cleanPath = filePath.trim();
                            if (!cleanPath) continue;

                            const normPath = cleanPath.replace(/\\/g, '/').toLowerCase();
                            const isMuted = mutedFiles.some((m: string) => arePathsEqualCheck(m, cleanPath));

                            if (isMuted) {
                                statuses[cleanPath] = 'muted';
                                continue;
                            }

                            const isIncluded = includedSet.has(normPath) || 
                                               Array.from(includedSet).some(inc => inc === normPath || inc.endsWith('/' + normPath) || normPath.endsWith('/' + inc));

                            if (isIncluded) {
                                statuses[cleanPath] = 'in_context';
                            } else {
                                const res = await this._contextManager.resolveWorkspaceFromPath(cleanPath);
                                if (res) {
                                    try {
                                        const stat = await Promise.resolve(vscode.workspace.fs.stat(res.uri)).catch(() => null);
                                        statuses[cleanPath] = stat ? 'not_in_context' : 'not_found';
                                    } catch {
                                        statuses[cleanPath] = 'not_found';
                                    }
                                } else {
                                    statuses[cleanPath] = 'not_found';
                                }
                            }
                        }
                    }

                    webview.postMessage({
                        command: 'filesStatusResult',
                        blockId,
                        statuses
                    });
                }
                break;
            case 'executeShowSymbol':
                {
                    const { target, symbol, symbols, path: filePath, reprompt, copyOnly } = message;
                    const { showSymbolTool } = require('../../tools/builtins/showSymbol');
                    const env = {
                        contextManager: this._contextManager,
                        lollmsApi: this._lollmsAPI,
                        workspaceRoot: vscode.workspace.workspaceFolders?.[0],
                        currentPlan: null
                    };
                    const res = await showSymbolTool.execute({ target, symbol, symbols, path: filePath }, env as any, new AbortController().signal);
                    if (copyOnly) {
                        if (res.output) {
                            await vscode.env.clipboard.writeText(res.output);
                            vscode.window.showInformationMessage("Symbol code copied to clipboard.");
                        } else {
                            vscode.window.showErrorMessage("Failed to extract symbol code.");
                        }
                    } else if (reprompt) {
                        await this.sendMessage({
                            role: 'user',
                            content: `Here is the requested symbol implementation code:\n\n${res.output}\n\nPlease proceed with your task.`
                        });
                    } else {
                        await this.addMessageToDiscussion({
                            role: 'system',
                            content: res.output,
                            skipInPrompt: false
                        });
                    }
                }
                break;
            case 'peekFilesAndCopy':
                {
                    const filesToPeek = Array.isArray(message.files) ? message.files : [];
                    if (this._contextManager && filesToPeek.length > 0) {
                        try {
                            const peekResults = await this._contextManager.peekFiles(filesToPeek);
                            const text = peekResults.map(r => r.error ? `// ${r.path}: ${r.error}` : `// --- ${r.path} ---\n${r.content}`).join('\n\n');
                            await vscode.env.clipboard.writeText(text);
                            vscode.window.showInformationMessage(`Copied peeked slice of ${peekResults.length} file(s) to clipboard.`);
                        } catch (err: any) {
                            vscode.window.showErrorMessage(`Peek failed: ${err.message}`);
                        }
                    }
                }
                break;
            case 'copyStructureToClipboard':
                {
                    const files = Array.isArray(message.files) ? message.files : (message.path ? [message.path] : []);
                    if (this._contextManager && files.length > 0) {
                        try {
                            const defsLog: string[] = [];
                            for (const p of files) {
                                const res = await this._contextManager.resolveWorkspaceFromPath(p);
                                if (res) {
                                    const defs = await this._contextManager.extractDefinitions(res.uri);
                                    defsLog.push(`### 📋 Definitions & Signatures for \`${p}\`:\n\`\`\`typescript\n${defs}\n\`\`\``);
                                } else {
                                    defsLog.push(`### ❌ File \`${p}\`\n(File not found)`);
                                }
                            }
                            const text = defsLog.join('\n\n');
                            await vscode.env.clipboard.writeText(text);
                            vscode.window.showInformationMessage(`Copied structure & signatures for ${files.length} file(s) to clipboard.`);
                        } catch (err: any) {
                            vscode.window.showErrorMessage(`Failed to copy structure: ${err.message}`);
                        }
                    }
                }
                break;
            case 'executePeekAndReprompt':
                {
                    const filesToPeek = Array.isArray(message.files) ? message.files : [];
                    if (this._contextManager && filesToPeek.length > 0) {
                        try {
                            const peekResults = await this._contextManager.peekFiles(filesToPeek);
                            const formattedResults = peekResults.map(r => {
                                if (r.error) return `### ❌ File \`${r.path}\`\nError: ${r.error}`;
                                return `### 📄 PEEK SLICE: \`${r.path}\`\n\`\`\`\n${r.content}\n\`\`\``;
                            }).join('\n\n');

                            const repromptMsg: ChatMessage = {
                                role: 'user',
                                content: `Here is the requested inspection content from disk:\n\n${formattedResults}\n\nPlease proceed with your analysis or code implementation based on this inspection.`
                            };

                            await this.sendMessage(repromptMsg);
                        } catch (err: any) {
                            vscode.window.showErrorMessage(`Peek and Reprompt failed: ${err.message}`);
                        }
                    }
                }
                break;
            case 'loadFilesStructure':
                {
                    const { files, blockId, reprompt } = message;
                    const filesToLoad: string[] = Array.isArray(files) ? files : (message.path ? [message.path] : []);
                    if (filesToLoad.length === 0) break;

                    try {
                        await this.unmuteFiles(filesToLoad);
                        await this.addFilesToDiscussionContext(filesToLoad, 'definitions-only');

                        const provider = this._contextManager.getContextStateProvider();
                        if (provider) {
                            const urisToSet: vscode.Uri[] = [];
                            for (const p of filesToLoad) {
                                const res = await this._contextManager.resolveWorkspaceFromPath(p);
                                if (res) {
                                    urisToSet.push(res.uri);
                                    this._contextManager.refreshFileInCache(res.uri);
                                }
                            }
                            if (urisToSet.length > 0) {
                                await provider.setStateForUris(urisToSet, 'definitions-only');
                            }
                        }

                        this.recordCurrentPromptFiles(filesToLoad);
                        await this.updateContextAndTokens({ isBackgroundSync: false });

                        webview.postMessage({
                            command: 'structureLoaded',
                            blockId: blockId,
                            files: filesToLoad,
                            success: true
                        });

                        vscode.window.showInformationMessage(`Loaded structure & signatures for ${filesToLoad.length} file(s) into context.`);

                        if (reprompt) {
                            const defsLog: string[] = [];
                            for (const p of filesToLoad) {
                                const res = await this._contextManager.resolveWorkspaceFromPath(p);
                                if (res) {
                                    const defs = await this._contextManager.extractDefinitions(res.uri);
                                    defsLog.push(`### 📋 Definitions & Signatures for \`${p}\`:\n\`\`\`typescript\n${defs}\n\`\`\``);
                                }
                            }
                            await this.sendMessage({
                                role: 'user',
                                content: `Here is the requested structure and typed signatures:\n\n${defsLog.join('\n\n')}\n\nPlease proceed with your task.`
                            });
                        }
                    } catch (err: any) {
                        Logger.error(`loadFilesStructure failed: ${err.message}`);
                        webview.postMessage({
                            command: 'structureLoaded',
                            blockId: blockId,
                            files: filesToLoad,
                            success: false,
                            error: err.message
                        });
                        vscode.window.showErrorMessage(`Failed to load structure: ${err.message}`);
                    }
                }
                break;
            case 'executeAllMessageActions':
                {
                    const { actions, messageId } = message;
                    if (!Array.isArray(actions) || actions.length === 0) return;

                    const resultsLog: string[] = [];
                    const provider = this._contextManager.getContextStateProvider();
                    const folders = vscode.workspace.workspaceFolders;

                    const { id: execProcId, controller: execCtrl } = this.processManager.register(
                        this.discussionId,
                        `Executing ${actions.length} action(s)...`
                    );
                    this.updateGeneratingState();

                    try {
                        for (let i = 0; i < actions.length; i++) {
                            if (execCtrl.signal.aborted) {
                                this.log("Batch tool execution aborted by user.");
                                break;
                            }

                            const action = actions[i];
                            const actionName = action.name || (action.type === 'tool' ? action.payload?.name : action.type);
                            const actionIdx = action.index !== undefined ? action.index : i;

                            this.processManager.updateDescription(execProcId, `Executing tool (${i + 1}/${actions.length}): ${actionName}...`);
                            this.updateGeneratingState();

                            // 1. Notify UI: Item processing started
                            this._panel.webview.postMessage({
                                command: 'executeActionStart',
                                messageId,
                                actionIndex: actionIdx,
                                actionId: action.id,
                                blockId: action.blockId,
                                actionType: action.type,
                                actionName,
                                currentIndex: i,
                                totalCount: actions.length
                            });

                            let isSuccess = true;
                            let outputText = '';

                            try {
                                if (action.type === 'peek') {
                                    const peekRes = await this._contextManager.peekFiles(action.payload);
                                    const sliceText = peekRes.map(r => r.error ? `[${r.path}: ${r.error}]` : `### 📄 ${r.path}\n\`\`\`\n${r.content}\n\`\`\``).join('\n\n');
                                    isSuccess = !peekRes.some(r => r.error);
                                    outputText = sliceText;
                                    resultsLog.push(`#### ✅ Peek Execution (${action.payload.length} files)\n${sliceText}`);
                                } else if (action.type === 'add_context') {
                                    const unmutedCount = await this.unmuteFiles(action.payload);
                                    const added = await provider?.addFilesToContext(action.payload) || [];
                                    this.recordCurrentPromptFiles(action.payload);
                                    const unmuteNotice = unmutedCount > 0 ? ` (Unmuted ${unmutedCount} file(s))` : '';
                                    isSuccess = added.length > 0 || unmutedCount > 0 || action.payload.length > 0;
                                    outputText = `Added to context: [${action.payload.join(', ')}]${unmuteNotice}`;
                                    resultsLog.push(`#### ✅ Added to Context: [${action.payload.join(', ')}]${unmuteNotice}`);
                                } else if (action.type === 'unmute') {
                                    const count = await this.unmuteFiles(action.payload);
                                    await provider?.addFilesToContext(action.payload);
                                    this.recordCurrentPromptFiles(action.payload);
                                    isSuccess = count > 0 || action.payload.length > 0;
                                    outputText = `Unmuted ${action.payload.length} file(s): [${action.payload.join(', ')}]`;
                                    resultsLog.push(`#### ✅ Unmuted Files: [${action.payload.join(', ')}] (${count} files reactivated with full content)`);
                                } else if (action.type === 'mute') {
                                    const paths = Array.isArray(action.payload) ? action.payload : [];
                                    const count = await this.muteFiles(paths);
                                    isSuccess = paths.length > 0;
                                    outputText = `Muted ${count} file(s): [${paths.join(', ')}]`;
                                    resultsLog.push(`#### ✅ Muted Files: [${paths.join(', ')}]`);
                                } else if (action.type === 'remove_context') {
                                    const paths = Array.isArray(action.payload) ? action.payload : [];
                                    const uris: vscode.Uri[] = [];
                                    for (const p of paths) {
                                        const res = await this._contextManager.resolveWorkspaceFromPath(p);
                                        if (res) {
                                            uris.push(res.uri);
                                            this._contextManager.refreshFileInCache(res.uri);
                                        }
                                    }
                                    if (provider) {
                                        await (provider as any).removeFiles?.(paths);
                                        if (uris.length > 0) await provider.setStateForUris(uris, 'tree-only');
                                    }
                                    await this.removeFilesFromDiscussionContext(paths);
                                    isSuccess = paths.length > 0;
                                    outputText = `Removed from context: [${paths.join(', ')}]`;
                                    resultsLog.push(`#### ✅ Removed from Context: [${paths.join(', ')}]`);
                                } else if (action.type === 'load_structure') {
                                    const files = Array.isArray(action.payload) ? action.payload : [action.payload];
                                    await this.unmuteFiles(files);
                                    await this.addFilesToDiscussionContext(files, 'definitions-only');

                                    if (provider) {
                                        const urisToSet: vscode.Uri[] = [];
                                        for (const p of files) {
                                            const res = await this._contextManager.resolveWorkspaceFromPath(p);
                                            if (res) {
                                                urisToSet.push(res.uri);
                                                this._contextManager.refreshFileInCache(res.uri);
                                            }
                                        }
                                        if (urisToSet.length > 0) {
                                            await provider.setStateForUris(urisToSet, 'definitions-only');
                                        }
                                    }
                                    this.recordCurrentPromptFiles(files);

                                    const defsLog: string[] = [];
                                    for (const p of files) {
                                        const res = await this._contextManager.resolveWorkspaceFromPath(p);
                                        if (res) {
                                            const defs = await this._contextManager.extractDefinitions(res.uri);
                                            defsLog.push(`### 📋 Definitions & Signatures for \`${p}\`:\n\`\`\`typescript\n${defs}\n\`\`\``);
                                        }
                                    }
                                    isSuccess = defsLog.length > 0;
                                    outputText = `Loaded structure & signatures for [${files.join(', ')}]`;
                                    resultsLog.push(`#### ✅ Structure & Signatures Loaded for [${files.join(', ')}]\n${defsLog.join('\n\n')}`);
                                } else if (action.type === 'manage_symbols') {
                                    const p = action.payload?.path || '';
                                    const actList = Array.isArray(action.payload?.activate) ? action.payload.activate : [];
                                    const deactList = Array.isArray(action.payload?.deactivate) ? action.payload.deactivate : [];
                                    const modeVal = action.payload?.mode === 'all' || action.payload?.mode === 'none' ? action.payload.mode : undefined;
                                    const res = await this.applySymbolBatchUpdate(p, actList, deactList, modeVal);
                                    isSuccess = res.success;
                                    outputText = res.message;
                                    resultsLog.push(`#### ${res.success ? '✅' : '❌'} Manage Symbols (${p})\n${res.message}`);
                                } else if (action.type === 'read_full_file') {
                                    const reqPath = action.payload?.path || '';
                                    const res = await this._contextManager.resolveWorkspaceFromPath(reqPath);
                                    if (res) {
                                        const fileBytes = await vscode.workspace.fs.readFile(res.uri);
                                        const text = Buffer.from(fileBytes).toString('utf8');
                                        isSuccess = true;
                                        outputText = `### 📄 FULL FILE: \`${reqPath}\`\n${this.wrapInSafeCodeFence(text)}`;
                                        resultsLog.push(`#### ✅ Read File (${reqPath})\n${outputText}`);
                                    } else {
                                        isSuccess = false;
                                        outputText = `Error: Could not resolve path "${reqPath}" on disk.`;
                                        resultsLog.push(`#### ❌ Read File (${reqPath})\n${outputText}`);
                                    }
                                } else if (action.type === 'grep') {
                                    const pattern = action.payload?.pattern || '';
                                    const subPath = action.payload?.path || undefined;
                                    const searchRes = await this._contextManager.searchWorkspaceContent(
                                        pattern,
                                        { matchCase: false, wholeWord: false, include: subPath, bypassGate: true },
                                        execCtrl.signal
                                    );
                                    const snippet = searchRes.length > 0
                                        ? searchRes.slice(0, 15).map(r => `${r.path}:${r.line} - ${r.snippet}`).join('\n')
                                        : 'No matches found in workspace.';
                                    isSuccess = true;
                                    outputText = `### 🔍 GREP RESULTS FOR "${pattern}" (${searchRes.length} hits):\n${this.wrapInSafeCodeFence(snippet)}`;
                                    resultsLog.push(`#### ✅ Grep "${pattern}" (${searchRes.length} hits)\n${outputText}`);
                                } else if (action.type === 'unpack_directory') {
                                    const dirs = Array.isArray(action.payload?.dirs) ? action.payload.dirs : [];
                                    const msgs: string[] = [];
                                    let allOk = true;
                                    for (const dir of dirs) {
                                        const res = await this._contextManager.unpackDirectory(dir);
                                        msgs.push(res.message);
                                        if (!res.success) allOk = false;
                                    }
                                    isSuccess = allOk;
                                    outputText = msgs.join('\n\n');
                                    resultsLog.push(`#### ${allOk ? '✅' : '❌'} Unpack Directory (${dirs.join(', ')})\n${outputText}`);
                                } else if (action.type === 'sparql') {
                                    const query = action.payload?.query || '';
                                    const { KnowledgeManager } = require('../../knowledgeManager');
                                    const km = new KnowledgeManager(this._discussionManager.context);
                                    const sparqlOut = await km.executeSparql(query, folders?.[0]);
                                    isSuccess = !String(sparqlOut).includes('Error');
                                    outputText = sparqlOut || 'No matches.';
                                    resultsLog.push(`#### ${isSuccess ? '✅' : '❌'} SPARQL Query\n${outputText}`);
                                } else if (action.type === 'load_knowledge') {
                                    const secPath = action.payload?.path || '';
                                    const { KnowledgeManager } = require('../../knowledgeManager');
                                    const km = new KnowledgeManager(this._discussionManager.context);
                                    const newScore = await km.incrementAccessCount(secPath);
                                    const secContent = await km.readSectionKnowledge(secPath);
                                    isSuccess = true;
                                    outputText = `### 📖 KNOWLEDGE SECTION LOADED: \`${secPath}\` [${newScore}]\n\`\`\`markdown\n${secContent || '(Empty)'}\n\`\`\``;
                                    resultsLog.push(`#### ✅ Load Knowledge (${secPath})\n${outputText}`);
                                } else if (action.type === 'show_symbol') {
                                    const { showSymbolTool } = require('../../tools/builtins/showSymbol');
                                    const env = {
                                        contextManager: this._contextManager,
                                        lollmsApi: this._lollmsAPI,
                                        workspaceRoot: folders?.[0],
                                        currentPlan: null
                                    };
                                    const symRes = await showSymbolTool.execute({
                                        target: action.payload.target,
                                        symbol: action.payload.symbol,
                                        symbols: action.payload.symbols
                                    }, env as any, execCtrl.signal);
                                    isSuccess = symRes.success;
                                    outputText = symRes.output;
                                    const label = action.payload.symbols 
                                        ? (Array.isArray(action.payload.symbols) ? action.payload.symbols.join(', ') : action.payload.symbols)
                                        : (action.payload.symbol || action.payload.target);
                                    resultsLog.push(`#### ${symRes.success ? '✅' : '❌'} Symbols: ${action.payload.target || ''} [${label}]\n${symRes.output}`);
                                } else if (action.type === 'read_external_file') {
                                    const { readExternalFileTool } = require('../../tools/builtins/readExternalFile');
                                    const env = {
                                        agentManager: this.agentManager,
                                        workspaceRoot: folders?.[0],
                                        contextManager: this._contextManager,
                                        lollmsApi: this._lollmsAPI,
                                        currentPlan: (this.agentManager as any)?.currentPlan || null
                                    };
                                    const extRes = await readExternalFileTool.execute(action.payload || {}, env as any, execCtrl.signal);
                                    isSuccess = extRes.success;
                                    outputText = extRes.output;
                                    const label = action.payload?.path || 'External Files List';
                                    resultsLog.push(`#### ${extRes.success ? '✅' : '❌'} Read External File (${label})\n${extRes.output}`);
                                } else if (action.type === 'run_tests') {
                                    const { runTestsTool } = require('../../tools/builtins/runTests');
                                    const env = {
                                        agentManager: this.agentManager,
                                        workspaceRoot: folders?.[0],
                                        contextManager: this._contextManager,
                                        lollmsApi: this._lollmsAPI,
                                        currentPlan: (this.agentManager as any)?.currentPlan || null
                                    };
                                    const testRes = await runTestsTool.execute(action.payload || {}, env as any, execCtrl.signal);
                                    isSuccess = testRes.success;
                                    outputText = testRes.output;
                                    const label = Array.isArray(action.payload?.targets) ? action.payload.targets.join(', ') : (action.payload?.targets || 'tests');
                                    resultsLog.push(`#### ${testRes.success ? '✅' : '❌'} Run Tests (${label})\n${testRes.output}`);
                                } else if (action.type === 'tool') {
                                    const toolDef = this.agentManager.getTools().find((t: any) => t.name === action.payload.name);
                                    if (toolDef) {
                                        const env = {
                                            workspaceRoot: vscode.workspace.workspaceFolders?.[0],
                                            lollmsApi: this._lollmsAPI,
                                            contextManager: this._contextManager,
                                            agentManager: this.agentManager,
                                            skillsManager: this._skillsManager,
                                            codeGraphManager: this._codeGraphManager,
                                            personalityManager: this._personalityManager,
                                            currentPlan: (this.agentManager as any)?.currentPlan || null
                                        };
                                        const toolRes = await toolDef.execute(action.payload.params || {}, env as any, execCtrl.signal);
                                        isSuccess = toolRes.success;
                                        outputText = toolRes.output;
                                        resultsLog.push(`#### ${toolRes.success ? '✅' : '❌'} Tool: ${action.payload.name}\n${toolRes.output}`);
                                    } else {
                                        isSuccess = false;
                                        outputText = `Tool '${action.payload.name}' not found.`;
                                        resultsLog.push(`#### ❌ Tool Not Found: ${action.payload.name}`);
                                    }
                                }
                            } catch (actionErr: any) {
                                isSuccess = false;
                                outputText = actionErr.message;
                                resultsLog.push(`#### ❌ Action Error: ${actionErr.message}`);
                            }

                            // 2. Notify UI: Item processing finished
                            this._panel.webview.postMessage({
                                command: 'executeActionResult',
                                messageId,
                                actionIndex: actionIdx,
                                actionId: action.id,
                                blockId: action.blockId,
                                actionType: action.type,
                                actionName,
                                success: isSuccess,
                                output: outputText,
                                currentIndex: i,
                                totalCount: actions.length
                            });
                        }
                    } finally {
                        this.processManager.unregister(execProcId);
                        this.updateGeneratingState();
                        this.updateContextAndTokens();
                    }

                    if (!execCtrl.signal.aborted && resultsLog.length > 0) {
                        const justAddedInBatch: string[] = [];
                        for (const act of actions) {
                            if ((act.type === 'add_context' || act.type === 'unmute') && Array.isArray(act.payload)) {
                                justAddedInBatch.push(...act.payload);
                            } else if (act.type === 'load_structure' && Array.isArray(act.payload)) {
                                justAddedInBatch.push(...act.payload);
                            } else if (act.type === 'manage_symbols' && act.payload?.path) {
                                justAddedInBatch.push(act.payload.path);
                            }
                        }
                        if (justAddedInBatch.length > 0) {
                            this.recordPendingJustAddedFiles(justAddedInBatch);
                        }
                        if (message.reprompt !== false) {
                            const observationPrompt = `### 📋 BATCH EXECUTION RESULTS (${actions.length} actions executed in order)\n\n${resultsLog.join('\n\n---\n\n')}\n\nReview the observation results above and proceed with your technical answer.`;
                            await this.sendMessage({ role: 'user', content: observationPrompt });
                        } else {
                            vscode.window.showInformationMessage(`✅ Applied ${actions.length} scouting/context action(s) in order.`);
                        }
                    }
                }
                break;
            case 'addFilesToContext':
                {
                    const blockId = message.blockId;
                    const filesToAdd = Array.isArray(message.files) ? message.files : [];
                    const reprompt = message.reprompt;
                    const results: { [key: string]: boolean } = {};

                    try {
                        // Unmute any files in filesToAdd that were previously muted
                        await this.unmuteFiles(filesToAdd);

                        const provider = this._contextManager.getContextStateProvider();
                        if (provider) {
                            // The updated provider now returns the list of strings that were actually matched
                            const addedPaths = await provider.addFilesToContext(filesToAdd);

                            // Map results for UI feedback
                            filesToAdd.forEach((f: string) => {
                                results[f] = addedPaths.includes(f);
                            });

                            if (addedPaths.length > 0) {
                                this._contextManager.recordRecentlyAddedFiles(addedPaths);
                                this.recordCurrentPromptFiles(addedPaths);

                                // Notify UI immediately to stop the spinner and show updated visual states (checkmarks)
                                webview.postMessage({
                                    command: 'filesAddedToContext',
                                    results: results,
                                    blockId: blockId
                                });

                                // --- INSTANT HUD INCREMENTAL INGESTION ---
                                // Concurrently read and tokenize ONLY the newly added files
                                let addedTokensWeight = 0;
                                const model = this._currentDiscussion?.model || this._lollmsAPI.getModelName();
                                const crypto = require('crypto');

                                for (const addedPath of addedPaths) {
                                    try {
                                        const res = await this._contextManager.resolveWorkspaceFromPath(addedPath);
                                        if (res) {
                                            const fileContentBytes = await vscode.workspace.fs.readFile(res.uri);
                                            const fileContent = Buffer.from(fileContentBytes).toString('utf8');
                                            const hash = crypto.createHash('md5').update(fileContent).digest('hex');

                                            // Tokenize the single file
                                            const tokenRes = await this._lollmsAPI.tokenize(fileContent, model);
                                            addedTokensWeight += tokenRes.count;

                                            // Cache the single file's token weight
                                            await this._contextManager.setCachedTokens(addedPath, hash, tokenRes.count);

                                            // Prime the internal file content cache so the next compile is instantaneous
                                            (this._contextManager as any)._fileContentCache.set(addedPath, { 
                                                content: fileContent, 
                                                state: 'included' 
                                            });
                                        }
                                    } catch (fileErr) {
                                        console.warn(`Incremental tokenization failed for ${addedPath}:`, fileErr);
                                    }
                                }

                                // Apply the mathematical delta directly to our cached metrics
                                if (this._currentDiscussion?.lastTokenMetrics && addedTokensWeight > 0) {
                                    const m = this._currentDiscussion.lastTokenMetrics;
                                    m.total += addedTokensWeight;
                                    if (m.segments) {
                                        m.segments.files += addedTokensWeight;
                                    }

                                    // Instantly update the webview's progress bar with zero delay
                                    this._panel.webview.postMessage({
                                        command: 'updateTokenProgress',
                                        totalTokens: m.total,
                                        contextSize: m.contextSize,
                                        isApproximate: false,
                                        segments: m.segments
                                    });
                                }

                                const currentFilesList = provider.getIncludedFiles();
                                this._panel.webview.postMessage({
                                    command: 'updateContext',
                                    files: currentFilesList
                                });

                                if (reprompt) {
                                    this.recordPendingJustAddedFiles(addedPaths);
                                    // Trigger the next turn immediately with fresh context
                                    await this.sendMessage({
                                        role: 'user',
                                        content: `I have added the requested files to context. Please continue.`
                                    });
                                } else {
                                    // Silent background sync to ensure alignment with other elements (briefing, history)
                                    this.updateContextAndTokens({ isBackgroundSync: true });
                                }
                            } else {
                                // Even if nothing was added, notify the UI to clear any pending spinners
                                webview.postMessage({
                                    command: 'filesAddedToContext',
                                    results: results,
                                    blockId: blockId
                                });
                            }
                        }
                    } catch (err: any) {
                        Logger.error(`Critical error in addFilesToContext: ${err.message}`);
                        // Safety fallback to clear spinners on error
                        webview.postMessage({
                            command: 'filesAddedToContext',
                            results: results,
                            blockId: blockId
                        });
                    }
                }
                break;
            case 'requestFileSearch':
                {
                    const query: string = String(message.query || "").trim();
                    const searchMode = message.mode || 'path';
                    const options = message.options || { matchCase: false, wholeWord: false };
                    let results: any[] = [];

                    try {
                        const includedFiles = new Set(
                            this._contextManager.getContextStateProvider()?.getIncludedFiles()?.map(f => f.path) || []
                        );

                        if (searchMode === 'content') {
                            // OPTIMIZATION: If the query is long (selection), treat as literal search
                            // to avoid regex parsing errors on special chars like () or [].
                            const isLiteral = query.length > 30 || query.includes('\n');
                            
                            const visibleFiles = await this._contextManager.getWorkspaceFilePaths();
                            
                            // SAFETY: Don't pass a massive include string to shell if tree is large.
                            const includeFilter = visibleFiles.length < 60 ? visibleFiles.join(',') : undefined;

                            results = await this._contextManager.searchWorkspaceContent(query, {
                                ...options,
                                include: includeFilter,
                                literal: isLiteral
                            });                        
                        } else {
                            let allFiles: string[] = await this._contextManager.getWorkspaceFilePaths();

                            // Apply Include/Exclude filters to filename list
                            if (options.include) {
                                const includes = options.include.split(',').map((p: string) => p.trim().toLowerCase());
                                allFiles = allFiles.filter(f => includes.some((p: string) => f.toLowerCase().includes(p) || f.toLowerCase().endsWith(p.replace('*', ''))));
                            }
                            if (options.exclude) {
                                const excludes = options.exclude.split(',').map((p: string) => p.trim().toLowerCase());
                                allFiles = allFiles.filter(f => !excludes.some((p: string) => f.toLowerCase().includes(p) || f.toLowerCase().endsWith(p.replace('*', ''))));
                            }
                            
                            // --- ADVANCED FILENAME PARSER ---
                            let filtered = allFiles;
                            
                            // 1. Handle Extension Filter (ext:py)
                            const extMatch = query.match(/ext:(\w+)/);
                            if (extMatch) {
                                const targetExt = "." + extMatch[1].toLowerCase();
                                filtered = filtered.filter(f => f.toLowerCase().endsWith(targetExt));
                            }
                            
                            // Clean query of metadata tags
                            const cleanQuery = query.replace(/ext:\w+/g, '').trim();
                            if (!cleanQuery) {
                                results = filtered.slice(0, 50).map(f => ({ path: f, snippet: "" }));
                            } else {
                                // 2. Handle OR logic (|)
                                const orParts = cleanQuery.split('|').map(p => p.trim()).filter(p => p);

                                if (options.fuzzy === false) {
                                    // STRICT MATCHING MODE
                                    const filteredFiles = filtered.filter(f => {
                                        return orParts.some(part => {
                                            const terms = part.split(/\s+/);
                                            return terms.every(term => {
                                                const isNot = term.startsWith('-');
                                                const actualTerm = isNot ? term.substring(1) : term;
                                                const match = options.matchCase ? f.includes(actualTerm) : f.toLowerCase().includes(actualTerm.toLowerCase());
                                                return isNot ? !match : match;
                                            });
                                        });
                                    });
                                    results = filteredFiles.slice(0, 50).map(f => ({ path: f, snippet: "" }));
                                } else {
                                    // FUZZY SCORING MODE
                                    const scoredResults = filtered.map(f => {
                                        let maxOrScore = 0;
                                        const matches = orParts.some(part => {
                                            const terms = part.split(/\s+/);
                                            return terms.every(term => {
                                                const isNot = term.startsWith('-');
                                                const actualTerm = isNot ? term.substring(1) : term;
                                                if (!actualTerm) return true;

                                                const fLower = f.toLowerCase();
                                                const tLower = actualTerm.toLowerCase();
                                                const idx = options.matchCase ? f.indexOf(actualTerm) : fLower.indexOf(tLower);

                                                if (idx !== -1) {
                                                    let score = 10;
                                                    if (f.split(/[\\/]/).pop()?.toLowerCase().startsWith(tLower)) score += 50;
                                                    if (idx === 0) score += 100;
                                                    maxOrScore = Math.max(maxOrScore, score);
                                                    return isNot ? false : true;
                                                }
                                                return isNot ? true : false;
                                            });
                                        });
                                        return { path: f, score: maxOrScore, matches };
                                    })
                                    .filter(res => res.matches)
                                    .sort((a, b) => b.score - a.score);

                                    results = scoredResults.slice(0, 50).map(r => ({ path: r.path, snippet: "" }));
                                }
                            }
                        }
                        
                        // Add the 'isAlreadyIncluded' flag to each result
                        const resultsWithMetadata = (results || []).map(r => ({
                            ...r,
                            isAlreadyIncluded: includedFiles.has(r.path)
                        }));
                        
                        webview.postMessage({ command: 'fileSearchResults', results: resultsWithMetadata, query, mode: searchMode });
                    } catch (err: any) {
                        Logger.error(`Search failed: ${err.message}`);
                        // Always send a response to stop the webview spinner
                        webview.postMessage({ command: 'fileSearchResults', results: [], query, mode: searchMode });
                    }
                }
                break;
            case 'requestAddFileToContext':
            {
                const uris = await vscode.window.showOpenDialog({
                    canSelectMany: true,
                    openLabel: 'Add to AI Context',
                    filters: { 
                        'Documentation & Code': ['md', 'txt', 'rst', 'pdf', 'docx', 'html', 'htm', 'json', 'yaml', 'yml', 'py', 'ts', 'js', 'cpp', 'c', 'cs', 'java', 'rs', 'go', 'sh', 'xlsx', 'pptx', 'msg', 'csv', 'svg'],
                        'Documents': ['md', 'txt', 'pdf', 'docx', 'pptx', 'xlsx', 'msg', 'odt', 'rtf', 'csv', 'tsv', 'html', 'rst', 'svg'],
                        'Images': ['png', 'jpg', 'jpeg', 'webp', 'bmp'],
                        'All Files': ['*']
                    }
                });
                if (uris && uris.length > 0) {
                    this._panel.webview.postMessage({ command: 'setGeneratingState', isGenerating: true, statusText: 'Ingesting documentation files...' });
                    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                    let addedCount = 0;

                    for (const uri of uris) {
                        const ext = path.extname(uri.fsPath).toLowerCase();
                        const fileName = path.basename(uri.fsPath);

                        // If it's a complex binary/document or raster image, treat it as a rich attachment
                        if (['.pdf', '.docx', '.pptx', '.xlsx', '.msg', '.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(ext)) {
                            try {
                                const bytes = await vscode.workspace.fs.readFile(uri);
                                const base64 = Buffer.from(bytes).toString('base64');
                                const isImage = ['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(ext);

                                let importMode: string | undefined = undefined;
                                if (ext === '.pdf') {
                                    const choices = [
                                        { label: 'Text (Markdown)', mode: 'text', detail: 'Extract text content only.' },
                                        { label: 'Text + Images', mode: 'mixed', detail: 'Extract text and include embedded images.' },
                                        { label: 'Images only', mode: 'images', detail: 'Convert every page of the PDF into an image for visual analysis.' }
                                    ];
                                    const choice = await vscode.window.showQuickPick(choices, { placeHolder: `How should I import ${fileName}?` });

                                    if (!choice) {
                                        this._panel.webview.postMessage({ command: 'setGeneratingState', isGenerating: false });
                                        continue;
                                    }
                                    importMode = choice.mode;
                                }

                                await this._handleFileAttachment(fileName, isImage ? `data:image/${ext.substring(1)};base64,${base64}` : `data:application/octet-stream;base64,${base64}`, isImage, importMode);
                                addedCount++;
                            } catch (e: any) {
                                vscode.window.showErrorMessage(`Failed to attach ${fileName}: ${e.message}`);
                            }
                        } else {
                            // Standard text/documentation/code file
                            try {
                                const isWithinWorkspace = workspaceFolder && vscode.workspace.getWorkspaceFolder(uri);

                                if (isWithinWorkspace) {
                                    await vscode.commands.executeCommand('lollms-vs-coder.setContextIncluded', uri, [uri]);
                                    addedCount++;
                                } else if (workspaceFolder) {
                                    const cacheDir = vscode.Uri.joinPath(workspaceFolder.uri, '.lollms', 'external_files');
                                    await vscode.workspace.fs.createDirectory(cacheDir).then(undefined, () => {});

                                    const fileBytes = await vscode.workspace.fs.readFile(uri);
                                    const safeName = `external_${fileName.replace(/[^a-zA-Z0-9.]/g, '_')}`;
                                    const cacheUri = vscode.Uri.joinPath(cacheDir, safeName);

                                    await vscode.workspace.fs.writeFile(cacheUri, fileBytes);

                                    const relativePath = path.join('.lollms', 'external_files', safeName).replace(/\\/g, '/');
                                    await vscode.commands.executeCommand('lollms-vs-coder.addFilesToContext', [relativePath]);
                                    addedCount++;
                                }
                            } catch (e: any) {
                                vscode.window.showErrorMessage(`Failed to ingest ${fileName}: ${e.message}`);
                            }
                        }
                    }

                    if (addedCount > 0) {
                        vscode.window.showInformationMessage(`✅ Added ${addedCount} file(s) to the discussion context.`);
                    }

                    this.updateContextAndTokens();
                    this._panel.webview.postMessage({ command: 'setGeneratingState', isGenerating: false });
                }
                break;                
            }

            case 'performDeepDiscussionSearch':
                const query = message.query.trim();
                if (!query) return;

                try {
                    const allDiscussions = await this._discussionManager.getAllDiscussions();
                    const results: any[] = [];
                    
                    // Conversion: treat query as regex if it contains special chars, 
                    // otherwise convert standard wildcards.
                    let regex: RegExp;
                    try {
                        const regexStr = query.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                                              .replace(/\\\*/g, '.*') // Support escaped *
                                              .replace(/\\\?/g, '.')  // Support escaped ?
                                              .replace(/\*/g, '.*')
                                              .replace(/\?/g, '.');
                        regex = new RegExp(regexStr, 'gi');
                    } catch (e) {
                        // Fallback to literal search if regex is invalid
                        regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                    }

                    for (const d of allDiscussions) {
                        let matchFound = false;
                        let snippet = "";
                        
                        // Check Title
                        if (d.title && d.title.match(regex)) {
                            matchFound = true;
                            snippet = "Discussion Title Match";
                        }

                        // Check Messages
                        if (!matchFound) {
                            for (const msg of d.messages) {
                                const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                                const match = regex.exec(content);
                                if (match) {
                                    matchFound = true;
                                    const start = Math.max(0, match.index - 50);
                                    const end = Math.min(content.length, match.index + 150);
                                    snippet = (start > 0 ? "..." : "") + content.substring(start, end).replace(/\r?\n/g, ' ') + (end < content.length ? "..." : "");
                                    break; 
                                }
                                regex.lastIndex = 0; // Reset for next message
                            }
                        }

                        if (matchFound) {
                            results.push({
                                id: d.id,
                                title: d.title || "Untitled Discussion",
                                snippet: snippet,
                                timestamp: d.timestamp
                            });
                        }
                    }

                    webview.postMessage({ command: 'discussionSearchResults', results, query });
                } catch (e: any) {
                    vscode.window.showErrorMessage("Deep Search failed: " + e.message);
                }
                break;
            // requestAddFileToContext removed - now handled by webview file input
            // to ensure files are treated as discussion attachments.
            case 'createCustomExternalFile':
                await this.handleCreateCustomExternalFile(message.fileName, message.content);
                break;
            case 'requestAddExternalFile':
                await this.handleRequestAddExternalFile();
                break;
            case 'requestAddExternalFileLink':
                await this.handleRequestAddExternalFileLink();
                break;
            case 'requestAddDiagramToContext':
                {
                    const diagType = await vscode.window.showQuickPick([
                        { label: '$(type-hierarchy) Inheritance Diagram', id: 'class_diagram', description: 'Classes, structs, and inheritance hierarchies' },
                        { label: '$(symbol-method) Call Graph', id: 'call_graph', description: 'Function and method invocation flow' },
                        { label: '$(repo) Import Graph', id: 'import_graph', description: 'Module import relationships and dependencies' },
                        { label: '$(symbol-interface) Function Signatures', id: 'function_signatures', description: 'Typed function and method signatures' },
                        { label: '$(file-text) Textual Architecture Summary (Token Efficient)', id: 'text_summary', description: 'Structured YAML architecture overview' }
                    ], { placeHolder: 'Select diagram type to include in AI context' });

                    if (diagType && this._currentDiscussion) {
                        const { id: processId } = this.processManager.register(
                            this.discussionId, 
                            `Generating ${diagType.label}...`
                        );
                        this.updateGeneratingState();

                        try {
                            // Ensure Code Graph is built before generating the diagram
                            if (this._codeGraphManager) {
                                if (this._codeGraphManager.getBuildState() !== 'ready' || this._codeGraphManager.getGraphData().nodes.length === 0) {
                                    this.processManager.updateDescription(processId, "Building Code Architecture Graph...");
                                    this.updateGeneratingState();
                                    await this._codeGraphManager.buildGraph((status) => {
                                        this.processManager.updateDescription(processId, status);
                                        this.updateGeneratingState();
                                    });
                                }
                            }

                            if (!this._currentDiscussion.activeDiagrams) this._currentDiscussion.activeDiagrams = [];
                            if (!this._currentDiscussion.activeDiagrams.includes(diagType.id)) {
                                this._currentDiscussion.activeDiagrams.push(diagType.id);
                            }

                            if (!this._currentDiscussion.id.startsWith('temp-')) {
                                await this._discussionManager.saveDiscussion(this._currentDiscussion);
                            }

                            this.processManager.updateDescription(processId, `Compiling ${diagType.id} diagram...`);
                            this.updateGeneratingState();
                            await this.updateContextAndTokens({ isBackgroundSync: false });

                            vscode.window.showInformationMessage(`✅ Added ${diagType.id.replace('_', ' ')} to discussion context.`);
                        } catch (diagErr: any) {
                            Logger.error(`Failed to generate diagram: ${diagErr.message}`);
                            vscode.window.showErrorMessage(`Failed to generate diagram: ${diagErr.message}`);
                        } finally {
                            this.processManager.unregister(processId);
                            this.updateGeneratingState();
                        }
                    }
                }
                break;
            case 'requestWebAction':
                {
                    const { action, params } = message;
                    try {
                        const loadingMsgId = 'system_web_loading_' + Date.now();
                        
                        if (action === 'youtube') {
                            const videoInput = (params.url || params.videoId || "").trim();
                            const lang = params.language || 'en';
                            let videoId = videoInput;

                            if (videoId.includes('youtube.com') || videoId.includes('youtu.be')) {
                                try {
                                    const parsed = new URL(videoId);
                                    if (videoId.includes('youtu.be')) {
                                        videoId = parsed.pathname.replace(/^\/+/, '');
                                    } else {
                                        videoId = parsed.searchParams.get('v') || videoId;
                                    }
                                } catch {}
                            }

                            await this.addMessageToDiscussion({
                                id: loadingMsgId,
                                role: 'system',
                                content: `📺 Fetching YouTube transcript for: ${videoId}...`
                            });

                            const ytRes = await (this._contextManager as any).fetchYoutubeTranscript(videoId, lang);
                            if (ytRes.success) {
                                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                                if (workspaceFolder) {
                                    const cacheDir = vscode.Uri.joinPath(workspaceFolder.uri, '.lollms', 'external_files');
                                    await vscode.workspace.fs.createDirectory(cacheDir).then(undefined, () => {});

                                    const filename = `youtube_${videoId.replace(/[^a-zA-Z0-9_-]/g, '_')}.md`;
                                    const fileUri = vscode.Uri.joinPath(cacheDir, filename);
                                    const markdownContent = `# 📺 YouTube Video Transcript: ${videoId}\nSource: https://www.youtube.com/watch?v=${videoId}\nLanguage: ${lang}\n\n${ytRes.output}`;

                                    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(markdownContent, 'utf8'));
                                    const relPath = path.join('.lollms', 'external_files', filename).replace(/\\/g, '/');
                                    await this._contextManager.getContextStateProvider()?.addFilesToContext([relPath]);

                                    await this.updateMessageContent(loadingMsgId, `✅ **YouTube Transcript Added:** \`${relPath}\`\n\nPreview:\n> ${ytRes.output.substring(0, 300)}...`);
                                    this.updateContextAndTokens();
                                    vscode.window.showInformationMessage(`✅ YouTube transcript saved to ${relPath} and added to context.`);
                                }
                            } else {
                                await this.updateMessageContent(loadingMsgId, `❌ **YouTube Transcript Failed:** ${ytRes.output}`);
                                vscode.window.showErrorMessage(`YouTube Transcript Failed: ${ytRes.output}`);
                            }
                        } else if (action === 'scrape') {
                            const targetUrl = params.url;
                            const lang = params.language || 'en';
                            const depth = params.depth || 0;

                            await this.addMessageToDiscussion({
                                id: loadingMsgId,
                                role: 'system', 
                                content: `🌐 Processing ${action}: ${targetUrl}...`
                            });

                            const result = await this._contextManager.processUrl(targetUrl, lang, undefined, undefined, depth, new Set(), this._discussionCapabilities);
                            const gateLabel = result.gateResult && result.gateResult.verdict !== 'clean'
                                ? `\n🛡️ **Context Poisoning Gate:** \`${result.gateResult.verdict.toUpperCase()}\` (Risk Score: ${result.gateResult.riskScore}/100)`
                                : '';
                            await this.updateMessageContent(loadingMsgId, `✅ **Web Content Added:** ${targetUrl}\nSaved as: \`${result.filename}\`${gateLabel}\n\nPreview:\n> ${result.summary}`);
                            this.updateContextAndTokens();
                        } else if (action === 'open_browser') {
                            const query = (params?.query || '').trim();
                            if (query) {
                                const browserUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
                                await vscode.env.openExternal(vscode.Uri.parse(browserUrl));
                            }
                        } else if ([
                            'auto', 'auto_keyless', 'wiki', 'arxiv', 'google', 'ddg', 'duckduckgo', 'searxng',
                            'so', 'stackoverflow', 'github', 'mdn', 'npm', 'pypi', 'crates',
                            'hal', 'crossref', 'europepmc', 'scopus', 'patent'
                        ].includes(action)) {
                            const query = params.query;
                            const limit = params.limit || 5;
                            const results = await this._contextManager.searchWebInfo(action, query, undefined, limit);
                            webview.postMessage({ command: 'webSearchResults', action, results, query });
                        }
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Web action failed: ${e.message}`);
                        webview.postMessage({ command: 'webSearchResults', action, results: [], query: params.query });
                    }
                }
                break;
            case 'addWebPagesToContext':
                {
                    const urls: string[] = Array.isArray(message.urls) ? message.urls : [];
                    let addedCount = 0;
                    const quarantinedUrls: string[] = [];
                    const blockedReasons: string[] = [];

                    for (const url of urls) {
                        try {
                            const res = await this._contextManager.processUrl(url, 'en', undefined, undefined, 0, new Set(), this._discussionCapabilities);
                            addedCount++;
                            if (res.gateResult?.verdict === 'quarantined') {
                                quarantinedUrls.push(url);
                            }
                        } catch (urlErr: any) {
                            blockedReasons.push(`${url}: ${urlErr.message}`);
                        }
                    }

                    if (addedCount > 0) {
                        const qNote = quarantinedUrls.length > 0 ? ` (${quarantinedUrls.length} quarantined & sanitized by Context Poisoning Gate)` : '';
                        vscode.window.showInformationMessage(`Added ${addedCount} web page(s) to context${qNote}.`);
                        this.updateContextAndTokens();
                    }
                    if (blockedReasons.length > 0) {
                        vscode.window.showWarningMessage(`🛡️ Context Poisoning Gate / Fetch blocked ${blockedReasons.length} page(s): ${blockedReasons[0]}`);
                    }
                }
                break;
            case 'syncFilesContext':
                {
                    const { add, remove } = message;
                    if (add && add.length > 0) {
                        await vscode.commands.executeCommand('lollms-vs-coder.addFilesToContext', add);
                    }
                    if (remove && remove.length > 0) {
                        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                        if (workspaceFolder) {
                            const uris = remove.map((p: string) => {
                                const isAbsolute = p.includes(':') || p.startsWith('/') || p.startsWith('\\');
                                return isAbsolute ? vscode.Uri.file(p) : vscode.Uri.joinPath(workspaceFolder.uri, p);
                            });
                            await this._contextManager.getContextStateProvider()?.setStateForUris(uris, 'tree-only');
                        }
                    }
                    this.updateContextAndTokens();
                }
                break;
            case 'pdfPagesExtracted':
                if (this.pdfExtractionPromises[message.requestId]) {
                    clearTimeout(this.pdfExtractionPromises[message.requestId].timeout);
                    this.pdfExtractionPromises[message.requestId].resolve(message.images);
                    delete this.pdfExtractionPromises[message.requestId];
                }
                break;
            case 'pdfPagesExtractionFailed':
                if (this.pdfExtractionPromises[message.requestId]) {
                    clearTimeout(this.pdfExtractionPromises[message.requestId].timeout);
                    this.pdfExtractionPromises[message.requestId].reject(new Error(message.error));
                    delete this.pdfExtractionPromises[message.requestId];
                }
                break;
            case 'requestAddUrlToContext':
                const url = await vscode.window.showInputBox({ 
                    prompt: "Enter URL to scrape and add to context",
                    placeHolder: "https://example.com/article" 
                });
                if (url) {
                    let language = 'en';
                    try {
                        const loadingMsgId = 'system_url_loading_' + Date.now();
                        await this.addMessageToDiscussion({
                             id: loadingMsgId,
                             role: 'system', 
                             content: `🌐 Scraping content from: ${url}...`
                        });
                        
                        // We use the context manager to process and save the URL content
                        const result = await this._contextManager.processUrl(url, language);
                        
                        await this.updateMessageContent(loadingMsgId, `✅ **URL Added to Context:** ${url}\nSaved as: \`${result.filename}\`\n\nPreview:\n> ${result.summary}`);
                        
                        // It automatically adds to context, so we refresh tokens
                        this.updateContextAndTokens();
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to add URL: ${e.message}`);
                    }
                }
                break;
            case 'bulkMoveFiles':
                vscode.commands.executeCommand('lollms-vs-coder.bulkMoveFiles', message.operations);
                break;
            case 'bulkCopyFiles':
                vscode.commands.executeCommand('lollms-vs-coder.bulkCopyFiles', message.operations);
                break;
            case 'generateInterProjectPrompt':
                await this.handleGenerateInterProjectPrompt(message);
                break;
            case 'cancelInterProjectPrompt':
                if (this._activeInterProjectController) {
                    this._activeInterProjectController.abort();
                    this._activeInterProjectController = null;
                }
                break;
            case 'cancelFileRepairPass':
                if (this._activeRepairController) {
                    this._activeRepairController.abort();
                    this._activeRepairController = null;
                }
                this.processManager.cancelForDiscussion(this.discussionId);
                this.updateGeneratingState();
                {
                    const maxRepairRounds = vscode.workspace.getConfiguration('lollmsVsCoder').get<number>('fileRepairStudioMaxRounds', 20) || 20;
                    // Inform the webview so it re-enables controls and resets the Fix/Stop button immediately
                    if (!this._isDisposed && this._panel.webview) {
                        this._panel.webview.postMessage({
                            command: 'fileRepairPassResult',
                            filePath: message.filePath,
                            round: 0,
                            maxRounds: maxRepairRounds,
                            patchApplied: false,
                            errorsRemaining: -1,
                            cancelled: true,
                            errors: [],
                            resolvedCount: 0,
                            llmExplanation: "Repair pass stopped by user. Settings and controls are now unlocked."
                        });
                    }
                }
                break;
            case 'rescanFileDiagnostics':
                await this.auditFileDiagnostics(message.filePath, message.messageId, message.blockIndex, message.blockId);
                break;
            case 'acceptFileRepair':
                vscode.window.showInformationMessage(`✅ Accepted current file state for ${path.basename(message.filePath)} (${message.errorsCount} errors remaining).`);
                if (message.filePath) {
                    try {
                        const res = await this._contextManager.resolveWorkspaceFromPath(message.filePath);
                        if (res) {
                            if (message.pendingContent) {
                                await vscode.workspace.fs.writeFile(res.uri, Buffer.from(message.pendingContent, 'utf8'));
                                this._contextManager.refreshFileInCache(res.uri);
                            }
                            const doc = await vscode.workspace.openTextDocument(res.uri);
                            await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
                        }
                    } catch {}
                }
                break;
            case 'openFileRepairStudio':
                {
                    const { FileRepairStudioPanel } = require('../../panels/fileRepairStudioPanel');
                    FileRepairStudioPanel.createOrShow(
                        this._extensionUri,
                        this._services,
                        message.filePath,
                        message.errors
                    );
                }
                break;
            case 'runFileRepairPass':
                await this.executeFileRepairPass(
                    message.filePath,
                    message.prompt,
                    message.round,
                    message.errors,
                    message.model,
                    message.temperature,
                    message.reasoningEffort,
                    message.maxRounds
                );
                break;
            case 'blameLibrarianForContext':
                {
                    const files = Array.isArray(message.files) ? message.files : [];
                    await this.recallLibrarianWithBlame(files);
                }
                break;
            case 'cancelGovernorFilter':
                {
                    const activeProc = this.processManager.getAllForDiscussion(this.discussionId)
                        .find(p => p.description.toLowerCase().includes('governor'));
                    if (activeProc) {
                        this.processManager.cancel(activeProc.id);
                    }
                    this.updateGeneratingState();
                }
                break;
            case 'runGovernorFilter':
            {
                const { prompt: filterPrompt, presetName, caller, contextSelection, history, currentMutedFiles, customCapacity, targetPercent, reasoningEffort, ignoreContextSize } = message;
                if (!filterPrompt || !this._currentDiscussion) break;

                    const { id: govProcId, controller: govCtrl } = this.processManager.register(
                        this.discussionId,
                        'Librarian: Scouting codebase & context...'
                    );
                    this.updateGeneratingState();

                    const isChatCaller = caller === 'chat' || !caller;
                    let libMsgId = '';

                    if (isChatCaller) {
                        libMsgId = 'librarian_consultation_' + Date.now();
                        await this.addMessageToDiscussion({
                            id: libMsgId,
                            role: 'assistant',
                            personalityName: '📚 Lead Librarian',
                            content: `### 📚 **Lead Librarian: Consulting on Technical Task**\n*Objective: "${filterPrompt.substring(0, 100)}..."*\n\n<div class="waiting-animation" style="display:flex; align-items:center; gap:8px; opacity:0.85;"><div class="spinner"></div> <span>Initializing investigation (Round 1)...</span></div>`,
                            model: this._currentDiscussion.model || this._lollmsAPI.getModelName(),
                            timestamp: Date.now()
                        });
                    }

                    try {
                        const targetModel = this._currentDiscussion.model || this._lollmsAPI.getModelName();
                        let candidateFiles: string[] | undefined = undefined;

                        if (caller === 'wizard' && contextSelection) {
                            if (contextSelection === 'empty') {
                                candidateFiles = [];
                            } else if (contextSelection !== 'current') {
                                const { loadContextSelectionFile } = require('../contextCommands');
                                const loadedSel = await loadContextSelectionFile(contextSelection);
                                if (loadedSel) {
                                    candidateFiles = loadedSel.files;
                                }
                            }
                        }

                        const result = await ContextLibrarian.filterFilesByPrompt({
                            lollmsAPI: this._lollmsAPI,
                            contextManager: this._contextManager,
                            discussionManager: this._discussionManager,
                            currentDiscussion: this._currentDiscussion!,
                            targetModel,
                            prompt: filterPrompt,
                            signal: govCtrl.signal,
                            candidateFiles,
                            currentMutedFiles,
                            history,
                            customCapacity,
                            targetPercent,
                            reasoningEffort: 'none',
                            ignoreContextSize: ignoreContextSize ?? (this._discussionCapabilities.ignoreContextSize === true),
                            pruneMsgId: isChatCaller ? libMsgId : undefined,
                            projectMemoryManager: this.projectMemoryManager,
                            onUpdateMessage: isChatCaller ? async (msgId, content) => {
                                await this.updateMessageContent(msgId, content);
                            } : undefined,
                            onStatusUpdate: (status) => {
                                this.processManager.updateDescription(govProcId, status);
                                this.updateGeneratingState();
                            },
                            onRoundProgress: (progress) => {
                                this.processManager.updateDescription(govProcId, progress.status);
                                this.updateGeneratingState();
                                webview.postMessage({
                                    command: 'governorRoundProgress',
                                    round: progress.round,
                                    maxRounds: progress.maxRounds,
                                    status: progress.status,
                                    discoverySteps: progress.discoverySteps
                                });
                            },
                            onStreamChunk: (data) => {
                                webview.postMessage({
                                    command: 'governorStreamChunk',
                                    round: data.round,
                                    maxRounds: data.maxRounds,
                                    chunk: data.chunk,
                                    fullText: data.fullText,
                                    messageId: data.messageId
                                });
                            },
                            onDiscoveryAction: (action) => {
                                webview.postMessage({
                                    command: 'governorDiscoveryAction',
                                    action
                                });
                            }
                        });

                        let updatedPresets: Record<string, string[]> | undefined;
                        if (presetName && presetName.trim()) {
                            const cleanName = presetName.trim();
                            const currentPresets = this._discussionManager.context.workspaceState.get<Record<string, string[]>>('lollms_saved_mute_patterns') || {};
                            currentPresets[cleanName] = result.mutedFiles;
                            await this._discussionManager.context.workspaceState.update('lollms_saved_mute_patterns', currentPresets);
                            updatedPresets = currentPresets;
                        } else {
                            updatedPresets = this._discussionManager.context.workspaceState.get<Record<string, string[]>>('lollms_saved_mute_patterns') || {};
                        }

                        if (isChatCaller && libMsgId) {
                            const analysis = result.advice || result.rationale || 'Codebase dependencies analyzed.';
                            const reportBlock = result.governorReport ? `\n<librarian_report>\n${result.governorReport}\n</librarian_report>\n` : '';

                            const finalReport = `### 📚 **Lead Librarian: Context Arbitration Complete**
- **Decision Status**: \`${((result as any).decision?.status || 'fit_edits_only').toUpperCase()}\`
- **Active Files for Patching [C]**: ${result.keptFiles.length} (${result.keptFiles.map(k => `\`${k}\``).join(', ') || 'None'})
- **Reference Files Muted [M]**: ${result.mutedFiles.length} (${result.mutedFiles.map(m => `\`${m}\``).join(', ') || 'None'})
- **Liberated Tokens**: ~${result.liberatedTokens.toLocaleString()} tokens
- **Rounds Used**: ${result.roundsUsed} of ${result.maxRounds}

#### 📝 **Librarian Architectural Analysis**:
${analysis}
${reportBlock}

> 💡 **Context Synchronized**: Files required for editing are loaded with full content ([C]), and reference files are muted ([M]) with contracts preserved above. You can now proceed with the implementation.`;

                            await this.updateMessageContent(libMsgId, finalReport);

                            if (result.keptFiles?.length) await this.unmuteFiles(result.keptFiles);
                            if (result.mutedFiles?.length) await this.muteFiles(result.mutedFiles);
                            if (result.addedFiles?.length) {
                                await this._contextManager.getContextStateProvider()?.addFilesToContext(result.addedFiles);
                            }

                            // 1. Upgrade findings in .lollms/structure.md and discussion data zone
                            await this.upgradeLibrarianFindings(result, filterPrompt, analysis);

                            this.updateContextAndTokens({ isBackgroundSync: false });

                            if (result.savedSelection) {
                                const { getAvailableContextSelections } = require('../contextCommands');
                                getAvailableContextSelections().then((updatedSelections: any[]) => {
                                    webview.postMessage({
                                        command: 'updateContext',
                                        selections: updatedSelections.map(s => s.fileName)
                                    });
                                }).catch(() => {});
                                vscode.window.showInformationMessage(`📚 Librarian saved context selection: ${result.savedSelection.name} (${result.savedSelection.path})`);
                            }

                            webview.postMessage({
                                command: 'librarianConsultationFinished',
                                keptFiles: result.keptFiles,
                                mutedFiles: result.mutedFiles
                            });

                            // Clean up temporary consultation message so it does not persist in discussion history
                            const libIdx = this._currentDiscussion.messages.findIndex(m => m.id === libMsgId);
                            if (libIdx !== -1) {
                                this._currentDiscussion.messages.splice(libIdx, 1);
                            }
                            this._panel.webview.postMessage({
                                command: 'removeMessage',
                                messageId: libMsgId
                            });

                            // 2. Clear scout process and immediately recall the worker
                            this.processManager.unregister(govProcId);
                            this.updateGeneratingState();

                            await this.recallWorkerAfterLibrarian(result, filterPrompt, analysis);
                            return;
                        }

                        webview.postMessage({
                            command: 'governorFilterResult',
                            keptFiles: result.keptFiles,
                            mutedFiles: result.mutedFiles,
                            addedFiles: result.addedFiles || [],
                            rationale: result.rationale,
                            advice: result.advice,
                            signatures: result.signatures,
                            discoverySteps: result.discoverySteps,
                            totalTokens: result.totalTokens,
                            liberatedTokens: result.liberatedTokens,
                            roundsUsed: result.roundsUsed,
                            maxRounds: result.maxRounds,
                            presets: updatedPresets,
                            presetName,
                            caller: caller || 'chat',
                            prompt: filterPrompt
                        });
                    } catch (err: any) {
                        const isAborted = govCtrl.signal.aborted || err.name === 'AbortError' || err.message === 'Operation cancelled';
                        if (!isAborted) {
                            Logger.error(`Governor filter error: ${err.message}`);
                            vscode.window.showErrorMessage(`Governor filter failed: ${err.message}`);
                        }
                        webview.postMessage({
                            command: 'governorFilterResult',
                            error: isAborted ? undefined : err.message,
                            cancelled: isAborted,
                            caller: caller || 'chat',
                            prompt: filterPrompt
                        });
                    } finally {
                        this.processManager.unregister(govProcId);
                        this.updateGeneratingState();
                    }
                }
                break;

            case 'applyGovernorSelection':
                {
                    const { mutedFiles, addedFiles, caller, presetName } = message;
                    if (presetName && presetName.trim()) {
                        const cleanName = presetName.trim();
                        const currentPresets = this._discussionManager.context.workspaceState.get<Record<string, string[]>>('lollms_saved_mute_patterns') || {};
                        currentPresets[cleanName] = mutedFiles || [];
                        await this._discussionManager.context.workspaceState.update('lollms_saved_mute_patterns', currentPresets);
                    }

                    // If Governor added unincluded files from workspace, include them into context provider now
                    if (Array.isArray(addedFiles) && addedFiles.length > 0 && this._contextManager) {
                        try {
                            await this._contextManager.getContextStateProvider()?.addFilesToContext(addedFiles);
                        } catch (addErr) {
                            Logger.warn(`Governor failed to add files to provider: ${addErr}`);
                        }
                    }

                    if (caller === 'wizard') {
                        webview.postMessage({
                            command: 'governorWizardSelectionApplied',
                            mutedFiles: mutedFiles || [],
                            addedFiles: addedFiles || []
                        });
                    } else if (this._currentDiscussion) {
                        this._currentDiscussion.mutedFiles = Array.isArray(mutedFiles) ? [...mutedFiles] : [];
                        this._discussionCapabilities.mutedFiles = [...this._currentDiscussion.mutedFiles];
                        await this._discussionManager.saveLastMutedFiles(this._currentDiscussion.mutedFiles);
                        if (!this._currentDiscussion.id.startsWith('temp-')) {
                            await this._discussionManager.saveDiscussion(this._currentDiscussion);
                        }
                        this.updateContextAndTokens({ isBackgroundSync: false });
                        const addedCount = Array.isArray(addedFiles) ? addedFiles.length : 0;
                        const addedInfo = addedCount > 0 ? ` (+${addedCount} files added to context)` : '';
                        vscode.window.showInformationMessage(`📚 Librarian: Selection applied (${this._currentDiscussion.mutedFiles.length} files muted)${addedInfo}.`);
                    }
                }
                break;
            case 'saveVisibilityPreset':
                {
                    const { name: pName, mutedFiles: pMuted } = message;
                    if (pName && Array.isArray(pMuted)) {
                        const currentPresets = this._discussionManager.context.workspaceState.get<Record<string, string[]>>('lollms_saved_mute_patterns') || {};
                        currentPresets[pName.trim()] = pMuted;
                        await this._discussionManager.context.workspaceState.update('lollms_saved_mute_patterns', currentPresets);
                        webview.postMessage({
                            command: 'updateVisibilityPresets',
                            presets: currentPresets
                        });
                        vscode.window.showInformationMessage(`Visibility profile preset '${pName}' saved.`);
                    }
                }
                break;
            case 'deleteVisibilityPreset':
                {
                    const { name: pName } = message;
                    if (pName) {
                        const currentPresets = this._discussionManager.context.workspaceState.get<Record<string, string[]>>('lollms_saved_mute_patterns') || {};
                        delete currentPresets[pName];
                        await this._discussionManager.context.workspaceState.update('lollms_saved_mute_patterns', currentPresets);
                        webview.postMessage({
                            command: 'updateVisibilityPresets',
                            presets: currentPresets
                        });
                        vscode.window.showInformationMessage(`Visibility profile preset '${pName}' deleted.`);
                    }
                }
                break;
            case 'applyVisibilityPreset':
                {
                    const { name: pName, caller } = message;
                    const currentPresets = this._discussionManager.context.workspaceState.get<Record<string, string[]>>('lollms_saved_mute_patterns') || {};
                    const targetMuted = currentPresets[pName];
                    if (Array.isArray(targetMuted)) {
                        if (caller !== 'wizard' && this._currentDiscussion) {
                            this._currentDiscussion.mutedFiles = [...targetMuted];
                            this._discussionCapabilities.mutedFiles = [...this._currentDiscussion.mutedFiles];
                            await this._discussionManager.saveLastMutedFiles(this._currentDiscussion.mutedFiles);
                            if (!this._currentDiscussion.id.startsWith('temp-')) {
                                await this._discussionManager.saveDiscussion(this._currentDiscussion);
                            }
                            this.updateContextAndTokens({ isBackgroundSync: false });
                        }
                        webview.postMessage({
                            command: 'visibilityPresetApplied',
                            name: pName,
                            mutedFiles: targetMuted,
                            caller: caller || 'chat'
                        });
                        vscode.window.showInformationMessage(`Applied visibility profile '${pName}' (${targetMuted.length} muted).`);
                    }
                }
                break;
            case 'requestFileSymbols':
                if (this._contextManager && message.filePath) {
                    const res = await this._contextManager.resolveWorkspaceFromPath(message.filePath);
                    if (res) {
                        const symbols = await this._contextManager.extractSymbolList(res.uri);
                        const discFiles: any[] = (this._currentDiscussion as any)?.includedFiles || [];
                        const { arePathsEqual } = require('../../utils');
                        const entry = discFiles.find(f => {
                            const cf = typeof f === 'string' ? f : (f.path || '');
                            return arePathsEqual(cf, res.relativePath) || arePathsEqual(cf, message.filePath);
                        });
                        let activeSymbols: string[] = [];
                        if (entry && typeof entry === 'object') {
                            if (Array.isArray(entry.symbols)) {
                                activeSymbols = entry.symbols;
                            } else if (typeof entry.state === 'string' && entry.state.startsWith('symbols:')) {
                                activeSymbols = entry.state.substring(8).split(',').map((s: string) => s.trim()).filter(Boolean);
                            }
                        }
                        webview.postMessage({
                            command: 'fileSymbolsData',
                            filePath: message.filePath,
                            symbols,
                            activeSymbols,
                            fileState: (entry && typeof entry === 'object' ? entry.state : 'included') || 'included'
                        });
                    } else {
                        webview.postMessage({
                            command: 'fileSymbolsData',
                            filePath: message.filePath,
                            symbols: [],
                            activeSymbols: [],
                            error: 'Could not resolve file path.'
                        });
                    }
                }
                break;

            case 'updateFileSymbols':
                if (this._currentDiscussion && message.filePath) {
                    const activeSymbols: string[] = Array.isArray(message.activeSymbols) ? message.activeSymbols : [];
                    await this.applySymbolBatchUpdate(message.filePath, activeSymbols, [], 'replace');
                    webview.postMessage({
                        command: 'fileSymbolsUpdated',
                        filePath: message.filePath,
                        activeSymbols
                    });
                }
                break;

            case 'toggleFileStructure':
                if (this._currentDiscussion && message.path) {
                    const targetPath = message.path.replace(/\\/g, '/').trim();
                    const res = await this._contextManager.resolveWorkspaceFromPath(targetPath);
                    const resolvedPath = res ? res.relativePath : targetPath;
                    const targetKey = this.normalizePathKey(resolvedPath);

                    const globalIncluded = this._contextManager?.getContextStateProvider()?.getIncludedFiles() || [];
                    (this._currentDiscussion as any).includedFiles = this.reconcileDiscussionFiles(
                        globalIncluded,
                        (this._currentDiscussion as any).includedFiles
                    );
                    const discFiles: any[] = (this._currentDiscussion as any).includedFiles;

                    const existing = discFiles.find(f => {
                        const cf = typeof f === 'string' ? f : (f.path || '');
                        return this.normalizePathKey(cf) === targetKey;
                    });

                    const currentState = typeof existing === 'object' ? existing.state : 'included';
                    const newState = message.targetState || (currentState === 'definitions-only' ? 'included' : 'definitions-only');

                    if (existing && typeof existing === 'object') {
                        existing.state = newState;
                        if (newState === 'included') delete existing.symbols;
                        else if (newState === 'definitions-only' && !Array.isArray(existing.symbols)) existing.symbols = [];
                    } else {
                        discFiles.push({ path: resolvedPath, state: newState, ...(newState === 'definitions-only' ? { symbols: [] } : {}) });
                    }

                    if (this._currentDiscussion.capabilities) {
                        (this._currentDiscussion.capabilities as any).includedFiles = discFiles;
                    }

                    const provider = this._contextManager.getContextStateProvider();
                    if (provider && res) {
                        await provider.setStateForUris([res.uri], newState as any);
                    }

                    // If file was muted and is now being switched to definitions-only/included, unmute it
                    if (this._currentDiscussion.mutedFiles) {
                        this._currentDiscussion.mutedFiles = this._currentDiscussion.mutedFiles.filter(m =>
                            this.normalizePathKey(m) !== targetKey
                        );
                        this._discussionCapabilities.mutedFiles = [...this._currentDiscussion.mutedFiles];
                    }

                    if (!this._currentDiscussion.id.startsWith('temp-')) {
                        await this._discussionManager.saveDiscussion(this._currentDiscussion);
                    }

                    this.updateContextAndTokens({ isBackgroundSync: true });
                }
                break;

            case 'bulkSetFilesStructure':
                if (this._currentDiscussion && Array.isArray(message.paths) && message.paths.length > 0) {
                    const targetState = message.targetState || 'definitions-only';
                    const provider = this._contextManager.getContextStateProvider();
                    const globalIncluded = provider ? provider.getIncludedFiles() : [];
                    (this._currentDiscussion as any).includedFiles = this.reconcileDiscussionFiles(
                        globalIncluded,
                        (this._currentDiscussion as any).includedFiles
                    );
                    const discFiles: any[] = (this._currentDiscussion as any).includedFiles;
                    const urisToUpdate: vscode.Uri[] = [];

                    for (const p of message.paths) {
                        const cleanP = p.replace(/\\/g, '/').trim();
                        const res = await this._contextManager.resolveWorkspaceFromPath(cleanP);
                        const resolved = res ? res.relativePath : cleanP;
                        const targetKey = this.normalizePathKey(resolved);

                        const existing = discFiles.find(f => {
                            const cf = typeof f === 'string' ? f : (f.path || '');
                            return this.normalizePathKey(cf) === targetKey;
                        });

                        if (existing && typeof existing === 'object') {
                            existing.state = targetState;
                            if (targetState === 'included') delete existing.symbols;
                            else if (targetState === 'definitions-only' && !Array.isArray(existing.symbols)) existing.symbols = [];
                        } else if (!existing) {
                            discFiles.push({ path: resolvedPath, state: targetState, ...(targetState === 'definitions-only' ? { symbols: [] } : {}) });
                        }

                        if (this._currentDiscussion.mutedFiles) {
                            this._currentDiscussion.mutedFiles = this._currentDiscussion.mutedFiles.filter(m =>
                                this.normalizePathKey(m) !== targetKey
                            );
                        }

                        if (res) {
                            urisToUpdate.push(res.uri);
                            this._contextManager.refreshFileInCache(res.uri);
                        }
                    }

                    this._discussionCapabilities.mutedFiles = [...(this._currentDiscussion.mutedFiles || [])];

                    if (this._currentDiscussion.capabilities) {
                        (this._currentDiscussion.capabilities as any).includedFiles = discFiles;
                    }

                    if (provider && urisToUpdate.length > 0) {
                        await provider.setStateForUris(urisToUpdate, targetState as any);
                    }

                    if (!this._currentDiscussion.id.startsWith('temp-')) {
                        await this._discussionManager.saveDiscussion(this._currentDiscussion);
                    }

                    this.updateContextAndTokens({ isBackgroundSync: true });
                }
                break;

            case 'toggleMuteFile':
                if (this._currentDiscussion && message.path) {
                    if (!this._currentDiscussion.mutedFiles) this._currentDiscussion.mutedFiles = [];
                    const targetPath = message.path.replace(/\\/g, '/').trim();
                    const targetKey = this.normalizePathKey(targetPath);
                    const isMuted = this._currentDiscussion.mutedFiles.some(p => this.normalizePathKey(p) === targetKey);
                    const shouldMute = typeof message.muted === 'boolean' ? message.muted : !isMuted;

                    if (!shouldMute) {
                        await this.unmuteFiles([targetPath]);
                    } else {
                        await this.muteFiles([targetPath]);
                    }
                }
                break;

            case 'toggleMuteTool':
                if (this._currentDiscussion && message.toolName) {
                    if (!this._currentDiscussion.mutedTools) this._currentDiscussion.mutedTools = [];
                    const tName = message.toolName.trim();
                    const idx = this._currentDiscussion.mutedTools.indexOf(tName);
                    if (idx !== -1) {
                        this._currentDiscussion.mutedTools.splice(idx, 1);
                        vscode.window.showInformationMessage(`Reactivated tool "${tName}" for this discussion.`);
                    } else {
                        this._currentDiscussion.mutedTools.push(tName);
                        vscode.window.showInformationMessage(`Deactivated tool "${tName}" for this discussion (Muted).`);
                    }

                    if (!this._currentDiscussion.id.startsWith('temp-')) {
                        await this._discussionManager.saveDiscussion(this._currentDiscussion);
                    }
                    this.updateContextAndTokens({ isBackgroundSync: false });
                }
                break;

            case 'toggleMuteSkill':
                if (this._currentDiscussion && message.skillId) {
                    if (!this._currentDiscussion.mutedSkills) this._currentDiscussion.mutedSkills = [];
                    const sId = message.skillId.trim();
                    const idx = this._currentDiscussion.mutedSkills.indexOf(sId);
                    if (idx !== -1) {
                        this._currentDiscussion.mutedSkills.splice(idx, 1);
                        vscode.window.showInformationMessage(`Reactivated skill for this discussion.`);
                    } else {
                        this._currentDiscussion.mutedSkills.push(sId);
                        vscode.window.showInformationMessage(`Deactivated skill for this discussion (Muted).`);
                    }

                    if (!this._currentDiscussion.id.startsWith('temp-')) {
                        await this._discussionManager.saveDiscussion(this._currentDiscussion);
                    }
                    this.updateContextAndTokens({ isBackgroundSync: false });
                }
                break;

            case 'toggleMuteDiagram':
                if (this._currentDiscussion && message.diagType) {
                    if (!this._currentDiscussion.mutedDiagrams) this._currentDiscussion.mutedDiagrams = [];
                    const dType = message.diagType.trim();
                    const idx = this._currentDiscussion.mutedDiagrams.indexOf(dType);
                    if (idx !== -1) {
                        this._currentDiscussion.mutedDiagrams.splice(idx, 1);
                        vscode.window.showInformationMessage(`Reactivated ${dType.replace('_', ' ')} diagram for this discussion.`);
                    } else {
                        this._currentDiscussion.mutedDiagrams.push(dType);
                        vscode.window.showInformationMessage(`Deactivated ${dType.replace('_', ' ')} diagram for this discussion (Muted).`);
                    }

                    if (!this._currentDiscussion.id.startsWith('temp-')) {
                        await this._discussionManager.saveDiscussion(this._currentDiscussion);
                    }
                    this.updateContextAndTokens({ isBackgroundSync: false });
                }
                break;
            case 'bulkMuteFiles':
                if (Array.isArray(message.paths)) {
                    const count = await this.muteFiles(message.paths);
                    vscode.window.showInformationMessage(`Deactivated content for ${count} file(s) for this discussion (Muted).`);
                }
                break;
            case 'bulkUnmuteFiles':
                if (Array.isArray(message.paths)) {
                    await this.unmuteFiles(message.paths);
                    this.recordCurrentPromptFiles(message.paths);
                    if (message.reprompt) {
                        this.recordPendingJustAddedFiles(message.paths);
                        await this.sendMessage({
                            role: 'user',
                            content: `I have unmuted the requested file(s): [${message.paths.join(', ')}]. Their full contents are now active in your context. Please continue.`
                        });
                    }
                }
                break;
            case 'removeFileFromContext':
            case 'bulkRemoveFiles':
                if (this._contextManager) {
                    const paths: string[] = message.command === 'bulkRemoveFiles' ? (message.paths || []) : [message.path];
                    const uris: vscode.Uri[] = [];
                    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

                    let tokensToRemove = 0;
                    for (const p of paths) {
                        const cleanP = String(p).replace(/\\/g, '/').trim();

                        // 1. Remove external link if linked
                        await (this._contextManager as any).removeExternalLink?.(cleanP, workspaceFolder);

                        // 2. If it's stored inside .lollms/external_files, delete it from disk
                        if (cleanP.includes('.lollms/external_files')) {
                            try {
                                const res = await this._contextManager.resolveWorkspaceFromPath(cleanP);
                                if (res) {
                                    await vscode.workspace.fs.delete(res.uri, { useTrash: true }).then(undefined, () => {});
                                }
                            } catch {}
                        }

                        const res = await this._contextManager.resolveWorkspaceFromPath(cleanP);
                        if (res) {
                            uris.push(res.uri);
                            this._contextManager.refreshFileInCache(res.uri);
                        } else {
                            uris.push(vscode.Uri.file(cleanP));
                        }

                        const cached = (this._contextManager as any)._fileContentCache?.get(cleanP);
                        if (cached) {
                            tokensToRemove += Math.ceil(cached.content.length / 3.5);
                        }
                        await this._contextManager.removeCachedTokens(cleanP);
                    }

                    const provider = this._contextManager.getContextStateProvider();
                    if (provider) {
                        await (provider as any).removeFiles?.(paths);
                        await provider.setStateForUris(uris, 'tree-only');
                    }

                    // Remove from discussion state and active muted files
                    await this.removeFilesFromDiscussionContext(paths);
                    if (this._currentDiscussion && this._currentDiscussion.mutedFiles) {
                        const { arePathsEqual } = require('../../utils');
                        const targetPaths = paths.map((x: string) => x.replace(/\\/g, '/').trim());
                        this._currentDiscussion.mutedFiles = this._currentDiscussion.mutedFiles.filter((m: string) => {
                            return !targetPaths.some((t: string) => arePathsEqual(m, t));
                        });
                        this._discussionCapabilities.mutedFiles = [...this._currentDiscussion.mutedFiles];
                        await this._discussionManager.saveLastMutedFiles(this._currentDiscussion.mutedFiles);
                        if (!this._currentDiscussion.id.startsWith('temp-')) {
                            await this._discussionManager.saveDiscussion(this._currentDiscussion);
                        }
                    }

                    // --- INSTANT HYDRATION SUBTRACTION ---
                    if (this._currentDiscussion?.lastTokenMetrics) {
                        const m = this._currentDiscussion.lastTokenMetrics;
                        m.total = Math.max(0, m.total - tokensToRemove);
                        if (m.segments) {
                            m.segments.files = Math.max(0, m.segments.files - tokensToRemove);
                            m.segments.external = Math.max(0, (m.segments.external || 0) - tokensToRemove);
                        }

                        this._panel.webview.postMessage({
                            command: 'updateTokenProgress',
                            totalTokens: m.total,
                            contextSize: m.contextSize,
                            isApproximate: false,
                            segments: m.segments
                        });
                    }

                    // Run synchronization to update HUD and token counts
                    this.updateContextAndTokens({ isBackgroundSync: false });
                }
                break;
            case 'scrutinizeKnowledgeTree':
            case 'rebuildKnowledgeGraph':
                await this.handleScrutinizeKnowledgeTree();
                break;
            case 'requestKnowledgeGraphData':
                {
                    try {
                        const folder = vscode.workspace.workspaceFolders?.[0];
                        if (folder) {
                            const { KnowledgeManager } = require('../../knowledgeManager');
                            const km = new KnowledgeManager(this._discussionManager.context);
                            const connectedOnly = message.connectedOnly === true;
                            let graphData = await km.getHighLevelGraphElements(folder, connectedOnly);

                            // Automatic ABox Auto-Population: If graph has no nodes or edges, trigger full AST parse and sync immediately
                            if ((!graphData.edges || graphData.edges.length === 0 || !graphData.nodes || graphData.nodes.length === 0) && this._codeGraphManager) {
                                this._codeGraphManager.setWorkspaceRoot(folder.uri);
                                this._codeGraphManager.reset();
                                await this._codeGraphManager.buildGraph();
                                await km.syncCodeGraph(
                                    this._codeGraphManager.getGraphData().nodes,
                                    this._codeGraphManager.getGraphData().edges,
                                    folder
                                );
                                graphData = await km.getHighLevelGraphElements(folder, connectedOnly);
                            }

                            webview.postMessage({
                                command: 'updateKnowledgeGraphData',
                                elements: graphData
                            });
                        }
                    } catch (e) {
                        Logger.warn("Failed to serve high-level graph elements", e);
                    }
                }
                break;
            case 'translateTextToSparql':
                {
                    const naturalQuery = (message.query || "").trim();
                    if (!naturalQuery) break;

                    const systemPrompt = `You are an expert SPARQL-lite query generator for the LoLLMs Software Architecture Ontology (.lollms/knowledge.ttl).
Translate the user's natural language question into a valid, executable SPARQL-lite SELECT query.

ONTOLOGY NAMESPACES:
- Prefix: s: <http://lollms.io/ontology#>

CLASSES:
- s:SourceFile, s:BackendModule, s:VueComponent, s:AutomationScript, s:ExternalLibrary
- s:ClassDefinition, s:InterfaceDefinition, s:FunctionDefinition, s:MethodDefinition, s:APIRoute, s:StateStore
- s:ArchitecturalInsight, s:TopicTag

PROPERTIES:
- s:containsEntity (SourceFile or Class contains entity)
- s:definedInFile (Entity defined in SourceFile)
- s:memberOfClass (Method member of Class)
- s:importsModule (SourceFile imports Module or Library)
- s:invokesFunction (CodeEntity calls Function)
- s:inheritsFrom (Class inherits Class)
- s:exposesEndpoint (SourceFile exposes APIRoute)
- s:disjointWith (Same-name entities in different files)
- s:programmingLanguage (Literal: "Python", "Vue", "TypeScript", "JavaScript", "Bash", etc.)
- s:layer (Literal: "Backend", "Frontend", "DevOps", "Shared")
- s:name (Symbol name)
- s:filePath (Relative file path)

OUTPUT RULES:
1. Provide a 1-sentence explanation of what the query searches for.
2. Output ONLY the SPARQL query inside a \`\`\`sparql ... \`\`\` code block.
3. Keep queries focused and always include LIMIT 25.`;

                    try {
                        const targetModel = this._currentDiscussion?.model || this._lollmsAPI.getModelName();
                        const llmRes = await this._lollmsAPI.sendChat([
                            { role: 'system', content: systemPrompt },
                            { role: 'user', content: `Translate this question to SPARQL: "${naturalQuery}"` }
                        ], null, undefined, targetModel, { thinking: false });

                        const cleanRes = stripThinkingTags(llmRes).trim();
                        const sparqlMatch = cleanRes.match(/```(?:sparql)?\s*([\s\S]+?)\s*```/i);
                        const sparqlQuery = sparqlMatch ? sparqlMatch[1].trim() : cleanRes;
                        const explanation = cleanRes.replace(/```[\s\S]*?```/g, '').trim();

                        const { KnowledgeManager } = require('../../knowledgeManager');
                        const folder = vscode.workspace.workspaceFolders?.[0];
                        const km = new KnowledgeManager(this._discussionManager.context);
                        const queryResult = await km.executeSparql(sparqlQuery, folder);

                        this._panel.webview.postMessage({
                            command: 'textToSparqlResult',
                            naturalQuery,
                            sparqlQuery,
                            explanation,
                            result: queryResult
                        });
                    } catch (err: any) {
                        this._panel.webview.postMessage({
                            command: 'textToSparqlResult',
                            naturalQuery,
                            error: err.message
                        });
                    }
                }
                break;
            case 'resetKnowledge':
                {
                    const { KnowledgeManager } = require('../../knowledgeManager');
                    const km = new KnowledgeManager(this._discussionManager.context);
                    await km.resetKnowledge();

                    if (this._currentDiscussion) {
                        let parsed: any = {};
                        try { parsed = JSON.parse(this._currentDiscussion.discussion_data_zone || '{}'); } catch {}
                        Object.keys(parsed).forEach(k => {
                            if (k.startsWith('librarian_findings_') || k.startsWith('findings_')) delete parsed[k];
                        });
                        this._currentDiscussion.discussion_data_zone = JSON.stringify(parsed);
                        if (!this._currentDiscussion.id.startsWith('temp-')) {
                            await this._discussionManager.saveDiscussion(this._currentDiscussion);
                        }
                    }

                    this._panel.webview.postMessage({
                        command: 'updateKnowledgeContent',
                        knowledge: ''
                    });
                    this.updateContextAndTokens({ isBackgroundSync: false });
                    vscode.window.showInformationMessage("🧹 Knowledge Base (.lollms/KNOWLEDGE.md & structure.md) has been reset.");
                }
                break;
            case 'loadKnowledgeSection':
                {
                    const targetSecPath = message.path;
                    if (targetSecPath) {
                        try {
                            const { KnowledgeManager } = require('../../knowledgeManager');
                            const km = new KnowledgeManager(this._discussionManager.context);
                            const newScore = await km.incrementAccessCount(targetSecPath);
                            const rendered = await km.renderContextKnowledge();
                            webview.postMessage({
                                command: 'updateKnowledgeContent',
                                knowledge: rendered
                            });
                            vscode.window.showInformationMessage(`Uncollapsed section '${targetSecPath}' [${newScore}]`);
                        } catch (err: any) {
                            vscode.window.showErrorMessage(`Failed to load knowledge section: ${err.message}`);
                        }
                    }
                }
                break;
            case 'openFile':
                if (this._contextManager) {
                    const res = await this._contextManager.resolveWorkspaceFromPath(message.path);
                    if (res) {
                        try {
                            const doc = await vscode.workspace.openTextDocument(res.uri);
                            const editor = await vscode.window.showTextDocument(doc);
                            if (typeof message.line === 'number' && message.line > 0) {
                                const lineNum = message.line - 1;
                                const charNum = (typeof message.character === 'number' && message.character > 0) ? message.character - 1 : 0;
                                const pos = new vscode.Position(lineNum, charNum);
                                editor.selection = new vscode.Selection(pos, pos);
                                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                            }
                        } catch (e: any) {
                            vscode.window.showErrorMessage(`Could not open file: ${e.message}`);
                        }
                    } else {
                        vscode.window.showErrorMessage(`Could not resolve path to open: ${message.path}`);
                    }
                }
                break;
            case 'removeSkillFromContext':
                if (this._currentDiscussion && this._currentDiscussion.importedSkills) {
                    this._currentDiscussion.importedSkills = this._currentDiscussion.importedSkills.filter(id => id !== message.skillId);
                    await this._contextManager.removeSkillFromProject(message.skillId);
                    if (!this._currentDiscussion.id.startsWith('temp-')) {
                        await this._discussionManager.saveDiscussion(this._currentDiscussion);
                    }
                    this.updateContextAndTokens();
                }
                break;
            case 'requestToolPicker':
                {
                    const isAssistant = !this._discussionCapabilities.agentMode && !this._discussionCapabilities.dynamicMode;
                    if (isAssistant) {
                        vscode.window.showInformationMessage("Tools are only active in Co-Engineer and Agent modes. Switch mode to activate tools.");
                    }
                    const allTools = this.agentManager.getTools().map(t => ({ name: t.name, description: t.description }));
                    const discussionTools = this._currentDiscussion?.importedTools || [];
                    const projectTools = await this._contextManager.getActiveProjectTools();
                    this._panel.webview.postMessage({ 
                        command: 'showToolPicker', 
                        allTools, 
                        discussionTools,
                        projectTools,
                        isAssistantMode: isAssistant
                    });
                }
                break;
            case 'removeToolFromContext':
                if (this._currentDiscussion) {
                    this._currentDiscussion.importedTools = (this._currentDiscussion.importedTools || []).filter(n => n !== message.toolName);
                    if (!this._currentDiscussion.id.startsWith('temp-')) {
                        await this._discussionManager.saveDiscussion(this._currentDiscussion);
                    }
                    this.updateContextAndTokens();
                }
                break;
            case 'summarizeContextFile':
                await this.handleSummarizeContextFile(message.path);
                break;
            case 'bulkSummarizeContextFiles':
                await this.handleBulkSummarizeContextFiles(message.files, message.instruction);
                break;
            case 'bulkDeleteContextFiles':
                await this.handleBulkDeleteContextFiles(message.files);
                break;
            case 'bulkRemoveSkills':
                await this.handleBulkRemoveSkills(message.skillIds);
                break;
            case 'showWarning':
                vscode.window.showWarningMessage(message.message);
                break;
            case 'updateDiscussionModel':
                if (this._currentDiscussion) {
                    this._currentDiscussion.model = message.model || undefined;
                    ChatPanel._tokenCountCache.clear();
                    const effectiveModel = message.model || this._lollmsAPI.getModelName();
                    this._panel.webview.postMessage({ command: 'updateModelNameOnly', modelName: effectiveModel });

                    // Auto-bind optimal temperature setting if configured for this model
                    const optConfig = vscode.workspace.getConfiguration('lollmsVsCoder');
                    const optimalSettings = optConfig.get<Record<string, { enableTemperature: boolean, temperature?: number }>>('modelOptimalSettings') || {};
                    const rawModelName = effectiveModel.includes('::') ? effectiveModel.split('::')[1] : effectiveModel;
                    const bound = optimalSettings[effectiveModel] || optimalSettings[rawModelName];
                    if (bound) {
                        this._discussionCapabilities.enableTemperature = bound.enableTemperature;
                        if (bound.enableTemperature && bound.temperature !== undefined) {
                            this._discussionCapabilities.temperature = bound.temperature;
                        }
                        if (this._currentDiscussion.capabilities) {
                            this._currentDiscussion.capabilities.enableTemperature = bound.enableTemperature;
                            this._currentDiscussion.capabilities.temperature = bound.temperature;
                        }
                        this._panel.webview.postMessage({
                            command: 'updateDiscussionCapabilities',
                            capabilities: this._discussionCapabilities
                        });
                        const tempDesc = bound.enableTemperature ? `Temp: ${bound.temperature}` : 'Auto (No Temperature)';
                        vscode.window.setStatusBarMessage(`Applied optimal setting for ${effectiveModel} (${tempDesc})`, 3000);
                    }

                    if (!this._currentDiscussion.id.startsWith('temp-')) {
                        await this._discussionManager.saveDiscussion(this._currentDiscussion);
                    }
                    this.updateContextAndTokens({ isBackgroundSync: false });
                }
                return;
            case 'refreshModels':
                await this._fetchAndSetModels(true);
                break;
            case 'calculateTokens':
                this.updateContextAndTokens({ forceFullScan: message.force === true });
                break;
            case 'markHunkApplied':
                const isUndo = message.undo === true;
                await this.updateAppliedState(message.messageId, message.blockIndex, message.hunkIndex, isUndo);
                webview.postMessage({
                    command: 'applyAllResult',
                    messageId: message.messageId,
                    blockIndex: message.blockIndex,
                    hunkIndex: message.hunkIndex,
                    blockId: message.blockId,
                    filePath: message.filePath,
                    success: true,
                    alreadyApplied: !isUndo,
                    undo: isUndo
                });
                break;
            case 'stopTokenCalculation':
                if (this._tokenAbortController) {
                    this._tokenAbortController.abort();
                    this._tokenAbortController = null;
                }
                break;
            case 'copyToClipboard':
                if (message.text) {
                    await vscode.env.clipboard.writeText(message.text);
                    // Optional: Show a small status bar message to confirm
                    vscode.window.setStatusBarMessage("Lollms: Copied to clipboard", 2000);
                }
                break;
            case 'executeLollmsCommand':
                const { command, params } = message.details;
                if (command === 'search-add-context-btn') {
                    // Send message back to webview to open the modal
                    webview.postMessage({ command: 'showFileSearchModal' });
                } else if (command === 'lollms-vs-coder.runSparqlQueryDirectly') {
                    let result = "";
                    let constructedGraph: any = null;
                    try {
                        const { KnowledgeManager } = require('../../knowledgeManager');
                        const folder = vscode.workspace.workspaceFolders?.[0];
                        const km = new KnowledgeManager(this._discussionManager.context);
                        result = await km.executeSparql(params.query, folder);
                        constructedGraph = km.lastConstructedGraph;
                    } catch (e: any) {
                        result = `SPARQL Error: ${e.message}`;
                    }

                    webview.postMessage({
                        command: 'applyAllResult',
                        messageId: params?.messageId,
                        blockIndex: params?.blockId,
                        success: true,
                        sparqlResult: result,
                        constructedGraph: constructedGraph
                    });

                    // Update live drawer results area if opened directly from HUD
                    webview.postMessage({
                        command: 'updateDrawerSparqlResult',
                        result: result
                    });
                    
                    if (params.reprompt) {
                        const activePanel = ChatPanel.panels.get(this.discussionId);
                        if (activePanel && activePanel.getCurrentDiscussion()) {
                            // Check if this is an active generation session
                            const proc = this.processManager.getForDiscussion(this.discussionId);
                            const activeGen = ChatPanel.activeGenerations.get(this.discussionId);
                            if (activeGen || proc) {
                                // Generation is already running, avoid spawning duplicate parallel turns
                                return;
                            }

                            // If triggered manually by user click while NOT generating, simulate the next turn privately
                            const responsePrompt = `### 📋 SPARQL QUERY RESULT\nQuery executed on the complete ontology graph:\n\`\`\`sparql\n${params.query}\n\`\`\`\n\n**Result:**\n${result}\n\nAnalyze these results and proceed with the mission.`;

                            activePanel.sendMessage({ role: 'system', content: responsePrompt, skipInPrompt: false });
                        }
                    }
                } else if (command === 'createNotebook') {
                    vscode.commands.executeCommand('lollms-vs-coder.createNotebook', params.path, params.cellContent);
                } else if (command === 'gitCommit') {
                    vscode.commands.executeCommand('lollms-vs-coder.gitCommit', params.message);
                } else if (command === 'resetContext') {
                    await this._contextManager.getContextStateProvider()?.softReset();
                    await this._discussionManager.saveLastMutedFiles([]);
                    this._contextManager.clearAllCaches();
                    if (this._currentDiscussion) {
                        this._currentDiscussion.mutedFiles = [];
                        this._currentDiscussion.importedTools = [];
                        this._currentDiscussion.activeDiagrams = [];
                        this._currentDiscussion.lastTokenMetrics = undefined;
                        if (!this._currentDiscussion.id.startsWith('temp-')) {
                            await this._discussionManager.saveDiscussion(this._currentDiscussion);
                        }
                    }
                    this._panel.webview.postMessage({
                        command: 'updateContext',
                        files: [],
                        tools: [],
                        diagrams: [],
                        mutedFiles: [],
                        mutedTools: [],
                        mutedDiagrams: []
                    });
                    this.updateContextAndTokens({ isBackgroundSync: false });
                    vscode.window.showInformationMessage("Reset included files and discussion context.");
                } else if (command === 'saveContext') {
                    vscode.commands.executeCommand('lollms-vs-coder.saveContextSelection');
                } else if (command === 'loadContext') {
                    vscode.commands.executeCommand('lollms-vs-coder.loadContextSelection');
                } else if (command === 'addContext') {
                    vscode.commands.executeCommand('lollms-vs-coder.addContextSelection');
                } else if (command === 'synthesizeSearchResults') {
                    if (!this.agentManager.getIsActive()) {
                        this.agentManager.toggleAgentMode();
                    }
                    const query = params.query;
                    const objective = `Research the following query: "${query}"
                    
Look at the previous message which contains search results and links.

Task:
1. Use the \`scrape_website\` tool to read the content of the relevant links found in the previous search results (limit to top 3).
2. Synthesize the information gathered from these pages.
3. Provide a comprehensive answer to the query based on the scraped content.`;

                    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                        this.agentManager.run(objective, this._currentDiscussion!, vscode.workspace.workspaceFolders[0], this._currentDiscussion?.model);
                    } else {
                        vscode.window.showErrorMessage("Active workspace required for agent execution.");
                    }
                } else {
                    // ROBUST FALLBACK: Allow execution of any command starting with allowed namespaces (whitelisting by prefix)
                    if (command.startsWith('lollms-vs-coder.') || command.startsWith('workbench.') || command.startsWith('vscode.')) {
                        if (Array.isArray(params)) {
                            vscode.commands.executeCommand(command, ...params);
                        } else if (params !== undefined) {
                            vscode.commands.executeCommand(command, params);
                        } else {
                            vscode.commands.executeCommand(command);
                        }
                    } else {
                        console.warn(`executeLollmsCommand: Blocked attempt to run unauthorized command: ${command}`);
                    }
                }
                break;


            case 'inspectCode':
                this.handleInspectCode(message);
                return;
            case 'inspectPatch':
                await this.handleInspectPatch(message);
                break;
            case 'stopGeneration':
                if (this._currentDiscussion) {
                    const isInterruption = message.isInterruption === true;
                    this._activeMultiPartPlan = undefined;
                    ChatPanel.isBatchApplying = false; // Immediately kill batch apply operations

                    if (this._activeRepairController) {
                        this._activeRepairController.abort();
                        this._activeRepairController = null;
                    }

                    // 1. Clear active generations and cancel current processes immediately
                    await this.processManager.cancelForDiscussion(this.discussionId);
                    ChatPanel.activeGenerations.delete(this.discussionId);

                    // 1.5 Embedded agent mode: reject any pending inline question and release the answer binding
                    if (this._pendingAgentQuestion) {
                        this.cancelPendingAgentQuestion('Generation stopped by user.');
                    }
                    if (this._inputResolver) {
                        const resolver = this._inputResolver;
                        this._inputResolver = null;
                        resolver('STOP_REQUESTED');
                    }
                    if (this._activeAgentAnswerId) {
                        const targetId = this._activeAgentAnswerId;
                        this._activeAgentAnswerId = undefined;
                        const targetMsg = this._currentDiscussion?.messages.find(m => m.id === targetId);
                        if (targetMsg) {
                            if (!targetMsg.content || (typeof targetMsg.content === 'string' && targetMsg.content.trim() === '')) {
                                const idx = this._currentDiscussion!.messages.findIndex(m => m.id === targetId);
                                if (idx !== -1) {
                                    this._currentDiscussion!.messages.splice(idx, 1);
                                }
                                this._panel.webview.postMessage({ command: 'removeMessage', messageId: targetId });
                            } else {
                                this._panel.webview.postMessage({ command: 'finalizeMessage', id: targetId, fullContent: targetMsg.content });
                            }
                        }
                    }

                    // 2. State management for Agent
                    if (this.agentManager) {
                        const plan = (this.agentManager as any).currentPlan;
                        if (isInterruption) {
                            // PAUSE: Keep the agent in "Active" intent but stop the loop execution
                            (this.agentManager as any).isActive = false; 
                            if (plan) {
                                plan.status = 'stale';
                                // Mark active tasks as stale so they stop spinning
                                plan.tasks.forEach((t: any) => {
                                    if (t.status === 'in_progress') t.status = 'pending';
                                });
                            }

                            await this.addMessageToDiscussion({
                                role: 'system',
                                content: '✋ **Mission Paused.** The Architect has stopped to receive your feedback. Provide your thoughts below to adjust the strategy.'
                            });
                        } else {
                            // KILL: Complete exit from agent mode. 
                            (this.agentManager as any).isActive = false;
                            if (plan) {
                                plan.status = 'failed';
                                // Force fail all unfinished tasks
                                plan.tasks.forEach((t: any) => {
                                    if (t.status === 'in_progress' || t.status === 'pending') {
                                        t.status = 'failed';
                                        t.result = t.result || "Terminated by user.";
                                    }
                                });
                            }
                            this.updateAgentMode(false);
                        }
                        // Refresh the UI plan state immediately
                        this.agentManager.displayPlan(plan);
                    }

                    // 3. Cleanup UI
                    this._panel.webview.postMessage({ command: 'resetApplyingButtons' });
                    this._panel.webview.postMessage({ command: 'updateGenerationMetrics', reset: true });
                    this.updateGeneratingState();
                    this.updateAgentMode(this.agentManager?.getIsActive() || false);
                }
                break;
            case 'toggleAgentMode':
                this.agentManager.toggleAgentMode();
                this._discussionCapabilities.agentMode = this.agentManager.getIsActive();
                this.saveCapabilities();
                this._panel.webview.postMessage({ command: 'updateDiscussionCapabilities', capabilities: this._discussionCapabilities });
                break;
            case 'setAgentMode':
                {
                    const isActive = !!message.isActive;
                    this._discussionCapabilities.agentMode = isActive;
                    if (this.agentManager) {
                        (this.agentManager as any).isActive = isActive;
                    }
                    await this.saveCapabilities();
                    this.updateAgentMode(isActive);
                    ChatPanel.panels.forEach(p => {
                        if (!p._isDisposed && p._panel && p._panel.webview) {
                            p._panel.webview.postMessage({ command: 'setAgentMode', isActive });
                            p._panel.webview.postMessage({ command: 'updateDiscussionCapabilities', capabilities: p._discussionCapabilities });
                        }
                    });
                }
                break;
            case 'agentSecurityAction':
                {
                    const act = message.action;
                    if (act === 'set_level' && ['strict', 'guarded', 'relaxed'].includes(message.level)) {
                        this._discussionCapabilities.agentSecurityLevel = message.level;
                        await this.saveCapabilities(true);
                        this.syncAgentSecurityState(
                            message.level,
                            this.agentManager?.securityGuard?.getActiveMutationCount() || 0
                        );
                        webview.postMessage({
                            command: 'updateDiscussionCapabilities',
                            capabilities: this._discussionCapabilities
                        });
                        vscode.window.setStatusBarMessage(`Agent Security Level set to: ${message.level.toUpperCase()}`, 3000);
                    } else if (act === 'checkpoint' && this.agentManager) {
                        const res = await this.agentManager.createSecurityCheckpoint();
                        if (res.success) {
                            vscode.window.showInformationMessage(`📸 ${res.message}`);
                        } else {
                            vscode.window.showWarningMessage(res.message);
                        }
                    } else if (act === 'rollback' && this.agentManager) {
                        const count = this.agentManager.securityGuard.getActiveMutationCount();
                        if (count === 0) {
                            vscode.window.showInformationMessage('No active agent file mutations to roll back in this session.');
                            break;
                        }
                        const scope = message.scope === 'last' ? 'last' : 'all';
                        const label = scope === 'last' ? 'Revert Last Agent Mutation' : `Rollback All ${count} Agent Mutations`;
                        const confirm = await vscode.window.showWarningMessage(
                            `Restore files from Agent Security Guard pre-mutation snapshots (${scope === 'last' ? '1 step' : `${count} operations`})?`,
                            { modal: true },
                            label
                        );
                        if (confirm === label) {
                            await this.agentManager.rollbackAgentMutations(scope);
                            this.updateContextAndTokens({ isBackgroundSync: false });
                        }
                    } else if (act === 'view_log' && this.agentManager) {
                        const logs = this.agentManager.securityGuard.getAuditLog();
                        const muts = this.agentManager.securityGuard.getMutations();
                        const level = this.agentManager.getSecurityLevel();
                        const report = [
                            `# 🛡️ Agent Security Audit & Mutation Vault`,
                            `- **Security Level**: \`${level.toUpperCase()}\``,
                            `- **Active Reversible Snapshots**: ${muts.filter(m => !m.reverted).length}`,
                            ``,
                            `## 📝 Recorded File Mutations`,
                            muts.length > 0
                                ? muts.map(m => `- \`${new Date(m.timestamp).toLocaleTimeString()}\` **${m.action.toUpperCase()}** via \`${m.tool}\` → \`${m.filePath}\`${m.reverted ? ' *(REVERTED)*' : ''}`).join('\n')
                                : '*No file mutations recorded yet.*',
                            ``,
                            `## 🔍 Security Gate Decisions`,
                            logs.length > 0
                                ? logs.map(l => `- \`${new Date(l.timestamp).toLocaleTimeString()}\` **[${l.verdict.toUpperCase()}]** \`${l.tool}\` on \`${l.target}\`: ${l.reason}`).join('\n')
                                : '*No security interventions triggered yet.*'
                        ].join('\n');
                        InfoPanel.createOrShow(this._extensionUri, 'Agent Security Audit Log', report);
                    }
                }
                break;
            case 'answerAgentQuestion':
                {
                    // Inline agent question answered from the chat stream (same answer block)
                    const answerText = typeof message.answer === 'string' ? message.answer : String(message.answer || '');
                    this.resolvePendingAgentQuestion(answerText);
                }
                break;
            case 'runAgent':
                if (!this._currentDiscussion) return;
                try {
                    await vscode.workspace.saveAll(false);
                } catch {}

                // Handle continuation after manual approval
                if (message.objective === 'CONTINUE_AFTER_APPROVAL') {
                    const approvedTaskId = parseInt(message.taskId, 10);
                    const alwaysAllow = !!message.alwaysAllow;

                    if (alwaysAllow && (this.agentManager as any)['currentPlan']) {
                        const task = (this.agentManager as any)['currentPlan'].tasks.find((t: any) => t.id === approvedTaskId);
                        if (task) {
                            const policies = this._discussionCapabilities.toolPolicies || {};
                            policies[task.action] = 'autonomous';
                            await this.updateCapabilities({ toolPolicies: policies });
                        }
                    }

                    const { id: processId, controller } = this.processManager.register(this.discussionId, 'Executing approved task...');
                    this.updateGeneratingState();

                    try {
                        await this.agentManager.resumeTask(approvedTaskId, processId, controller.signal);
                    } finally {
                        this.processManager.unregister(processId);
                        this.updateGeneratingState();
                    }
                    return;
                }

                if (message.message) await this.addMessageToDiscussion(message.message);
                if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                    await this.agentManager.handleUserMessage(
                        message.objective, 
                        this._currentDiscussion, 
                        vscode.workspace.workspaceFolders[0]
                    );
                } else {
                    this.addMessageToDiscussion({ role: 'system', content: 'Agent requires an active workspace folder.' });
                    this.updateGeneratingState();
                }
                break;
            case 'retryAgentTask':
                this.agentManager?.retryFailedTask(parseInt(message.taskId, 10));
                break;
            case 'editAndRetryAgentTask':
                if (this.agentManager) {
                    this.agentManager.editAndRetryTask(parseInt(message.taskId, 10), message.params);
                }
                break;
            case 'loadFile':
                {
                    const { name: fileName2, content: fileContent2, isImage: isImage2 } = message.file;
                    let importMode: string | undefined = undefined;
                    if (fileName2.toLowerCase().endsWith('.pdf')) {
                        const choices =[
                            { label: 'Text (Markdown)', mode: 'text', detail: 'Extract text content only.' },
                            { label: 'Text + Images', mode: 'mixed', detail: 'Extract text and include embedded images.' },
                            { label: 'Images only', mode: 'images', detail: 'Convert every page of the PDF into an image for visual analysis.' }
                        ];
                        const choice = await vscode.window.showQuickPick(choices, { placeHolder: `How should I import ${fileName2}?` });
                        
                        if (!choice) {
                            this._panel.webview.postMessage({ command: 'setGeneratingState', isGenerating: false });
                            break; // User cancelled
                        }
                        importMode = choice.mode;
                    }
                    await this._handleFileAttachment(fileName2, fileContent2, isImage2, importMode);
                }
                break;
            case 'requestDeleteMessage':
                await this.deleteMessage(message.messageId);
                break;
            case 'switchDiscussion':
                if (message.discussionId) {
                    // Pre-clean before sending back to extension host
                    const cleanId = message.discussionId.replace(/^\/+/, '');
                    vscode.commands.executeCommand('lollms-vs-coder.switchDiscussion', cleanId);
                }
                break;
            case 'requestAgentSettings': {
                const config = vscode.workspace.getConfiguration('lollmsVsCoder');
                const allTools = this.agentManager.getTools();
                const enabledTools = this.agentManager.getEnabledTools().map(t => t.name);
                const { AGENT_MISSION_PROFILES } = require('../../registries/agentProfiles');

                this._panel.webview.postMessage({ 
                    command: 'showAgentSettings', 
                    allTools, 
                    enabledTools,
                    allProfiles: AGENT_MISSION_PROFILES,
                    settings: {
                        maxSteps: config.get('lollmsVsCoder.agent.maxSteps') || 100,
                        maxEditRetries: config.get('lollmsVsCoder.agent.maxEditRetries') || 3,
                        activeProfile: config.get('lollmsVsCoder.agent.activeProfile') || 'software_architect'
                    }
                });
                break;
            }
            case 'requestDiscussionSettings': {
                const workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => ({
                    name: f.name,
                    uri: f.uri.toString()
                }));

                const { SYSTEM_RESPONSE_PROFILES } = require('../../utils');
                const systemProfiles = Array.isArray(SYSTEM_RESPONSE_PROFILES) ? SYSTEM_RESPONSE_PROFILES : [];
                const rawConfigProfiles = vscode.workspace.getConfiguration('lollmsVsCoder').get<any[]>('responseProfiles') || [];
                const customProfiles = (Array.isArray(rawConfigProfiles) ? rawConfigProfiles : []).filter((p: any) => p && p.id);
                const combinedProfiles = [...systemProfiles, ...customProfiles.filter((p: any) => !systemProfiles.some((sp: any) => sp.id === p.id))];

                this._panel.webview.postMessage({ 
                    command: 'showDiscussionSettings', 
                    capabilities: this._discussionCapabilities,
                    workspaceFolders: workspaceFolders,
                    profiles: combinedProfiles
                });
                break;
            }
            case 'updateProfiles': {
                if (Array.isArray(message.profiles)) {
                    const customOnly = message.profiles.filter((p: any) => p && p.id && !['balanced', 'creative', 'precise', 'code_expert'].includes(p.id));
                    await vscode.workspace.getConfiguration('lollmsVsCoder').update('responseProfiles', customOnly, vscode.ConfigurationTarget.Global);
                }
                break;
            }
            case 'requestLog':
                this.showInternalLog();
                return;
            case 'regenerateFromMessage':
                await this.regenerateFromMessage(message.messageId);
                break;
            case 'insertMessage':
                await this.insertMessage(message.afterMessageId, message.role, message.content, message.isPastedAsAi);
                break;
            case 'updateMessage':
                await this.updateMessage(message.messageId, message.newContent);
                break;
            case 'saveAndSendMessage':
                await this.handleSaveAndSendMessage(message.messageId, message.newContent, message.role);
                break;
            case 'applyFileContent':
                try {
                    const isManual = !message.options?.silent;
                    const opts = { 
                        silent: !isManual, 
                        autoSave: !isManual, 
                        messageId: message.messageId, 
                        blockIndex: message.blockIndex,
                        hunkIndex: message.hunkIndex,
                        blockId: message.blockId || message.options?.blockId,
                        ...(message.options || {})
                    };
                    const res: any = await vscode.commands.executeCommand('lollms-vs-coder.applyFileContent', message.filePath, message.content, opts);

                    if (res && res.success) {
                        if (message.filePath) {
                            const cleanP = message.filePath.includes(':') && !/^[a-zA-Z]:[\\/]/.test(message.filePath) ? message.filePath.split(':')[0] : message.filePath;
                            await this.unmuteFiles([cleanP]);
                            await this._contextManager.getContextStateProvider()?.addFilesToContext([cleanP]);
                            const resPath = await this._contextManager.resolveWorkspaceFromPath(cleanP);
                            if (resPath) this._contextManager.refreshFileInCache(resPath.uri);
                        }
                        if (opts.silent || res.alreadyApplied) {
                            webview.postMessage({
                                command: 'applyAllResult',
                                messageId: message.messageId,
                                filePath: message.filePath,
                                blockIndex: message.blockIndex,
                                blockId: message.blockId || message.options?.blockId,
                                success: true,
                                alreadyApplied: true
                            });
                            if (message.blockIndex !== undefined) {
                                await this.updateAppliedState(message.messageId, message.blockIndex);
                            }
                            this.auditFileDiagnostics(message.filePath, message.messageId, message.blockIndex, message.blockId || message.options?.blockId);
                        } else {
                            // Manual click: Diff editor opened. Notify webview to show reviewing state
                            webview.postMessage({
                                command: 'applyAllResult',
                                messageId: message.messageId,
                                filePath: message.filePath,
                                blockIndex: message.blockIndex,
                                blockId: message.blockId || message.options?.blockId,
                                success: true,
                                reviewingDiff: true
                            });
                        }
                    } else {
                        webview.postMessage({
                            command: 'applyAllResult',
                            messageId: message.messageId,
                            filePath: message.filePath,
                            blockIndex: message.blockIndex,
                            blockId: message.blockId || message.options?.blockId,
                            success: false,
                            error: res?.error
                        });
                    }
                } catch (e: any) {
                    this.log(`Command applyFileContent failed: ${e.message}`, 'ERROR');
                    webview.postMessage({ 
                        command: 'applyAllResult', 
                        messageId: message.messageId, 
                        blockIndex: message.blockIndex, 
                        blockId: message.blockId || message.options?.blockId,
                        filePath: message.filePath,
                        success: false, 
                        error: e.message 
                    });
                }
                break;
            case 'applyPatchContent':
                try {
                    const res: any = await vscode.commands.executeCommand('lollms-vs-coder.applyPatchContent', message.filePath, message.content);
                    webview.postMessage({
                        command: 'applyAllResult',
                        messageId: message.messageId,
                        filePath: message.filePath,
                        blockIndex: message.blockIndex,
                        success: res?.success ?? false,
                        error: res?.error
                    });
                    if (res && res.success) {
                        await this.updateAppliedState(message.messageId, message.blockIndex, message.hunkIndex);
                    }
                } catch (e: any) {
                    this.log(`Command applyPatchContent failed: ${e.message}`, 'ERROR');
                    webview.postMessage({ command: 'applyAllResult', messageId: message.messageId, blockIndex: message.blockIndex, hunkIndex: message.hunkIndex, success: false, error: e.message });
                }
                break;
            case 'runScript':
                vscode.commands.executeCommand('lollms-vs-coder.runScript', message.code, message.language, { reprompt: message.reprompt === true });
                break;
            case 'runInActiveTerminal':
                vscode.commands.executeCommand('lollms-vs-coder.runInActiveTerminal', message.code);
                break;
            case 'runTestsAndReport':
                await this.handleRunTestsAndReport();
                break;
            case 'startDebugLoop':
                await this.handleRunAndDebugLoop();
                break;
            case 'executeProject':
                await vscode.commands.executeCommand('lollms-vs-coder.executeProject', this);
                break;
            case 'setEntryPoint':
                vscode.commands.executeCommand('lollms-vs-coder.setEntryPoint');
                break;
            case 'debugRestart':
                vscode.commands.executeCommand('workbench.action.debug.restart');
                break;
            case 'saveMessageAsPrompt':
                vscode.commands.executeCommand('lollms-vs-coder.saveMessageAsPrompt', message.content);
                break;
            case 'saveCodeToFile':
                vscode.commands.executeCommand('lollms-vs-coder.saveCodeToFile', message.content, message.language);
                break;
            case 'saveDraftAsset':
                {
                    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                    if (!workspaceFolder) return;

                    const defaultUri = vscode.Uri.joinPath(workspaceFolder.uri, message.params.suggestedPath);
                    const ext = path.extname(message.params.suggestedPath).substring(1) || 'png';

                    const targetUri = await vscode.window.showSaveDialog({
                        defaultUri: defaultUri,
                        filters: { 'Images': [ext], 'All Files': ['*'] },
                        saveLabel: 'Save Asset to Workspace'
                    });

                    if (targetUri) {
                        try {
                            const base64Data = message.params.dataUri.split(',')[1];
                            await vscode.workspace.fs.writeFile(targetUri, Buffer.from(base64Data, 'base64'));

                            const relPath = vscode.workspace.asRelativePath(targetUri);
                            await vscode.commands.executeCommand('lollms-vs-coder.addFilesToContext', [relPath]);
                            vscode.window.showInformationMessage(`Asset saved and synced: ${relPath}`);
                        } catch (e: any) {
                            vscode.window.showErrorMessage(`Save failed: ${e.message}`);
                        }
                    }
                }
                break;
            case 'generateImage':
                vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "Lollms: Generating image...",
                    cancellable: true
                }, async (progress, token) => {
                    try {
                        const w = parseInt(message.width) || 1024;
                        const h = parseInt(message.height) || 1024;
                        const size = `${w}x${h}`;
                        const b64_json = await this._lollmsAPI.generateImage(message.prompt, { size }, token);
                        if (token.isCancellationRequested) {
                            webview.postMessage({ command: 'imageGenerationResult', buttonId: message.buttonId, success: false });
                            return;
                        }

                        // 🛡️ BUFFER-ONLY PROTOCOL: 
                        // If buttonId is present, we NEVER save to disk automatically.
                        // We send the raw data back to the UI to be handled as a draft.
                        if (message.buttonId) {
                            const dataUri = `data:image/png;base64,${b64_json}`;
                            webview.postMessage({ 
                                command: 'imageGenerationResult', 
                                buttonId: message.buttonId, 
                                success: true, 
                                webviewUri: dataUri 
                            });
                            return;
                        }

                        // Fallback for direct tool calls (not from UI button)
                        const targetPath = message.filePath || 'generated_image.png';
                        const saveUri = vscode.workspace.workspaceFolders 
                            ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, targetPath)
                            : undefined;

                        if (saveUri) {
                            await vscode.workspace.fs.writeFile(saveUri, Buffer.from(b64_json, 'base64'));
                            webview.postMessage({ command: 'imageGenerationResult', buttonId: message.buttonId, success: true, webviewUri: webview.asWebviewUri(saveUri).toString() });
                        }
                    } catch (error: any) {
                        // 1. Reset the specific button
                        webview.postMessage({ 
                            command: 'imageGenerationResult', 
                            buttonId: message.buttonId, 
                            success: false,
                            error: error.message 
                        });

                        // 2. Clear global UI overlay
                        webview.postMessage({ command: 'setGeneratingState', isGenerating: false });

                        this.addMessageToDiscussion({ role: 'system', content: `❌ Image generation failed: ${error.message}` });
                    }
                });
                break;
            case 'saveSkill':
                await this.handleSaveSkill(message.content);
                break;
            case 'saveSkillToFile':
                {
                    const { name, description, content, category } = message.skillData;
                    const format = await vscode.window.showQuickPick([
                        { label: 'LoLLMs XML (.xml)', value: 'lollms', description: 'Native Lollms format' },
                        { label: 'Claude Markdown (.md)', value: 'claude', description: 'Claude Code compatible format' }
                    ], { placeHolder: 'Select file format to save the skill' });

                    if (!format) return;

                    const isClaude = format.value === 'claude';
                    const fileName = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + (isClaude ? '.md' : '.xml');
                    
                    const uri = await vscode.window.showSaveDialog({
                        defaultUri: vscode.workspace.workspaceFolders ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, fileName) : undefined,
                        filters: isClaude ? { 'Markdown': ['md'] } : { 'XML': ['xml'] },
                        saveLabel: 'Save Skill File'
                    });

                    if (uri) {
                        const skill: any = { name, description, content, category, id: 'temp' };
                        const fileContent = isClaude 
                            ? this._skillsManager.skillToClaudeMarkdown(skill) 
                            : `<skill title="${name}" description="${description}" category="${category}">${content}</skill>`;

                        await vscode.workspace.fs.writeFile(uri, Buffer.from(fileContent, 'utf8'));
                        vscode.window.showInformationMessage(`Skill saved to ${path.basename(uri.fsPath)}`);
                    }
                }
                break;
            case 'saveGeneratedSkill':
                const { name: sName, description: sDesc, content: sContent, category: sCat, scope: sScope } = message.skillData;
                
                // Ensure a category exists before sending to the manager
                const finalCategory = (sCat && sCat.trim() !== "") ? sCat : "general";

                const sId = (sName || 'skill').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Date.now();
                
                await this._skillsManager.addSkill({
                    id: sId,
                    name: sName, 
                    description: sDesc, 
                    content: sContent,
                    category: finalCategory,
                    language: 'markdown',
                    scope: sScope 
                });
                vscode.window.showInformationMessage(vscode.l10n.t("Skill '{0}' saved to {1} library.", sName, sScope));
                vscode.commands.executeCommand('lollms-vs-coder.refreshSkills'); 
                break;
            case 'requestWizardSkills':
                {
                    const payload = await this.buildSkillsTreePayload();
                    webview.postMessage({
                        command: 'wizardSkillsData',
                        skillsTree: payload.skillsTree,
                        discussionSkills: payload.discussionSkills,
                        projectSkills: payload.projectSkills
                    });
                }
                break;
            case 'importSkills':
                await this.handleImportSkills();
                break;
            case 'inferPrompt':
                await this.handleInferPrompt(message.messageId);
                break;
            case 'requestFixFailedHunks':
                {
                    let resultPosted = false;
                    const notifyWebviewResult = (dispatched: boolean, error?: string) => {
                        if (resultPosted || this._isDisposed || !this._panel?.webview) return;
                        resultPosted = true;
                        this._panel.webview.postMessage({
                            command: 'fixFailedHunksResult',
                            messageId: message.messageId,
                            dispatched,
                            error
                        });
                    };

                    try {
                        const failedHunks: any[] = Array.isArray(message.failedHunks) ? message.failedHunks : [];
                        if (failedHunks.length === 0 || this._isDisposed) {
                            notifyWebviewResult(false, 'No failed hunks to fix.');
                            break;
                        }
                        if (!this._currentDiscussion || !this.processManager) {
                            notifyWebviewResult(false, 'No active discussion available.');
                            break;
                        }
                        if (this._isSendingMessage || this._inputResolver) {
                            vscode.window.showWarningMessage('Cannot start fix while another message or prompt is active. Please wait or stop the current operation.');
                            notifyWebviewResult(false, 'Another operation is currently active.');
                            break;
                        }

                        const affectedFiles = new Set<string>();
                        const itemizedReports: string[] = [];

                        for (let idx = 0; idx < failedHunks.length; idx++) {
                            const item = failedHunks[idx];
                            const rawPath = String(item.filePath || '').trim();
                            const cleanPath = rawPath.includes(':') && !/^[a-zA-Z]:[\\/]/.test(rawPath)
                                ? rawPath.split(':')[0].trim()
                                : rawPath;
                            if (cleanPath) affectedFiles.add(cleanPath);

                            let failingSnippet = String(item.content || '');
                            if (item.hunkIndex !== undefined && failingSnippet.includes('<<<<<<< SEARCH')) {
                                const hunks = parseAiderHunks(normalizeAiderContent(failingSnippet));
                                if (hunks[item.hunkIndex]) {
                                    failingSnippet = hunks[item.hunkIndex].fullMatch;
                                }
                            }
                            if (failingSnippet.length > 3000) {
                                failingSnippet = failingSnippet.substring(0, 3000) + '\n... [truncated]';
                            }

                            let diskContent = '';
                            try {
                                const res = await this._contextManager.resolveWorkspaceFromPath(cleanPath);
                                if (res) {
                                    const doc = await vscode.workspace.openTextDocument(res.uri);
                                    diskContent = doc.getText();
                                }
                            } catch {}

                            let crossNotice = '';
                            const crossSearchCtrl = new AbortController();
                            const crossSearchTimer = setTimeout(() => crossSearchCtrl.abort(), 3000);
                            try {
                                const searchMatch = failingSnippet.match(/<<<<<<< SEARCH\s*\r?\n([\s\S]*?)\r?\n=======/);
                                const searchPart = searchMatch ? searchMatch[1] : failingSnippet;
                                const crossFile = await findHunkInWorkspace(searchPart, cleanPath, this._contextManager, crossSearchCtrl.signal);
                                if (crossFile) {
                                    crossNotice = `\n> ⚠️ **MISPLACED HUNK DETECTED**: This search block was not found in \`${cleanPath}\`, but matched \`${crossFile.filePath}\` around line ${crossFile.line}.`;
                                    affectedFiles.add(crossFile.filePath);
                                }
                            } catch {} finally {
                                clearTimeout(crossSearchTimer);
                            }

                            const hunkTitle = item.hunkIndex !== undefined
                                ? `\`${cleanPath}\` (Hunk ${item.hunkIndex + 1})`
                                : `\`${cleanPath}\``;

                            const diskExcerpt = diskContent
                                ? (diskContent.length > 6000
                                    ? diskContent.substring(0, 6000) + `\n... [truncated at 6000 chars; full file is in LOADED FILE CONTENTS]`
                                    : diskContent)
                                : '(File could not be read from disk)';

                            itemizedReports.push(`#### Failed Hunk ${idx + 1}: ${hunkTitle}
**Error:** ${item.error || 'Search block mismatch'}${crossNotice}

**Failing Patch:**
\`\`\`diff
${failingSnippet}
\`\`\`

**Current Ground-Truth Content on Disk (\`${cleanPath}\`):**
\`\`\`
${diskExcerpt}
\`\`\``);
                        }

                        const fileList = Array.from(affectedFiles);
                        if (fileList.length > 0) {
                            await this.unmuteFiles(fileList);
                            await this._contextManager.getContextStateProvider()?.addFilesToContext(fileList);
                            await this.addFilesToDiscussionContext(fileList, 'included');
                            this.recordCurrentPromptFiles(fileList);
                            this.updateContextAndTokens({ isBackgroundSync: true });
                        }

                        const fixUserPrompt = `### 🛠️ FIX FAILED HUNKS (${failedHunks.length} failed hunk${failedHunks.length > 1 ? 's' : ''})
I ran **Apply All**, and the following hunk(s) failed to apply to disk. Please fix these hunks based on the actual current file contents on disk:

${itemizedReports.join('\n\n---\n\n')}

### 📋 INSTRUCTIONS:
1. Inspect the ground-truth file contents currently on disk (loaded in context [C] and excerpted above).
2. Ensure every \`<<<<<<< SEARCH\` block matches the exact lines, indentation, and whitespace currently on disk (or use \`action="update_symbol"\` / \`action="write"\` if needed).
3. Output ONLY the corrected \`<file path="..." action="patch|update_symbol|write">\` blocks for the failed hunks.`;

                        notifyWebviewResult(true);
                        await this.sendMessage({
                            id: 'user_fix_hunks_' + Date.now(),
                            role: 'user',
                            content: fixUserPrompt
                        });
                    } catch (fixErr: any) {
                        this.log(`requestFixFailedHunks failed: ${fixErr?.message || fixErr}`, 'ERROR');
                        vscode.window.showErrorMessage(`Failed to request hunk fix: ${fixErr?.message || fixErr}`);
                        notifyWebviewResult(false, fixErr?.message || String(fixErr));
                    } finally {
                        notifyWebviewResult(false);
                    }
                }
                break;
            case 'importSelectedSkills': {
                const discussionSkills: string[] = (message.discussionSkills || [])
                    .filter((id: string) => !id.includes('-lib') && !id.startsWith('zoo-'));
                const projectSkills: string[] = (message.projectSkills || [])
                    .filter((id: string) => !id.includes('-lib') && !id.startsWith('zoo-'));

                if (this._currentDiscussion) {
                    // 1. Authoritative State Update
                    this._currentDiscussion.importedSkills = Array.from(new Set(discussionSkills));

                    // 2. Update Project-level persistence
                    const allSkills = await this._skillsManager.getSkills();
                    const allSkillIdsLower = new Set(allSkills.map(s => s.id.toLowerCase()));

                    for (const skill of allSkills) {
                        const isProj = projectSkills.some(id => id.toLowerCase() === skill.id.toLowerCase());
                        if (isProj) {
                            await this._contextManager.addSkillToProject(skill.id);
                        } else {
                            await this._contextManager.removeSkillFromProject(skill.id);
                        }
                    }

                    // 3. Forced Sync & Save
                    if (!this._currentDiscussion.id.startsWith('temp-')) {
                        await this._discussionManager.saveDiscussion(this._currentDiscussion);
                    }

                    // 4. Update HUD with full skill records
                    const activeSkillsForHUD = allSkills.filter(s => 
                        this._currentDiscussion?.importedSkills?.some(id => id.toLowerCase() === s.id.toLowerCase()) || 
                        projectSkills.some(id => id.toLowerCase() === s.id.toLowerCase())
                    );

                    this._panel.webview.postMessage({ 
                        command: 'updateContext', 
                        skills: activeSkillsForHUD,
                        files: this._contextManager.getContextStateProvider()?.getIncludedFiles().map(f => f.path) || []
                    });

                    // 5. Trigger Re-tokenization
                    this.updateContextAndTokens();
                    vscode.window.showInformationMessage(`✅ Active skills updated (${activeSkillsForHUD.length} skill${activeSkillsForHUD.length === 1 ? '' : 's'} active).`);
                }
                break;
            }
            case 'runAndMonitorApp':
                vscode.commands.executeCommand('lollms-vs-coder.runAndMonitorApp', this, message.messageId);
                break;
            case 'saveUserPreferenceProfile':
                {
                    const { saveUserPreferenceProfile, getUserPreferenceProfiles } = require('../../registries/profiles');
                    if (message.profile) {
                        await saveUserPreferenceProfile(message.profile);
                        vscode.window.showInformationMessage(`User preference profile '${message.profile.name}' saved.`);
                        const allPrefProfiles = getUserPreferenceProfiles(vscode.workspace.getConfiguration('lollmsVsCoder'));
                        ChatPanel.panels.forEach(p => {
                            p._panel.webview.postMessage({
                                command: 'updateUserPreferenceProfiles',
                                userPreferenceProfiles: allPrefProfiles
                            });
                        });
                    }
                }
                break;
            case 'openSettings':
                vscode.commands.executeCommand('lollms-vs-coder.showConfigView');
                break;
            case 'openKnowledgeGraphPanel':
                vscode.commands.executeCommand('lollms-vs-coder.showKnowledgeGraphPanel');
                break;
            case 'requestSavePreferenceProfile':
                {
                    const text = message.preferences;
                    if (!text || !text.trim()) {
                        vscode.window.showErrorMessage('Preferences text is empty.');
                        break;
                    }
                    const profileName = await vscode.window.showInputBox({
                        prompt: "Enter a name for this developer preference profile:",
                        value: "My Custom Profile",
                        placeHolder: "e.g. Python Strict PEP8, Clean Craftsman"
                    });
                    if (profileName && profileName.trim()) {
                        const { saveUserPreferenceProfile, getUserPreferenceProfiles } = require('../../registries/profiles');
                        await saveUserPreferenceProfile({
                            id: 'custom_' + Date.now(),
                            name: profileName.trim(),
                            description: 'Custom user preference profile',
                            preferences: text.trim()
                        });
                        vscode.window.showInformationMessage(`User preference profile '${profileName}' saved.`);
                        const allPrefProfiles = getUserPreferenceProfiles(vscode.workspace.getConfiguration('lollmsVsCoder'));
                        ChatPanel.panels.forEach(p => {
                            p._panel.webview.postMessage({
                                command: 'updateUserPreferenceProfiles',
                                userPreferenceProfiles: allPrefProfiles
                            });
                        });
                    }
                }
                break;
            case 'openTestAndOptimize':
                {
                    const targetModel = message.model || this._currentDiscussion?.model || this._lollmsAPI.getModelName();
                    vscode.commands.executeCommand('lollms-vs-coder.testAndOptimizeModel', targetModel);
                }
                break;
            case 'resetDiscussionCapabilities':
                if (this._currentDiscussion) {
                    const defaultCaps = this._discussionManager.getDefaultCapabilities();
                    this._discussionCapabilities = { ...defaultCaps };
                    if (!this._currentDiscussion.id.startsWith('temp-')) {
                        this._currentDiscussion.capabilities = this._discussionCapabilities;
                        await this._discussionManager.saveDiscussion(this._currentDiscussion);
                    }
                    await this.updateContextAndTokens();
                    this._panel.webview.postMessage({ 
                        command: 'updateDiscussionCapabilities', 
                        capabilities: this._discussionCapabilities 
                    });
                    vscode.window.showInformationMessage("Discussion settings have been reset to defaults.");
                }
                break;
            case 'updateDiscussionCapabilities':
                this._discussionCapabilities = message.capabilities;
                if (this._discussionCapabilities.allowCodeExecution !== true) {
                    this._discussionCapabilities.autoExecuteCode = false;
                }
                // Full settings update from modal: we treat this as a potential default update
                await this.saveCapabilities(true);

                this.log(`Updated Discussion Capabilities: ${JSON.stringify(this._discussionCapabilities)}`);
                this._panel.webview.postMessage({ command: 'updateDiscussionCapabilities', capabilities: this._discussionCapabilities });
                break;
            case 'updateDiscussionCapabilitiesPartial':
                if (this._discussionCapabilities) {
                    const partial = message.partial;

                    // --- PROJECT TOOL SCOPE SYNC ---
                    if (partial.projectTools !== undefined) {
                        const allToolNames = this.agentManager.getTools().map(t => t.name);
                        for (const toolName of allToolNames) {
                            if (partial.projectTools.includes(toolName)) await this._contextManager.addToolToProject(toolName);
                            else await this._contextManager.removeToolFromProject(toolName);
                        }

                        // IMMEDIATE HUD SYNC for Tools
                        const discussionTools = this._currentDiscussion?.importedTools || [];
                        const allEquippedNames = Array.from(new Set([...discussionTools, ...partial.projectTools]));
                        const equippedTools = this.agentManager.getTools()
                            .filter(t => allEquippedNames.includes(t.name))
                            .map(t => ({ name: t.name, description: t.description }));

                        if (this._currentDiscussion?.lastTokenMetrics) {
                            this._currentDiscussion.lastTokenMetrics.activeTools = equippedTools;
                        }

                        this._panel.webview.postMessage({ command: 'updateContext', tools: equippedTools });

                        delete partial.projectTools;
                    }

                    if (partial.clearBriefing && this._currentDiscussion) {
                        this._currentDiscussion.discussion_data_zone = "";
                        if (!this._currentDiscussion.id.startsWith('temp-')) {
                            await this._discussionManager.saveDiscussion(this._currentDiscussion);
                        }
                        this._panel.webview.postMessage({ command: 'updateBriefingContent', text: '' });
                        this.updateContextAndTokens({ isBackgroundSync: false });
                        vscode.window.showInformationMessage("🎯 Mission Briefing cleared.");
                        return;
                    }

                    // --- ROOT REDIRECTION LAYER ---
                    // Some fields sent in the 'partial' actually belong to the root Discussion object
                    if (this._currentDiscussion) {
                        if (partial.importedTools !== undefined) {
                            this._currentDiscussion.importedTools = partial.importedTools;
                            delete partial.importedTools;
                        }
                        if (partial.importedSkills !== undefined) {
                            this._currentDiscussion.importedSkills = partial.importedSkills;
                            delete partial.importedSkills;
                        }
                        if (partial.mutedFiles !== undefined) {
                            this._currentDiscussion.mutedFiles = partial.mutedFiles;
                            this._discussionCapabilities.mutedFiles = [...partial.mutedFiles];
                            await this._discussionManager.saveLastMutedFiles(this._currentDiscussion.mutedFiles);
                            delete partial.mutedFiles;
                        }
                        if (partial.mutedTools !== undefined) {
                            this._currentDiscussion.mutedTools = partial.mutedTools;
                            delete partial.mutedTools;
                        }
                        if (partial.mutedSkills !== undefined) {
                            this._currentDiscussion.mutedSkills = partial.mutedSkills;
                            delete partial.mutedSkills;
                        }
                        if (partial.mutedDiagrams !== undefined) {
                            this._currentDiscussion.mutedDiagrams = partial.mutedDiagrams;
                            delete partial.mutedDiagrams;
                        }
                    }

                    // Handle specific diagram removal
                    if (partial.removeDiagram && this._currentDiscussion?.activeDiagrams) {
                        this._currentDiscussion.activeDiagrams = this._currentDiscussion.activeDiagrams.filter(d => d !== partial.removeDiagram);
                        delete partial.removeDiagram; // Don't save this key to capabilities
                    }

                    // If the user is specifically updating folder settings via the matrix,
                    // we should ensure the global 'disableProjectContext' is turned off
                    // so the HUD badge doesn't stay stuck on "Context Muted".
                    if (partial.folderSettings !== undefined) {
                        const settings = Object.values(partial.folderSettings);
                        const hasAnyContent = settings.some((s: any) => s.tree || s.content);
                        if (hasAnyContent) {
                            partial.disableProjectContext = false;
                        }
                    }

                    // --- SYNC PRECISE TOKENIZATION SETTING ---
                    if (partial.preciseTokenization !== undefined) {
                        await vscode.workspace.getConfiguration('lollmsVsCoder').update('preciseTokenization', partial.preciseTokenization, vscode.ConfigurationTarget.Global);
                    }

                    if (partial.allowCodeExecution === false) {
                        partial.autoExecuteCode = false;
                    }
                    const effectiveAllowCode = partial.allowCodeExecution !== undefined
                        ? partial.allowCodeExecution === true
                        : this._discussionCapabilities.allowCodeExecution === true;
                    if (!effectiveAllowCode) {
                        partial.autoExecuteCode = false;
                    }

                    if (partial.requireExplicitEndTag === true) {
                        partial.autoApply = true;
                        partial.autoExecuteScouting = true;
                        partial.autoExecuteTools = true;
                        (partial as any).autoMode = true;
                    }

                    const isComposablePartial = partial.autoExecuteScouting !== undefined ||
                        partial.autoExecuteCode !== undefined ||
                        partial.requireExplicitEndTag !== undefined ||
                        partial.allowCodeExecution !== undefined;

                    if (!isComposablePartial) {
                        if (partial.autoExecuteTools !== undefined && partial.autoApply === undefined) {
                            partial.autoApply = partial.autoExecuteTools;
                        } else if ((partial as any).autoMode !== undefined) {
                            partial.autoExecuteTools = !!(partial as any).autoMode;
                            partial.autoApply = !!(partial as any).autoMode;
                        }
                    }

                    this._discussionCapabilities = { ...this._discussionCapabilities, ...partial };
                    if (this._discussionCapabilities.allowCodeExecution !== true) {
                        this._discussionCapabilities.autoExecuteCode = false;
                    }

                    if (partial.agentMode !== undefined) {
                        if (partial.agentMode && !this.agentManager.getIsActive()) {
                            this.agentManager.toggleAgentMode();
                        } else if (!partial.agentMode && this.agentManager.getIsActive()) {
                            this.agentManager.toggleAgentMode();
                        }
                    }

                    // Refresh Plan HUD if plan exists (e.g. after adding tools)
                    if ((this.agentManager as any)["currentPlan"]) {
                        this.agentManager.displayPlan((this.agentManager as any)["currentPlan"]);
                    }

                    if (partial.webSearch !== undefined && this.agentManager) {
                        if (partial.webSearch) {
                            const tools = this.agentManager.getEnabledTools().map(t => t.name);
                            if (!tools.includes('search_web')) tools.push('search_web');
                            if (!tools.includes('search_wikipedia')) tools.push('search_wikipedia');
                            this.agentManager.setEnabledTools(tools);
                        }
                    }

                    if (this._currentDiscussion) {
                        this._currentDiscussion.capabilities = this._discussionCapabilities;
                        if (!this._currentDiscussion.id.startsWith('temp-')) {
                            await this._discussionManager.saveDiscussion(this._currentDiscussion);
                        }
                    }

                    // Only save to Global Defaults if it's NOT the ephemeral mute state
                    if (partial.disableProjectContext === undefined) {
                        await this._discussionManager.saveLastCapabilities(this._discussionCapabilities);
                    }

                    // Force an immediate UI refresh before any async context scan
                    this._panel.webview.postMessage({ command: 'updateDiscussionCapabilities', capabilities: this._discussionCapabilities });

                    // OPTIMIZATION: If only mode flags (Think, Agent, AutoTools, FastMode/Librarian) changed,
                    // do not trigger a full context scan to avoid badge-flicker or blocking state sync.
                    const isVisualOnly = partial.thinkingMode !== undefined || partial.agentMode !== undefined || partial.autoExecuteTools !== undefined || partial.useLibrarian !== undefined || partial.allowCodeExecution !== undefined || partial.autoExecuteCode !== undefined || partial.autoExecuteScouting !== undefined || partial.requireExplicitEndTag !== undefined;

                    if (!isVisualOnly) {
                        await this.updateContextAndTokens({ isBackgroundSync: false });
                    }
                }
                break;
            case 'updateDiscussionPersonality':
                if (this._currentDiscussion) {
                    this._currentDiscussion.personalityId = message.personalityId;

                    // Persist selected personality over the entire project workspace
                    await this._discussionManager.context.workspaceState.update('lollms_project_active_personality_id', message.personalityId);

                    const persona = this._personalityManager?.getPersonality(message.personalityId);
                    if (persona) {
                        this.log(`Personality switched to: ${persona.name}`);

                        // Equip personality bundled and runtime tools/skills automatically
                        const effectiveSkills = this._personalityManager?.getEffectiveSkills(message.personalityId) || [];
                        const effectiveTools = this._personalityManager?.getEffectiveTools(message.personalityId) || [];

                        if (effectiveSkills.length > 0) {
                            const currentSkills = this._currentDiscussion.importedSkills || [];
                            this._currentDiscussion.importedSkills = Array.from(new Set([...currentSkills, ...effectiveSkills]));
                        }

                        if (effectiveTools.length > 0) {
                            const currentTools = this._currentDiscussion.importedTools || [];
                            this._currentDiscussion.importedTools = Array.from(new Set([...currentTools, ...effectiveTools]));
                        }
                    }
                    if (!this._currentDiscussion.id.startsWith('temp-')) {
                        await this._discussionManager.saveDiscussion(this._currentDiscussion);
                    }

                    // Post back to webview to ensure full synchronization
                    this._panel.webview.postMessage({
                        command: 'updateDiscussionPersonality',
                        personalityId: message.personalityId
                    });
                    this.updateContextAndTokens({ isBackgroundSync: false });
                }
                break;
            case 'runTestsOnly':
                {
                    const { targets, runner, filter, blockId, reprompt } = message;
                    const { runTestsTool } = require('../../tools/builtins/runTests');
                    const { id: testProcId, controller: testCtrl } = this.processManager.register(this.discussionId, 'Running tests...');
                    this.updateGeneratingState();
                    let testRes: { success: boolean; output: string } = { success: false, output: '' };
                    try {
                        const env = {
                            agentManager: this.agentManager,
                            workspaceRoot: vscode.workspace.workspaceFolders?.[0],
                            contextManager: this._contextManager,
                            lollmsApi: this._lollmsAPI,
                            currentPlan: (this.agentManager as any)?.currentPlan || null
                        };
                        testRes = await runTestsTool.execute({ targets, runner, filter }, env as any, testCtrl.signal);
                    } finally {
                        this.processManager.unregister(testProcId);
                        this.updateGeneratingState();
                    }
                    webview.postMessage({
                        command: 'runTestsResult',
                        blockId,
                        success: testRes.success,
                        output: testRes.output
                    });
                    if (reprompt) {
                        await this.sendMessage({
                            role: 'user',
                            content: `### 🧪 TEST EXECUTION RESULTS\n${testRes.output}\n\nReview the test results above and proceed accordingly.`
                        });
                    }
                }
                break;
            case 'readExternalFileOnly':
                {
                    const { path: extPath, start_line, end_line, blockId, reprompt } = message;
                    const { readExternalFileTool } = require('../../tools/builtins/readExternalFile');
                    const { id: extProcId, controller: extCtrl } = this.processManager.register(this.discussionId, 'Reading external reference file...');
                    this.updateGeneratingState();
                    let extRes: { success: boolean; output: string } = { success: false, output: '' };
                    try {
                        const env = {
                            agentManager: this.agentManager,
                            workspaceRoot: vscode.workspace.workspaceFolders?.[0],
                            contextManager: this._contextManager,
                            lollmsApi: this._lollmsAPI,
                            currentPlan: (this.agentManager as any)?.currentPlan || null
                        };
                        extRes = await readExternalFileTool.execute({ path: extPath, start_line, end_line }, env as any, extCtrl.signal);
                    } finally {
                        this.processManager.unregister(extProcId);
                        this.updateGeneratingState();
                    }
                    webview.postMessage({
                        command: 'readExternalFileResult',
                        blockId,
                        success: extRes.success,
                        output: extRes.output
                    });
                    if (reprompt) {
                        await this.sendMessage({
                            role: 'user',
                            content: `${extRes.output}\n\nPlease proceed using this external reference content.`
                        });
                    }
                }
                break;
            case 'runTool':
                const isAssistantForTool = !this._discussionCapabilities.agentMode && !this._discussionCapabilities.dynamicMode;
                if (isAssistantForTool && message.tool !== 'run_tests' && message.tool !== 'read_external_file') {
                    vscode.window.showWarningMessage("Tools are deactivated in Assistant mode. Switch to Co-Engineer (🧠) or Agent (🤖) mode to use tools.");
                    break;
                }

                const toolName = message.tool;
                const toolParams = message.params;
                const buttonId = message.buttonId; // Captured from step 1
                const autoReprompt = message.reprompt !== false; // Default to true if not explicitly false

                if (this.agentManager) {
                    const toolDef = this.agentManager.getTools().find(t => t.name === toolName);
                    if (toolDef) {
                        const { id: processId, controller } = this.processManager.register(this.discussionId, `Running tool: ${toolName}...`);
                        this.updateGeneratingState();
                        try {
                            const env = {
                                workspaceRoot: vscode.workspace.workspaceFolders?.[0],
                                lollmsApi: this._lollmsAPI,
                                contextManager: this._contextManager,
                                agentManager: this.agentManager,
                                skillsManager: this._skillsManager,
                                codeGraphManager: this._codeGraphManager,
                                personalityManager: this._personalityManager,
                                currentPlan: (this.agentManager as any)?.currentPlan || null
                            };
                            const result = await toolDef.execute(toolParams, env as any, controller.signal);

                            // --- CALLBACK TO TRIGGERING BUTTON ---
                            if (buttonId && (toolName === 'edit_image_asset' || result.output.includes('<image_result'))) {
                                const outputPath = toolParams.output_path || toolParams.target_path;
                                if (outputPath) {
                                    const res = await this._contextManager.resolveWorkspaceFromPath(outputPath);
                                    if (res) {
                                        const webviewUri = webview.asWebviewUri(res.uri).toString();
                                        webview.postMessage({ 
                                            command: 'imageGenerationResult', 
                                            buttonId: buttonId, 
                                            success: true, 
                                            webviewUri 
                                        });
                                    }
                                    return; 
                                }
                            }

                            // If we requested local execution without reprompt, send result to the specific block
                            if (!autoReprompt && buttonId) {
                                webview.postMessage({
                                    command: 'applyAllResult',
                                    messageId: message.messageId, // Can pass down if available
                                    blockIndex: message.blockIndex,
                                    success: result.success,
                                    sparqlResult: result.output // Re-use for raw display
                                });
                                return;
                            }

                            const resultMessage: ChatMessage = {
                                role: 'system',
                                content: `**Tool Output (${toolName}):**\n\n${result.output}`
                            };
                            await this.addMessageToDiscussion(resultMessage);

                            // --- AUTOMATIC REACTION TRIGGER ---
                            // Only trigger a new chat turn if reprompt is explicitly desired AND not already running a generation
                            if (autoReprompt) {
                                const nudgeMessage: ChatMessage = {
                                    role: 'system',
                                    content: `The user manually triggered the tool '${toolName}'. Analyze the output above and proceed with the mission.`,
                                    skipInPrompt: false 
                                };

                                await this.sendMessage(nudgeMessage);
                            }

                            } catch (e: any) {
                            if (buttonId) {
                                webview.postMessage({ command: 'imageGenerationResult', buttonId: buttonId, success: false, error: e.message });
                            }
                            this.addMessageToDiscussion({ role: 'system', content: `❌ Tool execution failed: ${e.message}` });
                        } finally {
                            this.processManager.unregister(processId);
                            this.updateGeneratingState();
                        }
                    } else {
                        vscode.window.showErrorMessage(`Tool '${toolName}' not found.`);
                    }
                }
                break;
            case 'openGitWorkflowMenu':
                const branch = this._currentDiscussion?.gitState?.tempBranch || 'current';
                const items: vscode.QuickPickItem[] = [
                    { 
                        label: `$(git-branch) New Branch for Discussion`, 
                        description: 'Create a new feature branch for this chat context',
                        detail: 'lollms-vs-coder.createGitBranch'
                    },
                    { 
                        label: `$(git-merge) Fuse Branch into Main`, 
                        description: `Merge ${branch} back into original branch`,
                        detail: 'lollms-vs-coder.mergeGitBranch' 
                    }
                ];

                vscode.window.showQuickPick(items, { placeHolder: 'Git Workflow Actions' }).then(selected => {
                    if (selected && selected.detail) {
                        if (selected.detail === 'lollms-vs-coder.createGitBranch') {
                            vscode.commands.executeCommand('lollms-vs-coder.createGitBranch');
                        } else if (selected.detail === 'lollms-vs-coder.mergeGitBranch') {
                            vscode.commands.executeCommand('lollms-vs-coder.mergeGitBranch');
                        }
                    }
                });
                break;

            case 'requestGitStatus':
                if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                    const status = await this._gitIntegration.getGitStatus(vscode.workspace.workspaceFolders[0]);
                    this._panel.webview.postMessage({ command: 'updateGitStatus', status });
                } else {
                    vscode.window.showErrorMessage("No workspace open.");
                }
                break;

            case 'stageAndGenerateMessage':
                if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                    const files = message.files;
                    const folder = vscode.workspace.workspaceFolders[0];
                    
                    try {
                        await this._gitIntegration.stageFiles(folder, files);
                        
                        await vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: "Generating commit message..."
                        }, async () => {
                            const msg = await this._gitIntegration.generateCommitMessage(folder);
                            this._panel.webview.postMessage({ command: 'setCommitMessage', message: msg });
                        });

                    } catch (e: any) {
                        vscode.window.showErrorMessage("Error processing commit preparation: " + e.message);
                    }
                }
                break;

            case 'requestCommitMessage':
                if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                    this.log('Generating commit message...');
                    try {
                        const msg = await this._gitIntegration.generateCommitMessage(vscode.workspace.workspaceFolders[0]);
                        this._panel.webview.postMessage({ command: 'setCommitMessage', message: msg });
                    } catch (e: any) {
                        vscode.window.showErrorMessage("Failed to generate commit message: " + e.message);
                    }
                } else {
                    vscode.window.showErrorMessage("No workspace open.");
                }
                break;
            case 'requestCommitStaging':
                if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                    try {
                        const status = await this._gitIntegration.getGitStatus(vscode.workspace.workspaceFolders[0]);
                        if (status.staged.length === 0 && status.unstaged.length === 0 && status.untracked.length === 0) {
                            vscode.window.showInformationMessage("No changes found in git repository.");
                            return;
                        }
                        this._panel.webview.postMessage({ command: 'showStagingModal', status });
                    } catch (e: any) {
                        vscode.window.showErrorMessage("Failed to get git status: " + e.message);
                    }
                } else {
                    vscode.window.showErrorMessage("No active workspace.");
                }
                break;
            case 'performCommit':
                if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                    try {
                        const folder = vscode.workspace.workspaceFolders[0];
                        const hash = await this._gitIntegration.commitWithMessage(message.message, folder);
                        if (hash) {
                            // Notify chat with a system message containing the hash
                            await this.addMessageToDiscussion({
                                role: 'system',
                                content: `✅ **Commit Successful**\n**Hash:** \`${hash}\`\n*Link to this fix for CVE tracking.*`
                            });
                            // Update the UI state
                            this._panel.webview.postMessage({ command: 'updateGitState', branch: await this._gitIntegration.getCurrentBranch(folder), lastHash: hash });
                        }
                    } catch (e: any) {
                         vscode.window.showErrorMessage("Commit failed: " + e.message);
                    }
                }
                break;
            case 'requestGitHistory':
                if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                    try {
                        const folder = vscode.workspace.workspaceFolders[0];
                        const commits = await this._gitIntegration.getCommitHistory(folder);
                        const currentHash = await this._gitIntegration.getCurrentHash(folder);
                        this._panel.webview.postMessage({ command: 'showGitHistory', commits, currentHash });
                    } catch (e: any) {
                        vscode.window.showErrorMessage("Failed to fetch history: " + e.message);
                    }
                }
                break;
            case 'performRevert':
                 if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                    try {
                        await this._gitIntegration.checkout(vscode.workspace.workspaceFolders[0], message.hash);
                        vscode.window.showInformationMessage(`Checked out ${message.hash}`);
                        this.sendGitBranchState(vscode.workspace.workspaceFolders[0]);
                    } catch(e: any) {
                        vscode.window.showErrorMessage(e.message);
                    }
                }
                break;
            case 'requestViewFullContext':
                try {
                    const importedIds = this._currentDiscussion?.importedSkills || [];
                    const contextResult = await this._contextManager.getContextContent({ 
                        importedSkillIds: importedIds,
                        modelName: this._currentDiscussion?.model || this._lollmsAPI.getModelName() 
                    });

                    const contentToShow = contextResult.text || "No files or skills are currently included in the AI context.";
                    InfoPanel.createOrShow(this._extensionUri, "Full AI Context Preview", contentToShow);
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to load context preview: ${e.message}`);
                }
                break;
            case 'requestContextUsage':
                await this.handleRequestContextUsage();
                break;
            case 'requestLazyFileContent':
                {
                    const { filePath } = message;
                    if (filePath && this._contextManager) {
                        const resolution = await this._contextManager.resolveWorkspaceFromPath(filePath);
                        if (resolution) {
                            try {
                                const doc = await vscode.workspace.openTextDocument(resolution.uri);
                                const content = doc.getText();
                                this._panel.webview.postMessage({
                                    command: 'updateContextDelta',
                                    action: 'lazy_load_file',
                                    filePath: filePath,
                                    content: content
                                });
                            } catch (err: any) {
                                Logger.warn(`Lazy file ingestion failed for ${filePath}: ${err.message}`);
                            }
                        }
                    }
                }
                break;
            case 'requestMissionBriefing':
            case 'requestMissionBriefingUI':
                await this.openMissionBriefingUI();
                break;
            case 'launchDiscussionWithSelectedFiles':
                await vscode.commands.executeCommand('lollms-vs-coder.launchDiscussionWithSelectedFiles', message.paths);
                break;
            case 'newDiscussionWithSameContext':
                await vscode.commands.executeCommand('lollms-vs-coder.newDiscussionWithSameContext', this);
                break;
            case 'compressDiscussionHistory':
                await this.compressCurrentDiscussionHistory();
                break;
            case 'forkAndCompressDiscussion':
                await vscode.commands.executeCommand('lollms-vs-coder.forkAndCompressDiscussion', this);
                break;
            case 'toggleLlmHistoryView':
                {
                    if (!this._currentDiscussion) break;
                    const showLlm = message.showLlmHistory === true;
                    if (showLlm) {
                        const rawMsgs = (this._currentDiscussion.llmHistory && this._currentDiscussion.llmHistory.length > 0)
                            ? this._currentDiscussion.llmHistory
                            : (this._currentDiscussion.messages || []).filter(m => !m.skipInPrompt);
                        const sanitized = rawMsgs.map((m, idx) => ({
                            ...m,
                            id: m.id || `llm_hist_${idx}_${Date.now()}`,
                            content: this.sanitizeMessageContentForPrompt(m.content)
                        }));
                        this._panel.webview.postMessage({
                            command: 'renderLlmHistoryView',
                            messages: sanitized,
                            isLlmView: true
                        });
                    } else {
                        await this.loadDiscussion();
                    }
                }
                break;
            case 'requestBriefingFileUpload':
            {
                const uris = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    openLabel: 'Select Briefing Document',
                    filters: {
                        'Documents':['pdf', 'docx', 'md', 'txt']
                    }
                });
                if (uris && uris[0]) {
                    const uri = uris[0];
                    const fileName = path.basename(uri.fsPath);
                    const bytes = await vscode.workspace.fs.readFile(uri);
                    const base64 = Buffer.from(bytes).toString('base64');
                    
                    this._panel.webview.postMessage({ command: 'setGeneratingState', isGenerating: true, statusText: 'Parsing document...' });
                    try {
                        const text = await this._contextManager.processFile(fileName, base64,[], 'text');
                        this._panel.webview.postMessage({
                            command: 'updateBriefingContent',
                            text: text
                        });
                    } catch (e: any) {
                        vscode.window.showErrorMessage("Failed to read document: " + e.message);
                    } finally {
                        this._panel.webview.postMessage({ command: 'setGeneratingState', isGenerating: false });
                    }
                }
                break;
            }
            case 'autoBuildDoctrine':
                {
                    const { id: docProcId, controller: docCtrl } = this.processManager.register(
                        this.discussionId,
                        'Scouting project & synthesizing doctrine...'
                    );
                    this.updateGeneratingState();

                    try {
                        const targetModel = this._currentDiscussion?.model || this._lollmsAPI.getModelName();
                        const doctrine = await (this._contextManager as any).autoBuildProjectDoctrine(
                            targetModel,
                            docCtrl.signal,
                            (status) => {
                                this.processManager.updateDescription(docProcId, status);
                                this.updateGeneratingState();
                            },
                            (event) => {
                                webview.postMessage({
                                    command: 'doctrinePipelineEvent',
                                    event: event
                                });
                            }
                        );

                        webview.postMessage({
                            command: 'doctrineAutoBuilt',
                            doctrine: doctrine
                        });

                        vscode.window.showInformationMessage("🎯 Project Doctrine successfully generated and placed into Mission Briefing.");
                    } catch (err: any) {
                        Logger.error(`Auto-build doctrine failed: ${err.message}`);
                        webview.postMessage({
                            command: 'doctrineAutoBuilt',
                            error: err.message
                        });
                        vscode.window.showErrorMessage(`Auto-build doctrine failed: ${err.message}`);
                    } finally {
                        this.processManager.unregister(docProcId);
                        this.updateGeneratingState();
                    }
                }
                break;
            case 'requestBriefingClipboard':
                try {
                    const text = await vscode.env.clipboard.readText();
                    if (text) {
                        this._panel.webview.postMessage({
                            command: 'updateBriefingContent',
                            text: text
                        });
                    }
                } catch (e: any) {
                    vscode.window.showErrorMessage("Failed to read clipboard: " + e.message);
                }
                break;
            case 'compactMissionBriefing':
                {
                    if (!this._contextManager) break;
                    const res = await this._contextManager.getMissionBriefingManager().compactStore(undefined, true);
                    webview.postMessage({
                        command: 'updateBriefingContent',
                        text: res.rendered
                    });
                    this.updateContextAndTokens({ isBackgroundSync: false });
                    vscode.window.showInformationMessage(
                        `🗜️ Mission Briefing compacted (Pruned ${res.prunedStaleCount} stale, merged ${res.deduplicatedCount} duplicate${res.compactedViaLlm ? ', consolidated via AI' : ''}).`
                    );
                }
                break;
            case 'applyMissionBriefing':
                {
                    const { content: bContent, action: bAction, scope: bScope, category: bCategory, section: bSection, id: bId, title: bTitle, cardId } = message;
                    const allowedActions = ['add', 'edit', 'delete', 'remove', 'upsert', 'patch', 'write'];
                    const effectiveAction = allowedActions.includes(bAction)
                        ? bAction
                        : ((bContent && bContent.includes('<<<<<<< SEARCH')) ? 'patch' : 'upsert');
                    const effectiveScope = (bScope === 'local') ? 'local' : 'global';

                    const updatedBriefing = await this._contextManager.updateMissionBriefing(
                        bContent,
                        effectiveAction,
                        effectiveScope,
                        this._currentDiscussion,
                        { category: bCategory, section: bSection, id: bId, title: bTitle }
                    );

                    if (this._currentDiscussion && !this._currentDiscussion.id.startsWith('temp-')) {
                        await this._discussionManager.saveDiscussion(this._currentDiscussion);
                    }

                    webview.postMessage({
                        command: 'updateBriefingContent',
                        text: updatedBriefing
                    });

                    webview.postMessage({
                        command: 'missionBriefingApplied',
                        action: effectiveAction,
                        scope: effectiveScope,
                        cardId: cardId
                    });

                    this.updateContextAndTokens({ isBackgroundSync: false });
                    vscode.window.showInformationMessage(`🎯 Mission Briefing updated (${effectiveAction.toUpperCase()}, ${effectiveScope.toUpperCase()}).`);
                }
                break;
            case 'clearMissionBriefing':
                {
                    const { scope } = message;
                    if (scope === 'local' || scope === 'all') {
                        if (this._currentDiscussion) {
                            this._currentDiscussion.discussion_data_zone = "";
                            if (!this._currentDiscussion.id.startsWith('temp-')) {
                                await this._discussionManager.saveDiscussion(this._currentDiscussion);
                            }
                        }
                    }
                    if (scope === 'global' || scope === 'all') {
                        if (this._contextManager) {
                            await this._contextManager.getMissionBriefingManager().clearAll();
                        }
                    }
                    this._panel.webview.postMessage({
                        command: 'updateBriefingContent',
                        text: ''
                    });
                    this.updateContextAndTokens({ isBackgroundSync: false });
                    vscode.window.showInformationMessage("🎯 Mission Briefing cleared.");
                }
                break;
            case 'saveMissionBriefing':
                const { content, scope } = message;
                
                if (scope === 'global' && this._contextManager) {
                    await this._contextManager.getMissionBriefingManager().applyUpdate(content || '', 'write', { isUserModalSave: true });
                } else if (this._currentDiscussion) {
                    let parsed: any = {};
                    if (this._currentDiscussion.discussion_data_zone) {
                        try {
                            parsed = JSON.parse(this._currentDiscussion.discussion_data_zone);
                        } catch {
                            parsed = {};
                        }
                    }
                    // Clean out legacy librarian findings
                    Object.keys(parsed).forEach(k => {
                        if (k.startsWith('librarian_findings_') || k.startsWith('findings_')) delete parsed[k];
                    });
                    if (content) {
                        parsed.user_constraints = content;
                    } else {
                        delete parsed.user_constraints;
                    }
                    this._currentDiscussion.discussion_data_zone = Object.keys(parsed).length > 0 ? JSON.stringify(parsed, null, 2) : "";
                    if (!this._currentDiscussion.id.startsWith('temp-')) {
                        await this._discussionManager.saveDiscussion(this._currentDiscussion);
                    }
                }

                this.updateContextAndTokens({ isBackgroundSync: false });
                vscode.window.showInformationMessage("🎯 Mission Briefing updated.");
                break;
            case 'internetHelpSearch':
                // Execute ONLY the web research agent loop. 
                // This populates the project context with external info without generating a chat reply.
                if (this._isDisposed || !this.processManager) { break; }
                const { id: webProcId, controller: webCtrl } = this.processManager.register(this.discussionId, 'Running Web Research...');
                this.updateGeneratingState();
                try {
                    const model = this._currentDiscussion?.model || this._lollmsAPI.getModelName();
                    const query = message.query || "Latest information related to current context";
                    const webAgentMsgId = 'web_agent_manual_' + Date.now();
                    
                    await this.addMessageToDiscussion({
                        id: webAgentMsgId, 
                        role: 'system', 
                        content: `**🌍 Web Research Agent (Manual)**\n*Researching: "${query}"...*\n\n`, 
                        skipInPrompt: true 
                    });

                    await this._contextManager.runWebResearchAgent(query, model, webCtrl.signal, (newContent) => {
                        if (!this._isDisposed) {
                            this._panel.webview.postMessage({ command: 'updateMessage', messageId: webAgentMsgId, newContent });
                        }
                    });
                    
                    this.updateContextAndTokens();
                } catch (e: any) {
                    if (e.name !== 'AbortError') {
                        this.log(`Web Research failed: ${e.message}`, 'ERROR');
                    }
                } finally {
                    this.processManager.unregister(webProcId);
                    this.updateGeneratingState();
                }
                break;
            case 'runDebugAgent':
                if (this._isDisposed || !this.processManager || !this.agentManager || !this._currentDiscussion) break;
                
                // 1. Sync state and register process
                this._discussionCapabilities.debugMode = true;
                const { id: dbgProcId, controller: dbgCtrl } = this.processManager.register(this.discussionId, '🛰️ Orchestrator: Initializing Debug Sandbox...');
                const manualPrompt = message.prompt || "Improve project quality and ensure stability.";

                try {
                    // 2. Synchronize Manager with UI Context
                    this.agentManager.currentDiscussion = this._currentDiscussion;
                    (this.agentManager as any).chatHistory = [...this._currentDiscussion.messages];

                    // 3. Trigger Orchestrator linked to the UI Stop button
                    await this.agentManager.runDebuggingOrchestrator(manualPrompt, dbgCtrl.signal);
                    this.updateContextAndTokens();
                } catch (e: any) {
                    if (e.name !== 'AbortError') {
                        this.log(`Debug Mission failed: ${e.message}`, 'ERROR');
                        this.addMessageToDiscussion({ role: 'system', content: `❌ **Debug Mission Failed:** ${e.message}` });
                    }
                } finally {
                    this.processManager.unregister(dbgProcId);
                    this.updateGeneratingState();
                }
                break;
            case 'resolveImageUri':
                {
                    try {
                        const resolution = await this._contextManager.resolveWorkspaceFromPath(message.path);
                        if (resolution) {
                            // Ensure file exists before resolving
                            await vscode.workspace.fs.stat(resolution.uri);
                            const webviewUri = webview.asWebviewUri(resolution.uri);
                            webview.postMessage({ 
                                command: 'imageUriResolved', 
                                targetId: message.targetId, 
                                uri: webviewUri.toString() 
                            });
                        } else {
                            Logger.warn(`Could not resolve image result path: ${message.path}`);
                        }
                    } catch (e) {
                        Logger.warn(`Error resolving image path: ${message.path}`);
                    }
                }
                break;
            case 'requestDiagnosticReport':
                {
                    const agent = this.agentManager;
                    const plan = (agent as any)['currentPlan'];
                    const logs = (agent as any).completedActionsHistory || [];
                    const report = `### 🐛 BUG REPORT DIAGNOSTICS\n\n**OBJECTIVE**: ${plan?.objective || 'N/A'}\n\n**LAST PLAN STATE**:\n${JSON.stringify(plan, null, 2)}\n\n**ACTION LOGS**:\n${logs.join('\n')}`;
                    await vscode.env.clipboard.writeText(report);
                    vscode.window.showInformationMessage("Diagnostic report copied to clipboard. Paste it into a new issue.");
                }
                break;
            case 'runAutoSkill':
                if (this._isDisposed || !this.processManager) { break; }
                const { id: skillProcId, controller: skillCtrl } = this.processManager.register(this.discussionId, 'Optimizing Skills...');
                this.updateGeneratingState();
                try {
                    const model = this._currentDiscussion?.model || this._lollmsAPI.getModelName();
                    const prompt = message.prompt || "Update skills for current discussion";
                    const skillLogId = 'skill_refresh_' + Date.now();
                    
                    await this.addMessageToDiscussion({
                        id: skillLogId, 
                        role: 'system', 
                        content: `**💡 Auto-Skill Agent (Manual)**\n*Analyzing relevant skills...*\n\n`, 
                        skipInPrompt: true 
                    });

                    const newSkills = await this._contextManager.runSkillSelectionAgent(
                        prompt, 
                        model, 
                        skillCtrl.signal, 
                        this._currentDiscussion?.importedSkills || [],
                        (log) => {
                            if (!this._isDisposed) {
                                this._panel.webview.postMessage({ command: 'updateMessage', messageId: skillLogId, newContent: log });
                            }
                        }
                    );
                    
                    if (this._currentDiscussion && JSON.stringify(newSkills) !== JSON.stringify(this._currentDiscussion.importedSkills)) {
                        this._currentDiscussion.importedSkills = newSkills;
                        if (!this._currentDiscussion.id.startsWith('temp-')) {
                            await this._discussionManager.saveDiscussion(this._currentDiscussion);
                        }
                        this.updateContextAndTokens();
                        await this.updateMessageContent(skillLogId, `**💡 Auto-Skill Agent (Manual)**\n*Update complete. ${newSkills.length} skills active.*`);
                    } else {
                        await this.updateMessageContent(skillLogId, `**💡 Auto-Skill Agent (Manual)**\n*No changes needed. Context is optimal.*`);
                    }
                } catch (e: any) {
                    if (e.name !== 'AbortError') {
                        this.log(`Auto-Skill refresh failed: ${e.message}`, 'ERROR');
                    }
                } finally {
                    this.processManager.unregister(skillProcId);
                    this.updateGeneratingState();
                }
                break;
        }
    });
  }

  private wrapInSafeCodeFence(content: string, lang: string = ''): string {
      const text = String(content || '');
      const matches = text.match(/`{3,}/g) || [];
      let maxTicks = 2;
      for (const m of matches) {
          if (m.length > maxTicks) maxTicks = m.length;
      }
      const fence = '`'.repeat(maxTicks + 1);
      return `${fence}${lang}\n${text}\n${fence}`;
  }

  private findUnclosedMarkdownFence(text: string): { char: string; len: number } | null {
      if (!text) return null;
      const lines = text.split(/\r?\n/);
      let openFence: { char: string; len: number } | null = null;
      for (const line of lines) {
          const fm = line.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
          if (!fm) continue;
          const marker = fm[1];
          const ch = marker[0];
          const len = marker.length;
          const trailing = fm[2] || '';
          if (openFence) {
              if (ch === openFence.char && len >= openFence.len && trailing.trim() === '') {
                  openFence = null;
              }
          } else {
              const isInline = ch === '`' && trailing.includes(marker);
              if (!isInline) {
                  openFence = { char: ch, len };
              }
          }
      }
      return openFence;
  }

  private formatSafeToolResult(rawResult: string): string {
      let escaped = String(rawResult || '').replace(
          /<\/?(?:details|div|summary|script|style|iframe|pre|textarea|xmp|file|delete_code|delete_file|delete_files|think|thinking|thought|analysis|reasoning|lollms_tool|lollms_form|form|execute_code|add_files_to_context|remove_files_from_context|mute_files|unmute_files|load_structure|read_definitions|show_symbol|get_symbol_code|read_symbol|manage_symbols|unpack_directory|peek_files|read_full_file|read_file|read_external_file|grep|grep_search|search_files|sparql|query_architecture|run_tests|load_knowledge|update_knowledge|record_insight|add_insight|mission_briefing|user_instruction|plan|findings|phase|instruction|files_list|agent_round|milestone|project_memory)\b[^>]*>?/gi,
          (m) => m.replace(/</g, '&lt;').replace(/>/g, '&gt;')
      );

      // Ensure any code fence opened inside tool output is properly closed before closing </details>
      const openFence = this.findUnclosedMarkdownFence(escaped);
      if (openFence) {
          escaped = `${escaped}\n${openFence.char.repeat(openFence.len)}`;
      }

      // Close any unclosed HTML comments so they cannot swallow </div></details>
      const openComments = (escaped.match(/<!--/g) || []).length;
      const closeComments = (escaped.match(/-->/g) || []).length;
      if (openComments > closeComments) {
          escaped = `${escaped}\n-->`;
      }

      return escaped;
  }

  private findMatchingInlineBacktickEndInLine(line: string, startInLine: number): number {
      let tickCount = 0;
      while (startInLine + tickCount < line.length && line[startInLine + tickCount] === '`') {
          tickCount++;
      }
      if (tickCount === 0) return -1;
      let i = startInLine + tickCount;
      while (i < line.length) {
          if (line[i] === '`') {
              let closeCount = 0;
              while (i + closeCount < line.length && line[i + closeCount] === '`') {
                  closeCount++;
              }
              if (closeCount === tickCount) {
                  return i + closeCount;
              }
              i += closeCount;
          } else {
              i++;
          }
      }
      return -1;
  }

  private getProtectedContentRanges(text: string, options?: { keepToolWrapperFences?: boolean }): { start: number; end: number }[] {
      const ranges: { start: number; end: number }[] = [];
      if (!text) return ranges;

      // 1. Protect closed <file> mutation blocks
      const extractedFiles = extractFileBlocks(text);
      for (const fb of extractedFiles) {
          if (fb.isClosed) {
              ranges.push({ start: fb.start, end: fb.end });
          }
      }

      // 2. Protect <details class="processing-block">...</details> using balanced depth counting
      const procOpenRegex = /<details\b[^>]*\bclass=["'][^"']*\bprocessing-block\b[^"']*["'][^>]*>/gi;
      let pm: RegExpExecArray | null;
      while ((pm = procOpenRegex.exec(text)) !== null) {
          const pStart = pm.index;
          if (ranges.some(r => pStart >= r.start && pStart < r.end)) continue;
          const tagFinder = /<\/?details\b[^>]*>/gi;
          tagFinder.lastIndex = pStart + pm[0].length;
          let depth = 1;
          let pEnd = text.length;
          let tm: RegExpExecArray | null;
          while ((tm = tagFinder.exec(text)) !== null) {
              if (tm[0].toLowerCase().startsWith('</')) {
                  depth--;
                  if (depth === 0) {
                      pEnd = tm.index + tm[0].length;
                      break;
                  }
              } else {
                  depth++;
              }
          }
          ranges.push({ start: pStart, end: pEnd });
          procOpenRegex.lastIndex = pEnd;
      }

      const isAlreadyProtected = (offset: number) => ranges.some(r => offset >= r.start && offset < r.end);

      // 3. Protect fenced code blocks (matching variable-length backtick/tilde fences outside <file>/processing-block)
      //    and inline backticks
      const toolTagNamesPattern = /^(?:add_files_to_context|remove_files_from_context|mute_files|unmute_files|load_knowledge|update_knowledge|unpack_directory|load_structure|read_definitions|show_symbol|get_symbol_code|read_symbol|peek_files|read_full_file|read_file|read_external_file|grep|grep_search|search_files|manage_symbols|query_architecture|sparql|run_tests|lollms_tool|execute_code|lollms_form)\b/i;
      let openFence: { start: number; bodyStart: number; char: string; len: number; langHint: string } | null = null;

      let lineStart = 0;
      const len = text.length;
      while (lineStart < len) {
          let nlIdx = text.indexOf('\n', lineStart);
          const nextLineStart = nlIdx === -1 ? len : nlIdx + 1;
          const lineEnd = (nlIdx === -1 ? len : nlIdx) - (nlIdx > lineStart && text[nlIdx - 1] === '\r' ? 1 : 0);
          const lineText = text.slice(lineStart, lineEnd);

          if (!openFence && isAlreadyProtected(lineStart)) {
              lineStart = nextLineStart;
              continue;
          }

          const fm = lineText.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
          if (openFence) {
              if (fm && fm[1][0] === openFence.char && fm[1].length >= openFence.len && (fm[2] || '').trim() === '') {
                  const innerTrim = text.slice(openFence.bodyStart, lineStart).trim();
                  const isToolWrapperFence = options?.keepToolWrapperFences &&
                      (!openFence.langHint || ['xml', 'tool', 'tools', 'sparql', 'form', 'lollms_form'].includes(openFence.langHint)) &&
                      innerTrim.startsWith('<') &&
                      toolTagNamesPattern.test(innerTrim.substring(1));
                  if (!isToolWrapperFence) {
                      ranges.push({ start: openFence.start, end: nextLineStart });
                  }
                  openFence = null;
              }
              lineStart = nextLineStart;
              continue;
          }

          if (fm) {
              const marker = fm[1];
              const ch = marker[0];
              const mLen = marker.length;
              const trailing = (fm[2] || '').trim();
              const isInline = ch === '`' && trailing.includes(marker);
              if (!isInline) {
                  openFence = {
                      start: lineStart,
                      bodyStart: nextLineStart,
                      char: ch,
                      len: mLen,
                      langHint: trailing.toLowerCase()
                  };
                  lineStart = nextLineStart;
                  continue;
              }
          }

          let col = 0;
          while (col < lineText.length) {
              if (lineText[col] === '`') {
                  const endCol = this.findMatchingInlineBacktickEndInLine(lineText, col);
                  if (endCol !== -1) {
                      ranges.push({ start: lineStart + col, end: lineStart + endCol });
                      col = endCol;
                      continue;
                  }
              }
              col++;
          }

          lineStart = nextLineStart;
      }

      if (openFence) {
          ranges.push({ start: openFence.start, end: len });
      }

      return ranges;
  }

  private stripProtectedRegionsForTagScan(text: string): string {
      if (!text) return '';
      const stripped = stripThinkingTags(text);
      const ranges = this.getProtectedContentRanges(stripped, { keepToolWrapperFences: false });
      if (ranges.length === 0) return stripped;

      // Sort and merge overlapping ranges, then blank them out with spaces to preserve positions/newlines
      const sorted = [...ranges].sort((a, b) => a.start - b.start);
      const merged: { start: number; end: number }[] = [];
      for (const r of sorted) {
          const last = merged[merged.length - 1];
          if (last && r.start <= last.end) {
              last.end = Math.max(last.end, r.end);
          } else {
              merged.push({ ...r });
          }
      }

      let out = '';
      let cursor = 0;
      for (const r of merged) {
          out += stripped.slice(cursor, r.start);
          out += '\n';
          cursor = r.end;
      }
      out += stripped.slice(cursor);
      return out;
  }

  private findXmlTagCloseAngle(line: string, startCol: number): number {
      let quote: '"' | "'" | null = null;
      for (let i = startCol; i < line.length; i++) {
          const ch = line[i];
          if (quote) {
              if (ch === quote) quote = null;
          } else if (ch === '"' || ch === "'") {
              quote = ch;
          } else if (ch === '>') {
              return i;
          }
      }
      return -1;
  }

  private repairAndNormalizeRoundOutput(rawTurn: string): { repaired: string; wasRepaired: boolean; repairs: string[] } {
      if (!rawTurn) return { repaired: rawTurn, wasRepaired: false, repairs: [] };

      const normalizedInput = rawTurn.replace(/\r\n/g, '\n');
      const repairs: string[] = [];
      let wasRepaired = false;

      const THINK_TAGS = new Set(['think', 'thinking', 'thought', 'analysis', 'reasoning']);
      const OPAQUE_FILE_TAGS = new Set(['file', 'delete_code']);
      const OPAQUE_CODE_TAGS = new Set(['execute_code']);
      const PLAN_CHILD_TAGS = new Set(['findings', 'phase', 'instruction', 'files_list']);
      const REQUIRE_ATTR_OR_CLOSE = new Set([
          'add_files_to_context', 'remove_files_from_context', 'mute_files', 'unmute_files',
          'load_structure', 'read_definitions', 'show_symbol', 'get_symbol_code', 'read_symbol',
          'manage_symbols', 'unpack_directory', 'peek_files', 'read_full_file', 'read_file',
          'read_external_file', 'grep', 'grep_search', 'search_files', 'sparql', 'query_architecture',
          'run_tests', 'load_knowledge', 'update_knowledge', 'record_insight', 'add_insight',
          'mission_briefing', 'delete_files', 'delete_file', 'lollms_tool', 'lollms_form',
          'user_instruction', 'plan', 'milestone', 'project_memory', 'execute_code'
      ]);
      const ALL_TRACKED_TAGS = new Set<string>([
          ...THINK_TAGS,
          ...OPAQUE_FILE_TAGS,
          ...OPAQUE_CODE_TAGS,
          ...PLAN_CHILD_TAGS,
          ...REQUIRE_ATTR_OR_CLOSE,
          'form',
          'details'
      ]);

      const lines = normalizedInput.split('\n');
      const outLines: string[] = [];

      let activeFence: { char: string; len: number } | null = null;
      let inAiderHunk: 'search' | 'replace' | null = null;
      const tagStack: { name: string }[] = [];
      let sawAnyThinkInRound = false;
      let prependOpenThink = false;

      const getTopTag = (): string | null => (tagStack.length > 0 ? tagStack[tagStack.length - 1].name : null);
      const isOpaqueTop = (): boolean => {
          const top = getTopTag();
          return !!top && (OPAQUE_FILE_TAGS.has(top) || OPAQUE_CODE_TAGS.has(top) || THINK_TAGS.has(top));
      };

      const isValidFileTagAttr = (attrStr: string): boolean => {
          const attrs = parseFileTagAttributes(attrStr);
          if (!attrs || !attrs.path || !isValidFilePath(attrs.path)) return false;
          const clean = attrs.path.replace(/\\/g, '/').toLowerCase().trim();
          return clean !== '...' && clean !== 'path/to/file.ext' && !clean.startsWith('path/to/') && clean !== 'path/to/obsolete_file.ext';
      };

      const isToolWrapperFenceAt = (lineIdx: number, langHint: string): boolean => {
          const top = getTopTag();
          if (top && (OPAQUE_FILE_TAGS.has(top) || THINK_TAGS.has(top) || OPAQUE_CODE_TAGS.has(top))) return false;
          for (let j = lineIdx + 1; j < lines.length; j++) {
              const trimmed = lines[j].trim();
              if (!trimmed) continue;
              const fm = trimmed.match(/^<file\s+([^>]*?)>/i);
              if (fm && isValidFileTagAttr(fm[1] || '')) return true;
              const tm = trimmed.match(/^<([a-zA-Z_][a-zA-Z0-9_]*)\b/);
              if (tm && (!langHint || ['xml', 'tool', 'tools', 'sparql', 'form', 'lollms_form'].includes(langHint.toLowerCase()))) {
                  if (REQUIRE_ATTR_OR_CLOSE.has(tm[1].toLowerCase())) return true;
              }
              return false;
          }
          return false;
      };

      for (let li = 0; li < lines.length; li++) {
          let lineText = lines[li];
          const top = getTopTag();

          // 1. Inside an active fenced code block
          if (activeFence) {
              const cf = lineText.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
              if (cf && cf[1][0] === activeFence.char && cf[1].length >= activeFence.len) {
                  const trailing = cf[2] || '';
                  if (trailing.trim() === '') {
                      activeFence = null;
                      outLines.push(lineText);
                      continue;
                  }
                  if (top && OPAQUE_FILE_TAGS.has(top) && new RegExp(`^[ \\t]*<\\/\\s*${top}\\b`, 'i').test(trailing)) {
                      activeFence = null;
                      const splitIdx = lineText.indexOf(trailing);
                      outLines.push(lineText.slice(0, splitIdx).trimEnd());
                      lineText = trailing.trimStart();
                      wasRepaired = true;
                      repairs.push(`Separated </${top}> from closing fence`);
                  } else {
                      outLines.push(lineText);
                      continue;
                  }
              } else if (top && (OPAQUE_FILE_TAGS.has(top) || OPAQUE_CODE_TAGS.has(top)) && new RegExp(`^[ \\t]*<\\/\\s*${top}\\s*>[ \\t]*$`, 'i').test(lineText)) {
                  // Model opened a fence inside <file> or <execute_code> and closed  </file> without closing the fence
                  outLines.push(activeFence.char.repeat(activeFence.len));
                  activeFence = null;
                  wasRepaired = true;
                  repairs.push(`Closed unclosed inner code fence before </${top}>`);
              } else {
                  outLines.push(lineText);
                  continue;
              }
          }

          // 2. Check for opening code fence at line start
          const ofMatch = lineText.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
          if (ofMatch) {
              const marker = ofMatch[1];
              const ch = marker[0];
              const mLen = marker.length;
              const trailing = (ofMatch[2] || '').trim();
              const isInline = ch === '`' && trailing.includes(marker);
              if (!isInline && !isToolWrapperFenceAt(li, trailing)) {
                  activeFence = { char: ch, len: mLen };
                  outLines.push(lineText);
                  continue;
              }
          }

          // 3. Track Aider markers inside <file> / <delete_code>
          if (top && OPAQUE_FILE_TAGS.has(top)) {
              const trimmed = lineText.trim();
              if (/^<{7}\s*search\b/i.test(trimmed)) {
                  if (inAiderHunk === 'search') {
                      outLines.push('=======', '', '>>>>>>> REPLACE');
                      wasRepaired = true;
                      repairs.push('Closed incomplete Aider SEARCH hunk before next SEARCH');
                  } else if (inAiderHunk === 'replace') {
                      outLines.push('>>>>>>> REPLACE');
                      wasRepaired = true;
                      repairs.push('Closed incomplete Aider REPLACE hunk before next SEARCH');
                  }
                  inAiderHunk = 'search';
                  outLines.push(lineText);
                  continue;
              }
              if (/^={7,}[ \t]*$/.test(trimmed) && inAiderHunk === 'search') {
                  inAiderHunk = 'replace';
                  outLines.push(lineText);
                  continue;
              }
              if (/^>{7}\s*replace\b/i.test(trimmed)) {
                  if (inAiderHunk === 'search') {
                      outLines.push('=======', '');
                      wasRepaired = true;
                      repairs.push('Inserted missing ======= separator before >>>>>>> REPLACE');
                  }
                  inAiderHunk = null;
                  outLines.push(lineText);
                  continue;
              }
          }

          // 4. Scan columns on lineText
          let rebuilt = '';
          let col = 0;
          let seenNonWs = false;
          let inSingleQuote = false;
          let inDoubleQuote = false;

          while (col < lineText.length) {
              const ch = lineText[col];
              const curTop = getTopTag();

              if (curTop && OPAQUE_FILE_TAGS.has(curTop)) {
                  // Track basic quote state only for mid-line </file> safety
                  if (ch === '\\' && (inSingleQuote || inDoubleQuote) && col + 1 < lineText.length) {
                      rebuilt += lineText.slice(col, col + 2);
                      col += 2;
                      seenNonWs = true;
                      continue;
                  }
                  if (ch === '"' && !inSingleQuote) {
                      inDoubleQuote = !inDoubleQuote;
                      rebuilt += ch;
                      col++;
                      seenNonWs = true;
                      continue;
                  }
                  if (ch === "'" && !inDoubleQuote) {
                      inSingleQuote = !inSingleQuote;
                      rebuilt += ch;
                      col++;
                      seenNonWs = true;
                      continue;
                  }
              }

              if (ch === '`') {
                  const endCol = this.findMatchingInlineBacktickEndInLine(lineText, col);
                  if (endCol !== -1) {
                      rebuilt += lineText.slice(col, endCol);
                      col = endCol;
                      seenNonWs = true;
                      continue;
                  }
                  rebuilt += ch;
                  col++;
                  seenNonWs = true;
                  continue;
              }

              if (ch === '<') {
                  const slice = lineText.slice(col);

                  // 4A. Closing tag </name>
                  const closeM = slice.match(/^<\/\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*>/);
                  if (closeM) {
                      const rawCloseName = closeM[1];
                      const closeName = rawCloseName.toLowerCase();
                      const closeLen = closeM[0].length;

                      if (curTop && OPAQUE_FILE_TAGS.has(curTop)) {
                          const canCloseFile = closeName === curTop && (!seenNonWs || (!inSingleQuote && !inDoubleQuote && lineText.slice(col + closeLen).trim() === ''));
                          if (canCloseFile) {
                              if (inAiderHunk === 'search') {
                                  rebuilt += '\n=======\n\n>>>>>>> REPLACE';
                                  inAiderHunk = null;
                                  wasRepaired = true;
                                  repairs.push(`Closed incomplete Aider SEARCH hunk before </${curTop}>`);
                              } else if (inAiderHunk === 'replace') {
                                  rebuilt += '\n>>>>>>> REPLACE';
                                  inAiderHunk = null;
                                  wasRepaired = true;
                                  repairs.push(`Closed incomplete Aider REPLACE hunk before </${curTop}>`);
                              }
                              tagStack.pop();
                              if (seenNonWs) {
                                  rebuilt += `\n</${curTop}>`;
                                  wasRepaired = true;
                                  repairs.push(`Moved </${curTop}> onto its own line`);
                              } else {
                                  rebuilt += `</${curTop}>`;
                              }
                              col += closeLen;
                              if (lineText.slice(col).trim().length > 0) {
                                  rebuilt += '\n';
                                  wasRepaired = true;
                              }
                              seenNonWs = true;
                              continue;
                          }
                      } else if (curTop && OPAQUE_CODE_TAGS.has(curTop)) {
                          if (closeName === curTop) {
                              tagStack.pop();
                              if (seenNonWs) {
                                  rebuilt += `\n</${curTop}>`;
                                  wasRepaired = true;
                                  repairs.push(`Moved </${curTop}> onto its own line`);
                              } else {
                                  rebuilt += `</${curTop}>`;
                              }
                              col += closeLen;
                              if (lineText.slice(col).trim().length > 0) {
                                  rebuilt += '\n';
                                  wasRepaired = true;
                              }
                              seenNonWs = true;
                              continue;
                          }
                      } else if (curTop && THINK_TAGS.has(curTop)) {
                          if (THINK_TAGS.has(closeName)) {
                              tagStack.pop();
                              const normalizedClose = `</${curTop}>`;
                              if (closeName !== curTop) {
                                  wasRepaired = true;
                                  repairs.push(`Normalized mismatched </${rawCloseName}> to ${normalizedClose}`);
                              }
                              rebuilt += seenNonWs ? `\n${normalizedClose}` : normalizedClose;
                              if (seenNonWs) wasRepaired = true;
                              col += closeLen;
                              if (lineText.slice(col).trim().length > 0) {
                                  rebuilt += '\n';
                                  wasRepaired = true;
                              }
                              seenNonWs = true;
                              continue;
                          }
                      } else if (ALL_TRACKED_TAGS.has(closeName)) {
                          if (THINK_TAGS.has(closeName)) {
                              // Dangling </think> when no think tag is open
                              if (!sawAnyThinkInRound && tagStack.length === 0) {
                                  prependOpenThink = true;
                                  sawAnyThinkInRound = true;
                                  rebuilt += seenNonWs ? `\n</${closeName}>` : `</${closeName}>`;
                                  if (seenNonWs) wasRepaired = true;
                                  repairs.push(`Prepended missing <${closeName}> for dangling </${rawCloseName}>`);
                                  wasRepaired = true;
                                  col += closeLen;
                                  if (lineText.slice(col).trim().length > 0) {
                                      rebuilt += '\n';
                                      wasRepaired = true;
                                  }
                                  seenNonWs = true;
                                  continue;
                              } else {
                                  rebuilt += `&lt;/${rawCloseName}&gt;`;
                                  wasRepaired = true;
                                  repairs.push(`Escaped stray </${rawCloseName}>`);
                                  col += closeLen;
                                  seenNonWs = true;
                                  continue;
                              }
                          }

                          const stackIdx = [...tagStack].reverse().findIndex(t => t.name === closeName);
                          if (stackIdx !== -1) {
                              const actualIdx = tagStack.length - 1 - stackIdx;
                              while (tagStack.length - 1 > actualIdx) {
                                  const unclosedInner = tagStack.pop()!;
                                  rebuilt += `\n</${unclosedInner.name}>\n`;
                                  wasRepaired = true;
                                  repairs.push(`Auto-closed unclosed <${unclosedInner.name}> before </${closeName}>`);
                              }
                              tagStack.pop();
                              rebuilt += `</${closeName}>`;
                              col += closeLen;
                              if (lineText.slice(col).trim().length > 0) {
                                  rebuilt += '\n';
                                  wasRepaired = true;
                              }
                              seenNonWs = true;
                              continue;
                          } else {
                              // Stray closing tag for a tracked tag that was never opened
                              rebuilt += `&lt;/${rawCloseName}&gt;`;
                              wasRepaired = true;
                              repairs.push(`Escaped orphaned </${rawCloseName}>`);
                              col += closeLen;
                              seenNonWs = true;
                              continue;
                          }
                      }
                  }

                  // 4B. Opening tag <name ...>
                  const openNameM = slice.match(/^<([a-zA-Z_][a-zA-Z0-9_]*)(?=[\s\/>]|$)/);
                  if (openNameM) {
                      const rawTagName = openNameM[1];
                      const tagName = rawTagName.toLowerCase();

                      // If inside <file> at column 0 outside Aider hunk, auto-close previous <file> when a new valid <file> starts
                      if (curTop && OPAQUE_FILE_TAGS.has(curTop) && !seenNonWs && !inAiderHunk && tagName === 'file') {
                          const endAngle = this.findXmlTagCloseAngle(lineText, col);
                          if (endAngle !== -1) {
                              const attrStr = lineText.slice(col + 1 + rawTagName.length, endAngle);
                              if (isValidFileTagAttr(attrStr)) {
                                  tagStack.pop();
                                  rebuilt += `\n</${curTop}>\n`;
                                  wasRepaired = true;
                                  repairs.push(`Auto-closed unclosed <${curTop}> before new <file>`);
                                  // Fall through to handle the new <file> at top level
                              }
                          }
                      }

                      if (!isOpaqueTop() && ALL_TRACKED_TAGS.has(tagName)) {
                          let endAngle = this.findXmlTagCloseAngle(lineText, col);

                          // Recover missing '>' on <file ...> opening line if next line isn't continuing attributes
                          if (endAngle === -1 && OPAQUE_FILE_TAGS.has(tagName)) {
                              const nextLine = li + 1 < lines.length ? lines[li + 1] : '';
                              const nextContinuesAttr = /^\s*[a-zA-Z_][a-zA-Z0-9_-]*\s*=/.test(nextLine) || /^\s*>/.test(nextLine);
                              if (!nextContinuesAttr) {
                                  const candidateAttr = lineText.slice(col + 1 + rawTagName.length);
                                  if (isValidFileTagAttr(candidateAttr)) {
                                      lineText = `${lineText}>`;
                                      endAngle = lineText.length - 1;
                                      wasRepaired = true;
                                      repairs.push(`Inserted missing '>' on <${tagName}> opening tag`);
                                  }
                              }
                          }

                          if (endAngle !== -1) {
                              const fullTagText = lineText.slice(col, endAngle + 1);
                              const innerAttrRaw = lineText.slice(col + 1 + rawTagName.length, endAngle);
                              const isSelfClosing = innerAttrRaw.trimEnd().endsWith('/');
                              const attrClean = isSelfClosing ? innerAttrRaw.trimEnd().slice(0, -1) : innerAttrRaw;

                              let shouldTrack = true;
                              if (OPAQUE_FILE_TAGS.has(tagName)) {
                                  shouldTrack = isValidFileTagAttr(attrClean);
                              } else if (tagName === 'form') {
                                  shouldTrack = !seenNonWs || /\b(?:title|id)=/i.test(attrClean);
                              } else if (tagName === 'details') {
                                  shouldTrack = !seenNonWs || /\b(?:class|open)\b/i.test(attrClean);
                              } else if (PLAN_CHILD_TAGS.has(tagName)) {
                                  shouldTrack = tagStack.some(t => t.name === 'plan' || t.name === 'phase');
                              } else if (!isSelfClosing && REQUIRE_ATTR_OR_CLOSE.has(tagName)) {
                                  // Guard against unbackticked bare prose mention like "Use <unmute_files> to check"
                                  const hasAttrs = attrClean.trim().length > 0;
                                  const restOfLine = lineText.slice(endAngle + 1);
                                  const remainingAfter = restOfLine + '\n' + lines.slice(li + 1).join('\n');
                                  const hasCloserAhead = new RegExp(`<\\/\\s*${tagName}\\s*>`, 'i').test(remainingAfter);
                                  if (!hasAttrs && !hasCloserAhead && seenNonWs && restOfLine.trim().length > 0) {
                                      // Plain prose mention without closer -> wrap in backticks instead of opening a block
                                      rebuilt += `\`${fullTagText}\``;
                                      col = endAngle + 1;
                                      seenNonWs = true;
                                      wasRepaired = true;
                                      repairs.push(`Backtick-escaped unclosed prose mention of <${tagName}>`);
                                      continue;
                                  }
                              }

                              if (shouldTrack) {
                                  const hadPrefix = seenNonWs && !/^[ \t]*(?:(?:[-*+]|\d+\.)[ \t]+|>[ \t]*)?$/.test(rebuilt);
                                  if (hadPrefix) {
                                      rebuilt = `${rebuilt.trimEnd()}\n`;
                                      wasRepaired = true;
                                      repairs.push(`Moved mid-line <${tagName}> to start of new line`);
                                  }
                                  rebuilt += fullTagText;
                                  col = endAngle + 1;
                                  seenNonWs = true;

                                  if (THINK_TAGS.has(tagName)) {
                                      sawAnyThinkInRound = true;
                                  }

                                  if (!isSelfClosing) {
                                      tagStack.push({ name: tagName });
                                  } else if (lineText.slice(col).trim().length > 0) {
                                      rebuilt += '\n';
                                      wasRepaired = true;
                                  }
                                  continue;
                              }
                          } else if (li === lines.length - 1 && !seenNonWs) {
                              // Truncated opening tag at very end of stream without '>'
                              rebuilt += `\`${slice}\``;
                              col = lineText.length;
                              seenNonWs = true;
                              wasRepaired = true;
                              repairs.push(`Escaped truncated trailing <${tagName} tag at EOF`);
                              continue;
                          }
                      }
                  }
              }

              if (ch !== ' ' && ch !== '\t') {
                  seenNonWs = true;
              }
              rebuilt += ch;
              col++;
          }

          outLines.push(rebuilt);
      }

      if (prependOpenThink) {
          outLines.unshift('<think>');
      }

      // Close any unclosed structures left at EOF in clean LIFO order on their own lines
      if (activeFence) {
          outLines.push(activeFence.char.repeat(activeFence.len));
          wasRepaired = true;
          repairs.push('Closed unclosed code fence at EOF');
      }

      if (inAiderHunk === 'search') {
          outLines.push('=======', '', '>>>>>>> REPLACE');
          wasRepaired = true;
          repairs.push('Closed unclosed Aider SEARCH hunk at EOF');
      } else if (inAiderHunk === 'replace') {
          outLines.push('>>>>>>> REPLACE');
          wasRepaired = true;
          repairs.push('Closed unclosed Aider REPLACE hunk at EOF');
      }

      while (tagStack.length > 0) {
          const unclosed = tagStack.pop()!;
          outLines.push(`</${unclosed.name}>`);
          wasRepaired = true;
          repairs.push(`Auto-closed unclosed <${unclosed.name}> at EOF`);
      }

      const repaired = outLines.join('\n');
      return {
          repaired,
          wasRepaired,
          repairs
      };
  }

  /**
   * Sanitizes message content for LLM prompt transmission by removing ephemeral UI widgets,
   * animations, and raw processing tool artifacts.
   */
  public sanitizeMessageContentForPrompt(content: any): any {
      if (typeof content === 'string') {
          let text = content;
          if (text.startsWith('FORM_SUBMISSION:')) {
              try {
                  const parsedForm = JSON.parse(text.substring(16).trim());
                  const entries = Object.entries(parsedForm).map(([k, v]) => `- **${k}**: ${v}`).join('\n');
                  text = `User Form Submission:\n${entries}`;
              } catch {}
          }
          return stripThinkingTags(text)
              .replace(/<div class=["']waiting-animation["']>[\s\S]*?<\/div>/gi, '')
              .replace(/<details\s+class=["']processing-block["']>[\s\S]*?<\/details>/gi, '')
              .replace(/<details\s+class=["']lollms-form-block["']>[\s\S]*?<\/details>/gi, '')
              .replace(/<lollms_tool\b[^>]*>[\s\S]*?<\/lollms_tool>/gi, '')
              .replace(/<agent_git_diff\b[^>]*\/?>/gi, '')
              .trim();
      } else if (Array.isArray(content)) {
          return content.map((part: any) => {
              if (part && part.type === 'text' && typeof part.text === 'string') {
                  return { ...part, text: this.sanitizeMessageContentForPrompt(part.text) };
              }
              return part;
          });
      }
      return content;
  }

  /**
   * Compresses older assistant turns in history by replacing full duplicate <file> or code blocks
   * with lightweight references when those files are already loaded in full under LOADED FILE CONTENTS.
   */
  private compressOlderHistoryCodeBlocks(history: ChatMessage[], activeLoadedFiles: Set<string>): ChatMessage[] {
      if (history.length <= 2) return history;
      const older = history.slice(0, history.length - 2);
      const recent = history.slice(history.length - 2);

      const compressedOlder = older.map(msg => {
          if (msg.role !== 'assistant') return msg;
          let text = typeof msg.content === 'string' 
              ? msg.content 
              : (Array.isArray(msg.content) ? msg.content.map((p: any) => p.text || '').join('\n') : '');
          if (!text || text.length < 400) return msg;

          let modified = false;
          const { parseFileTagAttributes } = require('../../utils');

          let newText = text.replace(/<file\s+([^>]*?)>([\s\S]*?)<\/file>/gi, (match, attrStr, body) => {
              const attrs = parseFileTagAttributes(attrStr, body);
              if (attrs?.path) {
                  const cleanP = attrs.path.replace(/\\/g, '/').toLowerCase().trim();
                  if (activeLoadedFiles.has(cleanP) && body.length > 250) {
                      modified = true;
                      return `<file ${attrStr}>\n/* [Content previously generated (${body.split('\n').length} lines). Active state is in LOADED FILE CONTENTS] */\n</file>

`;
                  }
              }
              return match;
          });

          newText = newText.replace(/```(?:language:|lang:)?(\w+):([^\n\r\s]+)[\r\n]+([\s\S]+?)[\r\n]+```/g, (match, lang, filePath, body) => {
              const cleanP = filePath.replace(/\\/g, '/').toLowerCase().trim();
              if (activeLoadedFiles.has(cleanP) && body.length > 250) {
                  modified = true;
                  return `\`\`\`${lang}:${filePath}\n/* [Code previously generated. Active state loaded in context] */\n\`\`\``;
              }
              return match;
          });

          if (modified) {
              return {
                  ...msg,
                  content: typeof msg.content === 'string' ? newText : [{ type: 'text', text: newText }]
              };
          }
          return msg;
      });

      return [...compressedOlder, ...recent];
  }

  /**
   * Compresses conversation history up through the previous LLM assistant response,
   * preserving the UI messages intact while updating llmHistory for outbound prompts.
   */
  private async compressHistoryUpTillPreviousAnswer(
      activeHistory: ChatMessage[],
      targetModel: string,
      maxTokens: number,
      signal: AbortSignal,
      currentAssistantMessageId?: string
  ): Promise<{ history: ChatMessage[]; compressedCount: number; savedTokens: number } | null> {
      if (!this._currentDiscussion || activeHistory.length === 0) return null;

      let lastAssistantIdx = -1;
      for (let i = activeHistory.length - 1; i >= 0; i--) {
          if (activeHistory[i].role === 'assistant') {
              lastAssistantIdx = i;
              break;
          }
      }

      let splitEndIdx = lastAssistantIdx !== -1 ? lastAssistantIdx + 1 : activeHistory.length;
      if (lastAssistantIdx === -1) {
          const lastUserRevIdx = [...activeHistory].reverse().findIndex(m => m.role === 'user');
          if (lastUserRevIdx !== -1) {
              splitEndIdx = activeHistory.length - 1 - lastUserRevIdx;
          }
      }
      const sliceToCompress = activeHistory.slice(0, splitEndIdx);
      const trailingHistory = activeHistory.slice(splitEndIdx);

      if (sliceToCompress.length === 0) return null;

      const extractMsgText = (m: ChatMessage): string => {
          const sanitized = this.sanitizeMessageContentForPrompt(m.content);
          if (typeof sanitized === 'string') return sanitized;
          if (Array.isArray(sanitized)) {
              return sanitized
                  .map((p: any) => (p?.type === 'text' ? p.text || '' : '[Image attached]'))
                  .join('\n');
          }
          return '';
      };

      const originalChars = sliceToCompress.reduce((sum, m) => sum + extractMsgText(m).length, 0);
      const originalTokens = Math.ceil(originalChars / 3.5);
      if (originalTokens < 600) return null;

      const abbreviateLargeBlocks = (text: string): string => {
          return text
              .replace(/<file\b([^>]*?)>([\s\S]*?)<\/file>/gi, (m, attrs, body) => {
                  if (body.length <= 500) return m;
                  const lines = body.trim().split('\n');
                  return `<file${attrs}>\n${lines.slice(0, 3).join('\n')}\n... [${lines.length} lines abbreviated] ...\n${lines.slice(-2).join('\n')}\n</file>

`;
              })
              .replace(/```[\s\S]*?```/g, (m) => {
                  if (m.length <= 500) return m;
                  const lines = m.split('\n');
                  return `${lines.slice(0, 3).join('\n')}\n... [${lines.length} lines abbreviated] ...\n${lines.slice(-2).join('\n')}`;
              });
      };

      let transcript = sliceToCompress
          .map(m => `### ${m.role.toUpperCase()}\n${abbreviateLargeBlocks(extractMsgText(m)).trim()}`)
          .join('\n\n');

      const maxTranscriptChars = Math.max(12000, Math.floor(maxTokens * 0.55 * 3.5));
      if (transcript.length > maxTranscriptChars) {
          const headSize = Math.floor(maxTranscriptChars * 0.25);
          const tailSize = Math.floor(maxTranscriptChars * 0.70);
          transcript = `${transcript.substring(0, headSize)}\n\n... [middle ${transcript.length - headSize - tailSize} chars omitted for summarization budget] ...\n\n${transcript.substring(transcript.length - tailSize)}`;
      }

      let summaryText = '';
      try {
          const compressionPrompt = LibrarianPromptBuilder.getHistoryCompressionPrompt(transcript);
          const rawSummary = await this._lollmsAPI.sendChat([
              { role: 'system', content: 'You are a concise technical summarization assistant. Output only the requested summary.' },
              { role: 'user', content: compressionPrompt }
          ], null, signal, targetModel, { thinking: false });
          summaryText = stripThinkingTags(rawSummary).trim();
      } catch (err: any) {
          if (signal.aborted || err?.name === 'AbortError' || err?.message === 'AbortError') {
              throw err;
          }
          this.log(`[Context Compression] LLM history summarization fallback triggered: ${err?.message}`, 'WARN');
      }

      if (!summaryText) {
          summaryText = sliceToCompress
              .map(m => {
                  const txt = extractMsgText(m).replace(/\s+/g, ' ').trim();
                  return `- **${m.role.toUpperCase()}**: ${txt.substring(0, 180)}${txt.length > 180 ? '...' : ''}`;
              })
              .slice(-10)
              .join('\n');
      }

      const ts = Date.now();
      const compressedUserMsg: ChatMessage = {
          id: `compressed_history_user_${ts}`,
          role: 'user',
          content: `[COMPRESSED CONVERSATION HISTORY — SUMMARIZED UP TO PREVIOUS ASSISTANT RESPONSE]\nEarlier turns (${sliceToCompress.length} messages) were compressed to fit context limits:\n\n${summaryText}`
      };
      const compressedAckMsg: ChatMessage = {
          id: `compressed_history_ack_${ts}`,
          role: 'assistant',
          content: `Understood. I have the compressed recap of our conversation up to my previous response and am ready to address your current prompt.`
      };

      const nextHistory = [compressedUserMsg, compressedAckMsg, ...trailingHistory];
      const activePlaceholder = currentAssistantMessageId
          ? this._currentDiscussion.messages.find(m => m.id === currentAssistantMessageId)
          : undefined;
      const nonSkippedUsers = this._currentDiscussion.messages.filter(m => m.role === 'user' && !m.skipInPrompt);
      const latestUserMsg = nonSkippedUsers[nonSkippedUsers.length - 1];

      this._currentDiscussion.llmHistory = [
          ...nextHistory,
          ...(latestUserMsg ? [latestUserMsg] : []),
          ...(activePlaceholder ? [activePlaceholder] : [])
      ];

      // Promote enduring cross-session summary into the project-wide Mission Briefing (keyed so it never piles up)
      if (this._contextManager && summaryText.trim().length > 40) {
          this._contextManager.getMissionBriefingManager().upsertEntry({
              id: `session_${this.discussionId.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 32)}`,
              category: 'decisions',
              title: `Session: ${this._currentDiscussion.title || 'Discussion Summary'}`,
              content: summaryText.replace(/\s+/g, ' ').trim().slice(0, 600),
              confidence: 70
          }).catch(() => {});
      }

      const newTokens = Math.ceil((compressedUserMsg.content as string).length / 3.5) + Math.ceil((compressedAckMsg.content as string).length / 3.5);
      return {
          history: nextHistory,
          compressedCount: sliceToCompress.length,
          savedTokens: Math.max(0, originalTokens - newTokens)
      };
  }

  /**
   * Pre-generation Context Reduction Pipeline:
   * Evaluates outbound tokens against model budget and reduces bloated context via:
   * 1 - History bottleneck -> compress history up till previous LLM answer.
   * 2 - File content bottleneck -> convert eligible files to structures (avoiding recently added files).
   * 3 - Insufficient reduction -> mute files.
   * 4 - Bloated tree bottleneck -> omit deep/cold folders.
   * Always informs both the LLM and user what was compressed.
   */
  private async enforceContextBudgetProtection(
        currentContext: ContextResult,
        promptText: string,
        targetModel: string,
        signal: AbortSignal,
        historyMessages?: ChatMessage[],
        protectedFiles: string[] = [],
        currentAssistantMessageId?: string,
        processId?: string,
        extraOverheadTokens: number = 0
    ): Promise<{ contextData: ContextResult, history: ChatMessage[], cutFiles: string[], shrunkFiles: string[], mutedFiles: string[], exploded: boolean, initialTotalTokens: number, triggerBudget: number, maxTokens: number }> {
        if (!this._currentDiscussion || !this._contextManager) {
            return { contextData: currentContext, history: historyMessages || [], cutFiles: [], shrunkFiles: [], mutedFiles: [], exploded: false, initialTotalTokens: 0, triggerBudget: 128000, maxTokens: 128000 };
        }

        if (this._discussionCapabilities.ignoreContextSize === true) {
            return { contextData: currentContext, history: historyMessages || [], cutFiles: [], shrunkFiles: [], mutedFiles: [], exploded: false, initialTotalTokens: 0, triggerBudget: Number.MAX_SAFE_INTEGER, maxTokens: Number.MAX_SAFE_INTEGER };
        }

          const maxTokens =
              this._currentDiscussion.lastTokenMetrics?.contextSize ||
              ChatPanel._contextSizeCache.get(targetModel) ||
              getContextLimitForModel(targetModel) ||
              128000;

          const pruningStrategy: 'aggressive' | 'balanced' | 'permissive' =
              (this._discussionCapabilities as any).contextPruningStrategy || 'balanced';
          const rawHistoryMaxPct = Number((this._discussionCapabilities as any).historyMaxPercent);
          const historyMaxPercent = Number.isFinite(rawHistoryMaxPct)
              ? Math.max(5, Math.min(90, rawHistoryMaxPct))
              : 30;
          const historyBudgetTokens = Math.round(maxTokens * (historyMaxPercent / 100));

          const baseTriggerPct = Math.min(98, this._discussionCapabilities.contextGovernorThreshold ?? 95);
          const baseTargetPct = Math.min(baseTriggerPct, this._discussionCapabilities.contextGovernorTargetThreshold ?? 70);

          const triggerThresholdPct = pruningStrategy === 'aggressive'
              ? Math.min(baseTriggerPct, 80)
              : (pruningStrategy === 'permissive' ? Math.max(baseTriggerPct, 96) : baseTriggerPct);

          const triggerBudget = Math.round(maxTokens * (triggerThresholdPct / 100));
          const rawTargetBudget = Math.round(maxTokens * (baseTargetPct / 100));
          const targetBudget = pruningStrategy === 'aggressive'
              ? Math.min(triggerBudget, Math.round(maxTokens * Math.min(baseTargetPct, 55) / 100))
              : (pruningStrategy === 'permissive'
                  ? Math.min(triggerBudget, Math.max(rawTargetBudget, Math.round(maxTokens * 0.88)))
                  : Math.min(triggerBudget, Math.max(rawTargetBudget, Math.round(maxTokens * 0.82))));

          let activeHistory = (historyMessages || (this._currentDiscussion.llmHistory || this._currentDiscussion.messages || []).filter(m => !m.skipInPrompt)).map(m => ({
              ...m,
              content: this.sanitizeMessageContentForPrompt(m.content)
          }));

          const loadedBlocks = extractFileBlocks(currentContext.selectedFilesContent || '');
          const activeLoadedFiles = new Set<string>();
          loadedBlocks.forEach((fb: any) => {
              const attrs = parseFileTagAttributes(fb.attrStr, fb.rawContent);
              if (attrs?.path) activeLoadedFiles.add(attrs.path.replace(/\\/g, '/').toLowerCase().trim());
          });

          const getMsgTextLength = (msgs: ChatMessage[]) => msgs
              .map(m => typeof m.content === 'string'
                  ? m.content
                  : (Array.isArray(m.content) ? m.content.map((p: any) => p.type === 'text' ? (p.text || '') : '').join('\n') : ''))
              .join('\n').length;

          let activeTreeText = currentContext.projectTree || '';
          let historyTokens = Math.ceil(getMsgTextLength(activeHistory) / 3.5);
          let filesTokens = Math.ceil((currentContext.selectedFilesContent || '').length / 3.5);
          let treeTokens = Math.ceil(activeTreeText.length / 3.5);
          const skillsTokens = Math.ceil((currentContext.skillsContent || '').length / 3.5);
          const promptTokens = Math.ceil(promptText.length / 3.5);
          const imgCost = estimateImageTokens(targetModel) || 600;
          const imageCount = (currentContext.images?.length || 0) + activeHistory.reduce((acc, m) => acc + (Array.isArray(m.content) ? m.content.filter((p: any) => p?.type === 'image_url').length : 0), 0);
          const fixedOverheadTokens = 3000 + skillsTokens + promptTokens + (imageCount * imgCost) + extraOverheadTokens;

          const initialTotalTokens = fixedOverheadTokens + historyTokens + filesTokens + treeTokens;
          const historyOverCap = historyTokens > historyBudgetTokens && activeHistory.length > 0;

          // If both total context and history cap are under their thresholds, continue immediately
          if (initialTotalTokens <= triggerBudget && !historyOverCap) {
              return { contextData: currentContext, history: activeHistory, cutFiles: [], shrunkFiles: [], mutedFiles: [], exploded: false, initialTotalTokens, triggerBudget, maxTokens };
          }

          this.log(`[Context Compression:${pruningStrategy}] Outbound load (~${initialTotalTokens.toLocaleString()} tok, history ~${historyTokens.toLocaleString()} / ${historyBudgetTokens.toLocaleString()} [${historyMaxPercent}%]) exceeds budget (~${triggerBudget.toLocaleString()} tok / ${maxTokens.toLocaleString()} limit). Starting pruning...`, 'INFO');
          if (processId) {
              this.processManager.updateDescription(processId, historyOverCap
                  ? `🗜️ Compressing history (> ${historyMaxPercent}% limit) & optimizing context...`
                  : `🗜️ Context bloated (${pruningStrategy}): Optimizing context...`);
              this.updateGeneratingState();
          }

          let compactedCodeBlocksCount = 0;
          let historyCompressedCount = 0;
          let historySavedTokens = 0;
          let treeReduced = false;
          let treeSavedTokens = 0;
          let omittedFolders: string[] = [];
          const convertedToSymbols: { path: string; symbols: string[]; savedTokens: number }[] = [];
          let symbolsSavedTokens = 0;
          const convertedToStructure: { path: string; savedTokens: number }[] = [];
          let structureSavedTokens = 0;
          const mutedFilePaths: { path: string; tokens: number }[] = [];
          let mutedSavedTokens = 0;

          const recalculateTotal = () => fixedOverheadTokens + historyTokens + filesTokens + treeTokens;

          // Step 0: Non-destructive deduplication of older code blocks already loaded in context
          const beforeCompactHistoryLen = getMsgTextLength(activeHistory);
          const compactedHistory = this.compressOlderHistoryCodeBlocks(activeHistory, activeLoadedFiles);
          const afterCompactHistoryLen = getMsgTextLength(compactedHistory);
          if (afterCompactHistoryLen < beforeCompactHistoryLen) {
              compactedCodeBlocksCount = activeHistory.filter((m, idx) => m.content !== compactedHistory[idx]?.content).length;
              activeHistory = compactedHistory;
              historyTokens = Math.ceil(afterCompactHistoryLen / 3.5);
          }

          let totalEstimated = recalculateTotal();

          const runTreeReduction = () => {
              if (treeReduced) return false;
              const treePct = pruningStrategy === 'aggressive' ? 0.08 : (pruningStrategy === 'permissive' ? 0.15 : 0.12);
              const treeTargetTokens = Math.max(1000, Math.min(3500, Math.round(targetBudget * treePct)));
              const res = this._contextManager.reduceBloatedProjectTree(activeTreeText, treeTargetTokens);
              treeReduced = true;
              if (res.finalTokens < treeTokens && res.omittedFolders.length > 0) {
                  treeSavedTokens += Math.max(0, treeTokens - res.finalTokens);
                  activeTreeText = res.reducedTree;
                  treeTokens = res.finalTokens;
                  omittedFolders = Array.from(new Set([...omittedFolders, ...res.omittedFolders]));
                  totalEstimated = recalculateTotal();
                  return true;
              }
              return false;
          };

          const runHistoryCompression = async () => {
              if (historyCompressedCount > 0 || activeHistory.length === 0) return false;
              const res = await this.compressHistoryUpTillPreviousAnswer(
                  activeHistory,
                  targetModel,
                  maxTokens,
                  signal,
                  currentAssistantMessageId
              );
              if (res) {
                  activeHistory = res.history;
                  historyCompressedCount = res.compressedCount;
                  historySavedTokens += res.savedTokens;
                  historyTokens = Math.ceil(getMsgTextLength(activeHistory) / 3.5);
                  totalEstimated = recalculateTotal();
                  return true;
              }
              return false;
          };

          // Extract prompt keywords for relevance scoring (files & symbols)
          const stopWords = new Set([
              'the', 'and', 'for', 'with', 'this', 'that', 'from', 'your', 'will', 'have', 'been',
              'should', 'what', 'when', 'where', 'which', 'how', 'why', 'can', 'could', 'would',
              'file', 'files', 'code', 'function', 'class', 'const', 'let', 'var', 'import', 'export',
              'return', 'please', 'help', 'need', 'want', 'make', 'look', 'view', 'edit', 'update',
              'change', 'check', 'into', 'just', 'also', 'more', 'some', 'only', 'then', 'they'
          ]);
          const cleanPrompt = promptText.toLowerCase();
          const recentTurns = activeHistory.slice(-3).map(m => typeof m.content === 'string' ? m.content.toLowerCase() : '').join(' ');
          const combinedQuery = `${cleanPrompt} ${recentTurns}`;
          const mentionedPaths: string[] = [];
          const pathRegex = /([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)/g;
          let pMatch;
          while ((pMatch = pathRegex.exec(combinedQuery)) !== null) {
              mentionedPaths.push(pMatch[1].replace(/\\/g, '/').toLowerCase());
          }
          const promptKeywords = Array.from(new Set(
              cleanPrompt.replace(/[^a-z0-9_$\-\/.]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w))
          ));
          const allKeywords = Array.from(new Set(
              combinedQuery.replace(/[^a-z0-9_$\-\/.]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w))
          ));

          const prevTurnFiles = this.getPreviousTurnFiles();
          const currentPromptFiles = this.getCurrentPromptFiles();

          interface FileCandidate {
              block: any;
              path: string;
              norm: string;
              score: number;
              tokens: number;
              mode: 'full' | 'symbols' | 'structure';
              isJustAdded: boolean;
              isRecentlyAdded: boolean;
              isExplicitlyMentioned: boolean;
              isProtected: boolean;
              muted: boolean;
          }

          const candidateBlocks: FileCandidate[] = loadedBlocks.map((fb: any) => {
              const attrs = parseFileTagAttributes(fb.attrStr, fb.rawContent);
              const rawPath = attrs?.path || '';
              const norm = rawPath.replace(/\\/g, '/').toLowerCase().trim();
              const baseName = path.basename(norm);
              const toks = Math.max(1, Math.ceil((fb.fullMatch || fb.rawContent || '').length / 3.5));
              const isStructure = attrs?.mode === 'structure' || fb.attrStr.includes('mode="structure"') || fb.attrStr.includes('mode="definitions-only"');
              const isSymbols = fb.attrStr.includes('mode="symbols"');

              const isJustAdded = protectedFiles.some(pf => {
                  const cleanPf = pf.replace(/\\/g, '/').toLowerCase().trim();
                  return arePathsEqual(rawPath, pf) || norm === cleanPf || norm.endsWith('/' + cleanPf);
              });

              const isRecentlyAdded = !isJustAdded && (
                  this._contextManager.isRecentlyAdded(rawPath) ||
                  this._currentPromptAddedFiles.has(norm) ||
                  currentPromptFiles.has(norm) ||
                  prevTurnFiles.has(norm)
              );

              const isExplicitlyMentioned = mentionedPaths.some(mp => norm.includes(mp) || mp.includes(norm) || (baseName.length > 2 && mp.includes(baseName))) ||
                  cleanPrompt.includes(norm) ||
                  (baseName.length > 2 && cleanPrompt.includes(baseName));

              const isTargetProtected = isJustAdded || isExplicitlyMentioned;

              let score = 0;
              const isClutter = norm.endsWith('.min.js') || norm.endsWith('.min.css') || norm.endsWith('.map') ||
                  (norm.endsWith('.css') && !cleanPrompt.includes('css') && !cleanPrompt.includes('style'));
              if (isClutter) score -= 5000;
              if (isJustAdded) score += 100000;
              if (isExplicitlyMentioned) score += 50000;
              if (isTargetProtected) score += 40000;
              if (isRecentlyAdded) score += 25000;
              if (recentTurns.includes(norm) || (baseName.length > 2 && recentTurns.includes(baseName))) score += 2000;
              if (norm.includes('main') || norm.includes('app') || norm.includes('types') || norm.includes('schema') || norm.includes('index')) score += 200;

              const bodyLower = (fb.rawContent || '').toLowerCase();
              for (const kw of promptKeywords) {
                  if (norm.includes(kw)) score += 1500;
                  if (bodyLower.includes(kw)) score += 300;
              }
              for (const kw of allKeywords) {
                  if (!promptKeywords.includes(kw) && norm.includes(kw)) score += 150;
              }

              return {
                  block: fb,
                  path: rawPath,
                  norm,
                  score,
                  tokens: toks,
                  mode: isStructure ? 'structure' : (isSymbols ? 'symbols' : 'full'),
                  isJustAdded,
                  isRecentlyAdded,
                  isExplicitlyMentioned,
                  isProtected: isTargetProtected,
                  muted: false
              };
          });

          const shrinkFileViaSymbolsOrStructure = async (cand: FileCandidate, allowProtected: boolean): Promise<boolean> => {
              if (cand.muted || cand.mode === 'structure' || !isProjectFile(cand.path)) return false;
              if (!allowProtected && (cand.isRecentlyAdded || cand.isProtected)) return false;

              const res = await this._contextManager.resolveWorkspaceFromPath(cand.path).catch(() => null);
              if (!res) return false;

              // If file is currently full, try symbol-scoped shrinking first (keep a few keyword-relevant symbols in full)
              if (cand.mode === 'full') {
                  try {
                      const symbols = await this._contextManager.extractSymbolList(res.uri);
                      if (symbols.length > 1 && promptKeywords.length > 0) {
                          const scoredSyms = symbols.map(s => {
                              const hay = `${s.name} ${s.detail || ''}`.toLowerCase();
                              let symScore = 0;
                              for (const kw of promptKeywords) {
                                  if (hay.includes(kw)) symScore += 10;
                              }
                              return { sym: s, symScore };
                          }).filter(item => item.symScore > 0)
                            .sort((a, b) => b.symScore - a.symScore || a.sym.tokens - b.sym.tokens);

                          if (scoredSyms.length > 0) {
                              const symRatio = pruningStrategy === 'aggressive' ? 0.25 : (pruningStrategy === 'permissive' ? 0.65 : 0.45);
                              const maxSyms = pruningStrategy === 'aggressive' ? 1 : (pruningStrategy === 'permissive' ? 6 : 3);
                              const maxSymBudget = Math.max(150, Math.floor(cand.tokens * symRatio));
                              const chosenSymbols: string[] = [];
                              let symTokSum = 0;
                              for (const item of scoredSyms) {
                                  if (chosenSymbols.length >= maxSyms) break;
                                  if (symTokSum + item.sym.tokens <= maxSymBudget || chosenSymbols.length === 0) {
                                      chosenSymbols.push(item.sym.name);
                                      symTokSum += item.sym.tokens;
                                  }
                              }

                              if (chosenSymbols.length > 0) {
                                  const symContent = await this._contextManager.extractDefinitionsAndSymbols(res.uri, chosenSymbols);
                                  const symBlock = `<!-- NOTE: Compacted to structure + key symbol implementations. Use <unmute_files>${cand.path}</unmute_files> for full file. -->\n<file path="${cand.path}" mode="symbols" symbols="${chosenSymbols.join(', ')}">\n${symContent}\n</file>

  \n\n`;
                                  const newTokens = Math.max(1, Math.ceil(symBlock.length / 3.5));
                                  if (newTokens < cand.tokens - 40) {
                                      const saved = cand.tokens - newTokens;
                                      cand.tokens = newTokens;
                                      cand.mode = 'symbols';
                                      cand.block.fullMatch = symBlock;
                                      filesTokens = Math.max(0, filesTokens - saved);
                                      totalEstimated = recalculateTotal();
                                      symbolsSavedTokens += saved;
                                      convertedToSymbols.push({ path: cand.path, symbols: chosenSymbols, savedTokens: saved });
                                      return true;
                                  }
                              }
                          }
                      }
                  } catch {}
              }

              // Fallback: convert to structure-only [D]
              try {
                  const defs = await this._contextManager.extractDefinitions(res.uri);
                  if (!defs || defs === '(No definitions found)' || defs === '(No significant definitions found)') {
                      return false;
                  }
                  const structureBlock = `<!-- NOTE: Full content converted to structure during context compression. To recover full content, use <unmute_files>${cand.path}</unmute_files> -->\n<file path="${cand.path}" mode="structure">\n${defs}\n</file>

  \n\n`;
                  const defTokens = Math.max(1, Math.ceil(structureBlock.length / 3.5));
                  if (defTokens < cand.tokens - 40) {
                      const saved = cand.tokens - defTokens;
                      cand.tokens = defTokens;
                      cand.mode = 'structure';
                      cand.block.fullMatch = structureBlock;
                      filesTokens = Math.max(0, filesTokens - saved);
                      totalEstimated = recalculateTotal();
                      structureSavedTokens += saved;
                      if (!convertedToStructure.some(s => s.path === cand.path)) {
                          convertedToStructure.push({ path: cand.path, savedTokens: saved });
                      }
                      return true;
                  }
              } catch {}

              return false;
          };

          const muteCandidate = (cand: FileCandidate) => {
              if (cand.muted) return false;
              cand.muted = true;
              filesTokens = Math.max(0, filesTokens - cand.tokens);
              totalEstimated = recalculateTotal();
              mutedSavedTokens += cand.tokens;
              mutedFilePaths.push({ path: cand.path, tokens: cand.tokens });
              return true;
          };

          // Proactive History Cap: Never let conversation history exceed historyMaxPercent (default 30%) without compressing
          if (historyTokens > historyBudgetTokens && activeHistory.length > 0) {
              await runHistoryCompression();
          }

          // Iterative verification loop: judge best bottleneck, shrink/compress, re-verify until under budget
          const MAX_PROTECTION_PASSES = 8;
          for (let pass = 0; pass < MAX_PROTECTION_PASSES && totalEstimated > targetBudget; pass++) {
              if (signal.aborted) break;
              let madeProgress = false;

              const isHistoryBottleneck = historyCompressedCount === 0 && historyTokens > 1000 &&
                  (pruningStrategy === 'permissive' || historyTokens > historyBudgetTokens || historyTokens >= filesTokens * 0.6 || historyTokens > Math.round(targetBudget * 0.35));
              const isTreeBloated = !treeReduced && (
                  (pruningStrategy === 'permissive' && treeTokens > 1500) ||
                  (treeTokens > Math.max(3000, Math.round(maxTokens * 0.15)) && treeTokens >= filesTokens * 0.35)
              );

              if (isHistoryBottleneck) {
                  madeProgress = await runHistoryCompression();
                  if (madeProgress) continue;
              }

              if (isTreeBloated) {
                  madeProgress = runTreeReduction();
                  if (madeProgress) continue;
              }

              // Tier A: Shrink cold non-protected files (symbol-scoped first, then structure-only)
              const shrinkPassA = candidateBlocks
                  .filter(c => !c.muted && c.mode !== 'structure' && !c.isRecentlyAdded && !c.isProtected)
                  .sort((a, b) => a.score - b.score || b.tokens - a.tokens);

              for (const cand of shrinkPassA) {
                  if (totalEstimated <= targetBudget) break;
                  if (await shrinkFileViaSymbolsOrStructure(cand, false)) {
                      madeProgress = true;
                  }
              }
              if (totalEstimated <= targetBudget) break;

              // Tier B: Compress remaining history & tree if not done yet
              if (historyCompressedCount === 0 && historyTokens > 1000 && activeHistory.length > 0) {
                  if (await runHistoryCompression()) {
                      madeProgress = true;
                      if (totalEstimated <= targetBudget) break;
                  }
              }
              if (!treeReduced && treeTokens > 1500) {
                  if (runTreeReduction()) {
                      madeProgress = true;
                      if (totalEstimated <= targetBudget) break;
                  }
              }

              // Tier C: Shrink previously added files (skipped in permissive mode unless over hard triggerBudget)
              const fileGoal = pruningStrategy === 'permissive' ? triggerBudget : targetBudget;
              if (totalEstimated > fileGoal) {
                  const shrinkPassPrev = candidateBlocks
                      .filter(c => !c.muted && c.mode !== 'structure' && c.isRecentlyAdded && !c.isProtected)
                      .sort((a, b) => a.score - b.score || b.tokens - a.tokens);

                  for (const cand of shrinkPassPrev) {
                      if (totalEstimated <= fileGoal) break;
                      if (await shrinkFileViaSymbolsOrStructure(cand, true)) {
                          madeProgress = true;
                      }
                  }
              }
              if (totalEstimated <= targetBudget) break;

              // Tier D: Mute cold non-protected/non-recently-added files first
              const mutePassA = candidateBlocks
                  .filter(c => !c.muted && !c.isRecentlyAdded && !c.isProtected)
                  .sort((a, b) => a.score - b.score || b.tokens - a.tokens);

              for (const cand of mutePassA) {
                  if (totalEstimated <= targetBudget) break;
                  if (muteCandidate(cand)) {
                      madeProgress = true;
                  }
              }
              if (totalEstimated <= targetBudget) break;

              // Tier D1: Mute previously added files (skipped in permissive mode unless over hard triggerBudget)
              if (totalEstimated > fileGoal) {
                  const mutePassPrev = candidateBlocks
                      .filter(c => !c.muted && c.isRecentlyAdded && !c.isProtected)
                      .sort((a, b) => a.score - b.score || b.tokens - a.tokens);

                  for (const cand of mutePassPrev) {
                      if (totalEstimated <= fileGoal) break;
                      if (muteCandidate(cand)) {
                          madeProgress = true;
                      }
                  }
              }
              if (totalEstimated <= targetBudget) break;

              // Tier E (Emergency Last Resort): If STILL over triggerBudget, shrink/mute remaining protected files (preserving just-added files last)
              if (totalEstimated > triggerBudget) {
                  const shrinkPassProtected = candidateBlocks
                      .filter(c => !c.muted && c.mode !== 'structure' && c.isProtected)
                      .sort((a, b) => Number(a.isJustAdded) - Number(b.isJustAdded) || a.score - b.score || b.tokens - a.tokens);

                  for (const cand of shrinkPassProtected) {
                      if (totalEstimated <= triggerBudget) break;
                      if (await shrinkFileViaSymbolsOrStructure(cand, true)) {
                          madeProgress = true;
                      }
                  }
                  if (totalEstimated <= triggerBudget) break;

                  const mutePassProtected = candidateBlocks
                      .filter(c => !c.muted && c.isProtected)
                      .sort((a, b) => Number(a.isJustAdded) - Number(b.isJustAdded) || a.score - b.score || b.tokens - a.tokens);

                  for (const cand of mutePassProtected) {
                      if (totalEstimated <= triggerBudget) break;
                      if (muteCandidate(cand)) {
                          madeProgress = true;
                      }
                  }
              }

              if (!madeProgress) break;
          }

          // Persist symbol-scoped, structure-only, and muted states cleanly
          const provider = this._contextManager.getContextStateProvider();
          for (const item of convertedToSymbols) {
              if (mutedFilePaths.some(mp => arePathsEqual(mp.path, item.path))) continue;
              await this.applySymbolBatchUpdate(item.path, item.symbols, [], 'replace', { skipTokenUpdate: true });
          }

          const finalStructureEntries = convertedToStructure.filter(entry =>
              !mutedFilePaths.some(mp => arePathsEqual(mp.path, entry.path)) &&
              !convertedToSymbols.some(s => arePathsEqual(s.path, entry.path))
          );
          const finalStructureOnlyPaths = finalStructureEntries.map(e => e.path);
          if (finalStructureOnlyPaths.length > 0) {
              await this.addFilesToDiscussionContext(finalStructureOnlyPaths, 'definitions-only');
              if (provider) {
                  const urisToUpdate: vscode.Uri[] = [];
                  for (const p of finalStructureOnlyPaths) {
                      const r = await this._contextManager.resolveWorkspaceFromPath(p);
                      if (r) {
                          urisToUpdate.push(r.uri);
                          this._contextManager.refreshFileInCache(r.uri);
                      }
                  }
                  if (urisToUpdate.length > 0) {
                      await provider.setStateForUris(urisToUpdate, 'definitions-only');
                  }
              }
          }

          if (mutedFilePaths.length > 0) {
              if (!this._currentDiscussion.mutedFiles) this._currentDiscussion.mutedFiles = [];
              for (const mp of mutedFilePaths) {
                  const cleanMp = mp.path.replace(/\\/g, '/').trim();
                  if (!this._currentDiscussion.mutedFiles.some(existing => arePathsEqual(existing, cleanMp))) {
                      this._currentDiscussion.mutedFiles.push(cleanMp);
                  }
              }
              this._discussionCapabilities.mutedFiles = [...this._currentDiscussion.mutedFiles];
              this._discussionManager.saveLastMutedFiles(this._currentDiscussion.mutedFiles).catch(() => {});
              this.contextStateProvider?.updateContextKeys();
          }

          if ((convertedToSymbols.length > 0 || finalStructureOnlyPaths.length > 0 || mutedFilePaths.length > 0 || historyCompressedCount > 0) && !this._currentDiscussion.id.startsWith('temp-')) {
              this._discussionManager.saveDiscussion(this._currentDiscussion).catch(() => {});
          }

          const compressionSummaryLines: string[] = [];
          if (compactedCodeBlocksCount > 0) {
              compressionSummaryLines.push(`- **Older Code Blocks Compacted**: Replaced ${compactedCodeBlocksCount} duplicate code block(s) in earlier assistant turns with references to active loaded files.`);
          }
          if (historyCompressedCount > 0) {
              compressionSummaryLines.push(`- **Conversation History Compressed**: Summarized ${historyCompressedCount} earlier message(s) up to the previous LLM response (~${historySavedTokens.toLocaleString()} tokens saved).`);
          }
          if (convertedToSymbols.length > 0) {
              const symList = convertedToSymbols.map(s => `\`${s.path}\` (kept: ${s.symbols.join(', ')}; saved ~${s.savedTokens.toLocaleString()} tok)`).join(', ');
              compressionSummaryLines.push(`- **Files Shrunk to Key Symbols [D+Symbols]** (~${symbolsSavedTokens.toLocaleString()} tokens saved): ${symList}. You can directly update any loaded symbol with \`action="update_symbol"\`.`);
          }
          if (finalStructureEntries.length > 0) {
              const structList = finalStructureEntries.map(e => `\`${e.path}\` (saved ~${e.savedTokens.toLocaleString()} tok)`).join(', ');
              compressionSummaryLines.push(`- **Files Converted to Structure-Only [D]** (~${structureSavedTokens.toLocaleString()} tokens saved): ${structList}.`);
          }
          if (mutedFilePaths.length > 0) {
              const mutedList = mutedFilePaths.map(m => `\`${m.path}\` (~${m.tokens.toLocaleString()} tok)`).join(', ');
              compressionSummaryLines.push(`- **Files Muted [M]** (~${mutedSavedTokens.toLocaleString()} tokens saved; paths kept in tree): ${mutedList}.`);
          }
          if (omittedFolders.length > 0) {
              const preview = omittedFolders.slice(0, 15).map(f => `\`${f}\``).join(', ');
              const extra = omittedFolders.length > 15 ? `, +${omittedFolders.length - 15} more` : '';
              compressionSummaryLines.push(`- **Project Tree Reduced** (~${treeSavedTokens.toLocaleString()} tokens saved): Omitted deep/cold folders (${preview}${extra}). Use \`<unpack_directory>\` or \`<grep>\` to inspect them.`);
          }

          const shrunkFilesList = Array.from(new Set([...convertedToSymbols.map(s => s.path), ...finalStructureOnlyPaths]));
          const mutedFilesList = Array.from(new Set(mutedFilePaths.map(m => m.path)));
          const allCutFilesList = Array.from(new Set([...shrunkFilesList, ...mutedFilesList]));

          let compressionReport: string | undefined = undefined;
          if (compressionSummaryLines.length > 0) {
              const phasedRuleLine = allCutFilesList.length > 0
                  ? `\n- **Optimize Your Context**: Current full context size is **~${totalEstimated.toLocaleString()} / ${maxTokens.toLocaleString()} tokens**. Please help keep context lean: mute/remove useless or finished files (\`<mute_files>\` / \`<remove_files_from_context>\`), or collapse large files into symbols (\`<manage_symbols path="..." activate="Sym1, Sym2" />\`) while keeping only the few symbols you need intact.`
                  : '';
              compressionReport = `Automated context compression ran before sending because context exceeded budget (${initialTotalTokens.toLocaleString()} → ${totalEstimated.toLocaleString()} est. tokens; model limit: ${maxTokens.toLocaleString()}):\n${compressionSummaryLines.join('\n')}${phasedRuleLine}`;
              this.log(`[Context Compression] ${compressionReport.replace(/\n/g, ' | ')}`, 'INFO');

              await this.addMessageToDiscussion({
                  id: `ctx_compression_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                  role: 'system',
                  content: `🗜️ **Context Compression Applied** (~${initialTotalTokens.toLocaleString()} → ~${totalEstimated.toLocaleString()} tokens / ${maxTokens.toLocaleString()} limit)\n${compressionSummaryLines.join('\n')}`,
                  skipInPrompt: true
              });
          }

          const newSelectedFilesContent = candidateBlocks
              .filter(c => !c.muted)
              .map(c => c.block.fullMatch)
              .join('\n\n');

          const prunedContext: ContextResult = {
              ...currentContext,
              projectTree: activeTreeText,
              selectedFilesContent: newSelectedFilesContent,
              compressionReport
          };

          setImmediate(() => {
              this.updateContextAndTokens({ isBackgroundSync: false });
          });

          return {
              contextData: prunedContext,
              history: activeHistory,
              cutFiles: allCutFilesList,
              shrunkFiles: shrunkFilesList,
              mutedFiles: mutedFilesList,
              exploded: initialTotalTokens > triggerBudget,
              initialTotalTokens,
              triggerBudget,
              maxTokens
          };
      }

    /**
   * Performs an automated, deep architectural scrutiny of the codebase
   * to build the complete, hierarchical KNOWLEDGE.md tree and section files.
   */
  public async handleScrutinizeKnowledgeTree() {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
          vscode.window.showErrorMessage("Active workspace required to synchronize knowledge graph.");
          return;
      }

      await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: `Lollms: Building ABox & Syncing Knowledge Graph (${folder.name})...`,
          cancellable: true
      }, async (progress) => {
          try {
              if (this._codeGraphManager) {
                  this._codeGraphManager.setWorkspaceRoot(folder.uri);
                  this._codeGraphManager.reset(); // Clear stale cache to force complete fresh parse
                  await this._codeGraphManager.buildGraph(undefined, (p) => {
                      progress.report({ message: `AST Parse: ${p.status} (${p.percentage}%)` });
                  });
              }

              const { KnowledgeManager } = require('../../knowledgeManager');
              const km = new KnowledgeManager(this._discussionManager.context);
              if (this._codeGraphManager) {
                  progress.report({ message: 'Synchronizing ABox assertions and tagging disjoint functions...' });
                  await km.syncCodeGraph(this._codeGraphManager.getGraphData().nodes, this._codeGraphManager.getGraphData().edges, folder);
              }

              const rendered = await km.renderContextKnowledge(folder);
              const graphData = await km.getHighLevelGraphElements(folder);

              this._panel.webview.postMessage({
                  command: 'updateKnowledgeContent',
                  knowledge: rendered
              });

              this._panel.webview.postMessage({
                  command: 'updateKnowledgeGraphData',
                  elements: graphData
              });

              this.updateContextAndTokens({ isBackgroundSync: false });

              vscode.window.showInformationMessage(
                  `✅ Knowledge Graph ABox populated (${graphData.nodes.length} nodes, ${graphData.edges.length} relationships in knowledge.ttl)!`,
                  "Open knowledge.ttl"
              ).then(sel => {
                  if (sel === "Open knowledge.ttl") {
                      vscode.commands.executeCommand('lollms-vs-coder.openKnowledgeRoot');
                  }
              });
          } catch (err: any) {
              vscode.window.showErrorMessage(`Knowledge Graph sync error: ${err.message}`);
          }
      });
  }

  public async handleCreateCustomExternalFile(fileName: string, content: string): Promise<void> {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
          vscode.window.showErrorMessage("Active workspace required to create external content.");
          return;
      }

      this._panel.webview.postMessage({
          command: 'setGeneratingState',
          isGenerating: true,
          statusText: 'Saving custom external file...'
      });
      this._panel.webview.postMessage({
          command: 'tokenCalculationStarted',
          text: 'Saving external content & updating tokens...'
      });

      const targetDir = vscode.Uri.joinPath(workspaceFolder.uri, '.lollms', 'external_files');
      await vscode.workspace.fs.createDirectory(targetDir).then(undefined, () => {});

      let safeName = fileName.replace(/\\/g, '/').trim();
      safeName = path.basename(safeName).replace(/[^a-zA-Z0-9._-]/g, '_');
      if (!safeName.includes('.')) {
          safeName += '.md';
      }

      const fileUri = vscode.Uri.joinPath(targetDir, safeName);
      const relPath = path.join('.lollms', 'external_files', safeName).replace(/\\/g, '/');

      try {
          const gateRes = await this._contextManager.evaluateWithPoisoningGate(content, `custom://${safeName}`, {
              capabilities: this._discussionCapabilities
          });
          if (gateRes.verdict === 'blocked') {
              vscode.window.showWarningMessage(gateRes.reason || `Blocked custom external content '${safeName}' at Context Poisoning Gate.`);
              return;
          }
          const finalContent = gateRes.sanitizedContent;

          await vscode.workspace.fs.writeFile(fileUri, Buffer.from(finalContent, 'utf8'));

          await this.unmuteFiles([relPath]);
          await this.addFilesToDiscussionContext([relPath]);
          await this._contextManager.getContextStateProvider()?.addFilesToContext([relPath]);
          this._contextManager.recordRecentlyAddedFiles([relPath]);
          this.recordCurrentPromptFiles([relPath]);

          try {
              const toks = Math.max(1, Math.ceil(content.length / 3.5));
              const compHash = `${content.length}_${Date.now()}`;
              await this._contextManager.setCachedTokens(relPath, compHash, toks);
          } catch {}

          vscode.window.showInformationMessage(`✅ Added '${safeName}' to External & Research (.lollms/external_files).`);
      } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to save external content: ${err.message}`);
      } finally {
          this._panel.webview.postMessage({ command: 'setGeneratingState', isGenerating: false });
          await this.updateContextAndTokens({ isBackgroundSync: false });
      }
  }

  public async handleRequestAddExternalFileLink() {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
          vscode.window.showErrorMessage("Active workspace required to link external files.");
          return;
      }

      const uris = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: 'Link as Read-Only Reference',
          title: 'Select External File(s) to Link as Live Reference (Read-Only)',
          filters: {
              'Documents & Code': ['md', 'txt', 'pdf', 'docx', 'py', 'ts', 'js', 'json', 'yaml', 'yml', 'html', 'css', 'cpp', 'c', 'cs', 'java', 'rs', 'go', 'rst'],
              'All Files': ['*']
          }
      });

      if (!uris || uris.length === 0) return;

      this._panel.webview.postMessage({
          command: 'setGeneratingState',
          isGenerating: true,
          statusText: 'Linking external live reference files...'
      });
      this._panel.webview.postMessage({
          command: 'tokenCalculationStarted',
          text: 'Linking external reference files...'
      });

      let linkedCount = 0;
      const relativePathsAdded: string[] = [];

      for (const uri of uris) {
          try {
              const livePath = await this._contextManager.addExternalLink(uri, workspaceFolder);
              relativePathsAdded.push(livePath);
              linkedCount++;
          } catch (err: any) {
              vscode.window.showErrorMessage(`Failed to link ${path.basename(uri.fsPath)}: ${err.message}`);
          }
      }

      if (relativePathsAdded.length > 0) {
          await this.unmuteFiles(relativePathsAdded);
          await this.addFilesToDiscussionContext(relativePathsAdded);
          this.recordCurrentPromptFiles(relativePathsAdded);
          vscode.window.showInformationMessage(`🔗 Linked ${linkedCount} external file(s) as live read-only reference.`);
      }

      this._panel.webview.postMessage({ command: 'setGeneratingState', isGenerating: false });
      this.updateContextAndTokens({ isBackgroundSync: false });
  }

  public async handleRequestAddExternalFile() {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
          vscode.window.showErrorMessage("Active workspace required to add external files.");
          return;
      }

      const uris = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: 'Import to .lollms/external_files',
          title: 'Import External Documents (PDF, DOCX, TXT, MD, etc.)',
          filters: {
              'Documents & Text': ['pdf', 'docx', 'txt', 'md', 'rst', 'html', 'htm', 'json', 'yaml', 'yml', 'csv', 'tsv', 'xlsx', 'pptx', 'odt', 'rtf', 'py', 'js', 'ts'],
              'PDF Documents': ['pdf'],
              'Word Documents': ['docx', 'odt', 'rtf'],
              'Text Files': ['txt', 'md', 'rst', 'json', 'yaml', 'yml', 'csv'],
              'All Files': ['*']
          }
      });

      if (!uris || uris.length === 0) return;

      this._panel.webview.postMessage({
          command: 'setGeneratingState',
          isGenerating: true,
          statusText: 'Importing external documents into .lollms/external_files...'
      });

      const targetDir = vscode.Uri.joinPath(workspaceFolder.uri, '.lollms', 'external_files');
      await vscode.workspace.fs.createDirectory(targetDir).then(undefined, () => {});

      let importedCount = 0;
      const relativePathsAdded: string[] = [];

      for (const uri of uris) {
          try {
              const fileName = path.basename(uri.fsPath);
              const ext = path.extname(uri.fsPath).toLowerCase();
              const fileBytes = await vscode.workspace.fs.readFile(uri);
              const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');

              let targetFileName = safeName;
              let textToSave = "";

              if (['.pdf', '.docx', '.odt', '.rtf', '.xlsx', '.pptx'].includes(ext)) {
                  const base64 = Buffer.from(fileBytes).toString('base64');
                  textToSave = await this._contextManager.processFile(fileName, base64, [], 'text');
                  targetFileName = safeName.replace(/\.[^.]+$/, '') + '.md';
              } else {
                  textToSave = Buffer.from(fileBytes).toString('utf8');
              }

              const gateRes = await this._contextManager.evaluateWithPoisoningGate(textToSave, `external-file://${fileName}`, {
                  capabilities: this._discussionCapabilities
              });
              if (gateRes.verdict === 'blocked') {
                  vscode.window.showWarningMessage(gateRes.reason || `Blocked '${fileName}' at Context Poisoning Gate.`);
                  continue;
              }
              textToSave = gateRes.sanitizedContent;

              const targetUri = vscode.Uri.joinPath(targetDir, targetFileName);
              await vscode.workspace.fs.writeFile(targetUri, Buffer.from(textToSave, 'utf8'));

              const relPath = path.join('.lollms', 'external_files', targetFileName).replace(/\\/g, '/');
              relativePathsAdded.push(relPath);
              importedCount++;
          } catch (err: any) {
              Logger.error(`Failed to import external file ${uri.fsPath}: ${err.message}`);
              vscode.window.showErrorMessage(`Failed to import ${path.basename(uri.fsPath)}: ${err.message}`);
          }
      }

      if (relativePathsAdded.length > 0) {
          await this.unmuteFiles(relativePathsAdded);
          await this.addFilesToDiscussionContext(relativePathsAdded);
          await this._contextManager.getContextStateProvider()?.addFilesToContext(relativePathsAdded);
          this._contextManager.recordRecentlyAddedFiles(relativePathsAdded);
          this.recordCurrentPromptFiles(relativePathsAdded);
          vscode.window.showInformationMessage(`✅ Imported ${importedCount} document(s) into .lollms/external_files.`);
      }

      this._panel.webview.postMessage({ command: 'setGeneratingState', isGenerating: false });
      await this.updateContextAndTokens({ isBackgroundSync: false });
  }

  public async handleGenerateInterProjectPrompt(params: {
      request?: string;
      mode?: 'integration' | 'inspiration' | 'migration';
      targetProject?: string;
      model?: string;
      options?: {
          includeActiveFiles?: boolean;
          includeArchitecture?: boolean;
          includeBriefing?: boolean;
          includeHistory?: boolean;
      };
  }): Promise<void> {
      if (this._isDisposed || !this._panel?.webview) return;

      const userRequest = String(params?.request || '').trim();
      if (!userRequest) {
          this._panel.webview.postMessage({
              command: 'interProjectPromptResult',
              success: false,
              error: 'Prompt description cannot be empty.'
          });
          return;
      }

      if (this._activeInterProjectController) {
          this._activeInterProjectController.abort();
      }
      this._activeInterProjectController = new AbortController();
      const signal = this._activeInterProjectController.signal;

      const proc = this.processManager.register(this.discussionId, 'Generating Inter-Project Prompt...');
      const processId = proc.id;
      proc.controller.signal.addEventListener('abort', () => {
          if (this._activeInterProjectController) {
              this._activeInterProjectController.abort();
          }
      });

      const targetModel = params?.model || this._currentDiscussion?.model || this._lollmsAPI.getModelName();
      const mode = params?.mode || 'integration';
      const targetProject = String(params?.targetProject || '').trim();
      const opts = params?.options || {};
      const includeActiveFiles = opts.includeActiveFiles !== false;
      const includeArchitecture = opts.includeArchitecture !== false;
      const includeBriefing = opts.includeBriefing !== false;
      const includeHistory = opts.includeHistory === true;

      let fullText = '';

      try {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          const sourceProjectName = workspaceFolder?.name || 'Source Project';
          const sourceRootPath = workspaceFolder?.uri.fsPath || '';

          const contextData = await this._contextManager.getContextContent({
              importedSkillIds: this._currentDiscussion?.importedSkills || [],
              includeTree: true,
              discussionId: this.discussionId,
              mutedFiles: this._currentDiscussion?.mutedFiles || [],
              modelName: targetModel,
              signal,
              capabilities: this._discussionCapabilities
          });

          if (signal.aborted) {
              this._panel.webview.postMessage({ command: 'interProjectPromptResult', success: false, cancelled: true, fullText });
              return;
          }

          const sections: string[] = [];
          sections.push(`- **Source Project**: \`${sourceProjectName}\`${sourceRootPath ? ` (\`${sourceRootPath}\`)` : ''}`);
          if (targetProject) {
              sections.push(`- **Target Project / Stack**: ${targetProject}`);
          }

          if (contextData.projectTree) {
              sections.push(`### 🌳 SOURCE PROJECT STRUCTURE\n${contextData.projectTree}`);
          }

          if (includeActiveFiles && contextData.selectedFilesContent) {
              sections.push(`### 📄 SOURCE PROJECT LOADED FILES\n${contextData.selectedFilesContent}`);
          }

          if (includeArchitecture) {
              const graphSummary = this._codeGraphManager?.getGraphData?.()?.nodes?.length > 0
                  ? this._codeGraphManager.generateTextSummary()
                  : '';
              const structureGuide = await this._contextManager.getStructureGuide();
              if (graphSummary) {
                  sections.push(`### 🗺️ CODE ARCHITECTURE GRAPH SUMMARY\n${graphSummary.substring(0, 12000)}`);
              }
              if (structureGuide) {
                  sections.push(`### 🏛️ ARCHITECTURE & KNOWLEDGE GUIDE\n${structureGuide.substring(0, 8000)}`);
              }
          }

          if (includeBriefing) {
              const briefing = this._contextManager.renderBriefing(this._currentDiscussion);
              if (briefing) {
                  sections.push(`### 🎯 MISSION BRIEFING & PROJECT CONVENTIONS\n${briefing}`);
              }
          }

          if (includeHistory && this._currentDiscussion?.messages?.length) {
              const recentHistory = this._currentDiscussion.messages
                  .filter(m => !m.skipInPrompt && m.role !== 'system')
                  .slice(-8)
                  .map(m => {
                      const clean = this.sanitizeMessageContentForPrompt(m.content);
                      const txt = typeof clean === 'string' ? clean : (Array.isArray(clean) ? clean.map((p: any) => p.text || '').join('\n') : '');
                      return txt ? `**${m.role.toUpperCase()}**:\n${txt.substring(0, 2000)}` : '';
                  })
                  .filter(Boolean)
                  .join('\n\n');
              if (recentHistory) {
                  sections.push(`### 🕒 RELEVANT RECENT DISCUSSION CONTEXT\n${recentHistory}`);
              }
          }

          const modeDirective = mode === 'inspiration'
              ? `The target agent works in a SEPARATE project that wants to **get inspired by and adapt patterns, architecture, or mechanisms** from \`${sourceProjectName}\`. Distill the exact design patterns, state flows, invariants, and concrete implementation blueprints from the source project so the target agent can build an idiomatic version in its own codebase.`
              : mode === 'migration'
                  ? `The target agent works in a SEPARATE project that needs to **synchronize contracts, schemas, or migrate capabilities** with \`${sourceProjectName}\`. Detail exact schema mappings, breaking invariants, and step-by-step alignment instructions.`
                  : `The target agent works in a SEPARATE project that **uses or integrates with** \`${sourceProjectName}\`. Provide exact APIs, entry points, types, message/wire formats, configuration requirements, and step-by-step integration instructions.`;

          const systemPrompt = `You are a Principal Cross-Project Software Architect.
Your task is to write a **complete, self-contained Master Prompt & Technical Handoff Document** addressed directly to an AI coding agent working inside ANOTHER project/repository.

### 🎯 PURPOSE
${modeDirective}

### 🛡️ STRICT GROUNDING & QUALITY RULES
1. **THE TARGET AGENT CANNOT SEE THIS REPOSITORY**: You must include every relevant contract, interface, type signature, endpoint, message schema, protocol rule, and architectural invariant explicitly inside the generated document.
2. **ZERO HALLUCINATION**: Only cite file paths, symbol names, endpoints, config keys, and behaviors explicitly observed in the provided \`${sourceProjectName}\` context.
3. **DIRECTLY ACTIONABLE FOR AN AI AGENT**: Write in second-person imperative ("You are working in...", "Implement...", "Verify...") so the user can copy-paste your entire output straight into the other project's AI agent chat.
4. **REQUIRED DOCUMENT STRUCTURE**:
   - **# 🤖 Cross-Project Agent Handoff Prompt** (Role, Mission Objective, and Relationship to \`${sourceProjectName}\`)
   - **## 1. Source Project Contracts & Reference Architecture** (Exact APIs, types, protocols, file references, and key code/schema excerpts from \`${sourceProjectName}\`)
   - **## 2. Step-by-Step Implementation Guide** (Ordered, concrete implementation tasks for the target agent)
   - **## 3. Edge Cases, Security & Invariants** (Error handling, validation rules, and pitfalls to avoid)
   - **## 4. Verification Checklist** (Concrete checks/tests the target agent should run after implementing)
5. Output ONLY the Markdown document itself with no outer conversational preamble.`;

          const userMessage = `### 🧭 USER'S CROSS-PROJECT REQUEST
"${userRequest}"
${targetProject ? `\n**Target Project / Stack**: ${targetProject}` : ''}
**Mode**: ${mode.toUpperCase()}

---

### 📦 SOURCE PROJECT GROUND TRUTH (${sourceProjectName})
${sections.join('\n\n')}`;

          let lastPostTime = 0;
          const THROTTLE_MS = 80;

          const response = await this._lollmsAPI.sendChat(
              [
                  { role: 'system', content: systemPrompt },
                  { role: 'user', content: userMessage }
              ],
              (chunk) => {
                  if (signal.aborted) return;
                  fullText += chunk;
                  const now = Date.now();
                  if (now - lastPostTime >= THROTTLE_MS) {
                      lastPostTime = now;
                      this._panel.webview.postMessage({
                          command: 'interProjectPromptChunk',
                          chunk,
                          fullText
                      });
                  }
              },
              signal,
              targetModel,
              { thinking: false }
          );

          const finalOutput = stripThinkingTags(fullText || response).trim();
          this._panel.webview.postMessage({
              command: 'interProjectPromptResult',
              success: true,
              fullText: finalOutput
          });
      } catch (err: any) {
          const isAborted = signal.aborted || err?.name === 'AbortError' || err?.message === 'AbortError' || err?.message === 'Operation cancelled';
          this._panel.webview.postMessage({
              command: 'interProjectPromptResult',
              success: false,
              cancelled: isAborted,
              error: isAborted ? undefined : (err?.message || String(err)),
              fullText: stripThinkingTags(fullText).trim()
          });
      } finally {
          this.processManager.unregister(processId);
          this._activeInterProjectController = null;
      }
  }

  public async auditFileDiagnostics(filePath: string, messageId?: string, blockIndex?: number, blockId?: string, signal?: AbortSignal) {
      if (this._isDisposed || !this._panel || !this._panel.webview || signal?.aborted) return;
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) return;

      const resolution = await this._contextManager.resolveWorkspaceFromPath(filePath);
      if (!resolution || signal?.aborted) return;

      this._diagnosticWatchUris.add(resolution.uri.fsPath);

      // Brief delay allows language server (tsserver, pyright) to evaluate new disk content
      await new Promise(r => setTimeout(r, 200));
      if (this._isDisposed || signal?.aborted) return;

      const diags = vscode.languages.getDiagnostics(resolution.uri);
      const errors = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
      const warnings = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Warning);
      const allReportable = [...errors, ...warnings];

      const doc = await Promise.resolve(vscode.workspace.openTextDocument(resolution.uri)).catch(() => null);

      const errorDetails = allReportable.map(e => ({
          line: e.range.start.line + 1,
          character: e.range.start.character + 1,
          message: e.message,
          severity: e.severity,
          source: e.source || '',
          code: typeof e.code === 'object' ? String(e.code.value) : (e.code !== undefined ? String(e.code) : ''),
          snippet: doc ? doc.lineAt(Math.min(e.range.start.line, doc.lineCount - 1)).text.trim() : ''
      }));

      this._panel.webview.postMessage({
          command: 'fileDiagnosticsReport',
          filePath,
          messageId,
          blockIndex,
          blockId,
          errorsCount: errors.length,
          warningsCount: warnings.length,
          totalDiagnosticsCount: allReportable.length,
          errors: errorDetails
      });
  }

  public async executeFileRepairPass(
      filePath: string,
      userPromptHint?: string,
      round: number = 1,
      clientKnownErrors: any[] = [],
      modelOverride?: string,
      temperature?: number,
      reasoningEffort: 'none' | 'low' | 'medium' | 'high' | 'max' = 'none',
      maxRoundsOverride?: number
  ) {
      if (this._isDisposed || !this._panel || !this._panel.webview) return;
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) return;

      const resolution = await this._contextManager.resolveWorkspaceFromPath(filePath);
      if (!resolution) return;

      const maxRounds = maxRoundsOverride || vscode.workspace.getConfiguration('lollmsVsCoder').get<number>('fileRepairStudioMaxRounds', 20) || 20;

      if (this._activeRepairController) {
          this._activeRepairController.abort();
      }
      this._activeRepairController = new AbortController();
      const signal = this._activeRepairController.signal;

      let doc: vscode.TextDocument;
      let currentFileContent = "";
      let docLang = "plaintext";
      try {
          doc = await vscode.workspace.openTextDocument(resolution.uri);
          currentFileContent = doc.getText();
          docLang = doc.languageId;
      } catch (err: any) {
          vscode.window.showErrorMessage(`Cannot read file for repair: ${err.message}`);
          return;
      }

      // Re-read latest diagnostics from VS Code, prioritizing explicitly targeted errors
      const diags = vscode.languages.getDiagnostics(resolution.uri);
      const activeErrors = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
      const targetErrors = (clientKnownErrors && clientKnownErrors.length > 0)
          ? clientKnownErrors
          : (activeErrors.length > 0 ? activeErrors : diags);

      const fileName = path.basename(filePath);
      const proc = this.processManager.register(
          this.discussionId,
          `Repairing ${fileName} (Round ${round}/${maxRounds}): ${targetErrors.length} error(s)...`
      );
      const processId = proc.id;
      proc.controller.signal.addEventListener('abort', () => {
          if (this._activeRepairController) {
              this._activeRepairController.abort();
          }
      });

      // Helper to extract surrounding context window around an error line
      const getContextWindow = (document: vscode.TextDocument, errorLine: number, windowSize: number = 6): string => {
          const totalLines = document.lineCount;
          const startLine = Math.max(1, errorLine - windowSize);
          const endLine = Math.min(totalLines, errorLine + windowSize);
          const lines: string[] = [];

          for (let l = startLine; l <= endLine; l++) {
              const text = document.lineAt(l - 1).text;
              const isErrorLine = (l === errorLine);
              const prefix = isErrorLine ? '-> ' : '   ';
              const lineNumStr = String(l).padStart(4, ' ');
              lines.push(`${prefix}${lineNumStr} | ${text}`);
          }
          return lines.join('\n');
      };

      const errorReportLines = targetErrors.map((e: any, idx: number) => {
          const lNum = typeof e.line === 'number' ? e.line : (e.range ? e.range.start.line + 1 : 1);
          const colNum = typeof e.character === 'number' ? e.character : (e.range ? e.range.start.character + 1 : 1);
          const msg = e.message || String(e);
          const src = e.source ? ` [${e.source}]` : '';
          const windowText = doc ? getContextWindow(doc, lNum, 5) : (e.snippet || '');
          const startL = Math.max(1, lNum - 5);
          const endL = doc ? Math.min(doc.lineCount, lNum + 5) : lNum + 5;

          return `${idx + 1}. [Line ${lNum}:${colNum}]${src} (${e.criticality ? String(e.criticality).toUpperCase() : 'ERROR'}) ${msg}\n   Context around issue (lines ${startL}–${endL}):\n   \`\`\`${docLang}\n${windowText}\n   \`\`\``;
      }).join('\n\n');

      const isPy = docLang === 'python';
      const langRule = isPy
          ? "This is Python. Ensure indentation levels (spaces vs tabs) strictly match the file nesting."
          : `Target language is ${docLang}. Ensure valid syntax, brackets, and correct import statements.`;

      const aSearch = '<<<<<<<' + ' SEARCH';
      const aSep = '=======' + '';
      const aReplace = '>>>>>>>' + ' REPLACE';

      const systemPrompt = `You are the Senior Linter & Diagnostic Repair Architect (Guardian Protocol).
Your task is to inspect the reported language server compiler/linter errors in \`${filePath}\` and generate surgical code repairs to make the file 100% clean.

### 🛡️ STRICT REPAIR CONSTITUTION:
1. **SINGLE-FILE EDITING BOUNDARY (MANDATORY)**:
   - You can ONLY modify \`${filePath}\`. You are strictly forbidden from modifying other files.
   - All code patches must apply directly to \`${filePath}\`.
2. ${langRule}
3. **DO NOT COUNT LINES (CRITICAL)**:
   - Use the code context window provided with each error to locate the code directly. Never count lines.
4. **READ-ONLY SCOUTING OF OTHER FILES**:
   You can scout other files to check imports, signatures, or contracts using:
   - \`<peek_files path="path/to/other.ts" lines="30" from="top" />\`
   - \`<grep pattern="symbolName" path="src" />\`
   - \`<show_symbol target="path/to/other.ts:SymbolName" />\`
   - \`<read_full_file path="path/to/other.ts" />\`
5. **EXTERNAL ROOT-CAUSE PROTOCOL**:
   If an error fundamentally belongs to an external file:
   - Make a safe, clean accommodation in \`${filePath}\` if possible.
   - Clearly state that the root cause is external and propose a ready-to-use prompt for the main discussion:
     ### 📋 PROPOSED PROMPT FOR MAIN DISCUSSION:
     \`\`\`markdown
     [Prompt describing external file and needed changes]
     \`\`\`
6. **SURGICAL CODE DELIVERY**:
   Output very short, focused AIDER SEARCH/REPLACE blocks (1-5 lines of change):
\`\`\`${docLang}:${filePath}
${aSearch}
[exact lines currently on disk]
${aSep}
[corrected lines with imports/fixes]
${aReplace}
\`\`\`
Or use targeted symbol replacement: \`<file path="${filePath}" action="update_symbol" symbol="SymbolName">...</file>\`
7. Provide a brief 1-2 sentence explanation of what was fixed outside code blocks.`;

      const userMessageText = `### 🔍 COMPILER / LINTER ERRORS DETECTED IN \`${filePath}\` (Round ${round}):
${errorReportLines || 'No active errors listed. Verify syntax.'}

${userPromptHint ? `### 👤 USER INSTRUCTIONS / HINTS:\n"${userPromptHint}"\n` : ''}
> ⚠️ **NO LINE COUNTING**: Locate the code directly using the snippets and variable names above. Do NOT count lines.

### 📄 CURRENT CODE ON DISK (\`${filePath}\`):
\`\`\`${docLang}
${currentFileContent}
\`\`\`

Generate the surgical fix to resolve these errors.`;

      const config = vscode.workspace.getConfiguration('lollmsVsCoder');
      const targetModel = modelOverride || config.get<string>('surgicalModelName') || this._currentDiscussion?.model || this._lollmsAPI.getModelName();
      const roundMsgId = `repair_chunk_${round}_${Date.now()}`;
      let streamBuffer = "";

      try {
          let lastPostTime = 0;
          const THROTTLE_MS = 80;

          const response = await this._lollmsAPI.sendChat([
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userMessageText }
          ], (chunk) => {
              if (signal.aborted) return;
              streamBuffer += chunk;
              const now = Date.now();
              if (now - lastPostTime >= THROTTLE_MS) {
                  lastPostTime = now;
                  this._panel.webview.postMessage({
                      command: 'repairStreamChunk',
                      round,
                      maxRounds,
                      chunk,
                      fullText: streamBuffer,
                      messageId: roundMsgId
                  });
              }
          }, signal, targetModel, { 
              thinking: reasoningEffort !== 'none', 
              reasoningEffort: reasoningEffort,
              temperature: temperature
          });

          // Flush final buffer
          this._panel.webview.postMessage({
              command: 'repairStreamChunk',
              round,
              maxRounds,
              chunk: '',
              fullText: streamBuffer,
              messageId: roundMsgId
          });

          const cleanResponse = stripThinkingTags(response).trim();

          if (signal.aborted) {
              return;
          }

          const normalizedPatch = normalizeAiderContent(cleanResponse);
          const applyRes: any = await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', filePath, normalizedPatch, this, roundMsgId, { silent: true, autoSave: true });

          const freshDoc = await vscode.workspace.openTextDocument(resolution.uri);
          const newDiskContent = freshDoc.getText();

          await new Promise(r => setTimeout(r, 800));

          const freshDiags = vscode.languages.getDiagnostics(resolution.uri);
          const remainingErrors = freshDiags.filter(d => d.severity === vscode.DiagnosticSeverity.Error);

          const remainingDetails = remainingErrors.map(e => ({
              line: e.range.start.line + 1,
              character: e.range.start.character + 1,
              message: e.message,
              source: e.source || '',
              code: typeof e.code === 'object' ? String(e.code.value) : (e.code !== undefined ? String(e.code) : ''),
              snippet: freshDoc.lineAt(Math.min(e.range.start.line, freshDoc.lineCount - 1)).text.trim()
          }));

          const resolvedCount = Math.max(0, targetErrors.length - remainingErrors.length);

          const updatedErrorsWithFixed = (clientKnownErrors || []).map((ke: any) => {
              const stillPresent = remainingErrors.some(re => 
                  re.message === ke.message || Math.abs((re.range.start.line + 1) - ke.line) <= 5
              );
              return {
                  ...ke,
                  isFixed: !stillPresent
              };
          });

          this._panel.webview.postMessage({
              command: 'fileRepairPassResult',
              filePath,
              round,
              maxRounds,
              patchApplied: applyRes?.success ?? true,
              patchedContent: newDiskContent,
              errorsRemaining: remainingErrors.length,
              errors: updatedErrorsWithFixed.length > 0 ? updatedErrorsWithFixed : remainingDetails,
              resolvedCount,
              llmExplanation: cleanResponse.replace(/```[\s\S]*?```/g, '').trim()
          });

          this.auditFileDiagnostics(filePath);

      } catch (err: any) {
          if (signal.aborted || err.name === 'AbortError' || err.message === 'AbortError') {
              this._panel.webview.postMessage({
                  command: 'fileRepairPassResult',
                  filePath,
                  round,
                  maxRounds,
                  patchApplied: false,
                  errorsRemaining: -1,
                  cancelled: true,
                  errors: clientKnownErrors,
                  resolvedCount: 0,
                  llmExplanation: "Repair pass stopped by user."
              });
              return;
          }
          Logger.error(`Repair pass failed: ${err.message}`);
          this._panel.webview.postMessage({
              command: 'fileRepairPassResult',
              filePath,
              round,
              maxRounds,
              patchApplied: false,
              errorsRemaining: targetErrors.length,
              errors: clientKnownErrors,
              resolvedCount: 0,
              llmExplanation: `Repair pass encountered an error: ${err.message}`
          });
      } finally {
          this.processManager.unregister(processId);
          this.updateGeneratingState();
          this._activeRepairController = null;
      }
  }

  private async copySystemPromptToClipboard() {
      this._panel.webview.postMessage({ command: 'setGeneratingState', isGenerating: true, statusText: 'Assembling system prompt...' });

      await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: "Lollms: Preparing system prompt...",
          cancellable: false
      }, async (progress) => {
          try {
              const config = vscode.workspace.getConfiguration('lollmsVsCoder');
              const forceFullCode = config.get<boolean>('forceFullCodePath') || false;
              const importedIds = this._currentDiscussion?.importedSkills || [];
              
              const exportMutedFiles = this._currentDiscussion?.mutedFiles || this._discussionCapabilities?.mutedFiles || [];
              const exportCapabilities: DiscussionCapabilities = {
                  ...this._discussionCapabilities,
                  agentMode: false,
                  dynamicMode: false,
                  sparqlEnabled: false,
                  webSearch: false,
                  projectMemoryEnabled: false,
                  enableImages: false,
                  isExport: true,
                  mutedFiles: exportMutedFiles
              };

              progress.report({ message: "Reading context..." });
              const contextData = await this._contextManager.getContextContent({ 
                  importedSkillIds: importedIds,
                  mutedFiles: exportMutedFiles,
                  modelName: this._currentDiscussion?.model || this._lollmsAPI.getModelName(),
                  capabilities: exportCapabilities
              });
              
              const context = {
                  tree: contextData?.projectTree || '',
                  files: contextData?.selectedFilesContent || '',
                  skills: contextData?.skillsContent || '',
                  toolManager: this.agentManager?.['toolManager']
              };

              progress.report({ message: "Generating Persona..." });
              const personaContent = this.getCurrentPersonaSystemPrompt();
              const exportContext = {
                  ...context,
                  governorReport: (contextData as any)?.governorReport || await this._contextManager.getStructureGuide(),
                  toolManager: undefined
              };
              const systemPrompt = await getProcessedSystemPrompt('chat', exportCapabilities, personaContent, undefined, forceFullCode, exportContext);


              await vscode.env.clipboard.writeText(systemPrompt);
              vscode.window.showInformationMessage("✅ System prompt (with context) copied to clipboard.");
          } catch (e: any) {
              vscode.window.showErrorMessage(`Failed to copy system prompt: ${e.message}`);
          } finally {
              this._panel.webview.postMessage({ command: 'setGeneratingState', isGenerating: false });
          }
      });
  }
  
  public async handleBulkSummarizeContextFiles(files: string[], instruction: string) {
      if (!vscode.workspace.workspaceFolders || files.length === 0) return;
      
      const processor = new BigDataProcessor(this._lollmsAPI);
      const workspaceFolder = vscode.workspace.workspaceFolders[0];

      await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: `Bulk processing files...`,
          cancellable: true
      }, async (progress, token) => {
          let processedCount = 0;
          for (let i = 0; i < files.length; i++) {
              if (token.isCancellationRequested) break;
              
              const relativePath = files[i];
              const uri = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);
              
              progress.report({ 
                  message: `Processing (${i + 1}/${files.length}): ${path.basename(relativePath)}`
              });

              try {
                  const result = await processor.processFile(uri, instruction, undefined, token);
                  if (result) {
                      await vscode.workspace.fs.writeFile(uri, Buffer.from(result, 'utf8'));
                      processedCount++;
                  }
              } catch (e: any) {
                  console.error(`Failed to process ${relativePath}: ${e.message}`);
                  vscode.window.showWarningMessage(`Failed to process ${relativePath}: ${e.message}`);
              }
          }
          
          this.updateContextAndTokens();
          if (processedCount > 0) {
              vscode.window.showInformationMessage(`Bulk processing complete. Updated ${processedCount} files.`);
          }
      });
  }

  public async handleBulkRemoveSkills(skillIds: string[]) {
      if (!this._currentDiscussion || !skillIds || skillIds.length === 0) return;

      const confirm = await vscode.window.showWarningMessage(
          vscode.l10n.t("prompt.confirmBulkRemoveSkills", skillIds.length),
          { modal: true },
          vscode.l10n.t("label.removeAll")
      );

      if (confirm === vscode.l10n.t("label.removeAll")) {
          this._currentDiscussion.importedSkills = (this._currentDiscussion.importedSkills || [])
              .filter(id => !skillIds.includes(id));

          // Also remove from project global context if applicable
          for (const id of skillIds) {
              await this._contextManager.removeSkillFromProject(id);
          }

          if (!this._currentDiscussion.id.startsWith('temp-')) {
              await this._discussionManager.saveDiscussion(this._currentDiscussion);
          }
          
          this.updateContextAndTokens();
          vscode.window.showInformationMessage(vscode.l10n.t("info.bulkRemoveSkillsSuccess", skillIds.length));
      }
  }

  public async handleBulkDeleteContextFiles(files: string[]) {
      if (!vscode.workspace.workspaceFolders || files.length === 0) return;
      const workspaceFolder = vscode.workspace.workspaceFolders[0];

      const confirm = await vscode.window.showWarningMessage(
          vscode.l10n.t("prompt.confirmBulkDeleteFiles", files.length),
          { modal: true },
          vscode.l10n.t("label.deleteAll")
      );

      if (confirm === vscode.l10n.t("label.deleteAll")) {
          try {
              for (const p of files) {
                  const cleanP = String(p).replace(/\\/g, '/').trim();
                  // Remove from external links if linked
                  await (this._contextManager as any).removeExternalLink?.(cleanP, workspaceFolder);

                  // Delete file from disk if inside .lollms/external_files or workspace
                  const res = await this._contextManager.resolveWorkspaceFromPath(cleanP);
                  if (res && (cleanP.includes('.lollms/external_files') || res.folder)) {
                      await vscode.workspace.fs.delete(res.uri, { recursive: true, useTrash: true }).then(undefined, () => {});
                  }
              }
              await (this._contextManager.getContextStateProvider() as any)?.removeFiles?.(files);
              await this.removeFilesFromDiscussionContext(files);
              vscode.window.showInformationMessage(vscode.l10n.t("info.bulkDeleteFilesSuccess", files.length));
              this.updateContextAndTokens({ isBackgroundSync: false });
          } catch (e: any) {
              vscode.window.showErrorMessage(vscode.l10n.t("error.bulkDeleteFailed", e.message));
          }
      }
  }

  /**
   * Scans text for <project_memory> tags and delegates processing to the manager.
   */
  private async processProjectMemoryTags(content: string) {
      const memManager = this.projectMemoryManager || this.agentManager?.projectMemoryManager;
      if (memManager) {
          await memManager.processTags(content);
      }
  }

  /**
   * Processes <mission_briefing> updates when autonomous/autoApply is active.
   */
  private async processMissionBriefingTags(content: string) {
      if (!content || (!this._discussionCapabilities.autoApply && !this._discussionCapabilities.agentMode)) {
          return;
      }
      const scanContent = this.stripProtectedRegionsForTagScan(content);
      const briefingRegex = /<mission_briefing\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mission_briefing>)/gim;
      let match: RegExpExecArray | null;
      while ((match = briefingRegex.exec(scanContent)) !== null) {
          const attrStr = match[1] || '';
          const inner = (match[2] || '').trim();

          const actionMatch = attrStr.match(/action=["'](add|edit|delete|write|patch|upsert|remove)["']/i);
          const action = (actionMatch ? actionMatch[1].toLowerCase() : 'upsert') as 'add' | 'edit' | 'delete' | 'write' | 'patch' | 'upsert' | 'remove';
          if (!inner && action !== 'delete' && action !== 'remove') continue;

          const scopeMatch = attrStr.match(/scope=["'](global|local)["']/i);
          const scope = (scopeMatch ? scopeMatch[1].toLowerCase() : 'global') as 'global' | 'local';
          const catMatch = attrStr.match(/category=["'](doctrine|architecture|decisions|pitfalls|tasks|custom)["']/i);
          const sectionMatch = attrStr.match(/section=["']([^"']+)["']/i);
          const idMatch = attrStr.match(/id=["']([^"']+)["']/i);
          const titleMatch = attrStr.match(/title=["']([^"']+)["']/i);

          await this._contextManager.updateMissionBriefing(inner, action, scope, this._currentDiscussion, {
              category: catMatch ? (catMatch[1].toLowerCase() as any) : undefined,
              section: sectionMatch ? sectionMatch[1].trim() : undefined,
              id: idMatch ? idMatch[1].trim() : undefined,
              title: titleMatch ? titleMatch[1].trim() : undefined
          });
      }
  }

  public async handleSummarizeContextFile(relativePath: string) {
      if (!vscode.workspace.workspaceFolders) return;
      const workspaceFolder = vscode.workspace.workspaceFolders[0];
      const uri = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);

      const instruction = await vscode.window.showInputBox({
          prompt: `How should I process ${relativePath}?`,
          value: "Summarize this document and extract key insights.",
          placeHolder: "e.g., Clean up this transcript, Summarize into bullet points, Extract JSON data..."
      });

      if (!instruction) return;

      const processor = new BigDataProcessor(this._lollmsAPI);
      
      await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: `Processing ${path.basename(relativePath)}...`,
          cancellable: true
      }, async (progress, token) => {
          try {
              const result = await processor.processFile(uri, instruction, progress, token);
              if (result) {
                  // Replace file content
                  await vscode.workspace.fs.writeFile(uri, Buffer.from(result, 'utf8'));
                  vscode.window.showInformationMessage(`Successfully processed ${relativePath}. Content updated.`);
                  
                  // Refresh context
                  this.updateContextAndTokens();
              }
          } catch (e: any) {
              if (!token.isCancellationRequested) {
                  vscode.window.showErrorMessage(`Processing failed: ${e.message}`);
              }
          }
      });
  }
  private async handleRequestContextUsage() {
      if (this._isDisposed || !this._currentDiscussion || !this._contextManager) return;
      const provider = this._contextManager.getContextStateProvider();
      if (!provider) return;

      const includedFiles = provider.getIncludedFiles();
      const model = this._currentDiscussion.model || this._lollmsAPI.getModelName();

      // 1. Send initial list immediately so UI renders skeleton
      const initialUsage = includedFiles.map(f => ({
          path: f.path,
          state: f.state,
          tokens: -1, // Loading state
          isExtra: f.path.includes('.lollms/') || f.path.startsWith('http') || f.path.startsWith('external/')
      }));

      this._panel.webview.postMessage({ command: 'contextUsageData', usage: initialUsage });

      // 2. Populate tokens incrementally with multi-root resolution
      for (const file of includedFiles) {
          // Cooperative Yield: Let the main Extension Host thread breathe and process webview paints
          await new Promise(resolve => setTimeout(resolve, 5));

          try {
              const res = await this._contextManager.resolveWorkspaceFromPath(file.path);
              if (!res) {
                  this._panel.webview.postMessage({ command: 'updateContextFileUsage', path: file.path, tokens: 0, error: true });
                  continue;
              }

              const uri = res.uri;
              const stats = await vscode.workspace.fs.stat(uri);

              // Generate a lightweight composite hash using file size + modified time
              const compositeHash = `${stats.size}_${stats.mtime}`;

              let tokenCount = await this._contextManager.getCachedTokens(file.path, compositeHash);

              if (tokenCount === null) {
                  // Read only if cache is missing or invalidated
                  let text = "";
                  if (file.state === 'definitions-only') {
                      text = await (this._contextManager as any).extractDefinitions(uri);
                  } else {
                      const fileContent = await vscode.workspace.fs.readFile(uri);
                      text = Buffer.from(fileContent).toString('utf8');
                  }
                  const tokenRes = await this._lollmsAPI.tokenize(text, model);
                  tokenCount = tokenRes.count;
                  await this._contextManager.setCachedTokens(file.path, compositeHash, tokenCount);
              }

              this._panel.webview.postMessage({
                  command: 'updateContextFileUsage',
                  path: file.path,
                  tokens: tokenCount
              });
          } catch (e) {
              this._panel.webview.postMessage({ command: 'updateContextFileUsage', path: file.path, tokens: 0, error: true });
          }
      }
  }
private async _getHtmlForWebview(webview: vscode.Webview): Promise<string> {
        const nonce = getNonce();

        const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css')).toString();
        const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'chatPanel.css')).toString();
        const prismThemeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'prism-tomorrow.css')).toString();
        const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'chatPanel.bundle.js')).toString();
        const lollmsIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'lollms-icon.svg')).toString();

        const l10nStrings = JSON.stringify(LocalizationManager.getBundleForWebview());

        const srcHtmlPath = vscode.Uri.joinPath(this._extensionUri, 'src', 'commands', 'chatPanel', 'webview', 'chatPanel.html');
        const outHtmlPath = vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'chatPanel.html');
        const srcCssPath = vscode.Uri.joinPath(this._extensionUri, 'src', 'commands', 'chatPanel', 'webview', 'chatPanel.css');
        const outCssPath = vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'chatPanel.css');

        let htmlContent = "";
        try {
            // Read directly from src template so layout updates apply instantly
            const rawBytes = await vscode.workspace.fs.readFile(srcHtmlPath);
            htmlContent = Buffer.from(rawBytes).toString('utf8');
            vscode.workspace.fs.writeFile(outHtmlPath, rawBytes).then(undefined, () => {});
        } catch {
            const rawBytes = await vscode.workspace.fs.readFile(outHtmlPath);
            htmlContent = Buffer.from(rawBytes).toString('utf8');
        }

        Promise.resolve(vscode.workspace.fs.readFile(srcCssPath))
            .then(cssBytes => vscode.workspace.fs.writeFile(outCssPath, cssBytes))
            .catch(() => {});

        return htmlContent
            .replace(/\{\{cspSource\}\}/g, webview.cspSource)
            .replace(/\{\{nonce\}\}/g, nonce)
            .replace(/\{\{codiconsUri\}\}/g, codiconsUri)
            .replace(/\{\{cssUri\}\}/g, cssUri)
            .replace(/\{\{prismThemeUri\}\}/g, prismThemeUri)
            .replace(/\{\{jsUri\}\}/g, jsUri)
            .replace(/\{\{lollmsIconUri\}\}/g, lollmsIconUri)
            .replace(/\{\{l10nStrings\}\}/g, l10nStrings);
    }
    
    /**
     * Core loop that fixes errors in a set of files using Aider blocks.
     * UPGRADED: Now uses the "Guardian Protocol" to ensure zero-error handover.
     */
    public async repairFilesIteratively(fileUris: vscode.Uri[], signal: AbortSignal, processId: string, messageId: string) {
        const max = this._discussionCapabilities.maxFixRetries || 3;
        const agent = this.agentManager;

        for (const fileUri of fileUris) {
            const relativePath = vscode.workspace.asRelativePath(fileUri);
            let retries = 0;

            // Give VS Code a moment to update diagnostics after the file write
            await new Promise(r => setTimeout(r, 1000));

            while (retries < max) {
                if (signal.aborted) break;

                const diagnostics = vscode.languages.getDiagnostics(fileUri)
                    .filter(d => d.severity === vscode.DiagnosticSeverity.Error);

                if (diagnostics.length === 0) {
                    this.log(`File ${relativePath} is now clean.`);
                    break;
                }

                retries++;
                this.processManager.updateDescription(processId, `Repairing ${path.basename(relativePath)} (${diagnostics.length} errors, attempt ${retries}/${max})...`);

                const errorReport = diagnostics.map(d => `[Line ${d.range.start.line + 1}] ${d.message}`).join('\n');
                const doc = await vscode.workspace.openTextDocument(fileUri);
                
                const isPy = doc.languageId === 'python';
                const langGuidance = isPy 
                    ? "2. **INDENTATION SENSITIVITY**: This is Python code. Ensure your SEARCH and REPLACE blocks respect the exact nesting levels."
                    : `2. **LANGUAGE COMPLIANCE**: Target language is \`${doc.languageId}\`. Ensure valid syntax and brackets.`;

                const repairPrompt = `### 🛡️ GUARDIAN PROTOCOL: REPAIR MISSION
I have detected ${diagnostics.length} functional error(s) in your previous output for \`${relativePath}\`. 

**LINE-BY-LINE ERRORS:**
${errorReport}

**CURRENT FILE STATE:**
\`\`\`${doc.languageId}
${doc.getText()}
\`\`\`

**STRICT INSTRUCTIONS:**
1. Fix the specific lines reported above.
${langGuidance}
3. **NEVER WRITE VERY LONG PATCHES**: Generate focused, very short SEARCH/REPLACE blocks (1 to 5 lines of change with minimal context).
4. **SYMBOL REPLACEMENT FOR EXTENSIVE CHANGES**: If you need to make many changes across a function, method, or class, use targeted symbol replacement (\`<file path="${relativePath}" action="update_symbol" symbol="SymbolName">\`) instead of long patching.
5. **NO TRAILING COMMENTS**: Do not add placeholders or comments like "// ... existing code" or "# ... rest of code".
6. Output ONLY the code blocks. No chatter.`;

                const systemPrompt = "You are a surgical code repair expert. Output only valid Aider SEARCH/REPLACE blocks to fix the requested errors.";

                try {
                    if (agent) {
                        (agent as any).completedActionsHistory.push(`[GUARDIAN REPAIR] 🛡️ START: Attempting to fix ${diagnostics.length} errors in \`${relativePath}\` (Retry ${retries}/${max}).`);
                    }

                    const rawResponse = await this._lollmsAPI.sendChat([
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: repairPrompt }
                    ], null, signal, this._currentDiscussion?.model);

                    const cleanResponse = stripThinkingTags(rawResponse).trim();
                    const normalizedPatch = normalizeAiderContent(cleanResponse);

                    // Apply the fix silently and auto-save
                    const patchResult: any = await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', relativePath, normalizedPatch, this, messageId, { silent: true, autoSave: true });

                    if (!patchResult?.success && cleanResponse.includes('```')) {
                        // Fallback: Check if response provided full file content or symbol replacement
                        const codeBlockMatch = cleanResponse.match(/```(?:\w+)?[:]?([^\n\r]*)\n([\s\S]+?)\n```/);
                        if (codeBlockMatch) {
                            await vscode.commands.executeCommand('lollms-vs-coder.applyFileContent', relativePath, codeBlockMatch[2].trim(), { silent: true, autoSave: true });
                        }
                    }

                    if (agent) {
                        (agent as any).completedActionsHistory.push(`[GUARDIAN REPAIR] 📝 PATCH APPLIED: Sent surgical fix to \`${relativePath}\`. Waiting for linter verification...`);
                    }

                    // Wait for diagnostics to refresh
                    await new Promise(r => setTimeout(r, 2000));

                    const remaining = vscode.languages.getDiagnostics(fileUri).filter(d => d.severity === vscode.DiagnosticSeverity.Error);
                    if (agent && remaining.length === 0) {
                        (agent as any).completedActionsHistory.push(`[GUARDIAN REPAIR] ✅ SUCCESS: \`${relativePath}\` is now clean.`);
                    }
                } catch (e: any) {
                    this.log(`Repair failed for ${relativePath}: ${e.message}`, 'ERROR');
                    break;
                }
            }
        }
    }

    /**
     * Triggered by the manual "Fix All" command.
     */
    public async compressCurrentDiscussionHistory(): Promise<boolean> {
        if (!this._currentDiscussion || this._isDisposed) return false;

        const msgs = (this._currentDiscussion.messages || []).filter(m => !m.skipInPrompt && m.role !== 'system');
        if (msgs.length <= 1) {
            vscode.window.showInformationMessage("Discussion history is too short to compress.");
            return false;
        }

        // Immediately notify webview HUD to show the active spinner
        this._panel.webview.postMessage({
            command: 'tokenCalculationStarted',
            text: 'Compressing chat history...'
        });

        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Lollms: Compressing conversation history...",
            cancellable: false
        }, async (progress) => {
            progress.report({ message: "Synthesizing high-density conversation recap..." });
            try {
                const targetModel = this._currentDiscussion?.model || this._lollmsAPI.getModelName();
                const res = await ContextLibrarian.compressHistory(
                    this._currentDiscussion!.messages,
                    this._lollmsAPI,
                    targetModel,
                    new AbortController().signal,
                    this._currentDiscussion!,
                    this._discussionManager
                );

                if (res && res.liberatedTokens > 0) {
                    // 1. Calculate new history text and token weight
                    const newHistoryText = this._currentDiscussion!.messages
                        .filter(m => !m.skipInPrompt)
                        .map(m => typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(p => p.text || '').join('\n') : ''))
                        .join('\n');
                    const newHistoryTokens = Math.max(1, Math.ceil(newHistoryText.length / 3.5));

                    // 2. Adjust lastTokenMetrics immediately so loadDiscussion receives the newly reduced metrics
                    if (this._currentDiscussion!.lastTokenMetrics) {
                        const oldHistoryTokens = this._currentDiscussion!.lastTokenMetrics.segments?.history || 0;
                        const liberated = Math.max(0, oldHistoryTokens - newHistoryTokens);
                        this._currentDiscussion!.lastTokenMetrics.total = Math.max(0, this._currentDiscussion!.lastTokenMetrics.total - liberated);
                        if (this._currentDiscussion!.lastTokenMetrics.segments) {
                            this._currentDiscussion!.lastTokenMetrics.segments.history = newHistoryTokens;
                        }
                    }

                    // 3. Clear token count cache so stale history hash isn't used
                    ChatPanel._tokenCountCache.clear();

                    if (!this._currentDiscussion!.id.startsWith('temp-')) {
                        await this._discussionManager.saveDiscussion(this._currentDiscussion!);
                    }

                    // 4. Reload discussion layout with newly reduced metrics
                    await this.loadDiscussion();

                    // 5. Authoritatively update context and tokens
                    await this.updateContextAndTokens({ isBackgroundSync: false });

                    vscode.window.showInformationMessage(`✅ Chat history compressed (~${res.liberatedTokens.toLocaleString()} tokens liberated). Files preserved in context.`);
                    return true;
                } else {
                    this._panel.webview.postMessage({ command: 'tokenCalculationFinished' });
                    vscode.window.showWarningMessage("Could not compress conversation history.");
                    return false;
                }
            } catch (err: any) {
                this._panel.webview.postMessage({ command: 'tokenCalculationFinished' });
                this.log(`Failed to compress discussion history: ${err.message}`, 'ERROR');
                vscode.window.showErrorMessage(`Failed to compress history: ${err.message}`);
                return false;
            }
        });
    }

    public async handleFixAllErrors() {
        const { FileRepairStudioPanel } = require('../../panels/fileRepairStudioPanel');
        await FileRepairStudioPanel.createOrShowWorkspaceRepair(this._extensionUri, this._services);
    }

}
