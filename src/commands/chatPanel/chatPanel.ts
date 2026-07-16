import * as vscode from 'vscode';
import { LollmsAPI, ChatMessage } from '../../lollmsAPI';
import { ContextManager, ContextResult } from '../../contextManager';
import { Discussion, DiscussionManager } from '../../discussionManager';
import { AgentManager } from '../../agentManager';
import { HerdManager } from '../../herdManager';
import { getProcessedSystemPrompt, stripThinkingTags, DiscussionCapabilities, ResponseProfile } from '../../utils';
import * as path from 'path';
import { InfoPanel } from '../infoPanel';
import { ProcessManager } from '../../processManager';
import { getNonce } from './getNonce';
import { SkillsManager } from '../../skillsManager';
import { Logger } from '../../logger';
import { PersonalityManager } from '../../personalityManager';
import { GitIntegration } from '../../gitIntegration';
import { applyDiffToString, applySearchReplace } from '../../utils';
import { BigDataProcessor } from '../../bigDataProcessing';
import { AutomationPanel } from '../../panels/automationPanel';
import { LocalizationManager } from '../../utils/localizationManager';
import { LollmsServices } from '../../lollmsContext';
import { ChatPanelMessageHandler } from './chatPanelMessageHandler';


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
  public static _tokenCountCache: Map<string, number> = new Map();

  public static currentPanel: ChatPanel | undefined;
  public static isBatchApplying = false;
  public readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  public readonly _lollmsAPI: LollmsAPI;
  private _contextManager!: ContextManager;
  private _discussionManager!: DiscussionManager;
  private _gitIntegration: GitIntegration;
  private _currentDiscussion: Discussion | null = null;
  public agentManager!: AgentManager;
  private _toolManager!: ToolManager;
  public herdManager?: HerdManager;
  private _executionLogs: string[] = [];
  private processManager!: ProcessManager;
  private readonly discussionId: string;
  private _isWebviewReady = false;
  private _isLoadPending = false;
  private _inputResolver: ((value: string) => void) | null = null;
  private _skillsManager: SkillsManager;
  private _personalityManager?: PersonalityManager;
  private _isDisposed = false;

  public get isWebviewReady(): boolean { return this._isWebviewReady; }
  public get isDisposed(): boolean { return this._isDisposed; }
  
  private _viewReadyPromise: Promise<void>;
  private _viewReadyResolver!: () => void;
  
  private _discussionCapabilities: DiscussionCapabilities;
  private _tokenAbortController: AbortController | null = null;
  private _isTokenizing: boolean = false;

  // Track active listeners to prevent duplication
  private _activeGenerationListener?: (chunk: string) => void;
  private _activeGenerationCompleteListener?: (fullContent: string) => void;
  private pdfExtractionPromises: Record<string, { resolve: (val: string[]) => void, reject: (err: Error) => void, timeout: NodeJS.Timeout }> = {};

  // Tracks failing patches to prevent infinite repetition loops
  private _failedPatchesRegistry: Map<string, Set<string>> = new Map();

  private _initialPrompt?: string;

  private _activeTokenizationPromise: Promise<void> | null = null;
  private _tokenizationPendingRerun = false;
  private _tokenizationPendingOptions: any = null;

  public static createOrShow(services: LollmsServices, discussionId: string): ChatPanel {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

    const existingPanel = ChatPanel.panels.get(discussionId);
    if (existingPanel) {
      existingPanel._panel.reveal(column);
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

  private _codeGraphManager!: CodeGraphManager;

  private constructor(panel: vscode.WebviewPanel, services: LollmsServices, discussionId: string) {
    this._panel = panel;
    this._extensionUri = services.extensionUri;
    this._lollmsAPI = services.lollmsAPI;
    this._discussionManager = services.discussionManager;
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

      // Ensure AgentManager is initialized so its logic is available even in discussion mode
      if (ChatPanel.activeAgents.has(this.discussionId)) {
          this.agentManager = ChatPanel.activeAgents.get(this.discussionId)!;
          this.agentManager.setUI(this);
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
          this.agentManager.personalityManager = this._personalityManager;
          this.agentManager.projectMemoryManager = this.projectMemoryManager;
          ChatPanel.activeAgents.set(this.discussionId, this.agentManager);
      }
  }
  
    public async executeAutomationPipeline(content: string, messageId: string, signal: AbortSignal, processId: string) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return;

        const modifiedFiles = new Set<string>();
        let blockIndex = 0; // Initialize precise index tracker

        // 1. Process Fenced Code Blocks (Standard)
        const blockRegex = /```[\t ]*(?:language:|lang:)?(\w+)[\t ]*:[\t ]*([^\n\r\s]+)[\t ]*[\r\n]+([\s\S]+?)[\r\n]+```/g;
        let match;

        while ((match = blockRegex.exec(content)) !== null) {
            if (signal.aborted) break;
            let filePath = match[2];
            let blockContent = match[3];

            const currentBlockIndex = blockIndex++; // Track block index
            const opts = { silent: true, autoSave: true, blockIndex: currentBlockIndex };

            const isAiderInside = blockContent.includes('<<<<<<< SEARCH');
            const commonLangs = ['makefile', 'python', 'py', 'javascript', 'js', 'typescript', 'ts', 'json', 'bash', 'sh', 'css', 'html'];

            if (isAiderInside && commonLangs.includes(filePath.toLowerCase())) {
                const precedingText = content.substring(Math.max(0, match.index - 120), match.index);
                const backtickMatch = precedingText.match(/`([^`]+)`/);
                const pathMatch = backtickMatch ? backtickMatch : precedingText.match(/([a-zA-Z0-9._\-\/]+\.[a-z0-9]+)/i);
                if (pathMatch) {
                    filePath = pathMatch[1];
                }
            }

            if (filePath.includes(':')) {
                const parts = filePath.split(':');
                if (commonLangs.includes(parts[0].toLowerCase())) {
                    filePath = parts.slice(1).join(':');
                }
            }

            modifiedFiles.add(filePath);

            if (isAiderInside) {
                const normalizedAider = blockContent.replace(/^\s*(<<<<<<< SEARCH|=======|>>>>>>> REPLACE)/gm, '$1');
                const result: any = await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', filePath, normalizedAider, this, messageId, { ...opts, autoSave: true });

                // If the patch application failed, trigger automated self-correction (Mute for system IDs to prevent infinite loops)
                const isSystemId = messageId.startsWith('self_correction') || messageId.startsWith('guardian') || messageId.startsWith('system') || messageId.startsWith('inspection');
                if (result && !result.success && !isSystemId && !signal.aborted) {
                    this.log(`Patch failed for ${filePath}. Initiating automated AI self-correction...`, 'WARN');
                    await this.triggerSurgicalSelfCorrection(filePath, normalizedAider, result.error || "Search block mismatch.", signal, 1);
                }
            } else {
                const resolution = await this.contextManager.resolveWorkspaceFromPath(filePath);
                if (resolution) {
                    await vscode.workspace.fs.writeFile(resolution.uri, Buffer.from(blockContent, 'utf8'));
                    // Notify webview to collapse the newly written file
                    this._panel.webview.postMessage({
                        command: 'fileSavedOnDisk',
                        filePath: filePath
                    });
                }
            }
        }

        // 2. Process Naked Aider Blocks (No backtick fences)
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (signal.aborted) break;
            const line = lines[i].trim();

            if (line.startsWith('<<<<<<< SEARCH')) {
                // Find matching REPLACE end
                let endIdx = -1;
                for (let j = i + 1; j < lines.length; j++) {
                    if (lines[j].trim().startsWith('>>>>>>> REPLACE')) {
                        endIdx = j;
                        break;
                    }
                }

                if (endIdx !== -1) {
                    const blockContent = lines.slice(i, endIdx + 1).join('\n');
                    const currentBlockIndex = blockIndex++; // Track block index
                    const opts = { silent: true, autoSave: true, blockIndex: currentBlockIndex };

                    // Recover path from preceding text
                    let filePath = "";
                    for (let k = i - 1; k >= Math.max(0, i - 15); k--) {
                        const backtickMatch = lines[k].match(/`([^`]+)`/);
                        if (backtickMatch) {
                            const candidate = backtickMatch[1].trim();
                            if (candidate.includes('.') || candidate.includes('/')) {
                                filePath = candidate;
                                break;
                            }
                        }
                        const pathMatch = lines[k].match(/([a-zA-Z0-9._\-\/]+\.[a-zA-Z0-9]+)/);
                        if (pathMatch) {
                            filePath = pathMatch[1];
                            break;
                        }
                    }

                    if (filePath) {
                        modifiedFiles.add(filePath);
                        const normalizedAider = blockContent.replace(/^\s*(<<<<<<< SEARCH|=======|>>>>>>> REPLACE)/gm, '$1');
                        const result: any = await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', filePath, normalizedAider, this, messageId, opts);

                        // Trigger automated self-correction for naked block failure
                        const isSystemId = messageId.startsWith('self_correction') || messageId.startsWith('guardian') || messageId.startsWith('system') || messageId.startsWith('inspection');
                        if (result && !result.success && !isSystemId && !signal.aborted) {
                            this.log(`Naked patch failed for ${filePath}. Initiating automated AI self-correction...`, 'WARN');
                            await this.triggerSurgicalSelfCorrection(filePath, normalizedAider, result.error || "Search block mismatch.", signal, 1);
                        }
                    }
                    i = endIdx; // Advance parser beyond the block
                }
            }
        }

        // 🛡️ GUARDIAN PROTOCOL: Automated Repair Loop
        if (this._discussionCapabilities.autoFix && modifiedFiles.size > 0) {
            // Fallback to standard diagnostic-based repair if verifier is off
            const urisToFix = Array.from(modifiedFiles).map(fp => vscode.Uri.joinPath(workspaceFolder.uri, fp));
            await this.repairFilesIteratively(urisToFix, signal, processId, messageId);
        }
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
        - Provide surgical fixes using **AIDER SEARCH/REPLACE** blocks.
        - If a file is perfect, do not include it.
        - If everything is perfect, respond with "VERIFICATION PASSED".
        - Output ONLY the code blocks. No conversational chatter.`;

        try {
            const model = this._currentDiscussion?.model || this._lollmsAPI.getModelName();
            const systemPrompt = await getProcessedSystemPrompt('verifier');

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

            // If the Guardian found issues, provide them as a new assistant bubble
            const verifierMsgId = 'guardian_fix_' + Date.now();
            await this.addMessageToDiscussion({
                id: verifierMsgId,
                role: 'assistant',
                content: `**🛡️ Guardian Audit: Structural Issues Detected**\n\nI've identified indentation or dependency issues in the applied files. Here are the surgical repairs:\n\n${cleanResponse}`,
                model: model,
                personalityName: '🛡️ Guardian'
            });

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
      public async triggerSurgicalSelfCorrection(filePath: string, failingPatch: string, errorMsg: string, signal: AbortSignal, currentAttempt: number = 1) {
          const maxAttempts = 4;
          if (currentAttempt > maxAttempts) {
              this.log(`Self-Correction: Reached maximum attempts limit (${maxAttempts}) for ${filePath}. Halting.`, 'WARN');
              return;
          }

          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          if (!workspaceFolder) return;

          const resolution = await this._contextManager.resolveWorkspaceFromPath(filePath);
          if (!resolution) return;

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
          } catch (e: any) {
              this.log(`Self-Correction: Could not read original file ${filePath}: ${e.message}`, 'ERROR');
              return;
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
  4. Provide the CORRECTED block. Include 2-3 lines of unchanged context in the SEARCH section to ensure a unique match.
  5. Output **ONLY** the corrected \`<<<<<<< SEARCH ... >>>>>>> REPLACE\` block. Do not wrap it in other code blocks.`;

          try {
              const model = this._currentDiscussion?.model || this._lollmsAPI.getModelName();
              const response = await this._lollmsAPI.sendChat([
                  { role: 'system', content: systemPrompt },
                  { role: 'user', content: userPrompt }
              ], null, signal, model, { thinking: false });

              if (signal.aborted) return;

              const cleanResponse = stripThinkingTags(response);

              // Extract the fixed block from the response
              let fixedBlock = "";
              const startTag = "<<<<<<< SEARCH";
              const endTag = ">>>>>>> REPLACE";
              const startIdx = cleanResponse.indexOf(startTag);
              const endIdx = cleanResponse.indexOf(endTag);

              if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
                  fixedBlock = cleanResponse.substring(startIdx, endIdx + endTag.length);
              } else {
                  const match = cleanResponse.match(/```(?:\w+)?\n([\s\S]*?)\n```/);
                  fixedBlock = match ? match[1].trim() : cleanResponse.trim();
              }

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
                      return;
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
                      // Clear registry on complete success
                      this._failedPatchesRegistry.delete(filePath);
                  } else {
                      const nextError = applyResult?.error || "Search block mismatch.";
                      await this.updateMessageContent(successMsgId, `🛡️ **Sovereign Shield**: Corrected patch also failed to apply. Recurving loop...`);
                      // Recurse into the next attempt
                      await this.triggerSurgicalSelfCorrection(filePath, fixedBlock, nextError, signal, currentAttempt + 1);
                  }
              } else {
                  await this.updateMessageContent(correctionMsgId, `🛡️ **Sovereign Shield**: AI repair produced an invalid format. Please resolve the conflict manually.`);
              }

          } catch (e: any) {
              this.log(`Automated self-correction failed: ${e.message}`, 'ERROR');
          }
      }

  
    public updateGeneratingState() {
        if (this._isDisposed || !this.processManager || !this._panel.webview) return;

        const process = this.processManager.getForDiscussion(this.discussionId);
        const activeGen = ChatPanel.activeGenerations.get(this.discussionId);

        const desc = process?.description || "";
        const isBackgroundProcess = desc.toLowerCase().includes("title") || desc.toLowerCase().includes("counting");
        const isAgentActive = this.agentManager?.getIsActive() && this._discussionCapabilities.workerType === 'discussion';
        const showRaiseHand = !!(isAgentActive && process && !isBackgroundProcess);

        const isGenerating = ((process && !isBackgroundProcess) || !!activeGen) && !this._inputResolver;

        let statusText = vscode.l10n.t("Lollms is thinking...");
        if (process) statusText = process.description;
        else if (activeGen) statusText = vscode.l10n.t("Generating response...");

        this._panel.webview.postMessage({ 
            command: 'setGeneratingState', 
            isGenerating,
            statusText,
            showRaiseHand 
        });
    }
  
  public updateAgentMode(isActive: boolean) {
  if (this._isDisposed) return;
  if (this._panel.webview) {
      this._panel.webview.postMessage({ command: 'updateAgentMode', isActive });
  }
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
      const systemPrompt = await getProcessedSystemPrompt('verifier');

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
    this._discussionCapabilities = { ...this._discussionCapabilities, ...partial };

    // --- GLOBAL WORKSPACE SYNC ---
    if (partial.folderSettings !== undefined) {
        await this._discussionManager.context.workspaceState.update('lollms_global_folder_settings', partial.folderSettings);
    }
    if (partial.disableProjectContext !== undefined) {
        await this._discussionManager.context.workspaceState.update('lollms_global_context_muted', partial.disableProjectContext);
    }

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
  public async updateMessageContent(messageId: string, newContent: string) {
      if (!this._currentDiscussion) return;
      const msg = this._currentDiscussion.messages.find(m => m.id === messageId);
      if (msg) {
          if (typeof newContent === 'string' && newContent.startsWith('APPEND_TAG:')) {
              const tag = newContent.substring(11);
              if (typeof msg.content === 'string' && !msg.content.includes(tag)) {
                  msg.content = msg.content + "\n" + tag;
              }
          } else {
              msg.content = newContent;
          }

          if (!this._currentDiscussion.id.startsWith('temp-')) {
              await this._discussionManager.saveDiscussion(this._currentDiscussion);
          }
      }
      if (this._panel.webview && !this._isDisposed) {
          this._panel.webview.postMessage({ command: 'updateMessage', messageId, newContent });
      }
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
                  discussion = {
                      id: this.discussionId,
                      title: 'Temporary Discussion',
                      messages: [],
                      timestamp: Date.now(),
                      groupId: null,
                      plan: null,
                      capabilities: { ...this._discussionCapabilities, agentMode: false, preciseTokenization: preciseTokenizationVal }, 
                      personalityId: 'default_coder',
                      importedSkills: []
                  };
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

                  this._currentDiscussion = discussion;

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

          if (!this._isWebviewReady) {
              this.log("Webview not ready, queuing load.");
              this._isLoadPending = true;
              return;
          }
          this._isLoadPending = false;

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const isInspectorEnabled = config.get<boolean>('enableCodeInspector', true);
        const profiles = config.get('responseProfiles') || [];

        // --- PHASE 1: IMMEDIATE DISCUSSION MATERIALIZATION (NO BLOCKING I/O) ---
        const currentP = this._personalityManager?.getPersonality(this._currentDiscussion.personalityId || 'default_coder');
        const safeMessages = (this._currentDiscussion.messages || []).map(m => ({
            ...m,
            id: m.id || 'msg_' + Math.random().toString(36).substring(2, 9),
            personalityName: m.role === 'assistant' ? (m.personalityName || currentP?.name || 'Lollms') : undefined
        }));

        const workspaceFolders = (vscode.workspace.workspaceFolders ||[]).map(f => ({
            name: f?.name || "Workspace",
            uri: f?.uri?.toString() || ""
        })).filter(item => item.uri !== "");

        const { AGENT_MISSION_PROFILES } = require('../../registries/agentProfiles');

        // Immediately update capabilities and render discussion layout on the main thread
        this._panel.webview.postMessage({
            command: 'updateDiscussionCapabilities',
            capabilities: this._discussionCapabilities
        });

        this._panel.webview.postMessage({ 
            command: 'loadDiscussion', 
            messages: safeMessages,
            isInspectorEnabled: isInspectorEnabled,
            agentMode: !!this._discussionCapabilities.agentMode,
            appliedState: this._currentDiscussion.appliedState || {},
            currentModel: this._currentDiscussion.model || this._lollmsAPI.getModelName(),
            currentTemperature: this._discussionCapabilities.enableTemperature ? (this._discussionCapabilities.temperature ?? 0.7) : undefined,
            workspaceFolders: workspaceFolders,
            agentProfiles: AGENT_MISSION_PROFILES,
            initialPrompt: this._initialPrompt
        });
        this._initialPrompt = undefined;

        // --- PHASE 2: DEFERRED CONTEXT ASSEMBLY & DISK I/O (NON-BLOCKING) ---
        setImmediate(async () => {
            if (this._isDisposed || !this._panel || !this._panel.webview) return;

            if (this._contextManager) {
                const cachedContext = this._contextManager.getLastContext();
                let includedFiles: string[] = [];
                try {
                    const provider = this._contextManager.getContextStateProvider();
                    const rawFiles = provider ? provider.getIncludedFiles() : [];
                    includedFiles = rawFiles.filter(f => f && f.path).map(f => f.path);
                } catch (e) {
                    Logger.warn("Safeguard caught error reading included files.");
                }
                const projectSkills = await this._contextManager.getActiveProjectSkills();
                const discussionSkills = this._currentDiscussion?.importedSkills || [];

                const allSkillIds = Array.from(new Set([...projectSkills, ...discussionSkills]));
                const UI_PREVIEW_LIMIT = 10000;

                let savedSelections: string[] = [];
                const folders = vscode.workspace.workspaceFolders;
                if (folders && folders.length > 0) {
                    const selectionDir = vscode.Uri.joinPath(folders[0].uri, '.lollms', 'selection');
                    try {
                        const entries = await vscode.workspace.fs.readDirectory(selectionDir);
                        savedSelections = entries
                            .filter(([name]) => name.endsWith('.lollms-ctx'))
                            .map(([name]) => name);
                    } catch (e) {}
                }

                if (cachedContext) {
                    const contextTextToSend = cachedContext.text.length > UI_PREVIEW_LIMIT 
                        ? cachedContext.text.substring(0, UI_PREVIEW_LIMIT) + `\n\n... [Preview truncated for UI performance. Total: ${cachedContext.text.length} chars]`
                        : cachedContext.text;

                    const discussionTools = this._currentDiscussion?.importedTools || [];
                    const projectTools = await this._contextManager.getActiveProjectTools();
                    const allEquippedNames = Array.from(new Set([...discussionTools, ...projectTools]));
                    const equippedTools = this.agentManager.getTools()
                        .filter(t => allEquippedNames.includes(t.name))
                        .map(t => ({ name: t.name, description: t.description }));

                    this._panel.webview.postMessage({ 
                        command: 'updateContext', 
                        context: contextTextToSend,
                        files: includedFiles,
                        skills: cachedContext.importedSkills || [],
                        tools: equippedTools || [],
                        diagrams: cachedContext.diagrams || [],
                        briefing: this._currentDiscussion?.discussion_data_zone || "",
                        selections: savedSelections
                    });
                    this._panel.webview.postMessage({ command: 'updateImageContext', images: cachedContext.images });
                } else {
                    this._panel.webview.postMessage({ 
                        command: 'updateContext', 
                        context: '', 
                        files: includedFiles,
                        skills: allSkillIds.map(id => ({ id, name: '...' })),
                        diagrams: (this._currentDiscussion?.activeDiagrams || []).map(type => ({ type, mermaid: '' })),
                        briefing: this._currentDiscussion?.discussion_data_zone || "",
                        selections: savedSelections
                    });
                }
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

        const { SYSTEM_RESPONSE_PROFILES } = require('../../utils');
        const userProfiles = (Array.isArray(profiles) ? profiles : []).filter((p: any) => p && p.id);
        const allProfiles = [...SYSTEM_RESPONSE_PROFILES, ...userProfiles.filter((p: any) => !SYSTEM_RESPONSE_PROFILES.some((sp: any) => sp.id === p.id))];

        let isRepo = false;
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder && this._gitIntegration) {
            isRepo = await this._gitIntegration.isGitRepo(workspaceFolder);
        }
        this._panel.webview.postMessage({ command: 'updateGitRepoStatus', isRepo: isRepo });

        if (this._discussionCapabilities.gitWorkflow && workspaceFolder) {
            this.sendGitBranchState(workspaceFolder);
        }

        if (this._personalityManager) {
            this._panel.webview.postMessage({
                command: 'updatePersonalities',
                personalities: this._personalityManager.getPersonalities(),
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
            const safeFiles = provider ? provider.getIncludedFiles().filter(f => f && f.path).map(f => f.path) : [];

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
                segments: m.segments
            });

            this._panel.webview.postMessage({ command: 'tokenCalculationFinished' });
        } 

        // Non-blocking deferred calculations to prevent UI render blocking
        setTimeout(async () => {
            // --- LAZY NON-BLOCKING HYDRATION ---
            // If we have previously cached metrics for this discussion, restore them immediately
            if (this._currentDiscussion && this._currentDiscussion.lastTokenMetrics) {
                const m = this._currentDiscussion.lastTokenMetrics;
                if (this._panel && this._panel.webview && !this._isDisposed) {
                    this._panel.webview.postMessage({
                        command: 'updateTokenProgress',
                        totalTokens: m.total,
                        contextSize: m.contextSize,
                        isApproximate: false,
                        segments: m.segments
                    });
                }
            } else if (this._panel && this._panel.webview && !this._isDisposed) {
                // Otherwise, trigger a silent, low-priority background calculation pass [2]
                // This populates the HUD bar automatically on load without hanging the interface
                this.updateContextAndTokens({ isBackgroundSync: true });
            }

            if (this._panel && this._panel.webview && !this._isDisposed) {
                this._panel.webview.postMessage({ command: 'tokenCalculationFinished' });
                this._panel.webview.postMessage({ command: 'updateStatus', status: 'Ready', type: 'info' });
            }
            this._fetchAndSetModels(false);
        }, 300); // 300ms cushion allows the main UI thread to finish painting completely
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

  private async _fetchAndSetModels(forceRefresh: boolean = false) {
    if (this._isDisposed) return;
    try {
        if (!this._panel.webview) return;
        let models: Array<{ id: string }> = [];
        try {
            models = await this._lollmsAPI.getModels(forceRefresh);
        } catch (error: any) {
            this.log(`Failed to fetch models: ${error.message}`, 'WARN');
        }
        
        if (this._currentDiscussion) {
            this._panel.webview.postMessage({ 
                command: 'updateModels',
                models: models,
                currentModel: this._currentDiscussion.model
            });
        }
    } catch (e: any) {
        this.log(`Unexpected error in _fetchAndSetModels: ${e.message}`, 'ERROR');
    }
  }

  public async updateContextAndTokens(options?: { isBackgroundSync?: boolean, forceFullScan?: boolean }): Promise<void> {
    const self = this;
    if (self._isDisposed || !self._panel || !self._panel.webview) return;

    // Enhanced High-Performance Debouncing Gate:
    // If a calculation is requested within 400ms of another, we clear the timer 
    // and reschedule to completely avoid redundant parallel calculations.
    if ((self as any)._tokenDebounceTimeout) {
        clearTimeout((self as any)._tokenDebounceTimeout);
    }

    return new Promise<void>((resolvePromise) => {
        (self as any)._tokenDebounceTimeout = setTimeout(async () => {
            if (self._isDisposed || !self._panel || !self._panel.webview) {
                return resolvePromise();
            }

            // Concurrency Abort: Force-cancel any running tokenization promise immediately
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
                if (forceFull && self.contextStateProvider) {
                    self._panel.webview.postMessage({ command: 'showProjectLoader', projectName: self._currentDiscussion?.title || "Workspace" });
                    self._panel.webview.postMessage({ command: 'updateLoaderStatus', status: 'Librarian: Indexing files. Please stand by...' });

                    await self.contextStateProvider.triggerFullScan((pct, status) => {
                        if (signal.aborted) return;
                        self._panel.webview.postMessage({ 
                            command: 'updateLoaderStatus', 
                            status: `${status} Please stand by...`,
                            stats: { files: pct, tokens: -1 }
                        });
                    });

                    self._panel.webview.postMessage({ command: 'hideProjectLoader' });
                }

                if (signal.aborted) return resolvePromise();

                // --- IMMEDIATE INSTANT HYDRATION / REACTION ---
                const provider = self.contextStateProvider || self._contextManager.getContextStateProvider();
                const includedFiles = provider ? provider.getIncludedFiles().filter(f => f && f.path).map(f => f.path) : [];

                if (includedFiles.length === 0) {
                    self._panel.webview.postMessage({ 
                        command: 'updateContext', 
                        files: [],
                        skills: [],
                        tools: [],
                        diagrams: [],
                        briefing: ""
                    });

                    const oldMetrics = self._currentDiscussion?.lastTokenMetrics;
                    const fallbackSize = oldMetrics?.contextSize || 128000;
                    const fallbackSegments = {
                        system: oldMetrics?.segments?.system || 0,
                        briefing: 0,
                        tree: oldMetrics?.segments?.tree || 0,
                        skills: 0,
                        memory: oldMetrics?.segments?.memory || 0,
                        diagrams: 0,
                        files: 0,
                        history: oldMetrics?.segments?.history || 0,
                        images: 0
                    };

                    self._panel.webview.postMessage({
                        command: 'updateTokenProgress',
                        totalTokens: Object.values(fallbackSegments).reduce((a, b) => a + b, 0),
                        contextSize: fallbackSize,
                        isApproximate: false,
                        segments: fallbackSegments
                    });

                    self._panel.webview.postMessage({ command: 'tokenCalculationFinished' });
                    self._panel.webview.postMessage({ command: 'updateStatus', status: 'Ready', type: 'info' });
                    self._panel.webview.postMessage({ command: 'hideProjectLoader' }); // Failsafe dismiss
                    return resolvePromise();
                } else if (!isBackground) {
                    self._panel.webview.postMessage({ 
                        command: 'updateContext', 
                        files: includedFiles
                    });
                }

                self._isTokenizing = true;
                const modelForTokenization = (self._currentDiscussion?.model || self._lollmsAPI.getModelName() || "default").trim();

                try {
                    self.log("Fetching context content...");
                    const importedIds = self._currentDiscussion?.importedSkills || [];
                    const activeDiagramIds = self._currentDiscussion?.activeDiagrams || [];

                    self._panel.webview.postMessage({ command: 'updateLoaderStatus', status: 'Assembling Codebase Map...' });

                    let currentTokenEstimate = 0;
                    const context = await self._contextManager.getContextContent({ 
                        signal, 
                        capabilities: self._discussionCapabilities,
                        importedSkillIds: importedIds,
                        activeDiagramIds: activeDiagramIds,
                        modelName: modelForTokenization,
                        onProgress: (progressData: any) => {
                            if (!self._isDisposed) {
                                const pct = typeof progressData === 'object' ? progressData.percentage : progressData;
                                const current = progressData?.current || 0;
                                const total = progressData?.total || 0;
                                const name = progressData?.fileName || '';

                                // 1. Send detailed progress data to the webview
                                self._panel.webview.postMessage({ 
                                    command: 'tokenCalculationProgress', 
                                    progress: pct,
                                    current: current,
                                    total: total,
                                    fileName: name
                                });

                                // 2. Update the big Blueprint loader with "Live" stats
                                self._panel.webview.postMessage({
                                    command: 'updateLoaderStatus',
                                    status: `Indexing: ${pct}% complete...`,
                                    stats: { 
                                        files: current, 
                                        tokens: -1 
                                    }
                                });
                            }
                        },
                        onScanProgress: (pct: number, status: string) => {
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
                        }
                    });

                    if (signal.aborted) {
                        self.log("token calculation aborted.");
                        return;
                    }

                    if (self._isDisposed) return;

                    let includedFiles: string[] = [];
                    try {
                        const provider = self._contextManager.getContextStateProvider();
                        const rawFiles = provider ? provider.getIncludedFiles() : [];
                        includedFiles = rawFiles.filter(f => f && f.path).map(f => f.path);
                    } catch (e) {}

                    // Aggressive truncation for Webview UI to prevent IPC Channel Closure
                    const UI_PREVIEW_LIMIT = 10000; 
                    const contextTextForUI = context.text.length > UI_PREVIEW_LIMIT
                        ? context.text.substring(0, UI_PREVIEW_LIMIT) + `\n\n... [Preview truncated for UI performance. Total: ${context.text.length} chars]`
                        : context.text;

                    const { estimateImageTokens } = require('../../utils');

                    const historyText = self._currentDiscussion!.messages.map(msg => {
                        const content = msg.content;
                        if (typeof content === 'string') return content;
                        if (Array.isArray(content)) return content.filter(item => item.type === 'text').map(item => item.text).join('\n');
                        return '';
                    }).join('\n');

                    // --- Extract Project Memory early for tokenization ---
                    const projectMemory = (self._discussionCapabilities.projectMemoryEnabled !== false && self.agentManager?.projectMemoryManager)
                        ? await self.agentManager.projectMemoryManager.getFormattedMemoryBlock(historyText, self._skillsManager)
                        : "";

                    const rawBriefing = self._currentDiscussion?.discussion_data_zone || "";
                    briefingText = (rawBriefing.startsWith('{')) ? self._contextManager.renderBriefing(self._currentDiscussion) : rawBriefing;

                    systemText = await getProcessedSystemPrompt(
                        'chat', 
                        self._discussionCapabilities, 
                        self.getCurrentPersonaSystemPrompt(), 
                        undefined, 
                        self._discussionCapabilities.forceFullCode, 
                        { 
                            tree: context.projectTree, 
                            files: context.selectedFilesContent, 
                            skills: context.skillsContent, 
                            memory: projectMemory 
                        }
                    );

                    if (!self._isDisposed) {
                        // Scan .lollms/selection/ folder for saved selections
                        let savedSelections: string[] = [];
                        const folders = vscode.workspace.workspaceFolders;
                        if (folders && folders.length > 0) {
                            const selectionDir = vscode.Uri.joinPath(folders[0].uri, '.lollms', 'selection');
                            try {
                                const entries = await vscode.workspace.fs.readDirectory(selectionDir);
                                savedSelections = entries
                                    .filter(([name]) => name.endsWith('.lollms-ctx'))
                                    .map(([name]) => name);
                            } catch (e) {}
                        }

                        // --- LAZY INGESTION & DELTA STATE CACHE ---
                        const provider = self._contextManager.getContextStateProvider();
                        const includedFiles = provider ? provider.getIncludedFiles().map(f => ({
                            path: f.path,
                            state: f.state,
                            hasContent: false // Loaded dynamically on-demand
                        })) : [];
                        const currentSkills = context.importedSkills || []; 

                        const discussionTools = self._currentDiscussion?.importedTools || [];
                        const projectTools = await self._contextManager.getActiveProjectTools();
                        const allEquippedNames = Array.from(new Set([...discussionTools, ...projectTools]));
                        const equippedTools = self.agentManager.getTools()
                            .filter(t => allEquippedNames.includes(t.name))
                            .map(t => ({ name: t.name, description: t.description }));

                        self._panel.webview.postMessage({ 
                            command: 'updateContextDelta', 
                            action: 'sync_all',
                            files: includedFiles,
                            skills: (currentSkills || []).map(s => ({ id: s.id, name: s.name, description: s.description })), // Lightweight descriptors
                            tools: equippedTools || [],
                            briefing: self._currentDiscussion?.discussion_data_zone || "" ,
                            selections: savedSelections || []
                        });
                    }
                    self._panel.webview.postMessage({ command: 'updateImageContext', images: context.images });

                    self._panel.webview.postMessage({ command: 'tokenCalculationStarted', text: 'Counting tokens...' });
                    self._panel.webview.postMessage({ command: 'updateStatus', status: 'Computing tokens length...', type: 'info' });

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
                        self._currentDiscussion.messages.forEach(m => {
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

                    activeFolders.forEach(folder => {
                        const uriKey = folder.uri.toString();
                        const settings = folderSettings[uriKey] || { tree: true, content: true };

                        statsPromises.push((async () => {
                            if (signal.aborted) return;
                            try {
                                let treeTokens = 0;
                                let filesTokens = 0;

                                // 1. Tree Weight
                                if (settings.tree) {
                                    const folderTree = await self._contextManager.generateIsolatedProjectTree(folder, signal, self._discussionCapabilities);
                                    const res = await getTokenCount(folderTree);
                                    treeTokens = res.count;
                                }

                                // 2. Content Weight (Fast Heuristic from Cache/Stats)
                                if (settings.content) {
                                    const provider = self._contextManager.getContextStateProvider();
                                    const included = provider?.getIncludedFiles() || [];

                                    for (const file of included) {
                                        const resolution = await self._contextManager.resolveWorkspaceFromPath(file.path);
                                        if (resolution?.folder?.uri.toString() === uriKey) {
                                            const cached = (self._contextManager as any)._fileContentCache.get(file.path);
                                            if (cached) {
                                                filesTokens += Math.ceil(cached.content.length / 3.5);
                                            } else {
                                                try {
                                                    const stats = await vscode.workspace.fs.stat(resolution.uri);
                                                    filesTokens += Math.ceil(stats.size / 3.5);
                                                } catch {}
                                            }
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
                        results = await Promise.all([
                            getTokenCount(systemText),
                            getTokenCount(historyText),
                            getTokenCount(context.projectTree),
                            getTokenCount(context.skillsContent || ""),
                            getTokenCount(projectMemory || ""),
                            getTokenCount(briefingText || ""),
                            diagramText,
                            self._lollmsAPI.getContextSize(modelForTokenization).catch(e => {
                                Logger.error(`[TokenStats] Context Size API critically failed: ${e.message}`);
                                return { context_size: 128000, isEstimation: true }; 
                            }),
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
                        isLimitApproximate = !!contextSizeRes.isEstimation && !contextSizeRes.isUserDefined;
                        isUserDefined = !!contextSizeRes.isUserDefined;
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

                    const contentTokens = Math.ceil((filteredFilesText || '').length / 3.5) || 0;
                    const skillTokens = Number((skillsRes as any)?.count) || 0;
                    const systemTokens = Number((systemRes as any)?.count) || 0;
                    const historyTokens = Number((historyRes as any)?.count) || 0;
                    const treeTokens = Number((treeRes as any)?.count) || 0;
                    const memoryTokens = Number((memoryRes as any)?.count) || 0;
                    const briefingTokens = Number((briefingRes as any)?.count) || 0;
                    const diagramTokens = Number((diagramRes as any)?.count) || 0;
                    const safeImageTokens = Number(imageTokens) || 0;

                    const totalTokens = Math.max(0, 
                        (Number(systemTokens) || 0) + 
                        (Number(briefingTokens) || 0) +
                        (Number(historyTokens) || 0) + 
                        (Number(treeTokens) || 0) + 
                        (Number(contentTokens) || 0) + 
                        (Number(skillTokens) || 0) + 
                        (Number(memoryTokens) || 0) + 
                        (Number(diagramTokens) || 0) + 
                        (Number(safeImageTokens) || 0)
                    );

                    const segments = {
                        system: Number(systemTokens) || 0,
                        briefing: Number(briefingTokens) || 0,
                        tree: Number(treeTokens) || 0,
                        skills: Number(skillTokens) || 0,
                        memory: Number(memoryTokens) || 0,
                        diagrams: Number(diagramTokens) || 0,
                        files: Number(contentTokens) || 0,
                        history: Number(historyTokens) || 0,
                        images: Number(safeImageTokens) || 0
                    };

                    if (self._currentDiscussion) {
                        self._currentDiscussion.lastTokenMetrics = {
                            total: totalTokens,
                            contextSize: finalCtxSize,
                            segments: segments
                        };
                        if (!self._currentDiscussion.id.startsWith('temp-')) {
                            await self._discussionManager.saveDiscussion(self._currentDiscussion);
                        }
                    }

                    if (self._panel && self._panel.webview) {
                        const metricsStr = JSON.stringify({ totalTokens, finalCtxSize, segments });
                        if ((self as any)._lastSentMetricsStr !== metricsStr) {
                            (self as any)._lastSentMetricsStr = metricsStr;
                            self._panel.webview.postMessage({
                                command: 'updateTokenProgress',
                                totalTokens: totalTokens,
                                contextSize: finalCtxSize,
                                isApproximate: isLimitApproximate,
                                segments: segments
                            });
                        }

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
                    if (error.name === "Operation cancelled" || signal.aborted) {
                        self.log("Context update cancelled.", 'INFO');
                        if (self._panel && self._panel.webview && !self._isDisposed) {
                            self._panel.webview.postMessage({ command: 'tokenCalculationFinished' });
                            self._panel.webview.postMessage({ command: 'hideProjectLoader' });
                        }
                        return resolvePromise();
                    }

                    Logger.error(`[TokenStats] API Pipeline Failed! Error: ${error.message}`);

                    if (self._isDisposed) return resolvePromise();

                    try {
                        const contextSizeRes = await self._lollmsAPI.getContextSize(modelForTokenization).catch(() => null);
                        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
                        let finalCtxSize = 128000;
                        let isLimitApproximate = true;

                        if (contextSizeRes && contextSizeRes.context_size > 0) {
                            finalCtxSize = contextSizeRes.context_size;
                            isLimitApproximate = !!contextSizeRes.isEstimation && !contextSizeRes.isUserDefined;
                        } else {
                            const manualOverride = config.get<number>('failsafeContextSize') || 0;
                            if (manualOverride > 0) {
                                finalCtxSize = manualOverride;
                                isLimitApproximate = false;
                            } else {
                                finalCtxSize = 128000;
                                isLimitApproximate = true;
                            }
                        }

                        const folderStats: Record<string, { tree: number, files: number }> = {};
                        const activeFolders = vscode.workspace.workspaceFolders || [];
                        activeFolders.forEach(f => folderStats[f.uri.toString()] = { tree: 0, files: 0 });

                        self.log("updateContextAndTokens: Building context fallback...");
                        const context = await self._contextManager.getContextContent({ signal }).catch(() => ({
                            text: '', projectTree: '', selectedFilesContent: '', skillsContent: '', images: [], importedSkills: []
                        }));

                        if (signal.aborted) {
                            if (self._panel && self._panel.webview && !self._isDisposed) {
                                self._panel.webview.postMessage({ command: 'tokenCalculationFinished' });
                                self._panel.webview.postMessage({ command: 'hideProjectLoader' });
                            }
                            return resolvePromise();
                        }

                        const historyText = self._currentDiscussion!.messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
                        const systemText = await getProcessedSystemPrompt('chat', self._discussionCapabilities, undefined, undefined, false, { ...context, tree: '', files: '' });

                        const wordCount = (context.text + '\n' + historyText + '\n' + (systemText || '')).trim().split(/\s+/).length;
                        const estimatedTokens = Math.ceil(wordCount * 1.35);
                        Logger.warn(`[TokenStats] Recovered after context error. Estimated Tokens: ${estimatedTokens}, Capacity: ${finalCtxSize}`);

                        const systemTokens = Math.ceil((systemText?.length || 0) / 3.5);
                        const historyTokens = Math.ceil((historyText?.length || 0) / 3.5);
                        const treeTokens = Math.ceil((context.projectTree?.length || 0) / 3.5);
                        const filesTokens = Math.ceil((context.selectedFilesContent?.length || 0) / 3.5);
                        const skillsTokens = Math.ceil((context.skillsContent?.length || 0) / 3.5);
                        const briefingTokens = Math.ceil((briefingText?.length || 0) / 3.5);
                        const diagramTokens = Math.ceil((diagramText?.length || 0) / 3.5);

                        const projectMemory = (self._discussionCapabilities.projectMemoryEnabled !== false && self.agentManager?.projectMemoryManager)
                            ? await self.agentManager.projectMemoryManager.getFormattedMemoryBlock(historyText, self._skillsManager)
                            : "";
                        const memoryTokens = Math.ceil((projectMemory.length || 0) / 3.5);

                        const totalTokens = systemTokens + historyTokens + treeTokens + filesTokens + skillsTokens + memoryTokens + briefingTokens + diagramTokens;

                        if (self._panel && self._panel.webview && !self._isDisposed) {
                            self._panel.webview.postMessage({
                                command: 'updateTokenProgress',
                                totalTokens: totalTokens,
                                contextSize: finalCtxSize,
                                isApproximate: isLimitApproximate,
                                folderStats: folderStats,
                                segments: {
                                    system: systemTokens,
                                    briefing: briefingTokens,
                                    tree: treeTokens,
                                    skills: skillsTokens,
                                    memory: memoryTokens,
                                    diagrams: diagramTokens,
                                    files: filesTokens,
                                    history: historyTokens,
                                    images: 0
                                }
                            });

                            self._panel.webview.postMessage({ command: 'updateStatus', status: 'Ready (Approx)', type: 'warning' });
                        }

                    } catch (fallbackError: any) {
                        self.log(`Fallback token calculation failed: ${fallbackError.message}`, 'ERROR');
                        if (self._panel && self._panel.webview && !self._isDisposed) {
                            self._panel.webview.postMessage({
                                command: 'updateTokenProgress',
                                error: `API Error`
                            });
                            self._panel.webview.postMessage({ command: 'updateStatus', status: 'Error scanning context', type: 'error' });
                        }
                    } finally {
                        if (self._panel && self._panel.webview && !self._isDisposed) {
                            self._panel.webview.postMessage({ command: 'tokenCalculationFinished' });
                            self._panel.webview.postMessage({ command: 'hideProjectLoader' });
                        }
                        resolvePromise();
                    }
                } finally {
                    self._isTokenizing = false;
                    if (self._tokenAbortController === signal) {
                        self._tokenAbortController = null;
                    }
                }
            } catch (outerErr: any) {
                Logger.error(`[TokenStats] Outer API Pipeline error: ${outerErr.message}`);
                self._panel.webview.postMessage({ command: 'tokenCalculationFinished' });
                self._panel.webview.postMessage({ command: 'hideProjectLoader' });
                resolvePromise();
            }
        }, 400); // 400ms High-Performance debouncing interval
    });
  }
    /**
    * Helper to strip file blocks from context data if their parent folder is muted in the matrix.
    */
    private async _getFilteredFilesContent(contextData: ContextResult, folderSettings: any): Promise<string> {
        const folders = vscode.workspace.workspaceFolders || [];
        // Parse the raw markdown blocks reliably using a regex that captures the entire fenced code block
        const blockRegex = /```([\w-]+)?:([^\r\n]+)[\r\n]+([\s\S]*?)[\r\n]+```/g;
        const filteredBlocks: string[] = [];
        let match;

        while ((match = blockRegex.exec(contextData.selectedFilesContent)) !== null) {
            const lang = match[1] || '';
            const filePath = match[2].trim();
            const content = match[3];

            const isMultiRoot = folders.length > 1;
            const ownerFolder = folders.find(f => {
                if (isMultiRoot) {
                    return filePath.startsWith(f.name + '/');
                }
                return true;
            });

            let shouldInclude = true;
            if (ownerFolder) {
                const settings = folderSettings[ownerFolder.uri.toString()];
                if (settings && settings.content === false) {
                    shouldInclude = false;
                }
            }

            if (shouldInclude) {
                // Reconstruct the block ensuring it has a clean trailing newline and the required closing backticks
                const formattedContent = content.endsWith('\n') ? content : content + '\n';
                filteredBlocks.push(`\`\`\`${lang}:${filePath}\n${formattedContent}\`\`\``);
            }
        }

        return filteredBlocks.join('\n\n');
    }

    private async waitForWebviewReady() { if (this._isWebviewReady) return; return this._viewReadyPromise; }
  
  public async setInputText(text: string) {
      this._initialPrompt = text;
      if (this._isDisposed) return;
      await this.waitForWebviewReady();
      if (!this._isDisposed) {
          this._panel.webview.postMessage({ command: 'setInputText', text });
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
      let currentBriefing = "";
      let isGlobal = false;
      
      if (disc && disc.discussion_data_zone) {
          try {
              const parsed = JSON.parse(disc.discussion_data_zone);
              if (parsed.user_constraints) {
                  currentBriefing = parsed.user_constraints;
              }
          } catch {
              currentBriefing = disc.discussion_data_zone;
          }
      }
      
      if (!currentBriefing && this._contextManager) {
          const globalBriefing = this._contextManager.getGlobalBriefing();
          if (globalBriefing) {
              currentBriefing = globalBriefing;
              isGlobal = true;
          }
      }

      let dna = "";
      if (this.agentManager?.projectMemoryManager) {
          dna = await this.agentManager.projectMemoryManager.getFormattedMemoryBlock();
      }

      this._panel.webview.postMessage({
          command: 'openMissionBriefingModal',
          briefing: currentBriefing,
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

  private async handleImportSkills() {
    // 1. Show the UI immediately with loading state
    this._panel.webview.postMessage({ command: 'showSkillsModal', loading: true });

    // 2. Invalidate cache to ensure we pick up manually added files
    this._skillsManager.invalidateCache();

    // 3. Perform the heavy disk operations asynchronously
    const allSkills = await this._skillsManager.getSkills();
    
    if (allSkills.length === 0) {
        this._panel.webview.postMessage({ command: 'closeSkillsModal' });
        vscode.window.showInformationMessage("No saved skills found.");
        return;
    }

    const projectSkills = await this._contextManager.getActiveProjectSkills();
    const discussionSkills = this._currentDiscussion?.importedSkills ||[];

    const root: any = { id: 'root', label: 'Skills Library', children:[], isSkill: false };
    const globalRoot = { id: 'global-lib', label: 'Global Library', children: [], isSkill: false, isBundle: true };
    const projectRoot = { id: 'project-lib', label: 'Project Library', children: [], isSkill: false, isBundle: true };
    root.children.push(globalRoot, projectRoot);

    allSkills.forEach(skill => {
        const category = skill.category || 'Uncategorized';
        const parts = category.replace(/\\/g, '/').split('/').filter(p => p);
        
        // Route to the correct library branch based on scope
        let current = skill.scope === 'global' ? globalRoot : projectRoot;
        let pathSoFar = skill.scope;
        
        // Build/Navigate Categories within that branch
        parts.forEach(part => {
            pathSoFar = `${pathSoFar}/${part}`;
            let existing = current.children.find((c:any) => c.label === part && !c.isSkill);
            if (!existing) {
                existing = { id: pathSoFar, label: part, children: [], isSkill: false, isBundle: true };
                current.children.push(existing);
            }
            current = existing;
        });
        
        // Add Skill Leaf
        current.children.push({
            id: skill.id,
            label: skill.name,
            isSkill: true,
            description: skill.description,
            skill: skill 
        });
    });

    this._panel.webview.postMessage({ 
        command: 'showSkillsModal', 
        skillsTree: root,
        discussionSkills: discussionSkills,
        projectSkills: projectSkills
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
                // Handle multiple SEARCH/REPLACE blocks within the same content
                const aiderRegex = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======(?:\r?\n(?!>>>>>>> REPLACE)([\s\S]*?))?\r?\n>>>>>>> REPLACE/g;
                const matches =[...blockContent.matchAll(aiderRegex)];
                
                if (matches.length > 0) {
                    let currentFileState = originalFileText;
                    let allSuccess = true;
                    let firstError = "";

                    for (const match of matches) {
                        const searchPart = match[1] || "";
                        const replacePart = match[2] || "";
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
              
              progress.report({ message: "Extracting file contents..." });
              const contextData = await this._contextManager.getContextContent({ 
                  importedSkillIds: importedIds,
                  modelName: this._currentDiscussion?.model || this._lollmsAPI.getModelName()
              });
              
              // --- MATRIX FILTERED EXPORT ---
              const folderSettings = this._discussionCapabilities.folderSettings || {};
              const filteredFilesContent = await this._getFilteredFilesContent(contextData, folderSettings);

              // Ensure that if the filtered files content is missing a final closing code fence, we append it
              let safeFilesContent = filteredFilesContent;
              if (safeFilesContent && !safeFilesContent.trim().endsWith('```')) {
                  safeFilesContent = safeFilesContent.trim() + '\n```';
              }

              const context = {
                  tree: contextData.projectTree,
                  files: safeFilesContent,
                  skills: contextData.skillsContent,
                  toolManager: this.agentManager?.['toolManager'] // Pass the toolbelt reference
              };

              let memoryBlock = "";
              if (this._discussionCapabilities.projectMemoryEnabled !== false && this.agentManager?.projectMemoryManager) {
                  progress.report({ message: "Reading project memory..." });
                  memoryBlock = await this.agentManager.projectMemoryManager.getFormattedMemoryBlock();
              }

              progress.report({ message: "Processing system prompt..." });
              const personaContent = this.getCurrentPersonaSystemPrompt();
              const systemPrompt = await getProcessedSystemPrompt('chat', this._discussionCapabilities, personaContent, undefined, forceFullCode, { ...context, tree: '', files: '' });
              
              const projectName = contextData.projectName || "Unknown Project";
              let fullText = `
# 🧊 PROJECT SNAPSHOT: ${projectName.toUpperCase()} FOR EXTERNAL LLM
The following project state was exported from VS Code. 

## 📜 CORE INSTRUCTIONS & PERSONA
${systemPrompt}

${context.tree || 'No tree provided.'}

${context.files || '## 📄 FILE CONTENTS\nNo files selected.'}

${context.skills ? `## 🎓 ACTIVE SKILLS\n${context.skills}` : ''}

${memoryBlock ? `## 🧠 PROJECT MEMORY\n${memoryBlock}\n` : ''}

---

## 🕒 CHAT HISTORY
`.trim() + "\n\n";

              if (this._currentDiscussion) {
                  this._currentDiscussion.messages
                      .filter(m => !m.skipInPrompt)
                      .forEach(m => {
                          const content = Array.isArray(m.content) ? m.content.map(c => c.type === 'text' ? c.text : '[Image]').join('\n') : m.content;
                          fullText += `### ${m.role.toUpperCase()}\n${content}\n\n`;
                      });
              }
              
              if (draftMessage && draftMessage.trim()) {
                  fullText += `--- \n\n# 🎯 CURRENT REQUEST\n${draftMessage}\n`;
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
    if (targetMsg.id?.startsWith('attachment_')) {
        this._currentDiscussion.messages.splice(index, 1);
        this.log(`Deleted specific attachment: ${targetMsg.id}`);
    } else {
        // Otherwise, truncate from index onwards (Standard chat behavior)
        this._currentDiscussion.messages.splice(index);
        this.log(`Deleted messages starting from index ${index}.`);
    }

    // Explicitly update in-memory caches to align with the deleted state
    this.chatHistory = [...this._currentDiscussion.messages];
    if (this.agentManager) {
        this.agentManager.chatHistory = [...this._currentDiscussion.messages];
    }

    // 3. Persist to disk
    if (!this._currentDiscussion.id.startsWith('temp-')) {
        await this._discussionManager.saveDiscussion(this._currentDiscussion);
    }

    // 4. Refresh UI
    await this.loadDiscussion();
    
    // 5. Refresh sidebar tree
    vscode.commands.executeCommand('lollms-vs-coder.refreshDiscussions');
  }
  
  private async regenerateFromMessage(messageId: string) {
      if (!this._currentDiscussion) return;
      const index = this._currentDiscussion.messages.findIndex(m => m.id === messageId);
      if (index === -1) return;
      
      const messageToResend = this._currentDiscussion.messages[index];
      if (messageToResend.role !== 'user') return;

      this.processManager.cancelForDiscussion(this.discussionId);
      ChatPanel.activeGenerations.delete(this.discussionId);

      this._currentDiscussion.messages = this._currentDiscussion.messages.slice(0, index);

      if (!this._currentDiscussion.id.startsWith('temp-')) {
          await this._discussionManager.saveDiscussion(this._currentDiscussion);
      }

      await this.loadDiscussion();

      // FIXED: Respect Agent Mode during regeneration
      if (this._discussionCapabilities.agentMode) {
           await this.sendMessage(messageToResend); // This now correctly routes to AgentManager
      } else {
           await this.sendMessage(messageToResend);
      }
  }
  
  private async insertMessage(afterMessageId: string | null, role: 'user' | 'assistant', content: string) {
      if (!this._currentDiscussion) return;
      const newMessage: ChatMessage = {
          id: role + '_' + Date.now(),
          role: role,
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
      if (!this._currentDiscussion.id.startsWith('temp-')) {
          await this._discussionManager.saveDiscussion(this._currentDiscussion);
      }
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
          if (isImage) {
              const msg: ChatMessage = {
                  id: 'user_img_' + Date.now() + Math.random().toString(36).substring(2),
                  role: 'user',
                  content:[
                      { type: 'text', text: `Attached image: ${name}` },
                      { type: 'image_url', image_url: { url: content } }
                  ]
              };
              await this.addMessageToDiscussion(msg);
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
              // Write the parsed document to a non-ignored external cache folder so it is not strictly blocked by ContextStateProvider
              const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
              if (workspaceFolder && text.trim().length > 0) {
                  const cacheDir = vscode.Uri.joinPath(workspaceFolder.uri, 'external');
                  await vscode.workspace.fs.createDirectory(cacheDir).then(undefined, () => {});

                  const safeName = name.replace(/[^a-zA-Z0-9.]/g, '_');
                  const fileUri = vscode.Uri.joinPath(cacheDir, safeName);

                  await vscode.workspace.fs.writeFile(fileUri, Buffer.from(text, 'utf8'));

                  const relativePath = path.join('external', safeName).replace(/\\/g, '/');
                  await this._contextManager.getContextStateProvider()?.addFilesToContext([relativePath]);
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
          
          if (!options?.isAgentZone) {
            this.addMessageToDiscussion({
                id: 'agent_request_' + Date.now(),
                role: 'assistant',
                content: question,
                model: this._currentDiscussion?.model || this._lollmsAPI.getModelName()
            });
          }
          
          this.updateGeneratingState();

          const disposable = signal.addEventListener('abort', () => {
              if (this._inputResolver === resolve) {
                  this._inputResolver = null;
                  reject(new Error("Input request aborted."));
              }
          });
      });
  }


  public async sendMessage(message: ChatMessage, autoContext: boolean = false) {
    if (this._isDisposed || !this._currentDiscussion || !this.processManager) return;

    await this.waitForWebviewReady();

    // Force strict alignment of conversation state caches before building prompts
    this.chatHistory = [...this._currentDiscussion.messages];
    if (this.agentManager) {
        this.agentManager.chatHistory = [...this._currentDiscussion.messages];
    }

    // Declare configuration, targetModel, and folders at the outer scope of the function so they are universally accessible to all nested closures and blocks
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    const targetModel = this._currentDiscussion?.model || this._lollmsAPI.getModelName();
    const folders = vscode.workspace.workspaceFolders;

    // 1. Immediately extract the active persona and its system prompt to avoid temporal dead zone errors
    const currentP = this.getCurrentPersona();
    const personaContent = currentP?.systemPrompt || "";
    const personaName = currentP?.name || "Lollms";

    // Register process and instantiate AbortController so cancel buttons work reliably
    const proc = this.processManager.register(this.discussionId, 'Lollms: Preparing workspace context...');
    const processId = proc.id;
    let controller = proc.controller; // Use 'let' so it can be re-assigned in self-correction

    // 1.5 Sync capabilities to catch any changes from background tasks
    this._discussionCapabilities = this._currentDiscussion.capabilities || this._discussionCapabilities;

    // --- 1. PRESERVE USER CONTENT IMMEDIATELY (INSTANT MATERIALIZATION) ---
    const userMessage: ChatMessage = { 
        ...message, 
        id: message.id || 'user_' + Date.now() + Math.random().toString(36).substring(2),
        timestamp: Date.now()
    };

    // Add user message to discussion history and render it in the webview instantly
    await this.addMessageToDiscussion(userMessage);

    // Turn off the webview's input loading state and trigger immediate "Thinking" display
    this.processManager.updateDescription(processId, "Preparing workspace context...");
    this.updateGeneratingState();

    // Route to Agent Manager if Agent Mode is active
    if (this._discussionCapabilities.agentMode && folders && folders.length > 0) {
        const objectiveText = typeof message.content === 'string' 
            ? message.content 
            : (Array.isArray(message.content) 
                ? message.content.find((p: any) => p.type === 'text')?.text || "Run task"
                : "Run task");

        // Hand off control to the Agent's ReAct planning loop asynchronously to prevent blocking the thread
        setImmediate(async () => {
            await this.agentManager.handleUserMessage(
                objectiveText,
                this._currentDiscussion,
                folders[0]
            );
        });
        return;
    }

    // Code Graph is used to resolve context on-demand; legacy non-unified Librarian/AutoSkill agents removed.
    const hasWorkspace = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;

    // --- DEBUG SANDBOX BRANCH CREATION (PRE-WORKER) ---
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

    // --- 2. DEFER EXPENSIVE CONTEXT ASSEMBLY TO BACKGROUND EVENT LOOP ---
    // Using a yielding delay lets the VS Code main thread paint the UI, clear the text box,
    // and reveal the "Thinking..." status instantly without any lagging or stuttering.
    await new Promise(resolve => setTimeout(resolve, 30));

    if (this._discussionCapabilities.herdMode && this.herdManager) {
        this.processManager.updateDescription(processId, "🐂 Planning herd...");
        this.updateGeneratingState();

        try {
            const promptText = typeof message.content === 'string' 
                ? message.content : 'User rich content.';
            const herdMessageId = 'herd_log_' + Date.now();

            const orchestrator = this._discussionCapabilities.herdOrchestratorModel 
                || this._currentDiscussion.model 
                || this._lollmsAPI.getModelName();

            const config = vscode.workspace.getConfiguration('lollmsVsCoder');
            const modelPool = config.get<any[]>('herdDynamicModelPool') || [];
            const maxRounds = this._discussionCapabilities.herdRounds || 3;

            await this.addMessageToDiscussion({ 
                id: herdMessageId, 
                role: 'system', 
                content: `### 🐂 Herd Discussion\n\n*Planning team...*`, 
                skipInPrompt: true 
            });

            // Always plan first — this assigns personas to models
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

            // plan is null only if modelPool was empty — use empty arrays and
            // let herdManager's fallback archetypes kick in via buildFallbackHerd.
            // But buildFallbackHerd needs a pool, so if pool is empty we warn.
            if (!plan) {
                await this.updateMessageContent(herdMessageId, 
                    `### 🐂 Herd Discussion\n\n❌ No model pool configured. Add models to \`lollmsVsCoder.herdDynamicModelPool\` in settings.`
                );
                this.processManager.unregister(processId);
                this.updateGeneratingState();
                return;
            }

            this.processManager.updateDescription(processId, "🐂 Herd thinking...");

            // Fetch context data safely
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
                plan.pre,                   // brainstorming participants (with personas)
                plan.post,                  // review participants (with personas)
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
    try {
        // 🛑 FINAL WORKFLOW GATE: Prevent main generation if a sub-agent was stopped
        if (controller?.signal.aborted) {
            if (processId) this.processManager.unregister(processId);
            this.updateGeneratingState();
            return;
        }

        this.processManager.updateDescription(processId, "Waiting for model...");
        this.updateGeneratingState();

        const forceFullCode = this._discussionCapabilities?.forceFullCode || false;

        const importedIds = this._currentDiscussion?.importedSkills || [];
        const isContextMuted = this._discussionCapabilities?.disableProjectContext === true;

        // Fetch contextData lexically before utilizing it in sendMessage
        const contextData = await this._contextManager.getContextContent({
            importedSkillIds: importedIds,
            includeTree: !isContextMuted,
            modelName: targetModel,
            signal: controller.signal
        });

        const projectMemory = (this._discussionCapabilities.projectMemoryEnabled !== false && this.agentManager?.projectMemoryManager)
            ? await this.agentManager.projectMemoryManager.getFormattedMemoryBlock(typeof message.content === 'string' ? message.content : '', this._skillsManager)
            : "";

        const localContext = { 
            tree: contextData.projectTree, 
            files: contextData.selectedFilesContent, 
            skills: contextData.skillsContent,
            memory: projectMemory
        };

        // 1. Get Base System Instructions (VS Code Interface Tools, Skills, Rules) using localContext
        const baseInstructions = await getProcessedSystemPrompt(
            'chat', 
            this._discussionCapabilities, 
            personaContent, 
            undefined, 
            forceFullCode, 
            { 
                ...localContext, 
                tree: '', 
                files: '', 
                projectName: contextData.projectName,
                toolManager: this.agentManager?.['toolManager']
            } 
        );

        // 2. Prepare the Bundled Project Context Message (User role)
        const briefing = this._contextManager.renderBriefing(this._currentDiscussion);

        const projectStateText = `
### 📂 ATTACHED PROJECT CONTEXT
I am providing you with the current, ground-truth state of my project files and the Librarian's technical briefing. 
Use this information as your current "vision" of the workspace.

${briefing && !briefing.includes("Librarian is analyzing") ? `#### 📋 TEAM TECHNICAL BRIEFING\n${briefing}\n` : ""}
${localContext.tree ? `#### 🌳 PROJECT STRUCTURE\n${localContext.tree}\n` : ""}
${localContext.files ? `#### 📄 FILE CONTENTS\n${localContext.files}` : "*(No files currently selected)*"}
--------------------------------------------------
`.trim();

        // --- MULTIMODAL INJECTION ---
        let projectContextContent: any = projectStateText;
        if (this._discussionCapabilities.enableImages !== false && contextData.images.length > 0) {
            projectContextContent = [
                { type: 'text', text: projectStateText }
            ];
            contextData.images.forEach(img => {
                projectContextContent.push({
                    type: 'image_url',
                    image_url: { url: img.data }
                });
            });
        }

        const projectContextUserMessage: ChatMessage = {
            role: 'user',
            content: projectContextContent
        };

        // 3. Prepare Chronological History
        const allMessages = this._currentDiscussion.messages.filter(m => !m.skipInPrompt);
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

        // --- CO-ENGINEER (DYNAMIC) MODE LOOP LAYER ---
        const isDynamicMode = this._discussionCapabilities.dynamicMode === true;
        const originalIncludedFiles = this._contextManager.getContextStateProvider()?.getIncludedFiles() || [];

        let currentTurnIndex = 0;
        const maxTurnsLimit = 8;
        const completedDynamicActions: string[] = [];

        // Retries & repetition safeguards state
        let consecutiveFailsCount = 0;
        const maxFailsAllowed = 3;
        let lastExecutedFingerprint = "";

        assistantMessageId = 'assistant_' + Date.now().toString() + Math.random().toString(36).substring(2);

        // Keep local reference to allow updates to the same bubble
        let currentFullResponseBuffer = "";

        if (isDynamicMode) {
            const initialAssistantMessage: ChatMessage = {
                id: assistantMessageId,
                role: 'assistant',
                content: '',
                startTime: Date.now(),
                model: targetModel,
                personalityName: personaName,
                timestamp: Date.now()
            };

            // Mount the single visible assistant bubble in the discussion history and UI
            await this.addMessageToDiscussion(initialAssistantMessage, true);

            // Maintain the internal conversational thread context used during the multi-turn loop
            const loopMessages: ChatMessage[] = [
                { role: 'system', content: baseInstructions },
                ...history,
                projectContextUserMessage
            ];
            if (currentPromptMessage) {
                loopMessages.push(currentPromptMessage);
            }

            const runTurn = async () => {
                if (controller?.signal.aborted || currentTurnIndex >= maxTurnsLimit) return;
                currentTurnIndex++;

                if (consecutiveFailsCount >= maxFailsAllowed) {
                    const finalErrorMsg = `\n\n🛑 **CO-ENGINEER MODE TERMINATED**: Exceeded maximum self-correction retries (${maxFailsAllowed}). Please adjust your prompt.`;
                    currentFullResponseBuffer += finalErrorMsg;
                    await this.updateMessageContent(assistantMessageId, currentFullResponseBuffer);
                    return;
                }

                // Recalculate on-demand context weights to keep track of dynamic folder/file selections
                const currentData = await this._contextManager.getContextContent({ 
                    importedSkillIds: importedIds,
                    includeTree: !isContextMuted,
                    modelName: targetModel 
                });

                // Check context window boundary against the 85% safety threshold
                const tokenCheck = await this._lollmsAPI.tokenize(currentData.text, targetModel);
                const limitCheck = await this._lollmsAPI.getContextSize(targetModel);
                const usageRatio = tokenCheck.count / limitCheck.context_size;

                if (usageRatio > 0.85) {
                    this.log(`[Token Economy] Active context near capacity: ${Math.round(usageRatio * 100)}%`);
                    const warningMsg = `\n\n⚠️ **TOKEN BUDGET EXCEEDED**: Your active context has reached **${Math.round(usageRatio * 100)}%** capacity. Please use \`remove_files\` to release unused file slots.`;
                    currentFullResponseBuffer += warningMsg;
                    await this.updateMessageContent(assistantMessageId, currentFullResponseBuffer);
                    completedDynamicActions.push(`⚠️ WARNING: Exceeded 85% token budget.`);
                }

                // Format the memory scratchpad and append it to the active prompt context
                const scratchpadBlock = completedDynamicActions.length > 0 
                    ? `\n### 🧠 MEMORY SCRATCHPAD (YOUR COMPLETED RESEARCH STEPS)\n` + 
                      completedDynamicActions.map((a, i) => `${i+1}. ${a}`).join('\n')
                    : "";

                const isFinalTurn = currentTurnIndex > 1 && !currentFullResponseBuffer.match(/<(add_files_to_context|query_architecture|lollms_tool|search_web)/);
                const isCodeUpdate = typeof message.content === 'string' && (message.content.toLowerCase().includes('fix') || message.content.toLowerCase().includes('update') || message.content.toLowerCase().includes('write'));

                const profileId = (isFinalTurn && isCodeUpdate) ? (this._discussionCapabilities.responseProfileId || 'balanced') : 'minimalist';
                const activeProfile = (config.get('responseProfiles') || []).find((p: any) => p.id === profileId) || { name: 'Minimalist', systemPrompt: '' };

                const finalBaseInstructions = await getProcessedSystemPrompt(
                    'chat', 
                    this._discussionCapabilities, 
                    personaContent + `\n\n${activeProfile.systemPrompt}`, 
                    undefined, 
                    forceFullCode, 
                    { 
                        ...localContext, 
                        tree: !isContextMuted ? currentData.projectTree : '', 
                        files: currentData.selectedFilesContent, 
                        projectName: currentData.projectName || folders?.[0]?.name || "Workspace",
                        toolManager: this.agentManager?.['toolManager']
                    } 
                );

                // Update the system instructions for this specific generation turn
                loopMessages[0] = { role: 'system', content: finalBaseInstructions };

                let turnResponse = "";
                this.processManager.updateDescription(processId, `Co-Engineer Turn ${currentTurnIndex}: Generating...`);
                this.updateGeneratingState();

                try {
                    // Standard generation pass: Webview is used ONLY for streaming the letters
                    await this._lollmsAPI.sendChat(loopMessages, (chunk) => {
                        if (controller?.signal.aborted) return;
                        turnResponse += chunk;
                        currentFullResponseBuffer += chunk;

                        // Stream chunk to UI
                        this._panel.webview.postMessage({ 
                            command: 'appendMessageChunk', 
                            id: assistantMessageId, 
                            chunk: chunk 
                        });
                    }, controller.signal, this._currentDiscussion!.model, {
                        capabilities: this._discussionCapabilities,
                        temperature: this._discussionCapabilities.temperature
                    });
                } catch (err: any) {
                    if (err.name !== 'AbortError') {
                        throw err;
                    }
                }

                if (controller?.signal.aborted) return;

                // --- POST-STREAM PARSING & EXECUTION SHIELD ---
                // Only now that the generation is fully complete, we parse the completed response
                // for naked tag patterns outside of markdown fences.
                
                // Helper to identify boundaries of triple backtick fences in the text to ignore them
                const protectedRanges: { start: number, end: number }[] = [];
                const fenceRegex = /```[\s\S]*?(?:```|$)/g;
                let fMatch;
                while ((fMatch = fenceRegex.exec(turnResponse)) !== null) {
                    protectedRanges.push({ start: fMatch.index, end: fMatch.index + fMatch[0].length });
                }

                const isIndexInsideFence = (index: number) => {
                    return protectedRanges.some(r => index >= r.start && index < r.end);
                };

                // Find valid file manipulation or query actions on a line-start basis
                const patterns = [
                    { tag: 'add_files_to_context', pattern: /^[ \t]*<add_files_to_context>([\s\S]*?)<\/add_files_to_context>/gim },
                    { tag: 'remove_files_from_context', pattern: /^[ \t]*<remove_files_from_context>([\s\S]*?)<\/remove_files_from_context>/gim },
                    { tag: 'query_architecture', pattern: /^[ \t]*<query_architecture>([\s\S]*?)<\/query_architecture>/gim },
                    { tag: 'lollms_tool', pattern: /^[ \t]*<lollms_tool>([\s\S]*?)<\/lollms_tool>/gim }
                ];

                let interceptedTag: string | null = null;
                let interceptedParams: string | null = null;

                for (const item of patterns) {
                    item.pattern.lastIndex = 0;
                    let pMatch;
                    while ((pMatch = item.pattern.exec(turnResponse)) !== null) {
                        if (!isIndexInsideFence(pMatch.index)) {
                            interceptedTag = item.tag;
                            interceptedParams = pMatch[1].trim();
                            break;
                        }
                    }
                    if (interceptedTag) break;
                }

                if (interceptedTag) {
                    this.processManager.updateDescription(processId, `Executing tool: ${interceptedTag}...`);
                    this.updateGeneratingState();

                    // Synchronize the current text buffer to the persistent database before running
                    await this.updateMessage(assistantMessageId, currentFullResponseBuffer);

                    let toolResult = "";
                    let isSuccess = true;

                    const currentFingerprint = `${interceptedTag}:${interceptedParams!.trim()}`;
                    const isDuplicateRepetition = (currentFingerprint === lastExecutedFingerprint);
                    lastExecutedFingerprint = currentFingerprint;

                    try {
                        if (isDuplicateRepetition) {
                            isSuccess = false;
                            toolResult = `Error: REPETITIVE CALL DETECTED. You already attempted to call '${interceptedTag}' with these exact parameters. Please change your tactics.`;
                            completedDynamicActions.push(`Attempted identical duplicate tool call (BLOCKED).`);
                        } else if (interceptedTag === 'add_files_to_context') {
                            const filesToAdd = interceptedParams!.split(/[\s\r\n,]+/).map(f => f.trim()).filter(f => f);
                            const hasProjectRoot = filesToAdd.some(f => f === '.' || f === '/' || f === '*');
                            if (hasProjectRoot) {
                                toolResult = "Error: Adding the entire project root folder ('.') is forbidden to prevent context window bloating.";
                                isSuccess = false;
                                completedDynamicActions.push("Attempted project-wide import (BLOCKED).");
                            } else {
                                const added = await this._contextManager.getContextStateProvider()?.addFilesToContext(filesToAdd) || [];
                                if (added.length > 0) {
                                    toolResult = `Success: Added ${added.join(', ')} to context.`;
                                    completedDynamicActions.push("Loaded " + added.length + " files into memory.");
                                } else {
                                    toolResult = `Error: Could not resolve target files. Check if they exist on disk.`;
                                    isSuccess = false;
                                    completedDynamicActions.push("Failed to load requested files (not found).");
                                }
                            }
                        } else if (interceptedTag === 'remove_files_from_context') {
                            const filesToRemove = interceptedParams!.split(/[\s\r\n,]+/).map(f => f.trim()).filter(f => f);
                            const uris = [];
                            for (const p of filesToRemove) {
                                const res = await this._contextManager.resolveWorkspaceFromPath(p);
                                uris.push(res ? res.uri : vscode.Uri.file(p));
                            }
                            await this._contextManager.getContextStateProvider()?.setStateForUris(uris, 'tree-only');
                            toolResult = `Success: Removed ${filesToRemove.join(', ')} from context.`;
                            completedDynamicActions.push(`Removed ${filesToRemove.length} files from active attention.`);
                        } else if (interceptedTag === 'query_architecture') {
                            const sparql = interceptedParams!.trim();
                            const rawResult = this.agentManager.codeGraphManager.executeSparql(sparql);
                            toolResult = rawResult || "No matches.";
                            if (rawResult.includes("Error") || rawResult.includes("failed")) {
                                isSuccess = false;
                            }
                            completedDynamicActions.push(`Executed SPARQL query: "${sparql.split('\n')[0]}..."`);
                        } else if (interceptedTag === 'lollms_tool') {
                            const rawJson = interceptedParams!.trim();
                            let parsedCall: any = {};
                            try {
                                parsedCall = JSON.parse(rawJson);
                            } catch (e) {
                                const repaired = rawJson.replace(/\\`/g, '`').replace(/[\r\n\t]/g, ' ').replace(/,\s*([\]}])/g, '$1');
                                parsedCall = JSON.parse(repaired);
                            }
                            const name = parsedCall.name || "unknown_tool";
                            const parsedParams = parsedCall.arguments || parsedCall.params || {};

                            const toolDef = this.agentManager.getTools().find((t: any) => t.name === name);
                            if (toolDef) {
                                const env = { agentManager: this.agentManager, workspaceRoot: folders[0], contextManager: this._contextManager, lollmsApi: this._lollmsAPI };
                                const result = await toolDef.execute(parsedParams, env, controller.signal);
                                toolResult = result.output;
                                isSuccess = result.success;
                                completedDynamicActions.push(`Executed tool: ${name}`);
                            } else {
                                toolResult = `Error: Tool '${name}' is not equipped or does not exist.`;
                                isSuccess = false;
                                completedDynamicActions.push(`Failed to run tool: ${name} (not found).`);
                            }
                        }
                    } catch (executionErr: any) {
                        isSuccess = false;
                        toolResult = `Runtime Error: ${executionErr.message}`;
                        completedDynamicActions.push(`Crashed executing tool.`);
                    }

                    if (!isSuccess) {
                        consecutiveFailsCount++;
                        completedDynamicActions.push(`Refining... Tool failed with: "${toolResult.substring(0, 100)}..."`);
                    } else {
                        consecutiveFailsCount = 0;
                    }

                    // Append the visual widget tag representation of the executed tool block directly into the chat stream buffer
                    const summaryColor = isSuccess ? '' : 'color:var(--vscode-charts-red);';
                    const headerPrefix = isSuccess ? 'Ran Tool' : 'Tool Failed';

                    let blockWidgetHtml = "";
                    if (interceptedTag === 'add_files_to_context') {
                        const filesToAdd = interceptedParams!.split(/[\s\r\n,]+/).map(f => f.trim()).filter(f => f);
                        blockWidgetHtml = `\n\n<details class="processing-block"><summary style="${summaryColor}"><i class="codicon ${isSuccess ? 'codicon-cloud-download' : 'codicon-error'}"></i> ${isSuccess ? 'Loaded Files Context' : 'File Loading Failed'}: ${filesToAdd.join(', ')}</summary><div class="processing-body">${toolResult}</div></details>\n\n`;
                    } else if (interceptedTag === 'remove_files_from_context') {
                        const filesToRemove = interceptedParams!.split(/[\s\r\n,]+/).map(f => f.trim()).filter(f => f);
                        blockWidgetHtml = `\n\n<details class="processing-block"><summary style="${summaryColor}"><i class="codicon ${isSuccess ? 'codicon-trash' : 'codicon-error'}"></i> ${isSuccess ? 'Pruned Files Context' : 'Pruning Failed'}: ${filesToRemove.join(', ')}</summary><div class="processing-body">${toolResult}</div></details>\n\n`;
                    } else if (interceptedTag === 'query_architecture') {
                        const sparql = interceptedParams!.trim();
                        blockWidgetHtml = `\n\n<details class="processing-block"><summary style="${summaryColor}"><i class="codicon codicon-graph"></i> ${isSuccess ? 'Ran SPARQL Query' : 'SPARQL Query Failed'}</summary><div class="processing-body">\`\`\`sparql\n${sparql}\n\`\`\`\n\n**Result:**\n${toolResult}</div></details>\n\n`;
                    } else {
                        blockWidgetHtml = `\n\n<details class="processing-block"><summary style="${summaryColor}"><i class="codicon codicon-tools"></i> ${headerPrefix}: ${interceptedTag}</summary><div class="processing-body">**Output:**\n${toolResult}</div></details>\n\n`;
                    }

                    currentFullResponseBuffer += blockWidgetHtml;
                    await this.updateMessageContent(assistantMessageId, currentFullResponseBuffer);

                    // Add the results to the internal loop context and trigger next turn
                    loopMessages.push({ role: 'assistant', content: turnResponse });
                    loopMessages.push({ 
                        role: 'user', 
                        content: `### 📋 TOOL EXECUTION RESULT (${interceptedTag})\n${toolResult}\n\nReview this output, adjust your strategy if needed, and continue with the next logical step of the user request.` 
                    });

                    // Recurse into next turn step
                    await runTurn();
                } else {
                    // Final turn completed. Persist clean message to discussion, omitting internal tool artifacts
                    const cleanFinalText = stripThinkingTags(turnResponse).trim();
                    const finalAssistantMessage: ChatMessage = {
                        id: assistantMessageId,
                        role: 'assistant',
                        content: cleanFinalText,
                        model: targetModel,
                        personalityName: personaName,
                        timestamp: Date.now()
                    };
                    
                    // Replace the working dynamic stream message with the clean synthesized one
                    const msgIdx = this._currentDiscussion!.messages.findIndex(m => m.id === assistantMessageId);
                    if (msgIdx !== -1) {
                        this._currentDiscussion!.messages[msgIdx] = finalAssistantMessage;
                    }
                    if (!this._currentDiscussion!.id.startsWith('temp-')) {
                        await this._discussionManager.saveDiscussion(this._currentDiscussion!);
                    }

                    if (!this._isDisposed) {
                        this._panel.webview.postMessage({ 
                            command: 'finalizeMessage', 
                            id: assistantMessageId, 
                            fullContent: currentFullResponseBuffer 
                        });
                    }
                }
            };

            await runTurn();

            // RESTORE STATE CONSTITUTION: Always restore original included files list once loop finishes
            const finalFilesList = originalIncludedFiles.map(f => f.path);
            await this._contextManager.getContextStateProvider()?.softReset();
            await vscode.commands.executeCommand('lollms-vs-coder.addFilesToContext', finalFilesList);

            this.processManager.unregister(processId);
            this.updateGeneratingState();
            return; // Terminate execution to bypass standard non-looping flow below
        }



        // 4. Build Final Sequence for standard (non-dynamic) flow...
        let messagesToSend: ChatMessage[] = [
            { role: 'system', content: baseInstructions },
            ...history,
            projectContextUserMessage
        ];

        if (currentPromptMessage) {
            messagesToSend.push(currentPromptMessage);
        }

        // Determine if temperature override is active and configured
        const reqTemperature = this._discussionCapabilities.enableTemperature ? (this._discussionCapabilities.temperature ?? 0.7) : undefined;

        // =========================================================================
        // 🛡️ CONTEXT GOVERNOR: LLM-DRIVEN SMART PRUNING
        // =========================================================================

        const fileBlocks: { fullMatch: string, path: string, tokens: number, keep: boolean, reason?: string }[] = [];

        const isGovernorEnabled = this._discussionCapabilities.contextGovernorEnabled !== false;

        try {
            const metrics = this._currentDiscussion?.lastTokenMetrics;

            if (isGovernorEnabled && metrics) {
                const totalEstimated = metrics.total;
                const maxTokens = metrics.contextSize;

                // Read User-Defined Threshold (Default to 90 if missing)
                const userThresholdPercent = this._discussionCapabilities.contextGovernorThreshold || 90;
                const triggerThreshold = maxTokens * (userThresholdPercent / 100);

                const fillPercentage = Math.round((totalEstimated / maxTokens) * 100);

                if (totalEstimated > triggerThreshold) {
                    this.processManager.updateDescription(processId, "⚖️ Governor: Analyzing context relevance...");
                    this.updateGeneratingState();

                    const userPromptText = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
                    const overflow = totalEstimated - triggerThreshold;
                    const pruneMsgId = 'system_prune_' + Date.now();

                    // 1. Check for History Overflow (Immutable part)
                    const fixedLoad = metrics.segments.system + metrics.segments.briefing + metrics.segments.history + metrics.segments.images;
                    if (fixedLoad > triggerThreshold) {
                        await this.addMessageToDiscussion({
                            role: 'system',
                            content: `🛑 **Context Overflow Blocked**\nHistory and instructions (~${fixedLoad.toLocaleString()} tokens) exceed your configured ${userThresholdPercent}% threshold (**${maxTokens.toLocaleString()}**).\n\n**To continue:** Delete old messages or start a "New Discussion".`
                        });
                        this.processManager.unregister(processId);
                        this.updateGeneratingState();
                        return;
                    }

                    await this.addMessageToDiscussion({
                        id: pruneMsgId,
                        role: 'system',
                        content: `⚖️ **Context Governor: Pruning Triggered**
        Trigger Reason: Authoritative HUD payload reached **${fillPercentage}%** (${totalEstimated.toLocaleString()} / ${maxTokens.toLocaleString()} tokens).
        *Summoning the Pruning Specialist to optimize relevance based on project structure and mission history...*`,
                        skipInPrompt: true
                    });

                    // 2. Parse file blocks and build peeks
                    const blockRegex = /```(?:\w+)?[:]?([^\n]+)[\r\n]([\s\S]*?)[\r\n]```/g;
                    let fileMatch;
                    while ((fileMatch = blockRegex.exec(contextData.selectedFilesContent)) !== null) {
                        const filePath = fileMatch[1].trim();
                        if (filePath.includes('<<<<<<< SEARCH')) continue;

                        const fileBody = fileMatch[2];
                        const lines = fileBody.split('\n');
                        const peekLines = lines.slice(0, 40).join('\n');
                        const peek = lines.length > 40 ? `${peekLines}\n... [Truncated ${lines.length - 40} lines. Use grep_search if you need more context]` : peekLines;

                        fileBlocks.push({
                            fullMatch: fileMatch[0],
                            path: filePath,
                            tokens: Math.ceil(fileMatch[0].length / 3.5),
                            peek: peek,
                            keep: true 
                        });
                    }

                    // 3. AGENTIC DECISION PASS
                // Provide the LLM with the tree (grounded with markers) and recent history
                const recentHistory = history.slice(-3).map(m => {
                    const role = m.role.toUpperCase();
                    const content = typeof m.content === 'string' ? m.content : "[Multipart Content]";
                    return `### ${role}\n${content.substring(0, 1000)}${content.length > 1000 ? '...' : ''}`;
                }).join('\n\n');

                const decisionPrompt = `You are the **Sovereign Context Governor**. 
            The current request payload (**${totalEstimated.toLocaleString()}** tokens) has reached **${fillPercentage}%** of the model's limit (**${maxTokens.toLocaleString()}**).
            You must select which files to evict from the 'possessed' context to liberate at least **${Math.round(overflow).toLocaleString()}** tokens.

            ### 🌳 PROJECT STRUCTURE & CONTEXT STATUS
            ${contextData.projectTree}
            *(Legend: [C] = Content in memory, No marker = path only)*

            ### 🕒 RECENT MISSION HISTORY
            ${recentHistory || "No previous history."}

            ### 🎯 CURRENT USER PROMPT
            "${userPromptText}"

            ### 📄 LOADED FILES (MEMOIZED CONTENT & PEEKS)
            Analyze their relevance to the current mission and history.
            ${fileBlocks.map(b => `
            - **File**: \`${b.path}\` (${b.tokens} tokens)
              **Content Peek (First 40 lines)**:
              \`\`\`
              ${b.peek}
              \`\`\`
            `).join('\n')}

            ### 📝 PRUNING RULES:
            1. **PROTECT CORE**: Do NOT evict files containing "core", "mixin", "types", or "api" unless they are explicitly unrelated to the prompt.
            2. **PROTECT SELECTION**: If the user prompt refers to a specific file or logic found in one of these files, KEEP it.
            3. **EVICT NOISE**: Target large boilerplate files, unrelated utilities, or documentation that has already been digested.

            **OUTPUT FORMAT**: JSON only.
            {
            "keep": ["path/to/relevant/file.ts"],
            "evict": [
            {"path": "path/to/noise.py", "reason": "Short explanation why this is being evicted"}
            ]
            }
            `;
                let decision;
                try {
                    const decisionRes = await this._lollmsAPI.sendChat([
                        { role: 'system', content: "You are an architectural context governor. Output ONLY JSON." },
                        { role: 'user', content: decisionPrompt }
                    ], null, controller.signal, targetModel);
                    decision = JSON.parse(stripThinkingTags(decisionRes));
                } catch (e) {
                    // Fallback: Evict just enough tokens to clear the overflow instead of a blind 5-file nuke.
                    const sortedBySize = [...fileBlocks].sort((a, b) => b.tokens - a.tokens);
                    const evictList: any[] = [];
                    let liberated = 0;

                    for (const block of sortedBySize) {
                        // Attempt to protect core files even in fallback
                        const lowerPath = block.path.toLowerCase();
                        if (lowerPath.includes('core') || lowerPath.includes('mixin') || lowerPath.includes('types')) continue;

                        evictList.push({ path: block.path, reason: "Fallback: Removed to clear token overflow after decision error." });
                        liberated += block.tokens;
                        if (liberated >= overflow) break;
                    }

                    // If still not enough, force remove the largest remaining files
                    if (liberated < overflow) {
                        for (const block of sortedBySize) {
                            if (evictList.find(e => e.path === block.path)) continue;
                            evictList.push({ path: block.path, reason: "Emergency Fallback: Removed to prevent system crash." });
                            liberated += block.tokens;
                            if (liberated >= overflow) break;
                        }
                    }

                    decision = { keep: [], evict: evictList };
                }

                // 4. APPLY DECISIONS
                const evictedPaths = (decision.evict || []).map((e: any) => e.path);
                let liberatedTokens = 0;
                const keptList: string[] = [];
                const evictedReport: string[] = [];

                fileBlocks.forEach(b => {
                    const isEvicted = evictedPaths.includes(b.path);
                    if (isEvicted) {
                        b.keep = false;
                        liberatedTokens += b.tokens;
                        const reason = decision.evict.find((e:any) => e.path === b.path)?.reason || "Irrelevant to current prompt.";
                        evictedReport.push(`- ✂ \`${b.path}\`: ${reason}`);
                    } else {
                        keptList.push(`- ✅ \`${b.path}\``);
                    }
                });

                // 5. UPDATE CONTEXT
                const keptBlocks = fileBlocks.filter(b => b.keep);
                contextData.selectedFilesContent = keptBlocks.map(b => b.fullMatch).join('\n\n');

                // 5.5 PERMANENT PRUNING SYNC
                if (this._discussionCapabilities.contextGovernorPermanentPruning && evictedPaths.length > 0) {
                    this.log(`Governor: Performing permanent eviction of ${evictedPaths.length} files from Workspace State...`);
                    const urisToEvict: vscode.Uri[] = [];
                    for (const p of evictedPaths) {
                        const res = await this._contextManager.resolveWorkspaceFromPath(p);
                        if (res) urisToEvict.push(res.uri);
                    }
                    if (urisToEvict.length > 0) {
                        await this._contextManager.getContextStateProvider()?.setStateForUris(urisToEvict, 'tree-only');
                    }
                }

                // 6. DETAILED REPORT
                const newTotal = metrics ? (metrics.total - liberatedTokens) : 0;
                const newPct = metrics ? Math.round((newTotal / metrics.contextSize) * 100) : 0;

                await this.updateMessageContent(pruneMsgId, `⚖️ **Context Governor: Optimization Complete**
                Pruning liberated **${liberatedTokens.toLocaleString()}** tokens. New authoritative usage: **${newPct}%**.

                **📦 PRESERVED (Locked for Mission):**
                ${keptList.join('\n') || "- (None)"}

                **🗑️ EVICTED (Context Pruned):**
                ${evictedReport.join('\n')}

                *Evicted files remain in the Project Tree. Use \`<add_files_to_context>\` if they are needed in subsequent turns.*`);

                // Rebuild messagesToSend with the newly pruned context
                const briefingContent = this._contextManager.renderBriefing(this._currentDiscussion);
                const projectStateText = `
### 📂 ATTACHED PROJECT CONTEXT
I am providing you with the current, ground-truth state of my project files and the Librarian's technical briefing. 

${briefingContent && !briefingContent.includes("Librarian is analyzing") ? `#### 📋 TEAM TECHNICAL BRIEFING\n${briefingContent}\n` : ""}
${contextData.projectTree ? `#### 🌳 PROJECT STRUCTURE\n${contextData.projectTree}\n` : ""}
${contextData.selectedFilesContent ? `#### 📄 FILE CONTENTS\n${contextData.selectedFilesContent}` : "*(No files currently selected)*"}
--------------------------------------------------
`.trim();

                const projectContextUserMessage: ChatMessage = {
                    role: 'user',
                    content: projectStateText
                };

                messagesToSend = [
                    { role: 'system', content: baseInstructions },
                    ...history,
                    projectContextUserMessage
                ];

                if (currentPromptMessage) {
                    messagesToSend.push(currentPromptMessage);
                }
            }
        }
        } catch (e: any) {
            this.log(`Error during context pruning: ${e.message}`, 'ERROR');
        }

        // =========================================================================
        // 🛡️ FINAL API OUTBOUND LOG (DEBUG)
        // =========================================================================
        
        // --- DIAGNOSTIC: Log Context Payload ---
        const includedFiles = fileBlocks.filter(b => b.keep).map(b => b.path);
        Logger.info(`[ContextCheck] Sending ${includedFiles.length} files to LLM: ${includedFiles.join(', ')}`);

        messagesToSend.forEach((msg, idx) => {
            const role = msg.role.toUpperCase();
            let contentPrev = typeof msg.content === 'string' ? msg.content : "[Multipart Content]";

            if (contentPrev.length > 1000) {
                const head = contentPrev.substring(0, 500);
                const tail = contentPrev.substring(contentPrev.length - 500);
            } else {
            }
        });
        // =========================================================================

        assistantMessageId = 'assistant_' + Date.now().toString() + Math.random().toString(36).substring(2);

        const generationSession: ActiveGeneration = {
            messageId: assistantMessageId, 
            buffer: '', 
            model: this._currentDiscussion.model || this._lollmsAPI.getModelName(),
            startTime: Date.now(), 
            tokenCount: 0, // Explicit initialization
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

        // Fetch user-defined timeout or fallback to an extended 180s (3 minutes) to support high-context models
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
                    personalityName: 'Lollms',
                    timestamp: Date.now()
                } 
            });
            // Initiate the countdown timer in the webview
            this._panel.webview.postMessage({
                command: 'startCountdown',
                id: assistantMessageId,
                timeoutMs: ttftTimeoutValue
            });
        }
        let processedResponse ;
        let firstTokenReceived = false;
        this.log(`Outbound Stream: Initiating API call to Lollms Server at ${this._lollmsAPI.config.apiUrl}. Model: ${this._currentDiscussion.model || 'default'}.`);

        // 🛡️ SANITIZE OPTIONS: Strip complex local options map before sending to external API providers (like Kimi or Groq)
        // to prevent silent connection drop failures.
        const cleanOptions: any = {};
        if (reqTemperature !== undefined && !isNaN(reqTemperature)) {
            cleanOptions.temperature = reqTemperature;
        }
        if (this._discussionCapabilities.thinkingMode) {
            cleanOptions.thinking = true;
        }

        try {
            await this._lollmsAPI.sendChat(messagesToSend, (chunk) => {
                if (controller?.signal.aborted) {
                    this.log("Outbound Stream: Execution signal was aborted during chunk reception.");
                    return;
                }

                if (!firstTokenReceived) {
                    firstTokenReceived = true;
                    this.log("Outbound Stream: First token chunk successfully received from API server.");
                    if (processId) this.processManager.updateDescription(processId, "Worker: Drafting solution...");
                    this.updateGeneratingState();
                }

                fullResponse += chunk;
                generationSession.buffer += chunk;
                generationSession.tokenCount++;

                const elapsed = (Date.now() - generationSession.startTime) / 1000;
                const tps = (generationSession.tokenCount / elapsed).toFixed(1);

                this._panel.webview.postMessage({
                    command: 'updateGenerationMetrics',
                    tps: tps,
                    count: generationSession.tokenCount
                });

                generationSession.listeners.forEach(listener => {
                    try {
                        listener(chunk);
                    } catch (listenerErr: any) {
                        this.log(`Outbound Stream Listener Exception: ${listenerErr.message}`, 'ERROR');
                    }
                });
            }, controller?.signal, this._currentDiscussion.model, cleanOptions);

            this.log(`Outbound Stream: Completed successfully. Total tokens generated: ${generationSession.tokenCount}.`);

            // If we still get 0 tokens, check for connection parameter errors
            if (generationSession.tokenCount === 0 && !controller?.signal.aborted) {
                this.log(`Outbound Stream: Empty stream response. Checking connection settings...`, 'WARN');

                const connectionWarning = `
### 🔌 Connection Refused / Empty Response (0 tokens)
The API endpoint returned an empty response.

**🔍 DIAGNOSTICS & SOLUTIONS:**
1.  **Strict API Schema**: Ensure your API key is correctly configured inside Settings for the **${this._currentDiscussion.model || 'active'}** model.
2.  **Verify Server Endpoint**: If using a local proxy or custom API path, test the connection via the **Test Connection** button inside the Lollms Settings Panel.
`.trim();

                processedResponse = connectionWarning;
                fullResponse = connectionWarning;
            }
        } catch (streamErr: any) {
            this.log(`Outbound Stream: API call threw a fatal exception: ${streamErr.message}`, 'ERROR');
            if (streamErr.stack) {
                this.log(`Stack Trace: ${streamErr.stack}`, 'ERROR');
            }
            throw streamErr; // Escalate to the main outer error handler
        }

        // --- THE VERIFIER (GUARDIAN) ---
        let inspectedResponse = fullResponse;
        if (this._discussionCapabilities.verifierMode && processId) {
            this.processManager.updateDescription(processId, "Verifier: Performing logical audit & linting...");
            this.updateGeneratingState();

            const auditedResponse = await this.runVerificationAgent(
                fullResponse, 
                controller?.signal
            );

            // Compare cleaned versions (ignoring thinking tags and extra whitespace) to see if changes were made
            const cleanOrig = stripThinkingTags(fullResponse).trim();
            const cleanAudit = stripThinkingTags(auditedResponse).trim();

            if (cleanOrig !== cleanAudit) {
                this.log("Verifier detected flaws in the initial draft. Providing corrected version.");

                const verifiedMsgId = 'assistant_verified_' + Date.now();
                inspectedResponse = auditedResponse;

                // Add the NEW corrected bubble to the discussion
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

                // Update assistantMessageId so subsequent phases (Tests/Docs) refer to the verified ID
                assistantMessageId = verifiedMsgId;
            } else {
                this.log("Verification passed: No logical flaws detected in the draft.");
            }
        }

        if (processId) this.processManager.updateDescription(processId, "Verifying code block integrity...");
        this.updateGeneratingState();

        processedResponse = await this.verifyAndProcessCodeBlocks(
            assistantMessageId, 
            inspectedResponse, 
            controller?.signal,
            (status) => {
                if (processId) this.processManager.updateDescription(processId, status);
                this.updateGeneratingState();
            }
        );
        // --- CONTEXT EXPANSION (SELF-CORRECTION) ---
        const addFilesRegex = /<add_files_to_context>([\s\S]*?)<\/add_files_to_context>/i;
        const addFilesMatch = processedResponse.match(addFilesRegex);

        // --- CONTEXT EXPANSION (STOP & WAIT) ---
        if (addFilesMatch && !controller.signal.aborted) {
            // We do nothing here in the backend because the Webview UI already renders 
            // the <add_files> widget with a manual "Add to Context" button.
            // By NOT calling sendMessage here, we respect the "Don't call LLM" rule.
            this.log(`AI issued context expansion request. Waiting for user interaction.`);
        }

        // --- PROJECT MEMORY PROCESSING (NON-BLOCKING DEFERRED - ONLY WHEN SPARQL IS ACTIVE) ---
        if (this._discussionCapabilities.projectMemoryEnabled !== false && this._discussionCapabilities.sparqlEnabled !== false && !controller.signal.aborted) {
            setImmediate(async () => {
                try {
                    await this.processProjectMemoryTags(processedResponse);
                } catch (e) {
                    console.error("Deferred project memory tagging failed safely:", e);
                }
            });
        }

        // Initialize the Agentic Systems Code Book in Memory if it's a new project (Only when SPARQL is active)
        if (message.role === 'user' && this._currentDiscussion?.messages.length === 1 && this._discussionCapabilities.sparqlEnabled !== false) {
            setImmediate(async () => {
                try {
                    await this.processProjectMemoryTags(`<project_memory action="add" id="core_manifesto" title="Agentic Systems Code Book">The project follows the 10 core principles of the Agentic Systems Code Book, prioritizing composition, explicit tool use, and safety.</project_memory>`);
                } catch (e) {
                    console.error("Deferred core manifesto tagging failed safely:", e);
                }
            });
        }

        // --- AUTOMATION PIPELINE ---
        if (this._discussionCapabilities.autoApply && !controller?.signal.aborted && processId) {
            await this.executeAutomationPipeline(processedResponse, assistantMessageId, controller?.signal, processId);
            // Refresh context immediately after auto-apply so the next turn sees the new state
            this.updateContextAndTokens();
        }

    // --- PHASE 6: DEBUGGER (THE ITERATIVE LOOP) ---
    // Runs only after code is written, verified, and applied to disk.
        if (this._discussionCapabilities.debugMode && !controller?.signal.aborted && processId) {
            this.processManager.updateDescription(processId, "Debugger: Starting runtime validation...");
            this.updateGeneratingState();

            const debugObjective = typeof message.content === 'string' ? message.content : "Verify implementation.";

            // We use the existing agentManager loop
            await (this.agentManager as any).runDebuggerAgent(debugObjective, controller?.signal);

            // Final context refresh after debugger finishes
            this.updateContextAndTokens();
        }

        const elapsed = (Date.now() - generationSession.startTime) / 1000;
        const finalTps = (generationSession.tokenCount / elapsed).toFixed(1);

        const assistantMessage: ChatMessage = { 
            id: assistantMessageId, 
            role: 'assistant', 
            content: processedResponse, 
            model: generationSession.model,
            personalityName: personaName, // Store for future loads
            timestamp: Date.now()
        };
        await this.addMessageToDiscussion(assistantMessage, false);


        // Update history segment in the cache
        const modelForTokenization = (this._currentDiscussion?.model || this._lollmsAPI.getModelName() || "default").trim();
        const historyText = this._currentDiscussion!.messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
        const historyTokens = await this._lollmsAPI.tokenize(historyText, modelForTokenization);
        await this._contextManager.updateSegmentTokens('history', historyTokens.count);

        await this._contextManager.updateSegmentTokens('history', historyTokens.count);
        if (!this._isDisposed) {
            this._panel.webview.postMessage({ 
                command: 'finalizeMessage', 
                id: assistantMessageId, 
                fullContent: processedResponse,
                tps: finalTps,
                personalityName: personaName
            });
        }

        // --- PHASE 6: DEBUGGER (THE ITERATIVE LOOP) ---
        // Only trigger the automated debug loop if code was produced and mode is active
        if (this._discussionCapabilities.debugMode && !controller?.signal.aborted && processId) {
            this.processManager.updateDescription(processId, "Debugger: Starting runtime validation...");
            this.updateGeneratingState();

            const debugObjective = typeof message.content === 'string' ? message.content : "Verify implementation.";
            await this.agentManager.runDebuggerAgent(debugObjective, controller?.signal);
            this.updateContextAndTokens();
        }

        // --- PHASE 7: TEST GENERATION ---
        if (this._discussionCapabilities.testMode && !controller?.signal.aborted && processId) {
            this.processManager.updateDescription(processId, "Test Engineer: Writing unit tests...");

            // FORCE MINIMALIST PROFILE for sub-agents to remove reasoning bloat
            const subAgentCapabilities = { 
                ...this._discussionCapabilities, 
                responseProfileId: 'minimalist' 
            };
            this.updateGeneratingState();

            const testSystemPrompt = `You are a Senior QA/Test Engineer. 
Your task is to write comprehensive unit tests for the changes just made by the Lead Architect.
Look at the modifications provided in the previous message.
1. Identify the functions/classes that were modified or created.
2. Write unit tests to cover both the happy path and edge cases.
3. Output the tests using the exact formatting rules (e.g., \`\`\`language:path/to/test_file.ext\n[code]\n\`\`\`).
If you don't know the exact test file path, guess a standard path (e.g., tests/test_filename.py or filename.test.ts).
DO NOT explain your code. Output ONLY the test code blocks.`;

            const testPrompt = `Please write unit tests for the changes you just implemented. Ensure you use the exact formatting rules for file creation or modification.`;

            // Create a new array to prevent mutating the original history
            const testHistory: ChatMessage[] =[
                ...messagesToSend,
                { role: 'assistant', content: processedResponse },
                { role: 'system', content: testSystemPrompt },
                { role: 'user', content: testPrompt }
            ];

            const testMessageId = 'assistant_test_' + Date.now().toString() + Math.random().toString(36).substring(2);
            
            const testGenerationSession: ActiveGeneration = {
                messageId: testMessageId,
                buffer: '',
                model: generationSession.model,
                startTime: Date.now(),
                tokenCount: 0,
                listeners: new Set(),
                onComplete: new Set()
            };

            const testPanelListener = (chunk: string) => { 
                if (!this._isDisposed && this._panel.webview) {
                    this._panel.webview.postMessage({ command: 'appendMessageChunk', id: testMessageId, chunk }); 
                }
            };

            this._activeGenerationListener = testPanelListener;
            testGenerationSession.listeners.add(testPanelListener);
            ChatPanel.activeGenerations.set(this.discussionId, testGenerationSession);

            if (!this._isDisposed) {
                this._panel.webview.postMessage({ 
                    command: 'addMessage', 
                    message: { 
                        id: testMessageId, 
                        role: 'assistant', 
                        content: '', 
                        startTime: Date.now(), 
                        model: generationSession.model,
                        personalityName: '🧪 Test Engineer',
                        timestamp: Date.now()
                    } 
                });
            }

            let fullTestResponse = '';
            let firstTestTokenReceived = false;

            try {
                await this._lollmsAPI.sendChat(testHistory, (chunk) => {
                    if (!firstTestTokenReceived) {
                        firstTestTokenReceived = true;
                        if (processId) this.processManager.updateDescription(processId, "Test Engineer: Drafting tests...");
                        this.updateGeneratingState();
                    }

                    fullTestResponse += chunk;
                    testGenerationSession.buffer += chunk;
                    testGenerationSession.tokenCount++;

                    const elapsed = (Date.now() - testGenerationSession.startTime) / 1000;
                    const tps = (testGenerationSession.tokenCount / elapsed).toFixed(1);

                    this._panel.webview.postMessage({
                        command: 'updateGenerationMetrics',
                        tps: tps,
                        count: testGenerationSession.tokenCount
                    });

                    testGenerationSession.listeners.forEach(listener => listener(chunk));
                }, controller?.signal, this._currentDiscussion.model, { 
                    thinking: subAgentCapabilities.thinkingMode,
                    capabilities: subAgentCapabilities,
                    temperature: subAgentCapabilities.temperature
                });

                if (processId) this.processManager.updateDescription(processId, "Verifier: Auditing test code...");
                this.updateGeneratingState();

                const processedTestResponse = await this.verifyAndProcessCodeBlocks(
                    testMessageId, 
                    fullTestResponse, 
                    controller?.signal,
                    (status) => {
                        if (processId) this.processManager.updateDescription(processId, status);
                        this.updateGeneratingState();
                    }
                );

                // --- AUTOMATION PIPELINE FOR TESTS ---
                if (this._discussionCapabilities.autoApply && !controller?.signal.aborted && processId) {
                    await this.executeAutomationPipeline(processedTestResponse, testMessageId, controller?.signal, processId);
                }

                const elapsed = (Date.now() - testGenerationSession.startTime) / 1000;
                const finalTps = (testGenerationSession.tokenCount / elapsed).toFixed(1);

                const testAssistantMessage: ChatMessage = { 
                    id: testMessageId, 
                    role: 'assistant', 
                    content: processedTestResponse, 
                    model: generationSession.model,
                    personalityName: '🧪 Test Engineer',
                    timestamp: Date.now()
                };
                await this.addMessageToDiscussion(testAssistantMessage, false);
                
                if (!this._isDisposed) {
                    this._panel.webview.postMessage({ 
                        command: 'finalizeMessage', 
                        id: testMessageId, 
                        fullContent: processedTestResponse,
                        tps: finalTps,
                        personalityName: '🧪 Test Engineer'
                    });
                }

            } catch (testErr: any) {
                this.log(`Test Generation Failed: ${testErr.message}`, 'ERROR');
            } finally {
                ChatPanel.activeGenerations.delete(this.discussionId);
            }
        }

        // --- PHASE 8: DOCUMENTATION UPDATE ---
        if (this._discussionCapabilities.documentationMode && !controller?.signal.aborted && processId) {
            this.processManager.updateDescription(processId, "Technical Writer: Syncing documentation...");

            // FORCE MINIMALIST PROFILE for sub-agents to remove reasoning bloat
            const subAgentCapabilities = { 
                ...this._discussionCapabilities, 
                responseProfileId: 'minimalist' 
            };
            this.updateGeneratingState();

            const docsSystemPrompt = `You are the **Senior Technical Writer & Project Historian**.
Your primary goal is to maintain the project's PHYSICAL documentation files.

### 📚 DOCUMENTATION PROTOCOL (STRICT PRIORITY):
1. **FILE MODIFICATION (MANDATORY)**: You MUST update or create at least one documentation file (e.g., \`README.md\`, \`ARCHITECTURE.md\`, or \`docs/*.md\`) using the AIDER SEARCH/REPLACE format. 
   - Document new classes, functions, or changes in behavior.
   - If the project is missing a README, create one now.
2. **INTERNAL GROUNDING (SECONDARY)**: ONLY AFTER updating the files, you may use a \`<project_memory operation="add" ...>\` tag.
   - Use memory ONLY for "Project DNA" (e.g., "The user hates Flask, always use FastAPI") or "Hidden Quirks" that aren't appropriate for a public README.

### 🛑 PROHIBITIONS:
- **NO MEMORY-ONLY RESPONSES**: Generating a memory tag without updating a documentation file is a FAILURE.
- **NO CHATTER**: Output ONLY the Aider code blocks and the memory tags.

If there are no meaningful docs to update, find the README.md and add a "Latest Changes" entry.`;

            const docsPrompt = `Sync the project documentation and record architectural memories based on the work just completed.`;

            const docsHistory: ChatMessage[] = [
                ...messagesToSend,
                { role: 'assistant', content: processedResponse },
                { role: 'system', content: docsSystemPrompt },
                { role: 'user', content: docsPrompt }
            ];

            const docsMessageId = 'assistant_docs_' + Date.now().toString() + Math.random().toString(36).substring(2);
            
            const docsSession: ActiveGeneration = {
                messageId: docsMessageId,
                buffer: '',
                model: generationSession.model,
                startTime: Date.now(),
                tokenCount: 0,
                listeners: new Set(),
                onComplete: new Set()
            };

            const docsListener = (chunk: string) => { 
                if (!this._isDisposed && this._panel.webview) {
                    this._panel.webview.postMessage({ command: 'appendMessageChunk', id: docsMessageId, chunk }); 
                }
            };

            this._activeGenerationListener = docsListener;
            docsSession.listeners.add(docsListener);
            ChatPanel.activeGenerations.set(this.discussionId, docsSession);

            if (!this._isDisposed) {
                this._panel.webview.postMessage({ 
                    command: 'addMessage', 
                    message: { 
                        id: docsMessageId, 
                        role: 'assistant', 
                        content: '', 
                        startTime: Date.now(), 
                        model: generationSession.model,
                        personalityName: '📖 Technical Writer',
                        timestamp: Date.now()
                    } 
                });
            }

            try {
                const fullDocsResponse = await this._lollmsAPI.sendChat(docsHistory, (chunk) => {
                    docsSession.buffer += chunk;
                    docsSession.tokenCount++;
                    docsSession.listeners.forEach(l => l(chunk));
                }, controller?.signal, this._currentDiscussion.model, {
                    capabilities: subAgentCapabilities
                });

                const processedDocsResponse = await this.verifyAndProcessCodeBlocks(docsMessageId, fullDocsResponse, controller?.signal);

                if (this._discussionCapabilities.autoApply && !controller?.signal.aborted && processId) {
                    await this.executeAutomationPipeline(processedDocsResponse, docsMessageId, controller?.signal, processId);
                }

                // Process memory tags immediately so they are available for the next turn
                await this.processProjectMemoryTags(processedDocsResponse);

                const assistantDocsMessage: ChatMessage = { 
                    id: docsMessageId, 
                    role: 'assistant', 
                    content: processedDocsResponse, 
                    model: docsSession.model,
                    personalityName: '📖 Technical Writer',
                    timestamp: Date.now()
                };
                await this.addMessageToDiscussion(assistantDocsMessage, false);
                
                if (!this._isDisposed) {
                    this._panel.webview.postMessage({ command: 'finalizeMessage', id: docsMessageId, fullContent: processedDocsResponse, personalityName: '📖 Technical Writer' });
                }
            } catch (docErr: any) {
                this.log(`Documentation update failed: ${docErr.message}`, 'ERROR');
            } finally {
                ChatPanel.activeGenerations.delete(this.discussionId);
            }
        }

    } catch (error: any) { 
        // 1. Force cleanup of the generation registry
        ChatPanel.activeGenerations.delete(this.discussionId);

        if (error.name === 'AbortError' || error.message === 'AbortError') {
            // --- PRESERVE PARTIAL CONTENT ---
            if (fullResponse.trim()) {
                const stoppedText = fullResponse + "\n\n*(Generation stopped by user)*";
                const assistantMessage: ChatMessage = { 
                    id: assistantMessageId, 
                    role: 'assistant', 
                    content: stoppedText, 
                    model: generationSession.model,
                    personalityName: personaName,
                    timestamp: Date.now()
                };

                // Add to persistent history so it survives refreshes
                await this.addMessageToDiscussion(assistantMessage, false);

                // Tell the UI to finalize the current bubble with the partial text
                if (!this._isDisposed) {
                    this._panel.webview.postMessage({ 
                        command: 'finalizeMessage', 
                        id: assistantMessageId, 
                        fullContent: stoppedText,
                        personalityName: personaName
                    });
                }
            } else {
                // If stopped before any tokens arrived, just refresh to clean up the "Thinking" bubble
                await this.loadDiscussion();
            }
        } else {
            this.log(`Message delivery failed: ${error.message}`, 'ERROR');

            // 2. Add the system error to the message history
            await this.addMessageToDiscussion({ 
                id: 'error_' + Date.now(),
                role: 'system', 
                content: `### 🔌 Connection Error\nLollms could not reach the server at \`${this._lollmsAPI.config.apiUrl}\`.\n\n**Reason:** ${error.message}\n\n*Please check if your server is running and try again.*`,
                timestamp: Date.now()
            }); 

            // 3. CRITICAL: Force a full UI reload. 
            await this.loadDiscussion();
        }
    }
    finally { 
        ChatPanel.activeGenerations.delete(this.discussionId); 
        
        // Clean up listeners
        this._activeGenerationListener = undefined;
        this._activeGenerationCompleteListener = undefined;

        if (processId) {
            this.processManager.unregister(processId); 
        }
        
        // Reset metrics in the UI
        if (!this._isDisposed && this._panel.webview) {
            this._panel.webview.postMessage({
                command: 'updateGenerationMetrics',
                tps: "0.0",
                count: 0,
                reset: true
            });
        }

        // Authoritatively clear the generating state
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
      const graph = this.agentManager.codeGraphManager;
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
            // Handle multiple SEARCH/REPLACE blocks within the same content
            const aiderRegex = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
            const matches =[...content.matchAll(aiderRegex)];
              if (matches.length > 0) {
                  let tempContent = currentContent;
                  for (const match of matches) {
                      const result = applySearchReplace(tempContent, match[1], match[2]);
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

        this.processManager.updateDescription(processId, "Waiting for model response...");
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
        try {
            await this._lollmsAPI.sendChat(messagesToSend, (chunk) => {
                if (controller.signal.aborted) return;
                if (!firstTokenReceived) {
                    firstTokenReceived = true;
                    if (processId) this.processManager.updateDescription(processId, "Worker: Drafting solution...");
                    this.updateGeneratingState();
                }

                fullResponse += chunk;
                generationSession.buffer += chunk;
                generationSession.tokenCount++;

                const elapsed = (Date.now() - generationSession.startTime) / 1000;
                const tps = (generationSession.tokenCount / elapsed).toFixed(1);

                this._panel.webview.postMessage({
                    command: 'updateGenerationMetrics',
                    tps: tps,
                    count: generationSession.tokenCount
                });

                generationSession.listeners.forEach(listener => listener(chunk));
            }, controller.signal, targetModel, { 
                thinking: this._discussionCapabilities.thinkingMode,
                capabilities: this._discussionCapabilities,
                temperature: reqTemperature
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

            const assistantMessage: ChatMessage = { 
                id: assistantMessageId, 
                role: 'assistant', 
                content: processedResponse, 
                model: generationSession.model,
                personalityName: personaName,
                timestamp: Date.now()
            };
            await this.addMessageToDiscussion(assistantMessage, false);

            if (!this._isDisposed) {
                this._panel.webview.postMessage({ 
                    command: 'finalizeMessage', 
                    id: assistantMessageId, 
                    fullContent: processedResponse,
                    tps: finalTps,
                    personalityName: personaName
                });
            }

            // --- PHASE 6: DEBUGGER (THE ITERATIVE LOOP) ---
            if (this._discussionCapabilities.debugMode && !controller.signal.aborted && processId) {
                this.processManager.updateDescription(processId, "Debugger: Starting runtime validation...");
                this.updateGeneratingState();
                const debugObjective = typeof messagesToSend[messagesToSend.length - 1].content === 'string' ? messagesToSend[messagesToSend.length - 1].content : "Verify.";
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
          this._currentDiscussion.messages.push(message);
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

    // Clear any active context and token calculation timeouts immediately to prevent disposed webview crashes
    if ((this as any)._tokenDebounceTimeout) {
        clearTimeout((this as any)._tokenDebounceTimeout);
        (this as any)._tokenDebounceTimeout = undefined;
    }
    if (this._tokenAbortController) {
        this._tokenAbortController.abort();
        this._tokenAbortController = null;
    }

    // Unregister any active background loading tasks to release the Extension Host thread instantly
    if (this.processManager) {
        this.processManager.cancelForDiscussion(this.discussionId);
    }

    ChatPanel.currentPanel = undefined;
    ChatPanel.panels.delete(this.discussionId);

    if (this._panel) {
        try {
            this._panel.dispose();
        } catch (e) {}
    }

    while (this._executionLogs.length) { this._executionLogs.pop(); }
  }
  
private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(async (message) => {
        if (message.command !== 'webview-ready' && message.command !== 'webview-bootstrap-ok') {
            console.log("Lollms: Received message from webview:", message.command);
        }
        
        switch (message.command) {
            case 'webview-bootstrap-ok':
            case 'webview-html-loaded':
            case 'webview-ready':
                console.log(`[Lollms Debug:Handshake] Processing webview bootstrap handshake: ${message.command}`);
                this._isWebviewReady = true;
                
                // Resolve view ready promise safely if it exists
                if (typeof this._viewReadyResolver === 'function') {
                    this._viewReadyResolver();
                }

                if (this.agentManager) {
                    const plan = (this.agentManager as any).currentPlan;
                    if (plan) {
                        this.displayPlan(plan);
                    }
                }

                // Force load discussion on startup/handshake
                console.log("[Lollms Debug:Handshake] Handshake complete. Force loading discussion history...");
                await this.loadDiscussion();
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

                    // SEQUENTIAL HIGH-SPEED BATCH APPLY ENGINE (ORDER-PRESERVING)
                    const runBatch = async () => {
                        ChatPanel.isBatchApplying = true;
                        try {
                            for (let i = 0; i < changesBatch.length; i++) {
                                if (applyCtrl.signal.aborted) {
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
                                const isUndoMode = message.undo === true;

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
                                    } else if (change.type === 'replace') {
                                        result = await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', change.path, change.content, this, messageId, opts);
                                    } else if (change.type === 'diff') {
                                        result = await vscode.commands.executeCommand('lollms-vs-coder.applyPatchContent', change.path, change.content, opts);
                                    }

                                    if (result?.success) {
                                        // If undoing, remove from applied state, otherwise add it
                                        await this.updateAppliedState(messageId, change.blockIndex, change.hunkIndex, isUndoMode);

                                        // Collapse the newly applied file directly to keep the workspace clean [2]
                                        this._panel.webview.postMessage({
                                            command: 'fileSavedOnDisk',
                                            filePath: change.path
                                        });
                                    }
                                } catch (e: any) {
                                    result = { success: false, error: e.message };
                                    this.log(`Batch failure on ${change.path}: ${e.message}`, 'ERROR');
                                }

                                // 2. Notify UI: Item result
                                this._panel.webview.postMessage({
                                    command: 'applyAllResult',
                                    messageId: messageId,
                                    filePath: change.path,
                                    blockIndex: change.blockIndex,
                                    hunkIndex: change.hunkIndex,
                                    success: result?.success ?? false,
                                    error: result?.error,
                                    currentIndex: i,
                                    totalCount: changesBatch.length,
                                    undo: isUndoMode
                                });
                            }
                        } finally {
                            ChatPanel.isBatchApplying = false;
                        }

                        this.processManager.unregister(applyProcId);
                        this.updateGeneratingState();
                        // Final context refresh to show new state in HUD
                        this.updateContextAndTokens();
                    };

                    runBatch();
                    break;
                }
            case 'renameFile':
                vscode.commands.executeCommand('lollms-vs-coder.renameFile', message.originalPath, message.newPath);
                break;
            case 'deleteFile':
                // Check if it's an array from the new tag or a string from legacy UI
                const pathsToDelete = Array.isArray(message.filePaths) ? message.filePaths.join(',') : message.filePaths;
                vscode.commands.executeCommand('lollms-vs-coder.deleteFile', pathsToDelete);
                break;
            case 'insertCode':
                vscode.commands.executeCommand('lollms-vs-coder.insertCode', message.filePath, message.content);
                break;
            case 'replaceCode':
                try {
                    // Logic to normalize markers before sending to command
                    // Logic to normalize markers before sending to command
                    const normalizedContent = message.content
                        .replace(/^\s*<<<<<<< SEARCH/gm, '<<<<<<< SEARCH')
                        .replace(/^\s*=======/gm, '=======')
                        .replace(/^\s*>>>>>>> REPLACE/gm, '>>>>>>> REPLACE');

                    const res: any = await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', message.filePath, normalizedContent, this, message.messageId, message.options);
                    
                    webview.postMessage({
                        command: 'applyAllResult',
                        messageId: message.messageId,
                        filePath: message.filePath,
                        blockIndex: message.blockIndex,
                        hunkIndex: message.hunkIndex,
                        success: res?.success ?? false,
                        repaired: res?.repaired,
                        error: res?.error
                    });
                    if (res && res.success) {
                        await this.updateAppliedState(message.messageId, message.blockIndex, message.hunkIndex);
                    }
                } catch (e: any) {
                    this.log(`Command replaceCode failed: ${e.message}`, 'ERROR');
                    webview.postMessage({ command: 'applyAllResult', messageId: message.messageId, blockIndex: message.blockIndex, hunkIndex: message.hunkIndex, success: false, error: e.message });
                }
                break;
            case 'deleteCodeBlock':
                vscode.commands.executeCommand('lollms-vs-coder.deleteCodeBlock', message.filePath, message.content);
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
            case 'addFilesToContext':
                {
                    const blockId = message.blockId;
                    const filesToAdd = Array.isArray(message.files) ? message.files : [];
                    const reprompt = message.reprompt;
                    const results: { [key: string]: boolean } = {};

                    try {
                        const provider = this._contextManager.getContextStateProvider();
                        if (provider) {
                            // The updated provider now returns the list of strings that were actually matched
                            const addedPaths = await provider.addFilesToContext(filesToAdd);

                            // Map results for UI feedback
                            filesToAdd.forEach(f => {
                                results[f] = addedPaths.includes(f);
                            });

                            if (addedPaths.length > 0) {
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

                                const currentFilesList = provider.getIncludedFiles().map(f => f.path);
                                this._panel.webview.postMessage({
                                    command: 'updateContext',
                                    files: currentFilesList
                                });

                                if (reprompt) {
                                    // Trigger the next turn immediately with fresh context
                                    await this.sendMessage({
                                        role: 'user',
                                        content: `I have added the requested files to context. Please proceed with the analysis.`
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
                    const query = (message.query || "").trim();
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
                            let allFiles = await this._contextManager.getWorkspaceFilePaths();

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
                        'Documents':['pdf', 'docx', 'pptx', 'xlsx', 'msg'],
                        'Images':['png', 'jpg', 'jpeg', 'webp', 'bmp'],
                        'Code/Text': ['*']
                    }
                });
                if (uris && uris.length > 0) {
                    // Show progress immediately
                    this._panel.webview.postMessage({ command: 'setGeneratingState', isGenerating: true, statusText: 'Processing documents...' });
                    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                    
                    for (const uri of uris) {
                        const ext = path.extname(uri.fsPath).toLowerCase();
                        const fileName = path.basename(uri.fsPath);

                        // If it's a complex document or image, treat it as a rich attachment
                        if (['.pdf', '.docx', '.pptx', '.xlsx', '.msg', '.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
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
                                        continue; // User cancelled
                                    }
                                    importMode = choice.mode;
                                }

                                await this._handleFileAttachment(fileName, isImage ? `data:image/${ext.substring(1)};base64,${base64}` : `data:application/octet-stream;base64,${base64}`, isImage, importMode);
                            } catch (e: any) {
                                vscode.window.showErrorMessage(`Failed to attach ${fileName}: ${e.message}`);
                            }
                        } else {
                            // Standard text/code file
                            try {
                                const isWithinWorkspace = workspaceFolder && vscode.workspace.getWorkspaceFolder(uri);
                                
                                if (isWithinWorkspace) {
                                    // Standard internal file: add directly to background project context
                                    await vscode.commands.executeCommand('lollms-vs-coder.setContextIncluded', uri, [uri]);
                                } else if (workspaceFolder) {
                                    // External File: Ingest and write to the local external cache folder
                                    const cacheDir = vscode.Uri.joinPath(workspaceFolder.uri, 'external');
                                    await vscode.workspace.fs.createDirectory(cacheDir).then(undefined, () => {});

                                    const fileBytes = await vscode.workspace.fs.readFile(uri);
                                    const safeName = `external_${fileName.replace(/[^a-zA-Z0-9.]/g, '_')}`;
                                    const cacheUri = vscode.Uri.joinPath(cacheDir, safeName);

                                    await vscode.workspace.fs.writeFile(cacheUri, fileBytes);

                                    // Register the ingested path to the context
                                    const relativePath = path.join('external', safeName).replace(/\\/g, '/');
                                    await vscode.commands.executeCommand('lollms-vs-coder.addFilesToContext', [relativePath]);
                                }
                            } catch (e: any) {
                                vscode.window.showErrorMessage(`Failed to ingest ${fileName}: ${e.message}`);
                            }
                        }
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
            case 'requestAddDiagramToContext':
                const diagType = await vscode.window.showQuickPick([
                    { label: 'Inheritance Diagram', id: 'class_diagram' },
                    { label: 'Call Graph', id: 'call_graph' },
                    { label: 'Import Graph', id: 'import_graph' },
                    { label: 'Function Signatures', id: 'function_signatures' },
                    { label: 'Textual Architecture Summary (Token Efficient)', id: 'text_summary' }
                ], { placeHolder: 'Select diagram type to include in AI context' });

                if (diagType && this._currentDiscussion) {
                    if (!this._currentDiscussion.activeDiagrams) this._currentDiscussion.activeDiagrams = [];
                    if (!this._currentDiscussion.activeDiagrams.includes(diagType.id)) {
                        this._currentDiscussion.activeDiagrams.push(diagType.id);
                        await this._discussionManager.saveDiscussion(this._currentDiscussion);
                        this.updateContextAndTokens();
                    }
                }
                break;
            case 'requestWebAction':
                {
                    const { action, params } = message;
                    try {
                        const loadingMsgId = 'system_web_loading_' + Date.now();
                        
                        if (action === 'scrape') {
                            const targetUrl = params.url;
                            const lang = params.language || 'en';
                            const depth = params.depth || 0;

                            await this.addMessageToDiscussion({
                                id: loadingMsgId,
                                role: 'system', 
                                content: `🌐 Processing ${action}: ${targetUrl}...`
                            });

                            const result = await this._contextManager.processUrl(targetUrl, lang, undefined, undefined, depth);
                            await this.updateMessageContent(loadingMsgId, `✅ **Web Content Added:** ${targetUrl}\nSaved as: \`${result.filename}\`\n\nPreview:\n> ${result.summary}`);
                            this.updateContextAndTokens();
                        } else if (['wiki', 'arxiv', 'google', 'ddg', 'so', 'hal', 'scopus', 'patent'].includes(action)) {
                            const query = params.query;
                            const limit = params.limit || 5;
                            const results = await this._contextManager.searchWebInfo(action, query, undefined, limit);
                            webview.postMessage({ command: 'webSearchResults', action, results, query });
                        }
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Web action failed: ${e.message}`);
                        // CRITICAL: Tell the UI to stop spinning even on error
                        webview.postMessage({ command: 'webSearchResults', action, results: [], query: params.query });
                    }
                }
                break;
            case 'addWebPagesToContext':
                try {
                    const { urls } = message;
                    for (const url of urls) {
                        await this._contextManager.processUrl(url, 'en');
                    }
                    vscode.window.showInformationMessage(`Added ${urls.length} web pages to context.`);
                    this.updateContextAndTokens();
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to add web pages: ${e.message}`);
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
            case 'removeFileFromContext':
            case 'bulkRemoveFiles':
                if (this._contextManager) {
                    const paths = message.command === 'bulkRemoveFiles' ? message.paths : [message.path];
                    const uris: vscode.Uri[] = [];

                    let tokensToRemove = 0;
                    for (let p of paths) {
                        const res = await this._contextManager.resolveWorkspaceFromPath(p);
                        if (res) {
                            uris.push(res.uri);
                        } else {
                            uris.push(vscode.Uri.file(p));
                        }

                        // Retrieve the cached token weight before removing it to perform instant subtraction
                        const cached = (this._contextManager as any)._fileContentCache.get(p);
                        if (cached) {
                            tokensToRemove += Math.ceil(cached.content.length / 3.5);
                        }

                        // Remove from active token cache to force immediate accurate updates
                        await this._contextManager.removeCachedTokens(p);
                    }

                    await this._contextManager.getContextStateProvider()?.setStateForUris(uris, 'tree-only');

                    // --- INSTANT HYDRATION SUBTRACTION ---
                    // Dynamically subtract the token weight from the current cached metrics
                    // and update the webview instantly to eliminate any lagging calculation delay.
                    if (this._currentDiscussion?.lastTokenMetrics) {
                        const m = this._currentDiscussion.lastTokenMetrics;
                        m.total = Math.max(0, m.total - tokensToRemove);
                        if (m.segments) {
                            m.segments.files = Math.max(0, m.segments.files - tokensToRemove);
                        }

                        this._panel.webview.postMessage({
                            command: 'updateTokenProgress',
                            totalTokens: m.total,
                            contextSize: m.contextSize,
                            isApproximate: false,
                            segments: m.segments
                        });
                    }

                    // Run the background sync asynchronously to align with disk state
                    this.updateContextAndTokens({ isBackgroundSync: true });
                }
                break;
            case 'openFile':
                if (this._contextManager) {
                    const res = await this._contextManager.resolveWorkspaceFromPath(message.path);
                    if (res) {
                        try {
                            const doc = await vscode.workspace.openTextDocument(res.uri);
                            await vscode.window.showTextDocument(doc);
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
                    const allTools = this.agentManager.getTools().map(t => ({ name: t.name, description: t.description }));
                    const discussionTools = this._currentDiscussion?.importedTools || [];
                    const projectTools = await this._contextManager.getActiveProjectTools();
                    this._panel.webview.postMessage({ 
                        command: 'showToolPicker', 
                        allTools, 
                        discussionTools,
                        projectTools
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
                    // Clear the token cache since the tokenization logic will differ for the new model
                    ChatPanel._tokenCountCache.clear();
                    // Provide immediate feedback to the webview header
                    const effectiveModel = message.model || this._lollmsAPI.getModelName();
                    this._panel.webview.postMessage({ command: 'updateModelNameOnly', modelName: effectiveModel });
                    if (!this._currentDiscussion.id.startsWith('temp-')) {
                        await this._discussionManager.saveDiscussion(this._currentDiscussion);
                    }
                }
                return;
            case 'refreshModels':
                await this._fetchAndSetModels(true);
                break;
            case 'calculateTokens':
                this.updateContextAndTokens({ forceFullScan: message.force === true });
                break;
            case 'markHunkApplied':
                await this.updateAppliedState(message.messageId, message.blockIndex, message.hunkIndex, message.undo === true);
                // Send confirmation back to the webview to synchronize the specific Hunk tabs and Apply buttons
                webview.postMessage({
                    command: 'applyAllResult',
                    messageId: message.messageId,
                    blockIndex: message.blockIndex,
                    hunkIndex: message.hunkIndex,
                    success: true,
                    alreadyApplied: true
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
                    // Smart Routing: Identify if query targets memory/skills TBox concepts
                    const isMemoryQuery = params.query.includes('s:Engram') || 
                                          params.query.includes('s:Tag') || 
                                          params.query.includes('s:Rule') || 
                                          params.query.includes('s:Skill') || 
                                          params.query.includes('s:Document');

                    let result = "";
                    if (isMemoryQuery && this.agentManager?.projectMemoryManager) {
                        const skillsManager = this.agentManager.skillsManager;
                        const activeSkills = this._currentDiscussion?.importedSkills || [];

                        // Extract fully projected engram/skill graph from memory manager
                        const projected = await this.agentManager.projectMemoryManager.getProjectedGraph(skillsManager, activeSkills);

                        const customNodes = projected.filter((el: any) => el.group === 'nodes').map((el: any) => ({
                            id: el.data.id,
                            type: el.data.category || 'general',
                            label: el.data.label
                        }));
                        const customEdges = projected.filter((el: any) => el.group === 'edges').map((el: any) => ({
                            source: el.data.source,
                            target: el.data.target,
                            label: el.data.label
                        }));

                        result = this.agentManager.codeGraphManager.executeSparql(params.query, customNodes, customEdges);
                    } else {
                        // If the codebase graph has not been built yet, build it automatically in the background
                        if (this.agentManager.codeGraphManager.getBuildState() !== 'ready') {
                            await vscode.window.withProgress({
                                location: vscode.ProgressLocation.Notification,
                                title: "Lollms: Building architecture map for SPARQL query...",
                                cancellable: false
                            }, async (progress) => {
                                // Ensure the workspace root is set before building the graph
                                const folders = vscode.workspace.workspaceFolders;
                                if (folders && folders.length > 0) {
                                    this.agentManager.codeGraphManager.setWorkspaceRoot(folders[0].uri);
                                }
                                await this.agentManager.codeGraphManager.buildGraph(undefined, (p) => {
                                    progress.report({ message: `${p.status} (${p.percentage}%)` });
                                });
                            });
                        }
                        result = this.agentManager.codeGraphManager.executeSparql(params.query);
                    }

                    webview.postMessage({
                        command: 'applyAllResult',
                        messageId: params.messageId,
                        blockIndex: params.blockId,
                        success: true,
                        sparqlResult: result
                    });
                    
                    if (params.reprompt) {
                        // Rather than sending a new User message and starting a new chat turn,
                        // we privately inject the result into the current active conversation thread
                        // to keep all tool results and corrections inside the same single assistant bubble.
                        const activePanel = ChatPanel.panels.get(this.discussionId);
                        if (activePanel && activePanel.getCurrentDiscussion()) {
                            const disc = activePanel.getCurrentDiscussion()!;
                            
                            // Check if this is the dynamic mode loop
                            const activeGen = ChatPanel.activeGenerations.get(this.discussionId);
                            if (activeGen) {
                                // Dynamic mode is actively running, let the loop handle it
                                return;
                            }

                            // If triggered manually by user click, we simulate the next turn privately
                            const responsePrompt = `### 📋 SPARQL QUERY RESULT\nQuery executed on the complete ontology graph:\n\`\`\`sparql\n${params.query}\n\`\`\`\n\n**Result:**\n${result}\n\nAnalyze these results and proceed with the mission.`;
                            
                            activePanel.sendMessage({ role: 'system', content: responsePrompt, skipInPrompt: false });
                        }
                    }
                } else if (command === 'createNotebook') {
                    vscode.commands.executeCommand('lollms-vs-coder.createNotebook', params.path, params.cellContent);
                } else if (command === 'gitCommit') {
                    vscode.commands.executeCommand('lollms-vs-coder.gitCommit', params.message);
                } else if (command === 'resetContext') {
                    vscode.commands.executeCommand('lollms-vs-coder.resetContextSelection');
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

                    // 1. Clear active generations and cancel current processes
                    ChatPanel.activeGenerations.delete(this.discussionId);
                    this.processManager.cancelForDiscussion(this.discussionId);

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
            case 'runAgent':
                if (!this._currentDiscussion) return;

                // Handle continuation after manual approval
                if (message.objective === 'CONTINUE_AFTER_APPROVAL') {
                    const approvedTaskId = parseInt(message.taskId, 10);
                    const alwaysAllow = !!message.alwaysAllow;

                    if (alwaysAllow && this.agentManager['currentPlan']) {
                        const task = this.agentManager['currentPlan'].tasks.find(t => t.id === approvedTaskId);
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
                const config = vscode.workspace.getConfiguration('lollmsVsCoder');
                const profiles = config.get('responseProfiles') || [];
                const workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => ({
                    name: f.name,
                    uri: f.uri.toString()
                }));

                this._panel.webview.postMessage({ 
                    command: 'showDiscussionSettings',
                    capabilities: this._discussionCapabilities,
                    profiles: profiles,
                    workspaceFolders: workspaceFolders
                });
                break;
            }
            case 'requestLog':
                this.showInternalLog();
                return;
            case 'regenerateFromMessage':
                await this.regenerateFromMessage(message.messageId);
                break;
            case 'insertMessage':
                await this.insertMessage(message.afterMessageId, message.role, message.content);
                break;
            case 'updateMessage':
                await this.updateMessage(message.messageId, message.newContent);
                break;
            case 'applyFileContent':
                try {
                    const res: any = await vscode.commands.executeCommand('lollms-vs-coder.applyFileContent', message.filePath, message.content);
                    webview.postMessage({
                        command: 'applyAllResult',
                        messageId: message.messageId,
                        filePath: message.filePath,
                        blockIndex: message.blockIndex,
                        success: res?.success ?? false,
                        error: res?.error
                    });
                    if (res && res.success) {
                        await this.updateAppliedState(message.messageId, message.blockIndex);
                    }
                } catch (e: any) {
                    this.log(`Command applyFileContent failed: ${e.message}`, 'ERROR');
                    webview.postMessage({ command: 'applyAllResult', messageId: message.messageId, blockIndex: message.blockIndex, success: false, error: e.message });
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
                vscode.commands.executeCommand('lollms-vs-coder.runScript', message.code, message.language);
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
            case 'importSkills':
                await this.handleImportSkills();
                break;
            case 'importSelectedSkills': {
                const discussionSkills = message.discussionSkills || [];
                const projectSkills = message.projectSkills || [];

                if (this._currentDiscussion) {
                    // 1. Authoritative State Update
                    this._currentDiscussion.importedSkills = Array.from(new Set(discussionSkills));

                    // 2. Update Project-level persistence
                    const allSkills = await this._skillsManager.getSkills();
                    for (const skill of allSkills) {
                        if (projectSkills.includes(skill.id)) {
                            await this._contextManager.addSkillToProject(skill.id);
                        } else {
                            await this._contextManager.removeSkillFromProject(skill.id);
                        }
                    }

                    // 3. Forced Sync & Save
                    if (!this._currentDiscussion.id.startsWith('temp-')) {
                        await this._discussionManager.saveDiscussion(this._currentDiscussion);
                    }

                    // 4. Update HUD
                    const activeSkillsForHUD = allSkills.filter(s => 
                        this._currentDiscussion?.importedSkills?.includes(s.id) || projectSkills.includes(s.id)
                    );

                    this._panel.webview.postMessage({ 
                        command: 'updateContext', 
                        skills: activeSkillsForHUD,
                        context: "", 
                        files: this._contextManager.getContextStateProvider()?.getIncludedFiles().map(f => f.path) || []
                    });

                    // 5. Trigger Re-tokenization
                    this.updateContextAndTokens();
                    vscode.window.showInformationMessage(`✅ Skills context updated.`);
                }
                break;
            }
            case 'runAndMonitorApp':
                vscode.commands.executeCommand('lollms-vs-coder.runAndMonitorApp', this, message.messageId);
                break;
            case 'openSettings':
                vscode.commands.executeCommand('lollms-vs-coder.showConfigView');
                break;
            case 'updateDiscussionCapabilities':
                this._discussionCapabilities = message.capabilities;
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
                        await this._discussionManager.saveDiscussion(this._currentDiscussion);
                        this.updateContextAndTokens();
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

                    this._discussionCapabilities = { ...this._discussionCapabilities, ...partial };

                    if (partial.agentMode !== undefined) {
                        if (partial.agentMode && !this.agentManager.getIsActive()) {
                            this.agentManager.toggleAgentMode();
                        } else if (!partial.agentMode && this.agentManager.getIsActive()) {
                            this.agentManager.toggleAgentMode();
                        }
                    }

                    // Refresh Plan HUD if plan exists (e.g. after adding tools)
                    if (this.agentManager["currentPlan"]) {
                        this.agentManager.displayPlan(this.agentManager["currentPlan"]);
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

                    // OPTIMIZATION: If only visual modes (Think, Agent, AutoContext) changed,
                    // do not trigger a full context scan to avoid badge-flicker.
                    const isVisualOnly = partial.thinkingMode !== undefined || partial.agentMode !== undefined;

                    if (!isVisualOnly) {
                        await this.updateContextAndTokens({ isBackgroundSync: false });
                    }

                    // Force an immediate UI refresh
                    this._panel.webview.postMessage({ command: 'updateDiscussionCapabilities', capabilities: this._discussionCapabilities });
                }
                break;
            case 'updateDiscussionPersonality':
                if (this._currentDiscussion) {
                    this._currentDiscussion.personalityId = message.personalityId;

                    // Persist selected personality over the entire project workspace
                    await this._discussionManager.context.workspaceState.update('lollms_project_active_personality_id', message.personalityId);

                    const persona = this._personalityManager?.getPersonality(message.personalityId);
                    if (persona) {
                        this.log(`Personality switched and persisted project-wide: ${persona.name}`);
                    }
                    if (!this._currentDiscussion.id.startsWith('temp-')) {
                        await this._discussionManager.saveDiscussion(this._currentDiscussion);
                    }
                }
                break;
            case 'runTool':
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
                                currentPlan: null
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
                            const nudgeMessage: ChatMessage = {
                                role: 'system',
                                content: `The user manually triggered the tool '${toolName}'. Analyze the output above and proceed with the mission.`,
                                skipInPrompt: false 
                            };

                            await this.sendMessage(nudgeMessage);

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
            case 'saveMissionBriefing':
                const { content, scope } = message;
                
                if (this._currentDiscussion) {
                    let parsed: any = {};
                    if (this._currentDiscussion.discussion_data_zone) {
                        try {
                            parsed = JSON.parse(this._currentDiscussion.discussion_data_zone);
                        } catch {
                            parsed = { legacy: this._currentDiscussion.discussion_data_zone };
                        }
                    }
                    if (content) {
                        parsed.user_constraints = content;
                    } else {
                        delete parsed.user_constraints;
                    }
                    this._currentDiscussion.discussion_data_zone = JSON.stringify(parsed, null, 2);
                    if (!this._currentDiscussion.id.startsWith('temp-')) {
                        await this._discussionManager.saveDiscussion(this._currentDiscussion);
                    }
                }

                if (scope === 'global' && this._contextManager) {
                    await this._contextManager.setGlobalBriefing(content);
                } else if (this._contextManager) {
                    if (!content && scope === 'global') {
                        await this._contextManager.setGlobalBriefing('');
                    }
                }

                this.updateContextAndTokens();
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
                    this.agentManager.chatHistory = [...this._currentDiscussion.messages];

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
                    const plan = agent['currentPlan'];
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
              
              progress.report({ message: "Reading context..." });
              const contextData = await this._contextManager.getContextContent({ 
                  importedSkillIds: importedIds,
                  modelName: this._currentDiscussion?.model || this._lollmsAPI.getModelName()
              });
              
              const context = {
                  tree: contextData.projectTree,
                  files: contextData.selectedFilesContent,
                  skills: contextData.skillsContent,
                  toolManager: this.agentManager?.['toolManager']
              };

              progress.report({ message: "Generating Persona..." });
              const personaContent = this.getCurrentPersonaSystemPrompt();
              const systemPrompt = await getProcessedSystemPrompt('chat', this._discussionCapabilities, personaContent, undefined, forceFullCode, context);

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
              for (const relativePath of files) {
                  const uri = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);
                  await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
              }
              vscode.window.showInformationMessage(vscode.l10n.t("info.bulkDeleteFilesSuccess", files.length));
              this.updateContextAndTokens();
          } catch (e: any) {
              vscode.window.showErrorMessage(vscode.l10n.t("error.bulkDeleteFailed", e.message));
          }
      }
  }

  /**
   * Scans text for <project_memory> tags and delegates processing to the manager.
   */
  private async processProjectMemoryTags(content: string) {
      if (this.agentManager?.projectMemoryManager) {
          await this.agentManager.projectMemoryManager.processTags(content);
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
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!provider || !workspaceFolder) return;

      const includedFiles = provider.getIncludedFiles();
      const model = this._currentDiscussion.model || this._lollmsAPI.getModelName();
      const crypto = require('crypto');

      // 1. Send initial list immediately so UI renders skeleton
      const initialUsage = includedFiles.map(f => ({
          path: f.path,
          state: f.state,
          tokens: -1, // Loading state
          isExtra: f.path.includes('.lollms/') || f.path.startsWith('http')
      }));

      this._panel.webview.postMessage({ command: 'contextUsageData', usage: initialUsage });

      // 2. Populate tokens incrementally
      for (const file of includedFiles) {
          // Cooperative Yield: Let the main Extension Host thread breathe and process webview paints
          await new Promise(resolve => setTimeout(resolve, 5));

          try {
              const uri = vscode.Uri.joinPath(workspaceFolder.uri, file.path);
              const stats = await vscode.workspace.fs.stat(uri);

              // Generate a lightweight, non-reading composite hash using file size + modified time
              const compositeHash = `${stats.size}_${stats.mtime}`;

              let tokenCount = await this._contextManager.getCachedTokens(file.path, compositeHash);

              if (tokenCount === null) {
                  // Only read the file if we do not have a cached token count for this specific version!
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

        // Resolve path to chatPanel.html safely in a multi-platform environment
        const htmlPath = vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'chatPanel.html');
        let htmlContent = "";
        try {
            const rawBytes = await vscode.workspace.fs.readFile(htmlPath);
            htmlContent = Buffer.from(rawBytes).toString('utf8');
        } catch (err: any) {
            return `<h3>Error loading Chat Panel layout. Details: ${err.message}</h3>`;
        }

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
2. **INDENTATION SENSITIVITY**: This is Python code. Ensure your SEARCH and REPLACE blocks respect the exact nesting levels.
3. **NO TRAILING COMMENTS**: Do not add comments like "# ... existing code" inside blocks.
4. Use **AIDER SEARCH/REPLACE** format.
5. Output ONLY the code blocks. No chatter.`;

                const systemPrompt = "You are a surgical code repair expert. Output only Aider SEARCH/REPLACE blocks to fix the requested errors.";
                
                try {
                    if (agent) {
                        (agent as any).completedActionsHistory.push(`[GUARDIAN REPAIR] 🛡️ START: Attempting to fix ${diagnostics.length} errors in \`${relativePath}\` (Retry ${retries}/${max}).`);
                    }

                    const response = await this._lollmsAPI.sendChat([
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: repairPrompt }
                    ], null, signal, this._currentDiscussion?.model);

                    // Apply the fix silently and auto-save
                    await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', relativePath, response, this, messageId, { silent: true, autoSave: true });

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
    public async handleFixAllErrors() {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder || !this.processManager) return;

        const allDiagnostics = vscode.languages.getDiagnostics();
        const urisWithErrors: vscode.Uri[] = [];
        for (const [uri, diagnostics] of allDiagnostics) {
            if (diagnostics.some(d => d.severity === vscode.DiagnosticSeverity.Error)) {
                if (uri.fsPath.startsWith(workspaceFolder.uri.fsPath)) urisWithErrors.push(uri);
            }
        }

        if (urisWithErrors.length === 0) {
            vscode.window.showInformationMessage("🎉 No errors found in the workspace!");
            return;
        }

        const { id: processId, controller } = this.processManager.register(this.discussionId, `Repairing ${urisWithErrors.length} files...`);
        const autoUI = AutomationPanel.createOrShow(this._extensionUri);
        const sharedCache = new Map<string, string>(); // path -> content

        autoUI.onDidCancel(() => {
            this.processManager.cancel(processId);
            autoUI.dispose();
        });

        try {
            for (const uri of urisWithErrors) {
                if (controller.signal.aborted) break;
                const relPath = vscode.workspace.asRelativePath(uri);
                const diagnostics = vscode.languages.getDiagnostics(uri).filter(d => d.severity === vscode.DiagnosticSeverity.Error);
                
                autoUI.updateFileProgress(relPath, 'scanning', `Starting repair: ${diagnostics.length} errors detected.`, diagnostics.length);

                let hasFixed = false;
                let retries = 0;
                const max = this._discussionCapabilities.maxFixRetries || 3;

                while (retries < max && !hasFixed) {
                    if (controller.signal.aborted) break;
                    retries++;

                    const doc = await vscode.workspace.openTextDocument(uri);
                    const errorLog = diagnostics.map(d => `[Line ${d.range.start.line + 1}] ${d.message}`).join('\n');
                    
                    // Construct surgical prompt with mutualized cache
                    const cacheText = Array.from(sharedCache.entries()).map(([p,c]) => `--- ${p} ---\n${c}`).join('\n');
                    const systemPrompt = await getProcessedSystemPrompt('surgical_agent');
                    const userPrompt = `### REPAIR TASK\nFile: ${relPath}\n\nErrors:\n${errorLog}\n\nContent:\n${doc.getText()}\n\nShared Knowledge:\n${cacheText || 'No extra context cached yet.'}`;

                    autoUI.updateFileProgress(relPath, 'fixing', `Agent Decision (Attempt ${retries}/${max})...`);
                    const response = await this._lollmsAPI.sendChat([
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt }
                    ], null, controller.signal, this._currentDiscussion?.model);

                    const cleanResponse = stripThinkingTags(response);

                    // 1. Check for Context Expansion (Decision)
                    if (cleanResponse.includes('"tool"')) {
                        try {
                            const action = JSON.parse(cleanResponse.match(/\{[\s\S]*\}/)![0]);
                            if (action.tool === 'read_files') {
                                for(const p of (action.params.paths || [])) {
                                    autoUI.updateFileProgress(relPath, 'scanning', `Reading dependency: ${p}`);
                                    const content = await this._contextManager.readSpecificFiles([p]);
                                    sharedCache.set(p, content);
                                }
                                continue; // Retry fixing with new context
                            }
                        } catch(e) {}
                    }

                    // 2. Apply Aider Patch
                    autoUI.updateFileProgress(relPath, 'fixing', `Applying surgical patch...`);
                    await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', relPath, cleanResponse, this, undefined, { silent: true, autoSave: true });
                    
                    // 3. Verify
                    await new Promise(r => setTimeout(r, 2000));
                    const currentDiags = vscode.languages.getDiagnostics(uri).filter(d => d.severity === vscode.DiagnosticSeverity.Error);
                    if (currentDiags.length === 0) {
                        autoUI.updateFileProgress(relPath, 'success', `Fixed all errors successfully!`);
                        hasFixed = true;
                    } else {
                        autoUI.updateFileProgress(relPath, 'fixing', `Reduced to ${currentDiags.length} errors.`);
                    }
                }
            }
        } finally {
            this.processManager.unregister(processId);
        }
    }

}
