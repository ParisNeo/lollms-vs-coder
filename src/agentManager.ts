import * as vscode from 'vscode';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { ContextManager } from './contextManager';
import { GitIntegration } from './gitIntegration';
import { InfoPanel } from './commands/infoPanel';
import { PlanParser } from './planParser';
import { stripThinkingTags, getProcessedSystemPrompt, stripAnsiCodes, arePathsEqual, extractFileBlocks, parseFileTagAttributes, getContextLimitForModel, isProjectFile } from './utils';
import { ProcessManager } from './processManager';
import { DiscussionManager, Discussion } from './discussionManager';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ToolManager } from './tools/toolManager';
import { ToolExecutionEnv, ToolDefinition, Plan, ToolPermissionGroup } from './tools/tool';
import { CodeGraphManager } from './codeGraphManager';
import { SkillsManager } from './skillsManager';
import { PersonalityManager } from './personalityManager';
import { runCommandInTerminal } from './extensionState';
import { RLMDatabaseManager } from './rlmDatabaseManager';
import { FailureMemory } from './agent/failureHandling'; 
import { Logger } from './logger';
import { AgentSecurityGuard, AgentSecurityLevel } from './security/agentSecurityGuard';
import { ContextPoisoningGate } from './security/contextPoisoningGate';

export interface IAgentUI {
    addMessageToDiscussion(message: ChatMessage): Promise<void>;
    updateMessageContent?(messageId: string, newContent: string): Promise<void>;
    displayPlan(plan: Plan | null): void;
    updateGeneratingState(): void;
    requestUserInput(question: string, signal: AbortSignal, options?: { isAgentZone?: boolean }): Promise<string>;
    updateAgentMode(isActive: boolean): void;
    syncAgentSecurityState?(level: AgentSecurityLevel, mutationCount: number): void;
    runVerificationAgent(content: string, signal: AbortSignal): Promise<string>;
    executeAutomationPipeline(content: string, messageId: string, signal: AbortSignal, processId: string): Promise<void>;
}

export interface UserPermissions {
    canExecute: boolean;
    canRead: boolean;
}

import { Task } from './tools/tool';

export class AgentManager {
    private isActive: boolean = false;
    private currentPlan: Plan | null = null;
    private chatHistory: ChatMessage[] = [];
    public planParser: PlanParser;
    private processManager?: ProcessManager;
    public currentWorkspaceFolder?: vscode.WorkspaceFolder;
    private currentTaskIndex: number = 0;
    public currentDiscussion?: Discussion;
    private toolManager: ToolManager;
    private codeGraphManager: CodeGraphManager;
    private dashboardState: any = { web: "", skills: "", debugger: "" };
    private dashboardUpdater?: () => void;
    private skillsManager: SkillsManager;
    private globalFailureLog: string[] = []; 
    private currentUserPermissions: UserPermissions = { canExecute: true, canRead: true };
    private consecutiveTaskFailures: Map<number, number> = new Map();
    private taskEditRetries: Map<number, number> = new Map();

    private failureMemory: FailureMemory = new FailureMemory();
    public securityGuard: AgentSecurityGuard = new AgentSecurityGuard();
    private isDebugging: boolean = false;
    private activeExecutions: Set<string> = new Set();
    public projectMemoryManager?: any; 
    public personalityManager?: PersonalityManager;

    private completedActionsHistory: string[] = [];

    public rlmDb?: RLMDatabaseManager;

    public sessionState: {
        activeEnv?: string; 
        projectEnvironments: Record<string, string>; 
        replVariables: Record<string, any>; 
        installedPackages: string[];
        environmentHistory: string[];
        workingMemory: string[]; 
        projectMemory: string[]; 
        secureCredentials: Record<string, string>;
        isSafetyCheckPassed: boolean;
        startCommitHash?: string;
        startBranch?: string;
        unverifiedFiles: Set<string>; 
        lastFilesystemWriteTime: number; 
        blacklistedTools: Set<string>; 
        extensionVersion: string; 
        backgroundProcesses: Map<string, { pid: number, logFile: string, startTime: number }>;
    } = {
        projectEnvironments: {},
        replVariables: {},
        installedPackages: [],
        environmentHistory: [],
        workingMemory: [],
        projectMemory: [],
        secureCredentials: {},
        isSafetyCheckPassed: false,
        unverifiedFiles: new Set(),
        lastFilesystemWriteTime: 0,
        blacklistedTools: new Set(),
        extensionVersion: "",
        backgroundProcesses: new Map()
    };

    constructor(
        private ui: IAgentUI,
        public lollmsApi: LollmsAPI,
        public contextManager: ContextManager,
        private gitIntegration: GitIntegration,
        private discussionManager: DiscussionManager,
        private extensionUri: vscode.Uri,
        codeGraphManager: CodeGraphManager,
        skillsManager: SkillsManager,
        toolManager?: ToolManager,
        rlmDb?: RLMDatabaseManager
    ) {
        this.codeGraphManager = codeGraphManager;
        this.skillsManager = skillsManager;
        this.toolManager = toolManager || new ToolManager();
        this.planParser = new PlanParser(this.lollmsApi, this.contextManager, this.toolManager);
        this.rlmDb = rlmDb;
        this.activeExecutions = new Set();

        this.sessionState.workingMemory.push(
            "LESSON: Avoid nesting shells. Do not use 'powershell -Command' or 'bash -c' inside 'execute_command'. " +
            "Submit the raw command directly. For complex logic involving pipes or variables, always generate a temporary script in the target language (py, js, sh) first."
        );
        this.sessionState.workingMemory.push(
            "DIAGNOSTIC: If you see 'OS ERROR: Output capture file missing', this is a file system lock issue on Windows. Do NOT refactor your code or change the script. Simply use the 'wait' tool for 2 seconds and then retry the exact same command. This allows the OS to release the file handle."
        );

        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            this.currentWorkspaceFolder = vscode.workspace.workspaceFolders[0];
        }

        this.setupDreamScheduler();
    }

    private setupDreamScheduler() {
        setInterval(async () => {
            const config = vscode.workspace.getConfiguration('lollmsVsCoder.memory');
            if (!config.get<boolean>('autoDream')) return;

            const dreamTime = config.get<string>('dreamSchedule') || "01:00";
            const now = new Date();
            const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

            if (currentTime === dreamTime && this.projectMemoryManager) {
                Logger.info("Genie: Starting scheduled Dream Cycle...");
                await this.projectMemoryManager.performDreamCycle();
            }
        }, 60000); 
    }

    private async condenseObservations(model: string, signal: AbortSignal) {
        if (!this.currentPlan || !this.currentPlan.observations) return;

        const summaryPrompt: ChatMessage[] = [
            { 
                role: 'system', 
                content: `You are the Genie's Memory Optimizer. 
Condense the following list of technical observations into a single, high-density "Legacy Intelligence" block. 
Focus on: 
1. Hard facts discovered (paths, versions, logic quirks).
2. What failed and why.
3. What is confirmed working.
Keep it strictly technical and extremely concise.` 
            },
            { role: 'user', content: this.currentPlan.observations.join('\n') }
        ];

        try {
            const condensed = await this.lollmsApi.sendChat(summaryPrompt, null, signal, model);
            this.currentPlan.observations = [`COMPRESSED HISTORY: ${condensed}`];
            this.ui.addMessageToDiscussion({ role: 'system', content: '♻️ **Scratchpad Rearranged:** Observations compressed to save context.' });
        } catch (e) {
            console.error("Compression failed", e);
        }
    }

    public setUI(ui: IAgentUI) {
        this.ui = ui;
        this.ui.updateAgentMode(this.isActive);
        this.ui.displayPlan(this.currentPlan);
        this.ui.updateGeneratingState();
    }

    public setProcessManager(processManager: ProcessManager) {
        this.processManager = processManager;
    }

    public getIsActive(): boolean {
        return this.isActive;
    }

    public getTools(): ToolDefinition[] {
        return this.toolManager.getAllTools();
    }
    
    public getEnabledTools(): ToolDefinition[] {
        const policies = this.currentDiscussion?.capabilities?.toolPolicies || {};
        const isAgentMode = this.isActive; 
        const isBuilderMode = this.currentDiscussion?.capabilities?.workerType === 'builder';

        const discussionTools = this.currentDiscussion?.importedTools || [];
        const projectTools = (this as any)._projectToolsCache || []; 

        const allEquipped = new Set([...discussionTools, ...projectTools]);

        const DISCUSSION_SAFE_LIST = [
            'add_files_to_context',
            'remove_files_from_context',
            'navigate_to_code',
            'move_file',
            'delete_file',
            'generate_image',
            'edit_image_asset',
            'read_code_graph',
            'record_milestone',
            'record_discovery',
            'smart_scout'
        ];

        const attachments = this.currentDiscussion?.messages
            .filter(m => (m as any).attachmentData).length || 0;

        if (!this.toolManager || typeof this.toolManager.getAllTools !== 'function') {
            Logger.error("ToolManager not properly initialized in AgentManager");
            return [];
        }

        const sparqlEnabled = this.currentDiscussion?.capabilities?.sparqlEnabled !== false;
        const webSearchEnabled = this.currentDiscussion?.capabilities?.webSearch === true;

        const tools = this.toolManager.getAllTools().filter(t => {
            // Strictly exclude any blacklisted tools immediately
            if (this.sessionState.blacklistedTools && this.sessionState.blacklistedTools.has(t.name)) return false;

            // Dynamically remove SPARQL-specific tools when deactivated
            if (!sparqlEnabled && (t.name === 'query_architecture' || t.name === 'read_code_graph')) {
                return false;
            }

            // Dynamically remove Web-Search tools when deactivated
            if (!webSearchEnabled && (
                t.name === 'search_web' ||
                t.name === 'search_wikipedia' ||
                t.name === 'search_stackoverflow' ||
                t.name === 'scrape_website' ||
                t.name === 'research_web_page' ||
                t.name === 'search_arxiv' ||
                t.name === 'extract_youtube_transcript'
            )) {
                return false;
            }

            if (t.name === 'submit_response') return true;
            if (t.name === 'read_discussion_file' && attachments === 0) return false;

const isEquipped = allEquipped.has(t.name);
            const isDefaultDiscussion = DISCUSSION_SAFE_LIST.includes(t.name);

            if (!isAgentMode) {
                if (t.name === 'read_file' || t.name === 'read_files' || t.name === 'peek_at_context') return false;
                if (!isDefaultDiscussion && !isEquipped) return false;
            }

            if (isBuilderMode && t.permissionGroup === 'shell_execution') return false;

            let policy = policies[t.name];
            if (!policy) {
                const sensitiveGroups = ['shell_execution', 'filesystem_write'];
                const isSensitive = t.permissionGroup && sensitiveGroups.includes(t.permissionGroup);
                policy = isSensitive ? 'manual' : 'autonomous';
            }
            return policy !== 'disabled';
        });

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const useRLM = config.get<boolean>('agent.useRLM') || false;

        let filteredTools = tools;
        if (!useRLM) {
            filteredTools = tools.filter(t => t.name !== 'rlm_repl');
        }

        // Final sanity check: filter out any blacklisted tools from the final array
        return filteredTools.filter(t => !this.sessionState.blacklistedTools || !this.sessionState.blacklistedTools.has(t.name));
    }

    public setEnabledTools(toolNames: string[]) {
        this.toolManager.setEnabledTools(toolNames);
    }

    public setToolPolicies(policies: Record<string, 'disabled' | 'manual' | 'autonomous'>) {
        if (this.currentDiscussion?.capabilities) {
            this.currentDiscussion.capabilities.toolPolicies = policies;
        }
    }

    public getCurrentDiscussion(): Discussion | undefined {
        return this.currentDiscussion;
    }

    public toggleAgentMode() {
        this.isActive = !this.isActive;
        if (this.isActive) {
            this.ui.addMessageToDiscussion({ 
                role: 'system', 
                content: `🛰️ **Autonomous Agent Mode Engaged.** I am now operating as the **Leader Architect**. I will analyze the objective, create a multi-step plan, and execute tools autonomously.` 
            });
        } else {
            this.ui.addMessageToDiscussion({ role: 'system', content: '🤖 **Agent Mode Deactivated.**' });
            if (this.currentPlan) {
                this.currentPlan.status = 'stale';
                this.displayPlan(this.currentPlan);
            }
        }
        this.ui.updateAgentMode(this.isActive);
    }

    public getMetrics() {
        const memoryChars = this.sessionState.workingMemory.join('\n').length;
        const scratchpadChars = this.currentPlan?.scratchpad?.length || 0;
        const historyChars = this.completedActionsHistory.join('\n').length;

        return {
            memory: memoryChars,
            scratchpad: scratchpadChars,
            history: historyChars,
            replVars: Object.keys(this.sessionState.replVariables).length,
            total: memoryChars + scratchpadChars + historyChars
        };
    }

    public async displayPlan(plan: Plan | null) {
        this.currentPlan = plan;
        if (this.currentDiscussion && !this.currentDiscussion.id.startsWith('temp-') && !this.currentDiscussion.id.startsWith('remote-')) {
            this.currentDiscussion.plan = plan;
            await this.discussionManager.saveDiscussion(this.currentDiscussion);
        }

        const metrics = this.getMetrics();
        this.ui.displayPlan(plan ? { ...plan, metrics } : null);
    }

    public async exportTimelineToHtml() {
        if (!this.currentPlan) return;

        const { generateMissionReport } = await import('./utils/exportUtils.js');
        const html = generateMissionReport(this.currentPlan, this.completedActionsHistory);

        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`mission_report_${Date.now()}.html`),
            filters: { 'HTML': ['html'] },
            saveLabel: 'Export Mission Timeline'
        });

        if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(html, 'utf8'));
            vscode.window.showInformationMessage(`Mission report exported to ${path.basename(uri.fsPath)}`);
        }
    }

    private archiveCurrentPlanState(reason: string) {
        if (!this.currentPlan) return;
        if (!this.currentPlan.attempts) {
            this.currentPlan.attempts = [];
        }
        const archive: Plan = {
            objective: this.currentPlan.objective,
            current_sub_goal: this.currentPlan.current_sub_goal,
            observations: [...this.currentPlan.observations],
            scratchpad: this.currentPlan.scratchpad + `\n\n*(Plan archived because: ${reason})*`,
            tasks: JSON.parse(JSON.stringify(this.currentPlan.tasks)),
            investigation: this.currentPlan.investigation ? JSON.parse(JSON.stringify(this.currentPlan.investigation)) : [],
            status: 'stale'
        };
        this.currentPlan.attempts.push(archive);
    }

    private async preFlightSafetyCheck(folder: vscode.WorkspaceFolder, signal: AbortSignal): Promise<boolean> {
        const { hardenWorkspace } = require('./utils');
        await hardenWorkspace(folder);

        if (this.currentPlan && this.completedActionsHistory.length > 0) {
            this.sessionState.isSafetyCheckPassed = true;
            return true;
        }

        const proc = this.processManager?.getForDiscussion(this.currentDiscussion?.id || "");
        if (proc) this.processManager?.updateDescription(proc.id, "🛡️ Safety: Checking Git Integrity...");

        if (this.sessionState.isSafetyCheckPassed) {
            Logger.info(`[Phase 0] Safety check already passed for this session. Skipping.`);
            return true;
        }

        Logger.info(`[Phase 0] Starting Pre-Flight Safety Check for: ${folder.name}`);
        
        const withTimeout = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
            let timeoutHandle: NodeJS.Timeout;
            const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutHandle = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
            });
            try {
                return await Promise.race([promise, timeoutPromise]);
            } finally {
                // @ts-ignore
                clearTimeout(timeoutHandle);
            }
        };

        let isRepo = false;
        try {
            isRepo = await withTimeout(this.gitIntegration.isGitRepo(folder), 10000, "Git check");
        } catch (e: any) {
            Logger.warn(`[Phase 0] ${e.message}. Proceeding as non-repo.`);
            isRepo = false; 
        }

        if (!this.currentPlan) {
            this.currentPlan = {
                objective: "Initializing Safety Protocols...",
                current_sub_goal: "Verify Workspace Integrity",
                observations: [],
                scratchpad: "Waiting for workspace safety confirmation...",
                tasks: [],
                status: 'active'
            };
        }

        if (!isRepo) {
            const config = vscode.workspace.getConfiguration('lollmsVsCoder');
            const autoGit = this.currentDiscussion?.capabilities?.gitAutoWorkflow || config.get<boolean>('gitAutoWorkflow');

            if (autoGit) {
                // Auto-initialize clean repository
                this.ui.addMessageToDiscussion({ role: 'system', content: `⚙️ **Auto-Initializing Clean Git Repository...**` });
                try {
                    await this.runCommand('git init', signal);
                    const ignoreContent = [
                        "# Lollms Internal State",
                        ".lollms/",
                        ".lollms_workspaces/",
                        ".lollms_scripts/",
                        ".lollms_snapshots/",
                        "",
                        "# Dependencies (Strict)",
                        "venv/",
                        ".venv/",
                        "env/",
                        "node_modules/",
                        "__pycache__/",
                        "*.pyc",
                        "*.pyo",
                        "*.pyd",
                        "",
                        "# Build & System",
                        "dist/",
                        "build/",
                        "out/",
                        "target/",
                        ".vscode/",
                        ".idea/",
                        ".DS_Store"
                    ].join('\n');

                    const ignorePath = path.join(folder.uri.fsPath, '.gitignore');
                    await fs.writeFile(ignorePath, ignoreContent, 'utf8');

                    await this.runCommand('git add .gitignore', signal);
                    await this.runCommand('git commit -m "chore: initial gitignore"', signal);
                    await this.runCommand('git add .', signal);
                    await this.runCommand('git commit -m "chore: initial repository baseline"', signal);
                    isRepo = true;
                } catch (err: any) {
                    Logger.warn(`Auto git init failed: ${err.message}`);
                }
            } else {
                const formPrompt = `
<lollms_form id="no_git_repo" title="No Git Repository Detected">
<input type="radio" name="decision" label="Stop" value="stop" checked="true" />
<input type="radio" name="decision" label="Continue anyway (No automatic rollbacks)" value="continue" />
<input type="radio" name="decision" label="Create a new repository locally and start" value="init" />
<submit label="Confirm Action" />
</lollms_form>`.trim();

                const safetyTask: Task = {
                    id: -1,
                    task_type: 'safety_check',
                    description: "🛡️ Git missing. Decision required.",
                    action: "safety_check",
                    parameters: { lollms_form: formPrompt },
                    status: 'pending',
                    result: null,
                    retries: 0
                };
                this.currentPlan!.tasks.push(safetyTask);
                await this.displayPlan(this.currentPlan);

                const response = await this.ui.requestUserInput(formPrompt, signal, { isAgentZone: true });

                if (this.currentPlan) {
                    this.currentPlan.tasks = this.currentPlan.tasks.filter(t => t.id !== -1);
                    await this.displayPlan(this.currentPlan);
                }

                let choice = this.parseFormResponse(response, "no_git_repo");
                const safeChoice = (choice || "").toLowerCase().trim();

                if (safeChoice === 'init') {
                    this.ui.addMessageToDiscussion({ role: 'system', content: `⚙️ **Initializing Atomic Clean Repository...**` });

                    await this.runCommand('git init', signal);

                    const ignoreContent = [
                        "# Lollms Internal State",
                        ".lollms/",
                        ".lollms_workspaces/",
                        ".lollms_scripts/",
                        ".lollms_snapshots/",
                        "",
                        "# Dependencies (Strict)",
                        "venv/",
                        ".venv/",
                        "env/",
                        "node_modules/",
                        "__pycache__/",
                        "*.pyc",
                        "*.pyo",
                        "*.pyd",
                        "",
                        "# Build & System",
                        "dist/",
                        "build/",
                        "out/",
                        "target/",
                        ".vscode/",
                        ".idea/",
                        ".DS_Store"
                    ].join('\n');

                    const ignorePath = path.join(folder.uri.fsPath, '.gitignore');
                    await fs.writeFile(ignorePath, ignoreContent, 'utf8');

                    await this.runCommand('git add .gitignore', signal);
                    await this.runCommand('git commit -m "chore: establish ignore rules"', signal);
                    await this.runCommand('git reset', signal);
                    await this.runCommand('git add .', signal);
                    await this.runCommand('git commit -m "Initial commit (clean content)"', signal);

                    this.ui.addMessageToDiscussion({ role: 'system', content: `🛡️ **Repository Secured**: Ignore rules established and confirmed.` });
                    isRepo = true;
                } else if (safeChoice === 'continue') {
                    this.ui.addMessageToDiscussion({ role: 'system', content: `⚠️ **Proceeding without Git.** Automatic rollbacks are disabled.` });
                    return true;
                } else {
                    this.ui.addMessageToDiscussion({ role: 'system', content: `🛑 **Operation cancelled** — no Git repository and user declined to continue.` });
                    return false;
                }
            }
        }

        if (!isRepo) {
            return false;
        }

        let currentBranch = await this.gitIntegration.getCurrentBranch(folder);
        const isClean = await this.gitIntegration.isClean(folder);

        if (!isClean) {
            // DOCTRINE ENFORCEMENT: We ALWAYS start with a clean git environment.
            // If dirty, ask the user: Stash or Commit?
            const formPrompt = `
<lollms_form id="git_safeguard" title="🛡️ Git Safeguard: Clean Workspace Doctrine">
<p style="font-size:11px; margin-bottom:8px; opacity:0.85;">
    <strong>Doctrine Invariant:</strong> The Agentic Engine requires a clean Git environment before starting to ensure safe, isolated rollbacks.
</p>
<input type="radio" name="decision" label="📦 Stash uncommitted changes (git stash)" value="stash" checked="true" />
<input type="radio" name="decision" label="💾 Commit uncommitted changes (git commit checkpoint)" value="commit" />
<input type="radio" name="decision" label="🛑 Abort mission (cancel and resolve manually)" value="abort" />
<submit label="Confirm Git Safeguard" />
</lollms_form>`.trim();

            const safetyTask: Task = {
                id: -1,
                task_type: 'safety_check',
                description: "🛡️ Git Safeguard: Uncommitted changes detected. Stash or Commit required by Doctrine.",
                action: "safety_check",
                parameters: { lollms_form: formPrompt },
                status: 'pending',
                result: null,
                retries: 0
            };

            this.currentPlan!.tasks = [safetyTask];
            await this.displayPlan(this.currentPlan);

            Logger.info(`[Git Safeguard] Emitting Clean Workspace Form to Discussion Stream...`);
            const response = await this.ui.requestUserInput(`🛡️ **Git Safeguard Doctrine**: Uncommitted changes detected on branch \`${currentBranch}\`.\n\n${formPrompt}`, signal, { isAgentZone: false });

            if (this.currentPlan) {
                this.currentPlan.tasks = this.currentPlan.tasks.filter(t => t.id !== -1);
                await this.displayPlan(this.currentPlan);
            }

            let choice = this.parseFormResponse(response, "git_safeguard");
            const safeChoice = (choice || "").toLowerCase().trim();

            if (safeChoice === 'stash') {
                await this.gitIntegration.stash(folder, `Lollms: Stashed before AI mission ${Date.now()}`);
                this.completedActionsHistory.push(`[GIT SAFEGUARD] 📦 STASHED: Working tree cleaned before mission start.`);
                await this.ui.addMessageToDiscussion({ role: 'system', content: `🛡️ **Git Safeguard:** Changes stashed. Working tree is now clean.` });
                this.sessionState.isSafetyCheckPassed = true;
            } else if (safeChoice === 'commit') {
                const msg = await this.gitIntegration.generateCommitMessage(folder);
                const finalMsg = msg?.trim() || `chore: pre-mission checkpoint ${Date.now()}`;
                await this.gitIntegration.stageAllAndCommit(finalMsg, folder);
                this.completedActionsHistory.push(`[GIT SAFEGUARD] 💾 COMMITTED: Saved pre-mission checkpoint (\`${finalMsg}\`).`);
                await this.ui.addMessageToDiscussion({ role: 'system', content: `🛡️ **Git Safeguard:** Changes committed (\`${finalMsg}\`). Working tree is now clean.` });
                this.sessionState.isSafetyCheckPassed = true;
            } else {
                this.ui.addMessageToDiscussion({ role: 'system', content: `🛑 **Mission Aborted:** Working tree is dirty. Doctrine requires starting with a clean Git environment.` });
                return false;
            }
        }

        currentBranch = await this.gitIntegration.getCurrentBranch(folder);
        const startHash = await this.gitIntegration.getCurrentHash(folder);

        if (!currentBranch.startsWith('ai-task-') && !currentBranch.startsWith('debug/')) {
            const branchName = `ai-task-${Date.now()}`;
            await this.gitIntegration.createAndCheckoutBranch(folder, branchName);
            const gitMsg = `[GIT] 🌿 BRANCHED: Switched from \`${currentBranch}\` to isolated workspace \`${branchName}\`.`;
            this.completedActionsHistory.push(gitMsg);

            this.sessionState.startCommitHash = startHash;
            this.sessionState.startBranch = currentBranch;
            if (this.currentDiscussion) {
                this.currentDiscussion.gitState = {
                    originalBranch: currentBranch,
                    tempBranch: branchName,
                    startCommitHash: startHash
                };
            }

            await this.ui.addMessageToDiscussion({
                role: 'system',
                content: `<git_event type="branch" from="${currentBranch}" to="${branchName}" />`,
                skipInPrompt: true
            });
        } else {
            if (!this.sessionState.startCommitHash) {
                const existingStart = this.currentDiscussion?.gitState?.startCommitHash;
                if (existingStart) {
                    this.sessionState.startCommitHash = existingStart;
                    this.sessionState.startBranch = this.currentDiscussion?.gitState?.originalBranch || currentBranch;
                } else {
                    const resolvedStart = await this.gitIntegration.resolveStartingRef(folder);
                    this.sessionState.startCommitHash = resolvedStart?.ref || startHash;
                    this.sessionState.startBranch = resolvedStart?.label || currentBranch;
                }
            }
            this.completedActionsHistory.push(`[GIT] ℹ️ Persistence: Operating on isolated branch \`${currentBranch}\`.`);
        }

        this.sessionState.isSafetyCheckPassed = true;
        return true;
    }

    private parseFormResponse(response: string, context: string): string {
        if (response.startsWith('FORM_SUBMISSION:')) {
            try {
                const data = JSON.parse(response.substring(16));
                Logger.info(`[AgentManager] Parsed ${context} form data:`, data);
                if (data.decision) return String(data.decision);
                const values = Object.values(data);
                return values.length > 0 ? String(values[0]) : "";
            } catch (e) {
                Logger.error(`[AgentManager] Failed to parse ${context} form JSON: ${response}`, e);
                return "";
            }
        }
        return response;
    }
    public async handleUserMessage(
        content: string, 
        discussion: Discussion, 
        workspaceFolder: vscode.WorkspaceFolder,
        permissions: UserPermissions = { canExecute: true, canRead: true }
    ) {
        const isDebugActive = discussion.capabilities?.debugMode || false;
        if (!this.processManager && (this.ui as any).processManager) {
            this.processManager = (this.ui as any).processManager;
        }
        if (!this.processManager) return;

        this.currentWorkspaceFolder = workspaceFolder;
        this.currentDiscussion = discussion;
        this.chatHistory = discussion.messages.filter(m => {
            if (m.skipInPrompt) return false;
            if (!m.content) return false;
            if (typeof m.content === 'string' && m.content.trim().length === 0) return false;
            if (Array.isArray(m.content) && m.content.length === 0) return false;
            if ((this.ui as any)?._activeAgentAnswerId && m.id === (this.ui as any)._activeAgentAnswerId) return false;
            return true;
        });
        this.currentUserPermissions = permissions;

        const currentVersion = vscode.extensions.getExtension('parisneo.lollms-vs-coder')?.packageJSON.version || "0.0.0";

        if (discussion.agentSession) {
            const lastSessionVersion = (discussion.agentSession as any).extensionVersion || "";
            const isUpdated = lastSessionVersion !== currentVersion;

            this.sessionState.replVariables = discussion.agentSession.replVariables || {};
            this.sessionState.workingMemory = discussion.agentSession.workingMemory || [];
            this.sessionState.secureCredentials = discussion.agentSession.secureCredentials || {};
            this.sessionState.isSafetyCheckPassed = discussion.agentSession.isSafetyCheckPassed || false;
            this.sessionState.startCommitHash = discussion.agentSession.startCommitHash || discussion.gitState?.startCommitHash;
            this.sessionState.startBranch = discussion.agentSession.startBranch || discussion.gitState?.originalBranch;
            
            this.completedActionsHistory = discussion.agentSession.completedActionsHistory || [];
            Logger.info(`[Sovereign] Restored audit trail: ${this.completedActionsHistory.length} events loaded.`);

            this.sessionState.blacklistedTools = new Set(discussion.agentSession.blacklistedTools || []);
            this.sessionState.extensionVersion = currentVersion;

            if (isUpdated && this.sessionState.blacklistedTools.size > 0) {
                Logger.info(`[Sovereign] Extension update detected (${lastSessionVersion} -> ${currentVersion}). Clearing tool blacklist.`);
                this.sessionState.blacklistedTools.clear();

                this.sessionState.workingMemory = this.sessionState.workingMemory.filter(
                    m => !m.includes("BROKEN and now FORBIDDEN") && !m.includes("DIAGNOSTIC: Tool")
                );

                this.ui.addMessageToDiscussion({ 
                    role: 'system', 
                    content: `🚀 **Extension Update Detected:** Infrastructure state reset. Previously broken tools are now available for testing.` 
                });
            }
        } else {
            this.sessionState.extensionVersion = currentVersion;
        }
        
        if (!this.sessionState.secureCredentials) {
            this.sessionState.secureCredentials = {};
        }

        // Explicitly engage Active Agent Mode state when this method is invoked
        this.isActive = true;

        // Auto-title discussion on the first prompt if untitled
        const isUntitled = !this.currentDiscussion.title || 
                           this.currentDiscussion.title === 'New Discussion' || 
                           this.currentDiscussion.title === 'Untitled Discussion' ||
                           this.currentDiscussion.title.startsWith('New Discussion');

        if (isUntitled && !this.currentDiscussion.id.startsWith('temp-')) {
            setImmediate(async () => {
                try {
                    const generatedTitle = await this.discussionManager.generateDiscussionTitle(this.currentDiscussion!);
                    if (generatedTitle && generatedTitle.trim()) {
                        const cleanTitle = generatedTitle.trim();
                        this.currentDiscussion!.title = cleanTitle;
                        await this.discussionManager.saveDiscussion(this.currentDiscussion!);
                        vscode.commands.executeCommand('lollms-vs-coder.refreshDiscussions');
                    }
                } catch (e) {}
            });
        }

        if (!this.currentPlan) {
            this.failureMemory.clear();
            this.consecutiveTaskFailures.clear();
            if (this.completedActionsHistory.length === 0) {
                this.sessionState.isSafetyCheckPassed = false;
            }
        } else {
            const lastLog = this.completedActionsHistory[this.completedActionsHistory.length - 1];
            const newLog = `[USER INTERVENTION]\n- FEEDBACK: "${content}"\n- ACTION: Adjusting strategy based on user input.`;

            if (lastLog !== newLog) {
                this.completedActionsHistory.push(newLog);
                this.ui.addMessageToDiscussion({ role: 'system', content: '🔄 **Integrating feedback...** Resuming mission.' });
            }
        }
        this.ui.updateAgentMode(true);

        if (isDebugActive && workspaceFolder) {
            const isRepo = await this.gitIntegration.isGitRepo(workspaceFolder);
            if (isRepo) {
                const clean = await this.gitIntegration.isClean(workspaceFolder);
                if (!clean) {
                    setTimeout(() => {
                        this.ui.addMessageToDiscussion({ 
                            role: 'system', 
                            content: `🛑 **Debug Mode Blocked:** Your working directory has uncommitted changes. 
Please commit or stash your work before starting an iterative debug session to ensure we can roll back instrumentation safely.` 
                        });
                    }, 100);
                    this.ui.updateGeneratingState();
                    return;
                }
                
                const debugBranch = `debug/task-${Date.now()}`;
                await this.gitIntegration.createAndCheckoutBranch(workspaceFolder, debugBranch);
                this.ui.addMessageToDiscussion({ 
                    role: 'system', 
                    content: `🛡️ **Sandbox Created:** Switched to branch \`${debugBranch}\`. I can now freely add instrumentation and test fixes.` 
                });
            }
        }

        const { id: processId, controller } = this.processManager.register(discussion.id, `Orchestrator: Initializing...`);
        this.ui.updateGeneratingState();

        try {
            this.processManager.updateDescription(processId, "🛡️ Sovereign: Verifying workspace safety...");
            const safetyPassed = await this.preFlightSafetyCheck(workspaceFolder, controller.signal);
            if (!safetyPassed) return;

            this.processManager.updateDescription(processId, "🧠 Librarian: Scanning project structure...");
            await this.contextManager.getContextContent({
                includeTree: true,
                discussionId: discussion.id,
                importedSkillIds: discussion.importedSkills,
                mutedFiles: discussion.mutedFiles,
                mutedSkills: discussion.mutedSkills,
                mutedDiagrams: discussion.mutedDiagrams,
                capabilities: discussion.capabilities,
                modelName: discussion.model,
                signal: controller.signal
            });

            this.processManager.updateDescription(processId, "🎯 Dispatcher: Selecting mission profile...");
            await this.dispatchMissionProfile(content, controller.signal);

            if (this.currentPlan) {
                await this.displayPlan(this.currentPlan);
            }

            if (!this.sessionState.replVariables) {
                this.sessionState.replVariables = {};
            }

            await this.runAutonomousLoop(content, controller.signal, processId, this.currentDiscussion.model);

            const gitDiffTag = await this.buildEndOfWorkGitDiffTag(workspaceFolder);
            if (gitDiffTag) {
                await this.ui.addMessageToDiscussion({
                    id: `agent_git_diff_${Date.now()}`,
                    role: 'assistant',
                    content: gitDiffTag,
                    model: this.currentDiscussion.model
                });
            }

        } catch (error: any) {
            if (error.name !== 'AbortError' && error.message !== 'AbortError') {
                this.ui.addMessageToDiscussion({ role: 'system', content: `❌ **Critical Error:** ${error.message}` });
            }
        } finally {
            if (this.currentDiscussion) {
                this.currentDiscussion.agentSession = {
                    replVariables: this.sessionState.replVariables,
                    workingMemory: this.sessionState.workingMemory,
                    secureCredentials: this.sessionState.secureCredentials,
                    isSafetyCheckPassed: this.sessionState.isSafetyCheckPassed,
                    startCommitHash: this.sessionState.startCommitHash,
                    startBranch: this.sessionState.startBranch,
                    completedActionsHistory: this.completedActionsHistory,
                    blacklistedTools: Array.from(this.sessionState.blacklistedTools),
                    extensionVersion: this.sessionState.extensionVersion
                };
                await this.discussionManager.saveDiscussion(this.currentDiscussion);
            }

            this.processManager.unregister(processId);
            this.ui.updateGeneratingState();
        }
    }

    private async runAutonomousLoop(
        objective: string, 
        signal: AbortSignal, 
        processId: string, 
        modelOverride?: string,
        extraHistory: ChatMessage[] = []
    ) {
        if (!this.currentDiscussion) return;

        if (!this.currentPlan || this.currentPlan.objective === "Initializing Safety Protocols...") {
            this.currentPlan = {
                objective: objective,
                current_sub_goal: "Discovery & Planning",
                observations: [],
                scratchpad: "Mission started. Initializing discovery...",
                tasks: [],
                status: 'active'
            };
            this.completedActionsHistory.push(`[MISSION START]\n- OBJECTIVE: "${objective}"\n- TIMESTAMP: ${new Date().toISOString()}`);
            await this.displayPlan(this.currentPlan);
        }

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        let maxSteps = config.get<number>('agent.maxSteps') || 100;
        let stepCount = 0;
        let nonToolRetries = 0;
        const maxNonToolRetries = 3;
        const loopNudges: ChatMessage[] = [];
        const model = modelOverride || this.currentDiscussion.model;

        while (stepCount < maxSteps) {
            if (signal.aborted) break;
            stepCount++;

            this.processManager?.updateDescription(processId, `Agentic Loop (Turn ${stepCount}/${maxSteps}): Reasoning...`);
            this.ui.updateGeneratingState();

            const contextData = await this.contextManager.getContextContent({ 
                includeTree: true,
                discussionId: this.currentDiscussion.id,
                importedSkillIds: this.currentDiscussion.importedSkills,
                mutedFiles: this.currentDiscussion.mutedFiles,
                mutedSkills: this.currentDiscussion.mutedSkills,
                mutedDiagrams: this.currentDiscussion.mutedDiagrams,
                capabilities: this.currentDiscussion.capabilities,
                modelName: model,
                signal 
            });

            const availableSpecialists = this.personalityManager?.getPersonalities().map(p => p.id) || [];
            const systemPrompt = await this.planParser.getArchitectSystemPrompt(
                this.getEnabledTools(), 
                this.currentDiscussion.importedSkills,
                availableSpecialists,
                { agentManager: this }
            );

            const rawIncludedFiles = this.contextManager.getContextStateProvider()?.getIncludedFiles() || [];
            const includedFiles = rawIncludedFiles.filter(f => f && f.path);

            const inventory = includedFiles.length > 0 
                ? includedFiles.map(f => {
                    const status = f.state === 'included' ? '✅ FULL CONTENT LOADED (POSSESSED)' : '🔍 STRUCTURE ONLY (DEFINITIONS)';
                    return `- \`${f.path}\` [${status}]`;
                }).join('\n')
                : "No project files loaded into memory yet.";

            const attachments = this.currentDiscussion?.messages
                .filter(m => (m as any).attachmentData)
                .map(m => (m as any).attachmentData.name) || [];

            const discussionFilesBlock = attachments.length > 0 
                ? `\n### 📚 IMPORTED DISCUSSION DATA (ATTACHMENTS)\n` + 
                  attachments.map(name => `- ${name} (Use 'read_discussion_file' to see content)`).join('\n')
                : "";

            const envs = Object.entries(this.sessionState.projectEnvironments)
                .map(([root, env]) => `- ${path.basename(root)}: Uses \`${env}\``)
                .join('\n') || "No specialized environments active (using system default).";

            const historyContext = `
### 📦 ACTIVE CONTEXT INVENTORY
${inventory}
${discussionFilesBlock}

### 🔌 LOADED ENVIRONMENTS (ACTIVE)
${envs}
**PROTOCOL**: When running code for a project, the associated environment is used automatically.

### 🕒 MISSION TIMELINE (EXECUTED ACTIONS)
${this.completedActionsHistory.length > 0 ? this.completedActionsHistory.slice(-12).join('\n\n') : "No actions taken yet."}

### 🛑 REFLEXIVE MEMORY (MISTAKES TO AVOID)
${this.failureMemory.getMemoryContext()}

### 🛠️ CURRENT WORLD STATE (PROJECT STRUCTURE)
${contextData.projectTree}

### 📄 ACCESSIBLE FILE CONTENTS
${contextData.selectedFilesContent || "(No files read into context yet)"}
`;

            const hasContentLoaded = !!contextData.selectedFilesContent;
            const hasStructure = contextData.projectTree.includes('├──') || contextData.projectTree.includes('└──') || contextData.projectTree.includes('/:\n') || contextData.projectTree.includes('/: [') || contextData.projectTree.includes('./: [');

            let structuralNudge = "";
            if (hasStructure && !hasContentLoaded) {
                structuralNudge = "\n**⚠️ LIBRARIAN NOTICE**: You have VISION of the tree but no CODE in memory. Find target files in the tree and read/possess them before editing.";
            }

            const remainingSteps = maxSteps - stepCount;
            let budgetBlock = `### ⏳ MISSION BUDGET\n- **Current Step**: ${stepCount} of ${maxSteps}\n- **Remaining Turns**: ${remainingSteps}\n`;

            if (remainingSteps <= 3) {
                budgetBlock += `\n**🚨 CRITICAL WARNING: LOW BUDGET**\nYou are about to run out of turns. Finalize your current edits, verify tests, and call \`submit_response\` with your completed summary before timeout.\n`;
            }

            const recentHistoryLength = this.completedActionsHistory.length;
            let repetitionNudge = "";
            if (recentHistoryLength >= 2) {
                const lastLog = this.completedActionsHistory[recentHistoryLength - 1];
                const prevLog = this.completedActionsHistory[recentHistoryLength - 2];

                const isRepetitiveTool = lastLog.includes("STATUS: ❌ FAILURE") && prevLog.includes("STATUS: ❌ FAILURE");
                const isStuckInLoop = lastLog.includes("WARNING: You already executed") || lastLog.includes("ERROR: Tool failed");

                if (isRepetitiveTool || isStuckInLoop) {
                    repetitionNudge = `
### 🚨 COGNITIVE RESET: UNSTUCK MANDATE
Previous tool attempt encountered an error. 
Do NOT repeat the failing parameters. Analyze the error output above, update your hypothesis, adjust file edits or commands, and proceed.
`;
                }
            }

            const visionParts: any[] = [];
            visionParts.push({ 
                type: 'text', 
                text: `${historyContext}${structuralNudge}${repetitionNudge}\n\n${budgetBlock}\n\n**OBJECTIVE:** ${objective}\n\n**CONDITIONAL LOOP INSTRUCTION**: Follow the engineering loop (Code -> Test -> Debug/Fix -> Verify -> Conclude). What is your next single technical action? Output JSON tool call or Markdown code block.` 
            });

            const ensureDataUri = (data: string) => {
                if (!data) return "";
                if (data.startsWith('data:') || data.startsWith('http')) return data;
                return `data:image/png;base64,${data}`;
            };

            contextData.images.forEach(img => {
                const safeUrl = ensureDataUri(img.data);
                if (safeUrl) {
                    visionParts.push({ type: 'text', text: `[IMAGE DATA for ${img.filePath}]:` });
                    visionParts.push({ type: 'image_url', image_url: { url: safeUrl } });
                }
            });

            this.chatHistory.forEach(msg => {
                if (Array.isArray(msg.content)) {
                    msg.content.forEach((part: any) => {
                        if (part.type === 'image_url' && part.image_url?.url) {
                            const safeUrl = ensureDataUri(part.image_url.url);
                            if (safeUrl) {
                                visionParts.push({ ...part, image_url: { ...part.image_url, url: safeUrl } });
                            }
                        }
                    });
                }
            });

            // In the autonomous ReAct loop, scope conversation history to recent turns to avoid context overflow
            const recentHistory = this.chatHistory.slice(-4);

            const messages: ChatMessage[] = [
                systemPrompt,
                ...recentHistory,
                ...extraHistory,
                ...loopNudges.slice(-4),
                { role: 'user', content: visionParts }
            ];

            let task: Task | null = null;
            const lastTask = this.currentPlan!.tasks.length > 0 ? this.currentPlan!.tasks[this.currentPlan!.tasks.length - 1] : null;

            if (lastTask && lastTask.status === 'pending' && (lastTask as any).needsApproval === false) {
                task = lastTask;
                this.processManager?.updateDescription(processId, `Agentic Loop: Executing approved task...`);
                this.ui.updateGeneratingState();
            } else {
                let fullResponse = "";
                const response = await this.lollmsApi.sendChat(messages, (chunk) => {
                    fullResponse += chunk;
                    if (this.currentPlan) {
                        this.currentPlan.scratchpad = fullResponse;
                    }
                }, signal, model);

                const cleanResponse = stripThinkingTags(response);

                if (this.currentPlan!.observations && this.currentPlan!.observations.length > 15) {
                    this.processManager?.updateDescription(processId, `Agentic Loop: Compressing memory timeline...`);
                    await this.condenseObservations(model || "default", signal);
                }

                const toolCall = this.planParser.extractJson(cleanResponse);
                if (!toolCall) {
                    const hasFileMutationCode = /<file\b[^>]*>/i.test(cleanResponse) || 
                                                cleanResponse.includes('<<<<<<< SEARCH') ||
                                                /```[a-zA-Z0-9_+-]+:[^\r\n\s]+/.test(cleanResponse);
                    if (hasFileMutationCode) {
                        nonToolRetries = 0;
                        loopNudges.length = 0;
                        this.processManager?.updateDescription(processId, `Agentic Loop: Applying code updates...`);

                        const codingTask: Task = {
                            id: stepCount,
                            task_type: 'markdown_coding',
                            description: "Applying code modifications from Markdown response.",
                            action: "markdown_coding",
                            parameters: { content: cleanResponse },
                            status: 'in_progress',
                            result: null,
                            retries: 0
                        };
                        this.currentPlan!.tasks.push(codingTask);

                        await (this.ui as any).executeAutomationPipeline(cleanResponse, `agent_step_${stepCount}`, signal, processId);

                        codingTask.status = 'completed';
                        codingTask.result = "Code extracted and applied to disk.";
                        this.completedActionsHistory.push(`[STEP ${codingTask.id}] COMPLETED: Applied code changes via Markdown Coding Mode.`);

                        await this.displayPlan(this.currentPlan);
                        continue;
                    }

                    const trimmedResp = cleanResponse.trim();
                    if (trimmedResp.length > 0) {
                        const looksLikeFileListArray = /\[\s*"[^"]+"\s*(?:,\s*"[^"]+"\s*)*\]/.test(trimmedResp);
                        const hasXmlToolLikeTag = /<(?:add_files_to_context|unmute_files|read_full_file|peek_files|grep|show_symbol|load_structure|query_architecture|lollms_tool)\b/i.test(trimmedResp);

                        if (nonToolRetries < maxNonToolRetries) {
                            nonToolRetries++;
                            const nudgeReason = looksLikeFileListArray
                                ? `You output a raw JSON array of file paths instead of a JSON tool call. Execute it using: {"thought": "Inspect requested files", "tool": "read_files", "params": {"paths": [...]}}.`
                                : hasXmlToolLikeTag
                                    ? `XML tags like <add_files_to_context> or <peek_files> are NOT executed in Agent Mode. You MUST output a single JSON tool call: {"thought": "...", "tool": "read_files", "params": {"paths": [...]}}.`
                                    : `You did not invoke a tool or call submit_response. Do NOT just describe what you plan to do next—output a single valid JSON tool call {"thought": "...", "tool": "tool_name", "params": {...}} to execute your next step, or call submit_response once the task is completely verified.`;

                            loopNudges.push({ role: 'assistant', content: trimmedResp });
                            loopNudges.push({ role: 'user', content: `⚠️ **AGENT PROTOCOL CORRECTION (Attempt ${nonToolRetries}/${maxNonToolRetries})**:\n${nudgeReason}` });
                            this.completedActionsHistory.push(`[PROTOCOL NUDGE ${nonToolRetries}/${maxNonToolRetries}] Model omitted JSON tool call; prompting for valid tool invocation.`);
                            continue;
                        }

                        this.completedActionsHistory.push(`[CONVERSATIONAL RESPONSE]\n- CONTENT: ${trimmedResp.substring(0, 200)}...`);
                        await this.ui.addMessageToDiscussion({ role: 'assistant', content: cleanResponse, model });
                        break; 
                    }
                    continue; 
                }

                let action: any;
                try {
                    action = JSON.parse(toolCall);
                    if (!action.tool && typeof action.action === 'string') {
                        action.tool = action.action;
                    }
                    if (!action.tool && typeof action.name === 'string') {
                        action.tool = action.name;
                        if (!action.params && action.arguments !== undefined) {
                            action.params = typeof action.arguments === 'string' ? JSON.parse(action.arguments) : action.arguments;
                        }
                    }
                    if (!action.tool && Array.isArray(action.tool_calls) && action.tool_calls.length > 0) {
                        const tc = action.tool_calls[0];
                        action.tool = tc.function?.name || tc.name;
                        const rawArgs = tc.function?.arguments ?? tc.arguments;
                        if (rawArgs !== undefined) {
                            action.params = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
                        }
                    }
                    if (stepCount === 1 && action.milestones) {
                        this.currentPlan.milestones = action.milestones.map((m: any) => ({ label: m, status: 'pending' }));
                    }
                } catch (jsonErr: any) {
                    if (nonToolRetries < maxNonToolRetries) {
                        nonToolRetries++;
                        loopNudges.push({ role: 'assistant', content: cleanResponse });
                        loopNudges.push({ role: 'user', content: `❌ **MALFORMED JSON (${jsonErr.message})**: Output a single strictly valid JSON object: {"thought": "...", "tool": "tool_name", "params": {...}}.` });
                    }
                    this.completedActionsHistory.push(`[SYSTEM ERROR] Malformed JSON response received.`);
                    continue;
                }
                
                if (action.new_remark) {
                    if (!this.currentPlan.observations) this.currentPlan.observations = [];
                    this.currentPlan.observations.push(action.new_remark);
                }
                if (action.current_sub_goal) {
                    this.currentPlan.current_sub_goal = action.current_sub_goal;
                }

                if (!action.tool || typeof action.tool !== 'string' || action.tool.trim() === "") {
                    if (nonToolRetries < maxNonToolRetries) {
                        nonToolRetries++;
                        loopNudges.push({ role: 'assistant', content: cleanResponse });
                        loopNudges.push({ role: 'user', content: `⚠️ **MISSING TOOL NAME**: Your JSON must include a non-empty "tool" field (e.g. {"thought": "...", "tool": "read_files", "params": {...}}) or "submit_response" to conclude.` });
                        continue;
                    }
                    this.isActive = false;
                    this.ui.updateAgentMode(false);
                    this.ui.addMessageToDiscussion({
                        role: 'system',
                        content: `🛑 **Agent Loop Finished:** Empty tool signal received.`
                    });
                    break;
                }

                nonToolRetries = 0;
                loopNudges.length = 0;

                const workerScope = action.worker || action.worker_scope || this.inferWorkerScope(action.tool, action.params, action.thought || "");

                task = {
                    id: stepCount,
                    task_type: 'simple_action',
                    description: action.thought || action.new_remark || `Executing tool ${action.tool}...`,
                    action: action.tool,
                    parameters: action.params || {},
                    worker_scope: workerScope,
                    status: 'pending',
                    result: null,
                    retries: 0
                };

                this.currentPlan!.tasks.push(task);
                await this.displayPlan(this.currentPlan);
            }

            // Task execution
            const toolPolicies = this.currentDiscussion?.capabilities?.toolPolicies || {};
            const toolDef = this.toolManager.getTool(task.action);

            const sensitiveGroups = ['shell_execution', 'filesystem_write'];
            const isSensitive = toolDef?.permissionGroup && sensitiveGroups.includes(toolDef.permissionGroup);

            const secLevel = this.getSecurityLevel();
            const defaultSensitivePolicy = secLevel === 'strict' ? 'manual' : 'autonomous';
            const specificPolicy = toolPolicies[task.action] || (isSensitive ? defaultSensitivePolicy : 'autonomous');

            if (specificPolicy === 'manual' && (task as any).needsApproval !== false) {
                task.status = 'pending';
                (task as any).needsApproval = true;
                await this.displayPlan(this.currentPlan);

                const targetSummary = task.parameters?.command || task.parameters?.file_path || task.parameters?.path || (Array.isArray(task.parameters?.paths) ? task.parameters.paths.join(', ') : '') || task.action;
                const approval = await this.requestSecurityApproval(
                    `Manual Policy Approval: ${task.action}`,
                    `Tool policy for \`${task.action}\` requires manual confirmation.\nParameters: \`${JSON.stringify(task.parameters).slice(0, 350)}\``,
                    task.action,
                    String(targetSummary),
                    signal,
                    { allowCheckpoint: true }
                );

                if (approval === 'block') {
                    task.status = 'failed';
                    task.result = `🛑 Blocked by user policy.`;
                    this.completedActionsHistory.push(`[SECURITY BLOCKED BY USER] Tool '${task.action}' was denied by the user.`);
                    await this.displayPlan(this.currentPlan);
                    continue;
                }
                (task as any).needsApproval = false;
                (task as any)._securityApproved = true;
            }

            if (task.action === 'submit_response') {
                task.status = 'completed';
                task.result = "Goal verified and response submitted.";
                const finalContent = task.parameters.response || task.parameters.message || "Mission completed.";
                this.completedActionsHistory.push(`[MISSION COMPLETE]\n- ACTION: submit_response\n- RESPONSE: ${finalContent.substring(0, 100)}...`);
                await this.displayPlan(this.currentPlan);

                await this.ui.addMessageToDiscussion({
                    id: `agent_final_${Date.now()}`,
                    role: 'assistant',
                    content: finalContent,
                    model: model
                });
                break;
            }
            
            task.status = 'in_progress';
            (task as any).needsApproval = false; 
            await this.displayPlan(this.currentPlan);

            this.processManager?.updateDescription(processId, `Agentic Loop: Running ${task.action}...`);
            this.ui.updateGeneratingState();

            const resultPromise = this.runSingleTask(task, signal, model);
            const timeoutPromise = new Promise<{success: boolean, output: string}>((_, reject) => 
                setTimeout(() => reject(new Error("EXECUTION_TIMEOUT")), 900000)
            );

            let result;
            try {
                result = await Promise.race([resultPromise, timeoutPromise]);

                if (this.ui.updateMessageContent) {
                    const statusIcon = result.success ? '✅' : '❌';
                    const summaryLabel = result.success ? 'Success' : 'Failure';
                    const outputPreview = result.output.length > 1500 
                        ? result.output.substring(0, 1500) + "\n\n... [Output truncated for readability]" 
                        : result.output;

                    const worker = task.worker_scope;
                    const workerBadge = worker?.role === 'scout' ? '🔍 Scout Worker' :
                                        worker?.role === 'coder' ? '🛠️ Coder Worker' :
                                        worker?.role === 'tester' ? '🧪 Test Worker' : '🛡️ Audit Worker';

                    const filesScopeStr = worker?.targetFiles && worker.targetFiles.length > 0
                        ? `\n**Worker Scope Targets:** \`${worker.targetFiles.join(', ')}\``
                        : '';

                    await this.ui.updateMessageContent(
                        `agent_task_${task.id}`, 
                        `### ${statusIcon} Step ${task.id}: [${workerBadge}] \`${task.action}\` (${summaryLabel})\n` +
                        `**Orchestrator Intent:** *${task.description}*${filesScopeStr}\n` +
                        `**Worker Arguments:**\n\`\`\`json\n${JSON.stringify(task.parameters, null, 2)}\n\`\`\`\n` +
                        `**Worker Observation Output:**\n\`\`\`text\n${outputPreview || '[No output returned]'}\n\`\`\``
                    );
                }
            } catch (e: any) {
                task.status = 'failed';
                task.result = e.message === "EXECUTION_TIMEOUT" ? "Execution timeout exceeded." : e.message;
                await this.displayPlan(this.currentPlan);
                this.isActive = false;
                this.ui.updateAgentMode(false);
                return; 
            }

            const justAddedInStep: string[] = [];
            if (task.action === 'add_files_to_context' && task.parameters?.paths) {
                const pList = Array.isArray(task.parameters.paths) ? task.parameters.paths : [task.parameters.paths];
                pList.forEach((p: any) => { if (typeof p === 'string' && p.trim()) justAddedInStep.push(p.trim()); });
            } else if (['edit_code', 'generate_code'].includes(task.action)) {
                const fp = task.parameters?.file_path || task.parameters?.path;
                if (typeof fp === 'string' && fp.trim()) justAddedInStep.push(fp.trim());
            }

            await this.enforceAgentContextBudget(justAddedInStep, model || this.lollmsApi.getModelName(), signal);

            if (signal.aborted) break;
        }

        if (stepCount >= maxSteps) {
            this.ui.addMessageToDiscussion({ 
                role: 'system', 
                content: `⚠️ **Mission Step Budget Reached (${maxSteps} steps).** Autonomous loop concluded.` 
            });
        }
    }

    private inferWorkerScope(action: string, params: any, description: string): import('./tools/tool').WorkerScope {
        if (['read_external_file', 'read_file', 'read_files', 'search_files', 'grep_search', 'read_code_graph', 'query_architecture', 'peek_at_context', 'smart_scout'].includes(action)) {
            const files = params?.path ? [params.path] : (params?.paths || []);
            return {
                role: 'scout',
                focus: 'Codebase & Architecture Reconnaissance',
                targetFiles: files
            };
        }
        if (['edit_code', 'generate_code', 'replaceCode', 'applyFileContent', 'markdown_coding', 'delete_file', 'move_file'].includes(action)) {
            const files = [params?.file_path || params?.path || params?.source || params?.destination].filter(Boolean);
            return {
                role: 'coder',
                focus: 'Surgical Implementation & Refactoring',
                targetFiles: files
            };
        }
        if (['execute_command', 'run_file', 'execute_python_script', 'run_tests', 'run_tests_and_fix', 'test_web_ui', 'test_web_page', 'interactive_ui_test', 'secure_run'].includes(action)) {
            return {
                role: 'tester',
                focus: 'Runtime Execution, Web UI & Testing',
                targetFiles: params?.file ? [params.file] : []
            };
        }
        return {
            role: 'auditor',
            focus: 'Integrity & Quality Audit'
        };
    }

    private async checkMoltbookKeyExists(): Promise<boolean> {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        if (config.get<string>('moltbook.apiKey')) return true;
        if (process.env.MOLTBOOK_API_KEY) return true;
        if (this.currentWorkspaceFolder) {
            try {
                const envPath = path.join(this.currentWorkspaceFolder.uri.fsPath, '.env');
                const envContent = await fs.readFile(envPath, 'utf8');
                if (envContent.includes('MOLTBOOK_API_KEY')) return true;
            } catch (e) { }
        }
        return false;
    }

    public async run(initialObjective: string, discussion: Discussion, workspaceFolder: vscode.WorkspaceFolder, modelOverride?: string) {
        await this.handleUserMessage(initialObjective, discussion, workspaceFolder);
    }
    
    private async performGitBackup(reason: string) {
        if (!this.currentWorkspaceFolder) return;
        try {
            const isRepo = await this.gitIntegration.isGitRepo(this.currentWorkspaceFolder);
            if (!isRepo) return;

            const currentBranch = await this.gitIntegration.getCurrentBranch(this.currentWorkspaceFolder);
            const isAiBranch = currentBranch.startsWith('ai-task-') || currentBranch.startsWith('debug/');

            if (isAiBranch) {
                Logger.info(`[GitBackup] Already on isolated branch: ${currentBranch}. Creating checkpoint.`);
                try {
                    await this.gitIntegration.stageAllAndCommit(`Checkpoint: ${reason}`, this.currentWorkspaceFolder);
                } catch (commitErr) {
                    Logger.debug(`[GitBackup] Checkpoint skipped: nothing to commit.`);
                }
                return;
            }

            const config = vscode.workspace.getConfiguration('lollmsVsCoder');
            if (config.get<boolean>('agent.createBranchOnEdit') === false) {
                 await this.gitIntegration.stageAllAndCommit(`Auto-backup: ${reason}`, this.currentWorkspaceFolder);
                 return;
            }

            const branchName = `ai-task-${Date.now()}`;
            await this.gitIntegration.createAndCheckoutBranch(this.currentWorkspaceFolder, branchName);
            this.completedActionsHistory.push(`[GIT] 🔒 MID-MISSION ISOLATION: Switched to \`${branchName}\`.`);

        } catch (e: any) {
            Logger.warn(`[GitBackup] Non-critical backup failure: ${e.message}`);
        }
    }

    public async resumeTask(taskId: number, processId: string, signal: AbortSignal) {
        if (!this.currentPlan || !this.currentDiscussion) return;
        const task = this.currentPlan.tasks.find(t => t.id === taskId);
        if (!task) return;

        (task as any).needsApproval = false;

        if (task.action === 'safety_check') {
            task.status = 'completed';
            task.result = "Confirmed by user.";
        } else {
            task.status = 'pending'; 
        }

        await this.displayPlan(this.currentPlan);

        this.isActive = true;
        this.ui.updateAgentMode(true);

        await this.runAutonomousLoop("User approved the task.", signal, processId, this.currentDiscussion.model);
    }

    public async editAndRetryTask(taskId: number, newParams: any) {
        if (!this.currentPlan || !this.processManager || !this.currentDiscussion) return;

        const task = this.currentPlan.tasks.find(t => t.id === taskId);
        if (!task) return;

        task.parameters = newParams;
        task.status = 'in_progress';
        task.result = null;
        task.retries = 0;
        task.can_retry = false;

        this.isActive = true;
        this.ui.addMessageToDiscussion({ 
            role: 'system', 
            content: `🔄 **Manual Override:** Re-executing Task ${taskId}. Params: \`${JSON.stringify(newParams)}\`` 
        });
        
        await this.displayPlan(this.currentPlan);

        const { id: processId, controller } = this.processManager.register(this.currentDiscussion.id, `Agent: Retrying task ${taskId}...`);
        this.ui.updateGeneratingState();

        try {
            const tempEnv = {
                workspaceRoot: this.currentWorkspaceFolder,
                lollmsApi: this.lollmsApi,
                contextManager: this.contextManager,
                codeGraphManager: this.codeGraphManager,
                skillsManager: this.skillsManager,
                currentPlan: this.currentPlan,
                agentManager: this
            };

            const res = await this.executeTask(task.action, newParams, controller.signal, tempEnv as any);
            task.status = res.success ? 'completed' : 'failed';
            task.result = res.output;

            if (['execute_command', 'run_file', 'execute_python_script'].includes(task.action) && res.success) {
                this.sessionState.unverifiedFiles.clear();
            }

            await this.displayPlan(this.currentPlan);

            const msg = `Manual Override Applied: Task ${task.id} (${task.action}) was manually executed by the user with corrected parameters. 
            Result of Manual Execution:
            ${res.output}

            INSTRUCTION: Integrate this result into your world model and resume the mission immediately.`;

            await this.runAutonomousLoop(this.currentPlan.objective, controller.signal, processId, this.currentDiscussion.model, [{ role: 'system', content: msg }]);

        } catch (e: any) {
            task.status = 'failed';
            task.result = e.message;
            await this.displayPlan(this.currentPlan);
        } finally {
            this.processManager.unregister(processId);
            this.ui.updateGeneratingState();
        }
    }

    private async synthesizeFinalResponse(originalObjective: string, signal: AbortSignal, modelOverride?: string) {
        if (signal.aborted || !this.currentPlan || !this.currentDiscussion) return;

        const pendingTasks = this.currentPlan.tasks.filter(t => t.status === 'pending' || t.status === 'in_progress');
        if (pendingTasks.length > 0) return;

        if (this.currentPlan.tasks.length === 0) return;

        this.ui.addMessageToDiscussion({ role: 'system', content: '📝 **Synthesizing final results...**' });

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const architectModel = config.get<string>('architectModelName') || modelOverride || this.currentDiscussion.model;
        const persona = config.get<string>('agentPersona') || "You are a specialized AI agent.";

        let executionLog = `### TASK EXECUTION LOG\n`;
        this.currentPlan.tasks.forEach(t => {
            executionLog += `- **Task ${t.id}:** ${t.description} (Tool: \`${t.action}\`)\n`;
            executionLog += `  Status: **${t.status}**\n`;
            if (t.result) {
                const truncatedResult = t.result.substring(0, 2000) + (t.result.length > 2000 ? '\n...[truncated]' : '');
                executionLog += `  Result: ${truncatedResult}\n`;
            }
        });
        const prompt = `You are the Lead Architect. You have just finished executing an automated plan for the user.

**User's Original Request:** "${originalObjective}"

${executionLog}

**INSTRUCTION:**
Please provide a clear, concise final response to the user summarizing the outcome.
- If the user asked a question (e.g., "What is my IP?"), provide the answer clearly based on the task results.
- If tasks failed, explain why and what the user could do next.
- If tasks succeeded, confirm the actions taken.
- Output pure markdown, directly addressing the user. Do NOT output a JSON plan.`;

        try {
            const response = await this.lollmsApi.sendChat([
                { role: 'system', content: persona },
                { role: 'user', content: prompt }
            ], null, signal, architectModel);

            const msgId = `agent_synthesis_${Date.now()}`;
            
            if (this.projectMemoryManager) {
                await this.projectMemoryManager.processTags(response);
            }

            await this.ui.addMessageToDiscussion({
                id: msgId,
                role: 'assistant',
                content: response,
                model: architectModel
            });
        } catch (e: any) {
            if (e.name !== 'AbortError' && e.message !== 'AbortError') {
                this.ui.addMessageToDiscussion({ role: 'system', content: `❌ Final synthesis failed: ${e.message}` });
            }
        }
    }

    public async retryFailedTask(taskId: number) {
        if (!this.currentPlan || !this.processManager || !this.currentDiscussion) return;

        const { id: processId, controller } = this.processManager.register(this.currentDiscussion.id, `Agent: Retrying task ${taskId}...`);
        this.ui.updateGeneratingState();

        try {
            const failedTaskIndex = this.currentPlan.tasks.findIndex(t => t.id === taskId);
            if (failedTaskIndex === -1) return;
            
            const failedTask = this.currentPlan.tasks[failedTaskIndex];
            failedTask.status = 'in_progress';
            failedTask.retries++;
            failedTask.can_retry = false;
            await this.displayPlan(this.currentPlan);
            
            const config = vscode.workspace.getConfiguration('lollmsVsCoder');
            const architectModel = config.get<string>('architectModelName') || this.currentDiscussion.model;

            const revisionSucceeded = await this.revisePlanForFailure(failedTask, controller.signal, architectModel);
            if (revisionSucceeded) {
                await this.executePlan(failedTaskIndex, controller.signal, this.currentDiscussion.model);
            } else {
                this.ui.addMessageToDiscussion({ role: 'system', content: `🛑 Failed to generate a revised plan.` });
            }
        } catch (error: any) {
        } finally {
            this.processManager.unregister(processId);
            this.ui.updateGeneratingState();
        }
    }

    private async executePlan(startIndex: number = 0, signal: AbortSignal, modelOverride?: string) {
        if (!this.currentPlan) return;
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const maxRetries = config.get<number>('agentMaxRetries') || 1;
        const maxConcurrent = config.get<number>('agent.maxSimultaneousAgents') || 3;
        const architectModel = config.get<string>('architectModelName') || modelOverride || this.currentDiscussion?.model;

        this.currentPlan.tasks.forEach(t => {
            if (t.status === 'in_progress') t.status = 'pending';
        });

        let activePromises: Promise<void>[] =[];
        let planAborted = false;

        while (true) {
            if (signal.aborted || planAborted || !this.currentPlan) break;

            const pendingTasks = this.currentPlan.tasks.filter(t => t.status === 'pending');
            const inProgressTasks = this.currentPlan.tasks.filter(t => t.status === 'in_progress');

            if (pendingTasks.length === 0 && inProgressTasks.length === 0) {
                break; 
            }

            const availableTasks = pendingTasks.filter(t => {
                if (!t.dependencies || t.dependencies.length === 0) {
                    const hasAnyDeps = this.currentPlan!.tasks.some(x => x.dependencies && x.dependencies.length > 0);
                    if (!hasAnyDeps) {
                        return t.id === pendingTasks[0].id;
                    }
                    return true; 
                }
                return t.dependencies.every(depId => {
                    const depTask = this.currentPlan!.tasks.find(pt => pt.id === depId);
                    return depTask && depTask.status === 'completed';
                });
            });

            if (availableTasks.length === 0 && inProgressTasks.length === 0 && pendingTasks.length > 0) {
                this.ui.addMessageToDiscussion({ role: 'system', content: `❌ **Deadlock Detected:** Some tasks have unmet or failed dependencies.` });
                break;
            }

            let startedNewTask = false;
            while (activePromises.length < maxConcurrent && availableTasks.length > 0 && !planAborted) {
                const task = availableTasks.shift()!;
                task.status = 'in_progress';
                await this.displayPlan(this.currentPlan);
                
                startedNewTask = true;
                
                const taskPromise = this.runSingleTask(task, signal, modelOverride).then(async (result) => {
                    activePromises = activePromises.filter(p => p !== taskPromise);
                    
                    if (!result.success) {
                        planAborted = true; 
                        
                        if (activePromises.length > 0) {
                            await Promise.all(activePromises);
                        }
                        
                        if (task.retries < maxRetries) {
                            this.ui.addMessageToDiscussion({ 
                                role: 'system', 
                                content: `⚠️ **Task ${task.id} Failed.** Lead Architect is revising the strategy...`,
                                skipInPrompt: true 
                            });

                            const revisionSucceeded = await this.revisePlanForFailure(task, signal, architectModel);
                            if (revisionSucceeded) {
                                planAborted = false; 
                            } else {
                                await this.handleTaskFailureUserChoice(task);
                            }
                        } else {
                            await this.handleTaskFailureUserChoice(task);
                        }
                    }
                });
                
                activePromises.push(taskPromise);
            }

            if (!startedNewTask && activePromises.length > 0) {
                await Promise.race(activePromises);
            }
        }
    }

    private async runSingleTask(task: Task, signal: AbortSignal, modelOverride?: string): Promise<{ success: boolean, output: string }> {
        if (!this.currentPlan) return { success: false, output: "" };

        // Generate execution fingerprint to prevent concurrent double-triggering of the identical task
        const executionFingerprint = `${task.action}:${JSON.stringify(task.parameters)}`;
        if (this.activeExecutions.has(executionFingerprint)) {
            Logger.info(`[Harness] De-duplicating concurrent task execution: ${task.action}`);
            return { success: false, output: `🛑 CONCURRENCY GUARD: This identical task is already running. Duplicate execution prevented.` };
        }
        this.activeExecutions.add(executionFingerprint);

        const specialistModel = task.model || modelOverride || this.currentDiscussion?.model;

        if (['generate_code', 'delete_file', 'move_file'].includes(task.action)) {
            await this.performGitBackup(`Checkpoint: Task ${task.id} - ${task.description}`);
        }

        let result: { success: boolean; output: string; } = { success: false, output: "" };
        let resolvedParams: any = {};

        try {
            resolvedParams = this.resolveParameters(task);
            task.parameters = resolvedParams; 
            await this.displayPlan(this.currentPlan); 

            let secureParams = JSON.parse(JSON.stringify(resolvedParams));
            const credentials = this.sessionState.secureCredentials || {};
            if (Object.keys(credentials).length > 0) {
                const replaceSecrets = (obj: any) => {
                    for (const key in obj) {
                        if (typeof obj[key] === 'string') {
                            for (const [secId, secVal] of Object.entries(credentials)) {
                                obj[key] = obj[key].split(secId).join(secVal);
                            }
                        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                            replaceSecrets(obj[key]);
                        }
                    }
                };
                replaceSecrets(secureParams);
            }

            const includedFiles = this.contextManager.getContextStateProvider()?.getIncludedFiles() || [];
            let redundantPath = "";

            if (task.action === 'add_files_to_context') {
                const requestedPaths = (resolvedParams.paths || []).map((p: string) => p.replace(/\\/g, '/').toLowerCase().trim());
                const alreadyIn = includedFiles
                    .filter(f => f.state === 'included')
                    .map(f => f.path.replace(/\\/g, '/').toLowerCase().trim());

                const redundant = requestedPaths.filter((p: string) => {
                    return alreadyIn.some(ai => ai === p || ai.endsWith('/' + p) || p.endsWith('/' + ai));
                });

                if (redundant.length > 0 && redundant.length === requestedPaths.length) {
                    return {
                        success: false,
                        output: `🛑 COMPLIANCE ERROR: REDUNDANT CONTEXT REQUEST.
            The following files are ALREADY present in your 'ACTIVE CONTEXT INVENTORY' with full content:
            ${redundant.map(p => `- ${p}`).join('\n')}

            STRICT PROTOCOL:
            1. Look at the 'ACCESSIBLE FILE CONTENTS' block provided in every turn.
            2. The source code for these files is ALREADY there.
            3. Do NOT use 'add_files_to_context' or 'read_file' for files marked [C] in the tree.
            4. Proceed directly with analysis using the code you already possess.`
                    };
                }
            }

            if (task.action === 'read_file') {
                const checkPath = (resolvedParams.path || resolvedParams.file || "").replace(/\\/g, '/');
                const isDirty = this.sessionState.unverifiedFiles.has(checkPath);
                const isContextHeavy = (this.completedActionsHistory.some(h => h.includes("Context usage is at")));

                if (!isDirty && !isContextHeavy) {
                    if (includedFiles.some(f => f.path === checkPath && f.state === 'included')) {
                        redundantPath = checkPath;
                    }
                }
            } else if (task.action === 'read_files') {
                const paths = (resolvedParams.paths || []).map((p: string) => p.replace(/\\/g, '/'));
                const isContextHeavy = (this.completedActionsHistory.some(h => h.includes("Context usage is at")));

                for (const p of paths) {
                    const isDirty = this.sessionState.unverifiedFiles.has(p);
                    if (!isDirty && !isContextHeavy) {
                        if (includedFiles.some(f => f.path === p && f.state === 'included')) {
                            redundantPath = p;
                            break;
                        }
                    }
                }
            }

            const pastTasks = this.currentPlan.tasks.filter(t => t.id !== task.id && (t.status === 'completed' || t.status === 'failed'));

            const recentTasks = pastTasks.slice(-10);

            // Clean/normalize parameters using FailureMemory helper so synonymous formats are caught
            const cleanParamsHelper = (p: any) => {
                if (!this.failureMemory) return p;
                return (this.failureMemory as any).cleanParams(p);
            };

            const targetNormalizedStr = JSON.stringify(cleanParamsHelper(resolvedParams));

            let redundantSuccess = recentTasks.find(t => {
                if (t.status !== 'completed' || t.action !== task.action) return false;
                const otherNormalizedStr = JSON.stringify(cleanParamsHelper(t.parameters));
                return otherNormalizedStr === targetNormalizedStr;
            });

            if (redundantSuccess && (task.action === 'read_file' || task.action === 'read_files')) {
                const checkPath = (resolvedParams.path || resolvedParams.file || (resolvedParams.paths && resolvedParams.paths[0]) || "").replace(/\\/g, '/');
                if (this.sessionState.unverifiedFiles.has(checkPath)) {
                    Logger.info(`[Harness] Redundancy bypassed for Task ${task.id}: Reading dirty file ${checkPath} for verification.`);
                    redundantSuccess = undefined;
                }
            }

            if (redundantSuccess) {
                const lastExecTime = (redundantSuccess as any)._executionTimestamp || 0;
                if (this.sessionState.lastFilesystemWriteTime > lastExecTime) {
                    Logger.info(`[Harness] Redundancy invalidated for Task ${task.id}: Filesystem state changed since previous run.`);
                    redundantSuccess = undefined;
                }
            }

            const hasFailedBefore = this.failureMemory.hasFailedBefore(task.action, resolvedParams);
            const lastFailureTime = (this.failureMemory as any)._lastFailureTime || 0;
            const allowRetryAfterFix = hasFailedBefore && (this.sessionState.lastFilesystemWriteTime > lastFailureTime);

            const recentFailures = pastTasks.slice(-3).filter(t => t.status === 'failed');
            const isStuck = recentFailures.length >= 3 && recentFailures.every(t => t.action === task.action);

            const isWriteAction = ['edit_code', 'generate_code', 'replaceCode', 'applyFileContent', 'markdown_coding'].includes(task.action);
            const isVerifyAction = ['execute_command', 'run_file', 'execute_python_script', 'run_tests', 'run_tests_and_fix', 'test_web_page', 'test_web_ui', 'interactive_ui_test', 'secure_run'].includes(task.action);
            const targetFile = resolvedParams.file_path || resolvedParams.path || "";

            if (task.action === 'generate_code' && resolvedParams.file_path) {
                const fileExists = includedFiles.some(f => f.path === resolvedParams.file_path.replace(/\\/g, '/'));
                if (fileExists) {
                    result = {
                        success: false,
                        output: `🛑 RESOURCE VIOLATION: You are attempting to use 'generate_code' on \`${resolvedParams.file_path}\`, but this file already exists. 

                        STRICT PROTOCOL:
                        1. You MUST use 'edit_code' with SEARCH/REPLACE blocks for existing files.
                        2. This prevents token waste and protects against accidental code deletion.
                        3. Switch tools immediately.`
                    };
                    return result;
                }
            }

            if (isWriteAction && targetFile && this.sessionState.unverifiedFiles.has(targetFile)) {
                result = {
                    success: false,
                    output: `🛑 HARNESS ERROR: VERIFICATION REQUIRED.
            You are attempting to modify \`${targetFile}\` again, but you haven't verified your previous changes to this file. 

            STRICT PROTOCOL:
            1. You MUST run a test, execute the script, or run a diagnostic command to verify the current state of \`${targetFile}\`.
            2. Only after a verification tool returns a result can you apply further modifications.
            3. Do NOT repeat this edit until you have evidence that further changes are necessary.`
                };
            } else if (hasFailedBefore && !allowRetryAfterFix) {
                const shaker = [
                    "COMPLIANCE ERROR: Repetitive thought pattern detected.",
                    "CIRCUIT BREAKER: Action blocked. You already tried this and it didn't work.",
                    "LOGIC OVERRIDE: Same input, same output. You are stuck. Change your params.",
                    "STRICT BLOCK: I will not execute the same failing command twice."
                ];
                const randomMsg = shaker[Math.floor(Math.random() * shaker.length)];

                result = { 
                    success: false, 
                    output: `🛑 ${randomMsg}

            TOOL: ${task.action}
            REASON: Duplicate execution on a known failure path.

            REQUIRED CHANGE:
            - Change the 'path' or 'instructions'.
            - Or switch to a completely different tool.
            - DO NOT output this JSON again.` 
                };
            } else if (redundantSuccess) {
                result = {
                    success: false,
                    output: `🛑 HARNESS ERROR: REDUNDANT ACTION.
            You already successfully executed '${task.action}' with these parameters in step ${redundantSuccess.id}. 
            The result is already in your context or history.

            STRICT PROTOCOL:
            1. DO NOT read the same file twice.
            2. If you need a piece of information from that file again, use 'record_discovery' to save it to your Working Memory.
            3. Move to the next step of implementation.`
                };
            } else if (isStuck) {
                result = {
                    success: false,
                    output: `🛑 LOOP DETECTED: You are repeating tool '${task.action}' with identical logic. 
                    
                    STRICT MANDATE:
                    1. Use 'peek_at_context' to see what you actually know.
                    2. Use 'read_file_relations' to find a DIFFERENT file.
                    3. Do NOT try to read ${targetFile} again. I have already provided its content to you.`
                };
            } else if (redundantPath) {
                result = {
                    success: false,
                    output: `🛑 HARNESS ERROR: REDUNDANT READ.
            The file \`${redundantPath}\` is ALREADY in your 'ACCESSIBLE FILE CONTENTS' block below. 

            REASON: You are attempting to read a file that you already possess. This is a waste of context and a sign of a "Thought Loop."

            STRICT INSTRUCTION:
            1. Look at the 'ACCESSIBLE FILE CONTENTS' section provided in every turn.
            2. Locate the code for \`${redundantPath}\`.
            3. Use the existing code to fulfill the request.
            4. DO NOT use 'read_file' or 'read_files' for this path again.`
                };
            } else {
                const varsBefore = JSON.stringify(this.sessionState.replVariables);
                const memBefore = this.sessionState.workingMemory.length;

                result = await this.executeTask(task.action, secureParams, signal, undefined, specialistModel, task.agent_persona, task.agent_skills, task.agent_files, !!(task as any)._securityApproved);

                if (!result.success && ['execute_command', 'run_file', 'execute_python_script'].includes(task.action)) {
                    const caps = this.currentDiscussion?.capabilities;
                    if (caps?.webSearch) {
                        const errLines = result.output.split('\n').map(l => l.trim()).filter(l => l);
                        const errorLine =[...errLines].reverse().find(l => l.toLowerCase().includes('error') || l.toLowerCase().includes('exception')) || errLines[0];

                        if (errorLine && errorLine.length > 5) {
                            const proc = this.processManager?.getForDiscussion(this.currentDiscussion!.id);
                            if (proc) this.processManager?.updateDescription(proc.id, `Proactive Research: Triaging error...`);

                            try {
                                const searchTool = this.toolManager.getTool('search_stackoverflow') || this.toolManager.getTool('search_web');
                                if (searchTool) {
                                    const tempEnv: ToolExecutionEnv = {
                                        workspaceRoot: this.currentWorkspaceFolder,
                                        lollmsApi: this.lollmsApi,
                                        contextManager: this.contextManager,
                                        currentPlan: this.currentPlan,
                                        agentManager: this
                                    };
                                    const genericQuery = errorLine.replace(/[A-Za-z]:\\[^\s]+|\/[^\s]+/g, '').substring(0, 150);
                                    const searchRes = await searchTool.execute({ query: genericQuery }, tempEnv, signal);
                                    if (searchRes.success && !searchRes.output.includes('No results found') && !searchRes.output.includes('No relevant')) {
                                        result.output += `\n\n--- 🌐 PROACTIVE WEB RESEARCH ---\nI automatically searched the web for this error. Here are potential clues:\n${searchRes.output.substring(0, 1500)}`;
                                        this.completedActionsHistory.push(`[PROACTIVE RESEARCH] Automatically searched for error: "${genericQuery}"`);
                                    }
                                }
                            } catch (e) {
                            }
                        }
                    }
                }

                const newVars: Record<string, any> = {};
                for (const [k, v] of Object.entries(this.sessionState.replVariables)) {
                    if (!varsBefore.includes(`"${k}":`)) {
                        newVars[k] = v;
                    }
                }

                task.memory_delta = {
                    variables: newVars,
                    discoveries: this.sessionState.workingMemory.slice(memBefore),
                    thought: task.description
                };

                if (Object.keys(credentials).length > 0 && result.output) {
                    for (const [secId, secVal] of Object.entries(credentials)) {
                        if (secVal && secVal.length > 2) { 
                            result.output = result.output.split(secVal).join(secId);
                        }
                    }
                }
            }
        } catch (error: any) {
            console.error(`[AgentManager] Runtime Error during task ${task.id} (${task.action}):`, error);
            Logger.error(`Runtime Error during task ${task.id}:`, error);
            result = { success: false, output: `Specialist Runtime Error:\n${error.stack || error.message}` };
        }

        task.result = result.output;

        const osErrorPatterns = [
            "chemin d'accès spécifié est introuvable",
            "is not recognized as an internal or external command",
            "cannot find the path specified"
        ];
        const containsOsError = osErrorPatterns.some(p => result.output.toLowerCase().includes(p));

        task.status = (result.success && !containsOsError) ? 'completed' : 'failed';
        (task as any)._executionTimestamp = Date.now();

        if (result.success) {
            const isWriteAction = ['edit_code', 'generate_code', 'replaceCode', 'applyFileContent', 'markdown_coding'].includes(task.action);
            const isVerifyAction = ['execute_command', 'run_file', 'execute_python_script', 'run_tests', 'run_tests_and_fix', 'test_web_page', 'secure_run'].includes(task.action);

            if (isWriteAction) {
                const targetFile = resolvedParams.file_path || resolvedParams.path;
                if (targetFile) this.sessionState.unverifiedFiles.add(targetFile);
                this.sessionState.lastFilesystemWriteTime = Date.now();
            }

            if (isVerifyAction) {
                this.sessionState.unverifiedFiles.clear();
                this.completedActionsHistory.push(`[SYSTEM] All file modifications marked as 'Verified' by execution of \`${task.action}\`.`);
            }
        }

        let conciseThought = task.description;
        const objectiveStart = this.currentPlan?.objective.substring(0, 30);
        if (objectiveStart && conciseThought.includes(objectiveStart)) {
            const parts = conciseThought.split(/now I need to|therefore,|next step is/i);
            if (parts.length > 1) conciseThought = "Decision: " + parts[parts.length - 1].trim();
        }
        
        if (this.dashboardState && this.dashboardUpdater) {
            const shortOutput = result.output.length > 500 ? result.output.substring(0, 500) + '...' : result.output;
            if (task.action.includes('web') || task.action.includes('arxiv') || task.action.includes('scrape') || task.action.includes('research')) {
                this.dashboardState.web = `**Action:** \`${task.action}\`\n\n**Result:**\n${shortOutput}`;
            } else if (task.action.includes('skill')) {
                this.dashboardState.skills = `**Action:** \`${task.action}\`\n\n**Result:**\n${shortOutput}`;
            } else {
                this.dashboardState.debugger = `**Task ${task.id} Finished.**\nStatus: ${result.success ? '✅ Success' : '❌ Failed'}\n\n**Output:**\n${shortOutput}`;
            }
            this.dashboardUpdater();
        }

        const untrustedOutputTools = new Set([
            'execute_command', 'run_file', 'execute_python_script', 'run_tests',
            'search_web', 'search_wikipedia', 'search_stackoverflow', 'scrape_website',
            'research_web_page', 'search_arxiv', 'extract_youtube_transcript'
        ]);
        if (untrustedOutputTools.has(task.action) && result.output) {
            try {
                const gateObs = await ContextPoisoningGate.sanitizeExecutionOutput(result.output, `tool://${task.action}`, { signal });
                result.output = gateObs.sanitizedOutput;
                if (gateObs.blocked) {
                    result.success = false;
                }
            } catch {}
        }

        let observation = result.output;
        const PREVIEW_LIMIT = 3000;

        if (observation.length > PREVIEW_LIMIT) {
            observation = observation.substring(0, PREVIEW_LIMIT) + 
                         `\n\n[NOTICE: Output exceeds preview limit. Full size: ${result.output.length} characters. Use 'read_output_tail' if you need to see the end of the logs.]`;
        }

        const statusEmoji = result.success ? '✅ SUCCESS' : '❌ FAILURE';

        this.completedActionsHistory.push(
            `[STEP ${task.id}]
        - ACTION: ${task.action}
        - PARAMETERS: ${JSON.stringify(resolvedParams)}
        - INTENT: ${conciseThought}
        - STATUS: ${statusEmoji}
        - OBSERVATION: "${observation}"
        - CONSEQUENCE: ${result.success ? 'Proceed with next step.' : 'CRITICAL: Analyze failure logs above.'}`
        );

        if (!result.success) {
            this.failureMemory.recordFailure(task.action, resolvedParams, result.output);
        } else {
            const isCodeEdit = ['edit_code', 'generate_code', 'markdown_coding'].includes(task.action);
            const reflectionPrompt = this.failureMemory.getReflectionPrompt(task.action, resolvedParams);

            const currentMemories = await this.projectMemoryManager.getMemories();
            const workingMemTokens = currentMemories
                .filter((m: any) => m.importance >= 25)
                .reduce((acc: number, m: any) => acc + (m.content.length / 4), 0);

            const limit = (await this.lollmsApi.getContextSize()).context_size;
            const isMemoryFull = (workingMemTokens / limit) > 0.15; 

            if (!isMemoryFull && (reflectionPrompt || (isCodeEdit && result.success))) {
                this.ui.updateGeneratingState();

                const artifactPrompt = reflectionPrompt 
                ? `### 🧬 EVOLUTIONARY REFLECTION (FAILURE OVERCOME)
                You failed previously but just succeeded. This is a critical learning moment.
                1. **GENIE MEMORY (PINK CARD)**: You MUST output a \`<project_memory action="add" importance="100" category="technical_lesson" ...>\` tag. State the precise technical reason why previous attempts failed.

                **STRICT ANTI-HALLUCINATION RULES:**
                - If the failure was an 'OS ERROR' or 'Capture file missing', the lesson MUST be about 'System Latency' or 'Environment Timing'.
                - NEVER mention 'OAuth', 'API Scopes', or 'Tokens' unless you were explicitly using an authentication tool.
                - Do not invent complex logic errors to explain a simple terminal timeout.

                2. **PROGRESS MILESTONE (PURPLE CARD)**: Output \`<milestone title="Resolved Recurring Issue" ... />\` to document the fix.`
                : `### 🚩 MILESTONE REACHED
                    Implementation success. 
                    1. **PURPLE CARD**: Output a \`<milestone />\` tag now to summarize the technical achievements for the user.`;

                try {
                    const artifactResponse = await this.lollmsApi.sendChat([
                        { 
                            role: 'system', 
                            content: `You are the Project Historian. Your job is to manifest progress. 
                            1. For Successes: Output <milestone title="..." achievements="..." challenges="..." solutions="..." />.
                            2. For Lessons: Output <project_memory action="add" id="..." title="Lesson: ..." importance="100" category="technical_lesson">The lesson text...</project_memory>.` 
                        },
                        { role: 'user', content: artifactPrompt }
                    ], null, signal, specialistModel);

                    if (this.projectMemoryManager) {
                        await this.projectMemoryManager.processTags(artifactResponse);
                    }

                    if (!task.artifacts) task.artifacts = [];
                    task.artifacts.push(artifactResponse);
                } catch (e) {
                    Logger.error("Artifact generation failed", e);
                }
            }
        }
        
        if (result.success) {
            const isSignificant = ['edit_code', 'generate_code', 'markdown_coding', 'execute_command', 'run_file'].includes(task.action);

            if (isSignificant && this.projectMemoryManager) {
                const model = task.model || specialistModel;

                const artifactPrompt = `
        ### 🚩 MILESTONE ANALYZER
        You just successfully executed: \`${task.action}\`.
        **Result**: ${result.output.substring(0, 1000)}

        **TASK**:
        1. If this step represents a technical "win" or discovery, output a \`<milestone title="..." achievements="..." challenges="..." solutions="..." />\` tag.
        2. If you learned a permanent lesson (e.g. "Library X requires parameter Y"), output a \`<project_memory action="add" id="..." title="..." importance="100">...</project_memory>\` tag.
        3. If no significant progress was made, respond with "NO_ARTIFACT".
        Output ONLY the tags.`.trim();

                try {
                    const artifactResponse = await this.lollmsApi.sendChat([
                        { role: 'system', content: "You are the Project Historian. Your job is to make technical progress and memories visible." },
                        { role: 'user', content: artifactPrompt }
                    ], null, signal, model);

                    if (!artifactResponse.includes("NO_ARTIFACT")) {
                        await this.projectMemoryManager.processTags(artifactResponse);

                        await this.ui.addMessageToDiscussion({
                            id: `artifact_${task.id}_${Date.now()}`,
                            role: 'system',
                            content: artifactResponse,
                            skipInPrompt: true 
                        });
                    }
                } catch (e) {
                    Logger.error("Failed to generate autonomous artifact", e);
                }
            }
        }

        const skipMemoryTagsTools = new Set([
            'execute_command', 'run_file', 'execute_python_script', 'run_tests',
            'search_web', 'search_wikipedia', 'search_stackoverflow', 'scrape_website',
            'research_web_page', 'search_arxiv', 'extract_youtube_transcript',
            'read_file', 'read_files', 'read_external_file'
        ]);
        if (this.projectMemoryManager && !skipMemoryTagsTools.has(task.action)) {
            await this.projectMemoryManager.processTags(result.output);
        }

        if (this.currentDiscussion) {
            this.currentDiscussion.agentSession = {
                replVariables: this.sessionState.replVariables,
                workingMemory: this.sessionState.workingMemory,
                secureCredentials: this.sessionState.secureCredentials,
                isSafetyCheckPassed: this.sessionState.isSafetyCheckPassed,
                completedActionsHistory: this.completedActionsHistory, 
                blacklistedTools: Array.from(this.sessionState.blacklistedTools),
                extensionVersion: this.sessionState.extensionVersion
            };
            await this.discussionManager.saveDiscussion(this.currentDiscussion);
        }

        await this.displayPlan(this.currentPlan);
        this.activeExecutions.delete(executionFingerprint);
        return result;
    }

    private async handleTaskFailureUserChoice(task: Task) {
        if (!this.currentPlan) return;
        task.can_retry = true;
        await this.displayPlan(this.currentPlan);

        const userChoice = await vscode.window.showErrorMessage(
            `Task "${task.description}" failed.`,
            { modal: true },
            'Stop', 'Continue Anyway', 'View Log'
        );

        if (userChoice === 'View Log') {
            InfoPanel.createOrShow(this.extensionUri, `Task ${task.id} Log`, `## Result\n${task.result}`);
        }
        if (userChoice === 'Continue Anyway') {
            task.status = 'completed'; 
            await this.displayPlan(this.currentPlan);
        }
    }

    private parseToolCall(text: string): { name: string, params: any } | null {
        const jsonStr = this.planParser.extractJson(text);
        if (!jsonStr) return null;
        try {
            const parsed = JSON.parse(jsonStr);
            if (parsed.tool) {
                return { name: parsed.tool, params: parsed.params || {} };
            }
        } catch {}
        return null;
    }

    private async analyzeStepResult(task: Task, output: string, model: string | undefined, signal: AbortSignal): Promise<{ decision: 'continue' | 'replan', reasoning: string, new_instruction?: string }> {
        if (output.includes("RLM_REPL_ERROR") || output.includes("NameError")) {
            return { decision: 'replan', reasoning: "Technical error detected. Must adjust code or imports.", new_instruction: "Fix the reported python error before continuing." };
        }
        return { decision: 'continue', reasoning: "Step successful." };
    }

    private checkProjectBoundary(filePath: string): { allowed: boolean, message?: string } {
        if (!this.currentDiscussion?.capabilities?.selectedFolders || this.currentDiscussion.capabilities.selectedFolders.length === 0) {
            return { allowed: true };
        }

        if (this.currentDiscussion.capabilities.selectedFolders.includes('__none__')) {
            if (filePath.startsWith('.lollms/sandbox')) return { allowed: true };
            return { allowed: false, message: "Permission Denied: Discussion is in Sandbox mode. AI can only access .lollms/sandbox." };
        }

        const folders = vscode.workspace.workspaceFolders || [];
        const normalized = filePath.replace(/\\/g, '/').trim();
        const segments = normalized.split('/');

        // Explicitly block path traversal attempts
        if (normalized.includes('../') || normalized.includes('..\\')) {
            return { allowed: false, message: "Permission Denied: Path traversal detected." };
        }

        let resolvedPath = normalized;
        if (!path.isAbsolute(resolvedPath)) {
            const projectFolder = folders.length > 1
                ? folders.find(f => f.name.toLowerCase() === segments[0].toLowerCase())
                : undefined;
            if (projectFolder && segments.length > 1) {
                resolvedPath = path.resolve(projectFolder.uri.fsPath, segments.slice(1).join('/'));
            } else {
                const base = this.currentWorkspaceFolder?.uri.fsPath || folders[0]?.uri.fsPath || "";
                resolvedPath = path.resolve(base, resolvedPath);
            }
        } else {
            resolvedPath = path.resolve(resolvedPath);
        }

        const normalizedPath = resolvedPath;
        const allowedRoots = folders
            .filter(f => this.currentDiscussion!.capabilities!.selectedFolders!.some(sf => {
                const cleanSf = decodeURIComponent(sf).toLowerCase();
                const cleanUri = decodeURIComponent(f.uri.toString()).toLowerCase();
                return cleanSf === cleanUri || cleanSf === f.uri.fsPath.toLowerCase();
            }))
            .map(f => f.uri.fsPath);

        const effectiveRoots = allowedRoots.length > 0 ? allowedRoots : folders.map(f => f.uri.fsPath);
        const isWindows = process.platform === 'win32';

        const isAllowed = effectiveRoots.some(root => {
            const resolvedRoot = path.resolve(root);
            if (isWindows) {
                const nLower = normalizedPath.toLowerCase();
                const rLower = resolvedRoot.toLowerCase();
                return nLower === rLower || nLower.startsWith(rLower + path.sep);
            }
            return normalizedPath === resolvedRoot || normalizedPath.startsWith(resolvedRoot + path.sep);
        });

        return isAllowed 
            ? { allowed: true } 
            : { allowed: false, message: `Permission Denied: Access to ${filePath} is outside the selected workspace scope.` };
    }

    private async dispatchMissionProfile(objective: string, signal: AbortSignal): Promise<void> {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        if (!config.get<boolean>('agent.autoProfileSwitch')) return;

        const profiles = config.get<any[]>('agentProfiles') || [];
        const currentProfileId = this.currentDiscussion?.capabilities?.activeAgentProfileId || config.get<string>('agent.activeProfile');

        const profileCatalogue = profiles.map(p => `- ID: ${p.id}\n  Name: ${p.name}\n  Focus: ${p.description}`).join('\n');

        const dispatchPrompt = `You are the Mission Dispatcher.
    Your goal is to select the most specialized Mission Profile for the user's objective.

    ### AVAILABLE PROFILES:
    ${profileCatalogue}

    ### USER OBJECTIVE:
    "${objective}"

    ### INSTRUCTION:
    1. Identify if one of the specialized profiles above is a significantly better fit than a general 'software_architect'.
    2. If the current profile is already optimal, or if no specialized profile fits perfectly, stay with the current one.
    3. Return ONLY the ID of the chosen profile. No prose.

    Current Profile ID: ${currentProfileId}
    Chosen Profile ID:`;

        try {
            const response = await this.lollmsApi.sendChat([
                { role: 'system', content: "You are a specialized router. Output only a Profile ID." },
                { role: 'user', content: dispatchPrompt }
            ], null, signal, this.lollmsApi.getModelName(), { temperature: 0.1 });

            const chosenId = response.trim();
            const exists = profiles.find(p => p.id === chosenId);

            if (exists && chosenId !== currentProfileId) {
                Logger.info(`[Dispatcher] Switching profile from ${currentProfileId} to ${chosenId}`);

                if (this.currentDiscussion?.capabilities) {
                    this.currentDiscussion.capabilities.activeAgentProfileId = chosenId;
                }

                const switchLog = `[DISPATCHER] 🎯 Objective Analysis: Detected specialized mission requirements. \n- ACTION: Automatically switched from \`${currentProfileId}\` to specialized profile \`${chosenId}\` (${exists.name}).`;
                this.completedActionsHistory.push(switchLog);

                this.ui.addMessageToDiscussion({ 
                    role: 'system', 
                    content: `🎯 **Specialized Protocol Engaged:** Detected a ${exists.name} mission. Switching to optimized profile.` 
                });
            }
        } catch (e: any) {
            Logger.warn(`[Dispatcher] Profile analysis failed: ${e.message}`);
        }
    }

    public getSecurityLevel(): AgentSecurityLevel {
        return this.securityGuard.getLevel(this.currentDiscussion?.capabilities);
    }

    public syncSecurityHudState(): void {
        try {
            this.ui.syncAgentSecurityState?.(
                this.getSecurityLevel(),
                this.securityGuard.getActiveMutationCount()
            );
        } catch {}
    }

    public async createSecurityCheckpoint(reason?: string): Promise<{ success: boolean; message: string }> {
        if (!this.currentWorkspaceFolder) {
            return { success: false, message: 'No active workspace folder.' };
        }
        const isRepo = await this.gitIntegration.isGitRepo(this.currentWorkspaceFolder);
        if (!isRepo) {
            this.securityGuard.resetBlastRadiusCounter();
            return { success: true, message: 'Blast-radius counter reset (non-Git workspace; file snapshots active).' };
        }
        const label = reason || `chore(agent-checkpoint): ${new Date().toISOString().replace(/[:.]/g, '-')}`;
        await this.gitIntegration.stageAllAndCommit(label, this.currentWorkspaceFolder);
        this.securityGuard.resetBlastRadiusCounter();
        this.completedActionsHistory.push(`[GIT CHECKPOINT] 📸 Saved workspace state: ${label}`);
        return { success: true, message: `Git checkpoint created: ${label}` };
    }

    public async buildEndOfWorkGitDiffTag(folder: vscode.WorkspaceFolder): Promise<string | null> {
        try {
            if (!(await this.gitIntegration.isGitRepo(folder))) return null;
            const preferredBase = this.sessionState.startCommitHash ||
                this.currentDiscussion?.gitState?.startCommitHash ||
                this.currentDiscussion?.gitState?.originalBranch;

            const resolved = await this.gitIntegration.resolveStartingRef(folder, preferredBase);
            if (!resolved) return null;

            const changedFiles = await this.gitIntegration.getChangedFilesSince(folder, resolved.ref, 'WORKING_TREE');
            if (changedFiles.length === 0) return null;

            const currentBranch = await this.gitIntegration.getCurrentBranch(folder) || 'HEAD';
            const esc = (v: string) => String(v || '').replace(/"/g, '&quot;');
            return `<agent_git_diff base="${esc(resolved.ref)}" label="${esc(resolved.label)}" branch="${esc(currentBranch)}" files="${changedFiles.length}" />`;
        } catch (err: any) {
            Logger.warn(`[AgentManager] Failed to build end-of-work git diff summary: ${err?.message || err}`);
            return null;
        }
    }

    public async rollbackAgentMutations(scope: 'last' | 'all' = 'all'): Promise<{ restored: string[]; deleted: string[]; errors: string[] }> {
        const res = await this.securityGuard.rollbackMutations(scope, this.contextManager);
        this.syncSecurityHudState();
        const summaryLines: string[] = [];
        if (res.restored.length > 0) summaryLines.push(`- **Restored**: ${res.restored.map(f => `\`${f}\``).join(', ')}`);
        if (res.deleted.length > 0) summaryLines.push(`- **Removed Created Files**: ${res.deleted.map(f => `\`${f}\``).join(', ')}`);
        if (res.errors.length > 0) summaryLines.push(`- **Errors**: ${res.errors.join('; ')}`);

        await this.ui.addMessageToDiscussion({
            role: 'system',
            content: summaryLines.length > 0
                ? `🛡️ **Agent Security Rollback Complete**\n${summaryLines.join('\n')}`
                : `ℹ️ **Agent Security Rollback**: No active file mutations to revert.`,
            skipInPrompt: true
        });
        return res;
    }

    public async requestSecurityApproval(
        title: string,
        details: string,
        toolName: string,
        target: string,
        signal: AbortSignal,
        options?: { allowCheckpoint?: boolean }
    ): Promise<'allow' | 'checkpoint_and_allow' | 'block'> {
        const safeTitle = title.replace(/"/g, '&quot;');
        const safeDetails = details.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const formId = `sec_gate_${Date.now()}`;
        const checkpointOpt = options?.allowCheckpoint !== false
            ? `<input type="radio" name="decision" label="📸 Create Git Checkpoint &amp; Allow" value="checkpoint_and_allow" />`
            : '';

        const formPrompt = `🛡️ **Agent Security Gate: ${title}**\n${details}\n\n<lollms_form id="${formId}" title="🛡️ ${safeTitle}">
<p style="font-size:11px; margin-bottom:8px; opacity:0.9;">${safeDetails}</p>
<input type="radio" name="decision" label="🛑 Block Action (Force safer approach)" value="block" checked="true" />
${checkpointOpt}
<input type="radio" name="decision" label="✅ Allow Once" value="allow" />
<submit label="Confirm Security Decision" />
</lollms_form>`;

        const response = await this.ui.requestUserInput(formPrompt, signal, { isAgentZone: false });
        const choice = this.parseFormResponse(response, formId).toLowerCase().trim();

        if (choice === 'checkpoint_and_allow') {
            await this.createSecurityCheckpoint(`chore(pre-action): before ${toolName} on ${path.basename(target || 'workspace')}`);
            this.securityGuard.recordAudit({ verdict: 'confirmed', tool: toolName, target, reason: `${title} (with Git checkpoint)` });
            return 'checkpoint_and_allow';
        }
        if (choice === 'allow') {
            this.securityGuard.recordAudit({ verdict: 'confirmed', tool: toolName, target, reason: `${title} (approved once)` });
            return 'allow';
        }
        this.securityGuard.recordAudit({ verdict: 'blocked', tool: toolName, target, reason: `${title} (blocked by user)` });
        return 'block';
    }

    private async performSecurityAudit(command: string, signal: AbortSignal): Promise<{ safe: boolean, reason: string }> {
        const level = this.getSecurityLevel();
        const workspaceRoots = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
        const staticRes = AgentSecurityGuard.analyzeShellCommand(command, level, workspaceRoots);
        if (staticRes.decision === 'block') {
            this.securityGuard.recordAudit({ verdict: 'blocked', tool: 'execute_command', target: command, reason: staticRes.reason });
            return { safe: false, reason: staticRes.reason };
        }
        if (staticRes.decision === 'confirm') {
            const approval = await this.requestSecurityApproval(
                'Confirm Shell Command',
                `Command: \`${command}\`\nReason: ${staticRes.reason}`,
                'execute_command',
                command,
                signal,
                { allowCheckpoint: true }
            );
            if (approval === 'block') {
                return { safe: false, reason: `User blocked risky command: ${staticRes.reason}` };
            }
            return { safe: true, reason: 'Confirmed by user.' };
        }

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const model = config.get<string>('inspectorModelName') || this.lollmsApi.getModelName();

        const systemPrompt = `You are the Sovereign Security Auditor. 
    Your ONLY goal is to prevent malicious shell execution while allowing legitimate software engineering tasks.

    ### 🛡️ SECURITY RULES:
    1. **CRITICAL BLOCKS**: 
    - No unauthorized external web/network calls (curl, wget, Invoke-WebRequest, fetch, requests, nc, ssh, etc.) unless strictly using the websearch tool.
    - No searching for or exfiltrating credentials (~/.ssh, ~/.aws, .env files outside workspace).
    - No operations on system directories (/etc, /windows, /bin).
    2. **WORKSPACE BOUNDARIES**: No escaping the workspace (no cd .., cd /, ~/, ../, absolute paths outside workspace).
    3. **DESTRUCTIVE ACTIONS**:
    - Deleting code is ALLOWED only if it is inside a Git repository (recoverable).
    - Massive deletions in non-git folders are FORBIDDEN.
    4. **CREDENTIAL STEALING**: Block any command that tries to 'cat' or 'grep' for API keys to pipe them to an external URL.

    ### 📝 DECISION LOGIC:
    - If the command is safe for a developer environment: "STATUS: PASS"
    - If dangerous: "STATUS: FAIL" followed by a 1-sentence reason.

    Output ONLY the status and the reason.`;

        const userPrompt = `### ENVIRONMENT
    Workspace Root: ${this.currentWorkspaceFolder?.uri.fsPath}
    Platform: ${process.platform}

    ### COMMAND TO AUDIT
    \`\`\`bash
    ${command}
    \`\`\`

    Is this command safe?`;

        try {
            const response = await this.lollmsApi.sendChat([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ], null, signal, model, { temperature: 0.1 });

            const clean = response.trim();
            const safe = clean.includes("STATUS: PASS");
            const reason = clean.split("STATUS: FAIL")[1]?.trim() || "Security violation detected.";

            return { safe, reason };
        } catch (e: any) {
            return { safe: false, reason: `Security Audit Timeout/Error: ${e.message}` };
        }
    }

    private async checkGlobalPermission(tool: ToolDefinition, params?: any): Promise<{ allowed: boolean, message?: string }> {
        const pathCandidates: string[] = [];
        if (params) {
            ['path', 'file_path', 'source', 'destination', 'script_path', 'file'].forEach(k => {
                if (typeof params[k] === 'string' && params[k].trim()) pathCandidates.push(params[k]);
            });
            if (Array.isArray(params.paths)) {
                params.paths.forEach((p: any) => { if (typeof p === 'string' && p.trim()) pathCandidates.push(p); });
            }
        }

        const isWriteOrDeleteTool = tool.permissionGroup === 'filesystem_write' || ['delete_file', 'move_file', 'edit_code', 'generate_code', 'update_function'].includes(tool.name);
        const isReadOnlyTool = tool.permissionGroup === 'filesystem_read' || tool.name === 'read_external_file';

        for (const p of pathCandidates) {
            if (isWriteOrDeleteTool) {
                const protCheck = AgentSecurityGuard.isProtectedPath(p);
                if (protCheck.protected) {
                    return { allowed: false, message: `🛑 SECURITY VIOLATION: ${protCheck.reason}` };
                }
            }
            if (isReadOnlyTool) {
                const authorizedExternal = await this.contextManager.resolveAuthorizedExternalFile(p);
                if (authorizedExternal) {
                    continue;
                }
            }
            const boundaryCheck = this.checkProjectBoundary(p);
            if (!boundaryCheck.allowed) return boundaryCheck;
        }

        const config = vscode.workspace.getConfiguration('lollmsVsCoder.agent.permissions');
        if (tool.permissionGroup === 'shell_execution' && !config.get('shellExecution')) {
            return { allowed: false, message: "Permission Denied: Shell Execution is disabled in settings." };
        }
        if (tool.permissionGroup === 'filesystem_write' && !config.get('filesystemWrite')) {
            return { allowed: false, message: "Permission Denied: File writing is disabled." };
        }
        return { allowed: true };
    }

    private async executeTask(action: string, params: any, signal: AbortSignal, overrideEnv?: ToolExecutionEnv, taskModel?: string, taskPersona?: string, taskSkills?: string[], taskFiles?: string[], preApproved: boolean = false): Promise<{ success: boolean, output: string }> {
        const tool = this.toolManager.getTool(action) || this.toolManager.getAllTools().find(t => t.name === action);
        if (!tool) return { success: false, output: `Unknown action: ${action}` };

        const perm = await this.checkGlobalPermission(tool, params);
        if (!perm.allowed) {
            this.securityGuard.recordAudit({ verdict: 'blocked', tool: action, target: JSON.stringify(params).slice(0, 120), reason: perm.message || 'Permission denied' });
            return { success: false, output: perm.message || "Permission denied." };
        }

        // --- 🛡️ AGENT SECURITY LAYER: PRE-EXECUTION GUARDRAILS & SNAPSHOTS ---
        const securityLevel = this.getSecurityLevel();
        if (this.currentWorkspaceFolder) {
            if (action === 'generate_code' && params?.file_path) {
                const res = await this.contextManager.resolveWorkspaceFromPath(params.file_path);
                if (res) {
                    try {
                        const st = await vscode.workspace.fs.stat(res.uri);
                        if (st.type === vscode.FileType.File && st.size > 0) {
                            if (securityLevel !== 'relaxed' && !preApproved) {
                                const approval = await this.requestSecurityApproval(
                                    'Overwrite Existing File via generate_code',
                                    `\`generate_code\` is targeting an existing file (\`${res.relativePath}\`, ${st.size} bytes). Normally \`edit_code\` should be used to preserve existing logic.`,
                                    action,
                                    res.relativePath,
                                    signal
                                );
                                if (approval === 'block') {
                                    return {
                                        success: false,
                                        output: `🛑 SECURITY BLOCK: '${res.relativePath}' already exists on disk. Use 'edit_code' or 'update_function' for surgical edits instead of overwriting the whole file with 'generate_code'.`
                                    };
                                }
                            }
                            await this.securityGuard.snapshotFile(this.currentWorkspaceFolder, res.uri, res.relativePath, action, 'modify');
                        } else {
                            await this.securityGuard.snapshotFile(this.currentWorkspaceFolder, res.uri, res.relativePath, action, 'create');
                        }
                    } catch {
                        await this.securityGuard.snapshotFile(this.currentWorkspaceFolder, res.uri, res.relativePath, action, 'create');
                    }
                }
            } else if ((action === 'edit_code' || action === 'update_function') && (params?.file_path || params?.path)) {
                const targetPath = params.file_path || params.path;
                const radius = this.securityGuard.checkBlastRadius(targetPath, securityLevel);
                if (radius.exceeded && !preApproved) {
                    const approval = await this.requestSecurityApproval(
                        `Blast-Radius Quota Reached (${radius.count} files)`,
                        `The agent has already modified ${radius.count - 1} unique files without a checkpoint (limit: ${radius.limit}). Confirm to continue modifying \`${targetPath}\`.`,
                        action,
                        targetPath,
                        signal
                    );
                    if (approval === 'block') {
                        return { success: false, output: `🛑 SECURITY PAUSE: Blast-radius limit (${radius.limit} files) exceeded and user declined continuation.` };
                    }
                }
                const res = await this.contextManager.resolveWorkspaceFromPath(targetPath);
                if (res) {
                    await this.securityGuard.snapshotFile(this.currentWorkspaceFolder, res.uri, res.relativePath, action, 'modify');
                }
            } else if (action === 'delete_file' && Array.isArray(params?.paths)) {
                let hasDir = false;
                for (const p of params.paths) {
                    const res = await this.contextManager.resolveWorkspaceFromPath(p);
                    if (res) {
                        try {
                            const st = await vscode.workspace.fs.stat(res.uri);
                            if (st.type === vscode.FileType.Directory) hasDir = true;
                        } catch {}
                    }
                }
                if (!preApproved && (securityLevel === 'strict' || (securityLevel === 'guarded' && (hasDir || params.paths.length > 2)))) {
                    const approval = await this.requestSecurityApproval(
                        `Confirm File Deletion (${params.paths.length} target${params.paths.length > 1 ? 's' : ''})`,
                        `The agent proposes to delete:\n${params.paths.map((p: string) => `• ${p}`).join('\n')}${hasDir ? '\n(Includes directory deletion!)' : ''}`,
                        action,
                        params.paths.join(', '),
                        signal
                    );
                    if (approval === 'block') {
                        return { success: false, output: `🛑 SECURITY BLOCK: File deletion rejected by user.` };
                    }
                }
                for (const p of params.paths) {
                    const res = await this.contextManager.resolveWorkspaceFromPath(p);
                    if (res) {
                        await this.securityGuard.collectFilesForDeletionSnapshot(this.currentWorkspaceFolder, res.uri, res.relativePath, action);
                    }
                }
            } else if (action === 'move_file' && params?.source && params?.destination) {
                if (securityLevel === 'strict' && !preApproved) {
                    const approval = await this.requestSecurityApproval(
                        'Confirm File Move / Rename',
                        `Move \`${params.source}\` -> \`${params.destination}\``,
                        action,
                        `${params.source} -> ${params.destination}`,
                        signal
                    );
                    if (approval === 'block') {
                        return { success: false, output: `🛑 SECURITY BLOCK: File move rejected by user.` };
                    }
                }
                const srcRes = await this.contextManager.resolveWorkspaceFromPath(params.source);
                const dstRes = await this.contextManager.resolveWorkspaceFromPath(params.destination);
                if (srcRes && dstRes) {
                    await this.securityGuard.snapshotFile(this.currentWorkspaceFolder, srcRes.uri, srcRes.relativePath, action, 'move', dstRes.uri, dstRes.relativePath);
                }
            } else if (action === 'execute_python_script' || action === 'run_file') {
                const scriptTarget = params?.script_path || params?.file_path;
                if (scriptTarget) {
                    const res = await this.contextManager.resolveWorkspaceFromPath(scriptTarget);
                    if (res) {
                        try {
                            const bytes = await vscode.workspace.fs.readFile(res.uri);
                            const scriptScan = AgentSecurityGuard.analyzeScriptContent(Buffer.from(bytes).toString('utf8'), res.relativePath, securityLevel);
                            if (scriptScan.decision === 'block') {
                                return { success: false, output: `🛑 SECURITY BLOCK: ${scriptScan.reason}` };
                            }
                            if (scriptScan.decision === 'confirm' && !preApproved) {
                                const snippet = scriptScan.matchedLines.length > 0 ? `\nFlagged lines:\n${scriptScan.matchedLines.slice(0, 5).join('\n')}` : '';
                                const approval = await this.requestSecurityApproval(
                                    `Confirm Script Execution: ${res.relativePath}`,
                                    `${scriptScan.reason}${snippet}`,
                                    action,
                                    res.relativePath,
                                    signal
                                );
                                if (approval === 'block') {
                                    return { success: false, output: `🛑 SECURITY BLOCK: Script execution rejected by user.` };
                                }
                            }
                        } catch {}
                    }
                }
            }
        }

        const assetDir = vscode.Uri.joinPath(this.currentWorkspaceFolder!.uri, '.lollms', 'assets', this.currentDiscussion!.id);

        // --- HIGH-PERFORMANCE SEMANTIC MEMORY SHARING FILTER ---
        // Dynamically extract and share only relevant memory engrams with the specialist
        let sharedMemorySegment = "";
        if (this.projectMemoryManager) {
            try {
                const engrams = await this.projectMemoryManager.getMemories();
                const specialistAura = `${taskPersona || ''} ${taskSkills?.join(' ') || ''} ${taskFiles?.join(' ') || ''} ${JSON.stringify(params)}`.toLowerCase();

                // Extract keywords from the specialist's target description Aura
                const keywords = specialistAura.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3);

                const matchedEngrams = engrams.filter(e => {
                    const score = this.projectMemoryManager.calculateRelevanceScore(e, keywords);
                    // Core rules/protocols are always shared
                    return score > 35 || e.importance >= 90;
                });

                if (matchedEngrams.length > 0) {
                    sharedMemorySegment = matchedEngrams.map(e => `### [${e.category.toUpperCase()}] ${e.title} (${e.id})\n${e.content}`).join('\n\n');
                    Logger.info(`[Memory Share] Injected ${matchedEngrams.length} highly relevant engrams into specialist '${action}' session.`);
                }
            } catch (err) {
                Logger.warn("Failed to apply inter-agent memory filter", err);
            }
        }

        const env: ToolExecutionEnv = overrideEnv || {
            workspaceRoot: this.currentWorkspaceFolder,
            lollmsApi: this.lollmsApi,
            contextManager: this.contextManager,
            codeGraphManager: this.codeGraphManager,
            skillsManager: this.skillsManager,
            personalityManager: this.personalityManager,
            currentPlan: this.currentPlan,
            agentManager: this,
            discussionId: this.currentDiscussion?.id,
            assetDirectory: assetDir, 
            taskModel: taskModel,
            taskPersona: taskPersona ? `${taskPersona}\n\n### 🧠 SHARED MEMORY SEGMENT (TASK CONTEXT)\n${sharedMemorySegment}` : undefined,
            taskSkills: taskSkills,
            taskFiles: taskFiles
        };
        
        try {
            const execResult = await tool.execute(params, env, signal);
            this.syncSecurityHudState();
            return execResult;
        } catch (error: any) {
            const isDebugOn = this.currentDiscussion?.capabilities?.debugMode === true;
            
            console.error(`[Tool implementation Error] ${action}:`, error);
            Logger.error(`Tool '${action}' implementation crashed:`, error);

            let errorOutput = `❌ **CRITICAL TOOL ERROR**: The tool implementation for \`${action}\` crashed.`;
            
            if (isDebugOn) {
                const stack = error.stack || "No stack trace available.";
                const sanitizedStack = stack.replace(new RegExp(os.homedir(), 'g'), '~'); 

                errorOutput += `\n\n### 🛠️ TOOL BUG REPORT (Debug Mode Active)\n` +
                              `- **Exception**: \`${error.name}: ${error.message}\`\n` +
                              `- **Action**: \`${action}\`\n` +
                              `- **Stack Trace**:\n\`\`\`\n${sanitizedStack}\n\`\`\`\n` +
                              `**INSTRUCTION**: This error comes from the Lollms Extension tool code. \n` +
                              `MANDATORY: Tool \`${action}\` is now **FORBIDDEN** for the rest of this session. I have blacklisted it to protect your budget.\n` +
                              `If there is NO OTHER tool to complete the mission, you MUST use \`submit_response\` immediately to inform the user and STOP.\n\n` +
                              `<lollms_tool_bug_report action="${action}" error="${encodeURIComponent(error.message)}" stack="${encodeURIComponent(sanitizedStack)}" />`;

                this.sessionState.blacklistedTools.add(action);
                this.sessionState.workingMemory.push(`CRITICAL: Tool '${action}' is BROKEN and now FORBIDDEN. Do not attempt to use it again.`);
            }

            if (error.message && (error.message.includes('EACCES') || error.message.includes('permission denied'))) {
                return { success: false, output: `❌ **OS Permission Error.**\nRaw Error: ${error.message}` };
            }

            return { success: false, output: errorOutput };
        }
    }

    public async submitFinalMessage(message: ChatMessage) {
        await this.ui.addMessageToDiscussion(message);
    }
    
    private async revisePlanForFailure(failedTask: Task, signal: AbortSignal, modelOverride?: string): Promise<boolean> {
        if (!this.currentPlan || !this.currentDiscussion) return false;
        
        this.archiveCurrentPlanState(`Task ${failedTask.id} failed.`);

        failedTask.retries++;
        this.currentPlan.scratchpad += `\n\n⚠️ **Task ${failedTask.id} Failed.** Attempting self-correction...`;
        await this.displayPlan(this.currentPlan);

        const planResult = await this.planParser.generateAndParsePlan(
            this.currentPlan.objective,
            this.currentPlan,
            failedTask.id,
            failedTask.result,
            signal,
            modelOverride,
            this.chatHistory,
            this.getEnabledTools(),
            this.currentDiscussion?.importedSkills,
            this.completedActionsHistory 
        );

        if (signal.aborted || !planResult.plan) return false;

        const failedTaskIndex = this.currentPlan.tasks.findIndex(t => t.id === failedTask.id);
        this.currentPlan.tasks.splice(failedTaskIndex);

        let nextId = this.currentPlan.tasks.length > 0 ? Math.max(...this.currentPlan.tasks.map(t => t.id)) + 1 : 1;
        for (const newTask of planResult.plan.tasks) {
            newTask.id = nextId++;
            this.currentPlan.tasks.push(newTask);
        }
        
        this.currentPlan.scratchpad += `\n\n--- PLAN REVISED ---`;
        await this.displayPlan(this.currentPlan);
        return true;
    }
    
    private formatValueForDisplay(val: any): string {
        if (typeof val === 'string') {
            try { return JSON.stringify(JSON.parse(val), null, 2); } catch { return val; }
        }
        return JSON.stringify(val, null, 2);
    }

    private resolveParameters(task: Task): { [key: string]: any } {
        if (!this.currentPlan) throw new Error("No active plan.");
        const resolvedParams: { [key: string]: any } = {};
        const taskResultRegex = /\{\{(?:[\s(]*)(tasks\[(\d+)\]\.result(?:.*?))(?:\s*[\)|]*)\}\}/g;
        const variableRegex = /\{\{\s*([a-zA-Z_]\w*)\s*\}\}/g;
        for (const key in task.parameters) {
            let value = task.parameters[key];
            if (typeof value === 'string') {
                let resolvedValue = value.replace(taskResultRegex, (match, fullMatch, idStr) => {
                    const id = parseInt(idStr, 10);
                    const sourceTask = this.currentPlan?.tasks.find(t => t.id === id);
                    if (!sourceTask || sourceTask.result === null) return match; 
                    return sourceTask.result || "";
                });
                resolvedValue = resolvedValue.replace(variableRegex, (match, varName) => {
                    const val = this.sessionState.replVariables[varName];
                    if (val !== undefined) return this.formatValueForDisplay(val);
                    return match; 
                });
                resolvedParams[key] = resolvedValue;
            } else {
                 resolvedParams[key] = value;
            }
        }
        return resolvedParams;
    }

    public async replan(instruction: string, signal: AbortSignal, modelOverride?: string): Promise<{ success: boolean; output: string; }> {
        if (!this.currentPlan) return { success: false, output: "No active plan." };
        
        this.archiveCurrentPlanState(`Replanning requested: ${instruction}`);
        this.currentPlan.scratchpad += `\n\n🔄 **Replanning requested:** ${instruction}`;
        await this.displayPlan(this.currentPlan);
        
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const plannerModel = config.get<string>('architectModelName') || modelOverride;
        const failureContext = this.failureMemory.getMemoryContext();
        const augmentedInstruction = `${instruction}\n\n${failureContext}\n\nSTRICT REQUIREMENT: The previous errors prove your current approach is blocked. YOU MUST CHANGE TOOLS OR LOGIC.`;

        try {
            const planResult = await this.planParser.generateAndParsePlan(
                `${this.currentPlan.objective} (Update: ${augmentedInstruction})`,
                this.currentPlan,
                undefined,
                undefined,
                signal,
                plannerModel,
                this.chatHistory,
                this.getEnabledTools(),
                this.currentDiscussion?.importedSkills,
                this.completedActionsHistory 
            );

            if (!planResult.plan) return { success: false, output: "Failed to generate new plan." };

            this.currentPlan.tasks = this.currentPlan.tasks.filter(t => t.status !== 'pending');

            let nextId = this.currentPlan.tasks.length > 0 ? Math.max(...this.currentPlan.tasks.map(t => t.id)) + 1 : 1;
            const minGeneratedId = Math.min(...planResult.plan.tasks.map(t => t.id));
            const idOffset = nextId - minGeneratedId;

            for (const newTask of planResult.plan.tasks) {
                newTask.id += idOffset;
                if (newTask.dependencies) {
                    newTask.dependencies = newTask.dependencies.map(d => d + idOffset);
                }

                newTask.status = 'pending';
                this.currentPlan.tasks.push(newTask);
            }

            planResult.plan.investigation = this.currentPlan.investigation;

            await this.displayPlan(this.currentPlan);
            return { success: true, output: "Plan modified successfully." };

        } catch (error: any) {
            return { success: false, output: `Error: ${error.message}` };
        }
    }
    
    public async generateFileTree(startPath: string, prefix: string = ''): Promise<string> {
        let result = '';
        let entries;

        const TRUNCATE_FOLDERS = ['venv', '.venv', 'node_modules', '.git', '.lollms', 'dist', 'build', 'bin', 'obj', 'target', 'env'];

        try { 
            entries = await fs.readdir(startPath, { withFileTypes: true }); 
        } catch (e) { 
            return ` (access denied)\n`; 
        }

        const provider = this.contextManager.getContextStateProvider();

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const fullPath = path.join(startPath, entry.name);
            const uri = vscode.Uri.file(fullPath);
            const isLast = i === entries.length - 1;
            const connector = isLast ? '└── ' : '├── ';

            if (provider && provider.isStrictlyIgnored(uri)) {
                continue; 
            }

            if (entry.isDirectory()) {
                if (TRUNCATE_FOLDERS.includes(entry.name.toLowerCase())) {
                    result += `${prefix}${connector}${entry.name}/ ... (contents truncated, use specialized tools to inspect)\n`;
                } else {
                    result += `${prefix}${connector}${entry.name}/\n`;
                    result += await this.generateFileTree(fullPath, prefix + (isLast ? '    ' : '│   '));
                }
            } else {
                result += `${prefix}${connector}${entry.name}\n`;
            }
        }
        return result;
    }

    public async runCommand(command: string, signal: AbortSignal, options?: { shell?: any, timeoutMs?: number, projectRoot?: string }): Promise<{ success: boolean, output: string }> {
        if (!this.currentWorkspaceFolder) return { success: false, output: "No workspace." };

        const activeRoots = (vscode.workspace.workspaceFolders || []).map(f => path.resolve(f.uri.fsPath));
        const requestedRoot = path.resolve(options?.projectRoot || this.currentWorkspaceFolder.uri.fsPath);
        const isWin = process.platform === 'win32';
        const isWithinWorkspace = activeRoots.some(r => {
            const rr = isWin ? r.toLowerCase() : r;
            const rq = isWin ? requestedRoot.toLowerCase() : requestedRoot;
            return rq === rr || rq.startsWith(rr + path.sep);
        });
        if (!isWithinWorkspace) {
            return { success: false, output: `🛑 SECURITY VIOLATION: Command working directory '${requestedRoot}' is outside the workspace.` };
        }

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const activationScript = config.get<string>('agent.envActivationScript');
        let finalCommand = command;
        const targetRoot = requestedRoot;
        let envPath = this.sessionState.projectEnvironments[targetRoot] || this.sessionState.activeEnv;

        if (!envPath) {
            const folderUri = vscode.Uri.file(targetRoot);
            const pythonCfg = vscode.workspace.getConfiguration('python', folderUri);
            const venvPath = pythonCfg.get<string>('defaultInterpreterPath');
            if (venvPath && venvPath !== 'python') {
                envPath = venvPath.includes(path.sep) ? path.dirname(path.dirname(venvPath)) : venvPath;
                this.sessionState.projectEnvironments[targetRoot] = envPath;
            }
        }

        if (activationScript) {
            if (isWin) {
                finalCommand = `cmd /c "${activationScript} && ${command}"`;
            } else {
                finalCommand = `source ${activationScript} && ${command}`;
            }
        }

        if (envPath && (command.startsWith('python') || command.startsWith('pip'))) {
            if (isWin) {
                const fullEnvPath = path.isAbsolute(envPath) ? envPath : path.join(targetRoot, envPath);
                finalCommand = `& "${path.join(fullEnvPath, 'Scripts', 'Activate.ps1')}"; ${finalCommand}`;
            } else {
                const fullEnvPath = path.isAbsolute(envPath) ? envPath : path.join(targetRoot, envPath);
                finalCommand = `. "${path.join(fullEnvPath, 'bin', 'activate')}" && ${finalCommand}`;
            }
        }
        
        const taskName = command.length > 30 ? command.substring(0, 27) + "..." : command;
        
        return runCommandInTerminal(
            finalCommand, 
            this.currentWorkspaceFolder.uri.fsPath, 
            `Lollms: ${taskName}`, 
            signal,
            options
        );
    }

    public async requestUserInput(question: string, signal: AbortSignal): Promise<string> {
        return this.ui.requestUserInput(question, signal);
    }

    public async runDebuggingOrchestrator(
        objective: string, 
        signal: AbortSignal
    ): Promise<string> {
        if (!this.currentWorkspaceFolder || !this.currentDiscussion || !this.processManager) {
            throw new Error("Debugger context missing (workspace or discussion).");
        }
        const processId = this.processManager.getForDiscussion(this.currentDiscussion.id)?.id || "orchestrator";

        await this.displayPlan(null);

        const isClean = await this.gitIntegration.isClean(this.currentWorkspaceFolder);
        if (!isClean) {
            const message = `🛑 **Debug Mission Blocked**

I cannot start an autonomous debug mission while you have uncommitted changes. 

**Why?** 
I will be creating a sandbox branch and applying surgical patches. To ensure you can roll back safely, your workspace must be clean.

**To continue:**
- Run: \`git add . && git commit -m "save before debug"\`
- Or: \`git stash\`
- Then click the **Debug** badge again.`;

            await this.ui.addMessageToDiscussion({ 
                role: 'system', 
                content: message 
            });
            
            this.processManager.unregister(processId);
            this.ui.updateGeneratingState();
            return "Workspace dirty";
        }
        const debugBranch = `debug/sandbox-${Date.now()}`;
        await this.gitIntegration.createAndCheckoutBranch(this.currentWorkspaceFolder, debugBranch);
        this.ui.addMessageToDiscussion({ role: 'system', content: `**🛰️ Orchestrator**\n*Sandbox Ready: Switched to branch \`${debugBranch}\`.*` });

        this.processManager.updateDescription(processId, "Phase 1: Worker drafting solution...");
        this.ui.updateGeneratingState();
        
        const model = this.currentDiscussion.model || this.lollmsApi.getModelName();
        
        const contextData = await this.contextManager.getContextContent({ 
            includeTree: true, 
            modelName: model,
            signal
        });

        const workerSystemPrompt = await getProcessedSystemPrompt(
            'chat', 
            this.currentDiscussion.capabilities,
            undefined,
            undefined,
            false,
            {
                tree: contextData.projectTree,
                files: contextData.selectedFilesContent,
                skills: contextData.skillsContent
            }
        );

        const workerResponse = await this.lollmsApi.sendChat([
            { role: 'system', content: workerSystemPrompt },
            ...this.chatHistory,
            { role: 'user', content: `Draft the complete solution for: "${objective}". Use the technical briefing.` }
        ], null, signal, model);

        this.processManager.updateDescription(processId, "Phase 2: Verifier auditing logic...");
        this.ui.updateGeneratingState();
        const auditedResponse = await this.ui.runVerificationAgent(workerResponse, signal);

        this.processManager.updateDescription(processId, "Phase 2: Applying fixes & verifying integrity...");
        this.ui.updateGeneratingState();
        
        const workerMsgId = 'worker_final_' + Date.now();
        await this.ui.addMessageToDiscussion({
            id: workerMsgId,
            role: 'assistant',
            content: auditedResponse,
            model: model
        });

        await this.ui.executeAutomationPipeline(auditedResponse, workerMsgId, signal, processId);

        if (this.currentDiscussion.capabilities?.debugMode) {
            this.processManager.updateDescription(processId, "Phase 3: Debugger starting validation...");
            this.ui.updateGeneratingState();
            
            await this.contextManager.getContextContent({ includeTree: true, modelName: model, signal });

            return await this.runDebuggerAgent(objective, signal);
        }
        
        return "Complete";
    }

    /**
     * Autonomous TDD Loop:
     * test -> code -> auto-apply -> test -> code -> ... until all tests pass or max iterations reached.
     */
    public async runTestDrivenLoop(
        testCommand: string,
        signal: AbortSignal,
        maxIterations: number = 8
    ): Promise<{ success: boolean; output: string; iterations: number }> {
        const workspaceFolder = this.currentWorkspaceFolder || vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return { success: false, output: "No active workspace folder.", iterations: 0 };
        }

        const model = this.currentDiscussion?.model || this.lollmsApi.getModelName();
        let currentIteration = 0;
        let lastOutput = "";
        let isAllPassing = false;

        this.isActive = true;
        this.ui.updateAgentMode(true);

        const logRelPath = path.join('.lollms', 'last_test_log.log').replace(/\\/g, '/');
        const logUri = vscode.Uri.joinPath(workspaceFolder.uri, logRelPath);

        while (currentIteration < maxIterations) {
            if (signal.aborted) break;
            currentIteration++;

            const proc = this.processManager?.getForDiscussion(this.currentDiscussion?.id || "");
            if (proc) {
                this.processManager?.updateDescription(proc.id, `🧪 TDD Loop [${currentIteration}/${maxIterations}]: Running \`${testCommand}\`...`);
            }
            this.ui.updateGeneratingState();

            // 1. RUN TEST
            const runRes = await this.runCommand(testCommand, signal, { timeoutMs: 180000 });
            const cleanOutput = stripAnsiCodes(runRes.output || '').trim();
            lastOutput = cleanOutput;

            // Check if test passed
            const hasExplicitFailure = cleanOutput.toLowerCase().includes('failed,') ||
                cleanOutput.toLowerCase().includes('failures=') ||
                cleanOutput.toLowerCase().includes('errors=') ||
                cleanOutput.toLowerCase().includes('failing') ||
                cleanOutput.toLowerCase().includes('err!') ||
                cleanOutput.toLowerCase().includes('traceback');

            const isPassed = runRes.success && !hasExplicitFailure;

            // Save test log on disk and sync to context
            try {
                await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceFolder.uri, '.lollms')).then(undefined, () => {});
                await vscode.workspace.fs.writeFile(logUri, Buffer.from(cleanOutput || '(No output recorded)', 'utf8'));
                await this.contextManager.getContextStateProvider()?.addFilesToContext([logRelPath]);
                this.contextManager.refreshFileInCache(logUri);
            } catch {}

            if (isPassed) {
                isAllPassing = true;
                const successMsg = `✅ **TDD Victory (Round ${currentIteration}/${maxIterations})**: All tests passed clean!\nCommand: \`${testCommand}\`\nOutput saved to \`${logRelPath}\`.`;
                this.completedActionsHistory.push(`[TDD SUCCESS] ${successMsg}`);
                await this.ui.addMessageToDiscussion({ role: 'system', content: successMsg });
                break;
            }

            // 2. TESTS FAILED -> DRAFT FIX
            const failNotice = `⚠️ **TDD Failure (Round ${currentIteration}/${maxIterations})** on \`${testCommand}\`.\nAnalyzing traceback, locating broken code, and auto-applying fixes...`;
            this.completedActionsHistory.push(`[TDD FAILURE] Round ${currentIteration}: ${cleanOutput.substring(0, 300)}`);
            await this.ui.addMessageToDiscussion({ role: 'system', content: failNotice });

            if (proc) {
                this.processManager?.updateDescription(proc.id, `🛠️ TDD Loop [${currentIteration}/${maxIterations}]: Drafting code fix...`);
            }
            this.ui.updateGeneratingState();

            // Read context files with ground-truth disk contents
            const contextData = await this.contextManager.getContextContent({
                includeTree: true,
                modelName: model,
                signal
            });

            const tddRepairPrompt = `### 🧪 AUTONOMOUS TDD REPAIR MISSION (ROUND ${currentIteration} of ${maxIterations})
Test Command: \`${testCommand}\`
Status: FAILED (Exit Code: ${runRes.success ? 0 : 1})

**TEST LOG / TRACEBACK (${logRelPath}):**
\`\`\`text
${cleanOutput.substring(0, 4000) || '(No test output captured)'}
\`\`\`

**ACTIVE GROUND-TRUTH CODE ON DISK:**
${contextData.selectedFilesContent || '(Inspect files from the tree)'}

---
### 🛠️ MANDATORY TDD REPAIR INSTRUCTIONS:
1. **ANALYZE ROOT CAUSE**: Examine the assertion failure, missing import, or error in the test output above.
2. **DELIVER IMMEDIATE CODE**: Output the necessary code modifications to make the tests pass.
3. **FORMAT**: Output code updates inside standard XML \`<file path="..." action="write|patch|update_symbol">\` tags.
4. **KEEP PATCHES SHORT**: Use short SEARCH/REPLACE blocks (1-5 lines) or targeted symbol replacements. Do not write unnecessary prose.`;

            const systemPrompt = `You are an expert autonomous Test-Driven Development (TDD) engineer. Your goal is to make all tests pass by providing verified, surgical code modifications inside <file path="..." action="..."> tags.`;

            let fixResponse = "";
            try {
                fixResponse = await this.lollmsApi.sendChat([
                    { role: 'system', content: systemPrompt },
                    ...this.chatHistory.slice(-2),
                    { role: 'user', content: tddRepairPrompt }
                ], (chunk) => {
                    if (this.currentPlan) {
                        this.currentPlan.scratchpad = (this.currentPlan.scratchpad || '') + chunk;
                    }
                }, signal, model);
            } catch (err: any) {
                if (err.name === 'AbortError' || signal.aborted) break;
                Logger.error(`TDD repair LLM generation error: ${err.message}`);
                break;
            }

            const cleanFix = stripThinkingTags(fixResponse).trim();

            // 3. AUTO-APPLY CODE UPDATES TO DISK
            if (proc) {
                this.processManager?.updateDescription(proc.id, `⚡ TDD Loop [${currentIteration}/${maxIterations}]: Auto-applying patches...`);
            }
            this.ui.updateGeneratingState();

            const stepId = `agent_tdd_${Date.now()}_${currentIteration}`;
            await this.ui.executeAutomationPipeline(cleanFix, stepId, signal, proc?.id || 'tdd_loop');

            this.completedActionsHistory.push(`[TDD APPLIED] Round ${currentIteration}: Patches applied to disk.`);

            // Brief pause for file system I/O and text documents to settle
            await new Promise(r => setTimeout(r, 800));
        }

        return {
            success: isAllPassing,
            output: lastOutput,
            iterations: currentIteration
        };
    }

    public async runDebuggerAgent(objective: string, signal: AbortSignal): Promise<string> {
        if (!this.currentWorkspaceFolder || !this.currentDiscussion) return "No context.";

        const dbgMsgId = 'debug_report_' + Date.now();
        let fullDebugHistoryDisplay: string[] = [];

        await this.ui.addMessageToDiscussion({ 
            id: dbgMsgId, 
            role: 'system', 
            content: `**🧪 Debug Specialist**\n*Objective: "${objective}"*\n\nInitializing...` 
        });

        const maxSteps = this.currentDiscussion.capabilities?.maxDebugSteps || 10;
        const model = this.currentDiscussion.model || this.lollmsApi.getModelName();
        const enabledTools = this.getEnabledTools();
        const toolDescriptions = enabledTools.map(t => `- ${t.name}: ${t.description}`).join('\n');
        
        const systemPrompt = `You are the **Autonomous Debugging Engine**. Your mission: "${objective}".
You MUST reach the goal by iterating: Run -> Observe -> Fix -> Verify.

### 🧪 SURGICAL REPAIR PROTOCOL:
1. **Reproduction**: Run the code immediately to identify the failure.
2. **Fixing**: Use SEARCH/REPLACE (AIDER) blocks or full file writes.
3. **Validation**: After every fix, you MUST run the code again to verify the fix works.
4. **Conclusion**: Only stop when the code runs without errors AND the objective is met.

### 🛠️ TOOLS AVAILABLE:
${toolDescriptions}

OUTPUT JSON ONLY for tool calls.
\`\`\`json
{
  "thought": "Reasoning...",
  "tool": "tool_name",
  "params": { ... }
}
\`\`\``;

        const loopHistory: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            ...this.chatHistory.slice(-3) 
        ];

        let step = 0;
        while (step < maxSteps) {
            if (signal.aborted) break;
            step++;

            const currentData = await this.contextManager.getContextContent({ includeTree: true, modelName: model, signal });
            const diskStateMsg: ChatMessage = { 
                role: 'system', 
                content: `[CURRENT DISK STATE]\n${currentData.projectTree}\n${currentData.selectedFilesContent}`, 
                skipInPrompt: true 
            };

            const currentStepPrompt: ChatMessage[] = [
                ...loopHistory,
                diskStateMsg,
                { role: 'user', content: step === 1 ? `Begin the debug mission.` : `Previous tool result received. Analyze and decide next step (Step ${step}/${maxSteps}).` }
            ];

            const response = await this.lollmsApi.sendChat(currentStepPrompt, null, signal, model);
            loopHistory.push({ role: 'assistant', content: response });

            const cleanResponse = stripThinkingTags(response);
            const toolMatch = this.parseToolCall(cleanResponse);

            if (toolMatch) {
                const res = await this.executeTask(toolMatch.name, toolMatch.params, signal);
                
                loopHistory.push({ role: 'user', content: `[OBSERVATION]\n${res.output}` });
                fullDebugHistoryDisplay.push(`**Step ${step}:** \`${toolMatch.name}\`\n${res.output}`);

                if (this.ui.updateMessageContent) {
                    const logContent = fullDebugHistoryDisplay.map((entry, i) => {
                        const title = entry.split('\n')[0];
                        return `<details><summary>${title}</summary>\n\n${entry}\n\n</details>`;
                    }).join('\n');
                    
                    await this.ui.updateMessageContent(dbgMsgId, `**🧪 Debug Specialist**\n*Objective: "${objective}"*\n\n${logContent}`);
                }

                if (['generate_code', 'replaceCode', 'applyFileContent', 'delete_file', 'move_file'].includes(toolMatch.name)) {
                    await this.contextManager.getContextContent({ includeTree: true, modelName: model, signal });
                }
            } else if (cleanResponse.toLowerCase().includes("mission accomplished") || cleanResponse.toLowerCase().includes("verified")) {
                if (this.ui.updateMessageContent) {
                    await this.ui.updateMessageContent(dbgMsgId, `**🧪 Debug Specialist**\n\n${cleanResponse}`);
                }
                return "Complete";
            } else {
                loopHistory.push({ role: 'user', content: "No tool call detected. You must use a tool to progress or state 'Mission Accomplished'." });
            }
        }
        
        const finalReport = `🛑 **Debugger Stopped**: Reached maximum iteration limit (${maxSteps} steps) without reaching a verified conclusion.`;
        if (this.ui.updateMessageContent) await this.ui.updateMessageContent(dbgMsgId, finalReport);
        return "Max steps reached";
    }

    private async enforceAgentContextBudget(justAddedFiles: string[], model: string, signal: AbortSignal): Promise<void> {
        if (!this.currentDiscussion || this.currentDiscussion.capabilities?.ignoreContextSize === true) {
            return;
        }

        const currentData = await this.contextManager.getContextContent({
            discussionId: this.currentDiscussion.id,
            importedSkillIds: this.currentDiscussion.importedSkills,
            mutedFiles: this.currentDiscussion.mutedFiles,
            mutedSkills: this.currentDiscussion.mutedSkills,
            mutedDiagrams: this.currentDiscussion.mutedDiagrams,
            capabilities: this.currentDiscussion.capabilities,
            modelName: model,
            signal
        });

        const limitInfo = await this.lollmsApi.getContextSize(model).catch(() => null);
        const maxTokens = (limitInfo && limitInfo.context_size > 0)
            ? limitInfo.context_size
            : (this.currentDiscussion.lastTokenMetrics?.contextSize || getContextLimitForModel(model) || 128000);

        const triggerPct = Math.min(98, this.currentDiscussion.capabilities?.contextGovernorThreshold ?? 95);
        const targetPct = Math.min(triggerPct, this.currentDiscussion.capabilities?.contextGovernorTargetThreshold ?? 70);
        const triggerBudget = Math.round(maxTokens * (triggerPct / 100));
        const targetBudget = Math.round(maxTokens * (targetPct / 100));

        const getChatHistoryChars = () => this.chatHistory.slice(-4).reduce((sum, m) => {
            const txt = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
            return sum + txt.length;
        }, 0);

        const getActionsChars = () => this.completedActionsHistory.slice(-12).join('\n\n').length;

        const contextTokens = Math.ceil((currentData.text || '').length / 3.5);
        let actionsTokens = Math.ceil(getActionsChars() / 3.5);
        let historyTokens = Math.ceil(getChatHistoryChars() / 3.5);
        const systemOverhead = 3500;

        let totalEstimated = contextTokens + actionsTokens + historyTokens + systemOverhead;
        const initialTotal = totalEstimated;

        if (totalEstimated <= triggerBudget) {
            if (totalEstimated / maxTokens > 0.90) {
                const pruneWarning = `[SYSTEM WARNING] Context usage is at ${Math.round((totalEstimated / maxTokens) * 100)}%. Prune unnecessary files with 'remove_files_from_context' or finalize your task now.`;
                this.completedActionsHistory.push(pruneWarning);
            }
            return;
        }

        const actionsLog: string[] = [];

        // 1. Compact older completedActionsHistory entries (keep the most recent 4 intact)
        if (this.completedActionsHistory.length > 4 && actionsTokens > 1500) {
            const olderCount = this.completedActionsHistory.length - 4;
            let savedChars = 0;
            for (let i = 0; i < olderCount; i++) {
                const entry = this.completedActionsHistory[i];
                if (entry.length > 260) {
                    const compacted = `${entry.substring(0, 220)}... [compacted]`;
                    savedChars += entry.length - compacted.length;
                    this.completedActionsHistory[i] = compacted;
                }
            }
            if (savedChars > 0) {
                const savedTok = Math.ceil(savedChars / 3.5);
                totalEstimated = Math.max(0, totalEstimated - savedTok);
                actionsTokens = Math.ceil(getActionsChars() / 3.5);
                actionsLog.push(`- **Timeline Compacted**: Abbreviated ${olderCount} earlier step log(s) (~${savedTok.toLocaleString()} tok saved).`);
            }
        }

        // 2. Compact older chatHistory entries (keep the most recent 2 intact)
        if (this.chatHistory.length > 2 && historyTokens > 1500 && totalEstimated > targetBudget) {
            const olderLimit = this.chatHistory.length - 2;
            let savedChars = 0;
            for (let i = 0; i < olderLimit; i++) {
                const msg = this.chatHistory[i];
                if (typeof msg.content === 'string' && msg.content.length > 400) {
                    const compacted = `${msg.content.substring(0, 350)}\n... [earlier message compacted]`;
                    savedChars += msg.content.length - compacted.length;
                    this.chatHistory[i] = { ...msg, content: compacted };
                }
            }
            if (savedChars > 0) {
                const savedTok = Math.ceil(savedChars / 3.5);
                totalEstimated = Math.max(0, totalEstimated - savedTok);
                historyTokens = Math.ceil(getChatHistoryChars() / 3.5);
                actionsLog.push(`- **History Compacted**: Abbreviated earlier chat messages (~${savedTok.toLocaleString()} tok saved).`);
            }
        }

        // 3. Reduce previous files (shrink to definitions-only, then mute), strictly preserving justAddedFiles
        const isProtectedFile = (p: string) => justAddedFiles.some(jp => arePathsEqual(p, jp));
        const loadedBlocks = extractFileBlocks(currentData.selectedFilesContent || '');
        const candidates = loadedBlocks.map((fb: any) => {
            const attrs = parseFileTagAttributes(fb.attrStr, fb.rawContent);
            const filePath = attrs?.path || '';
            const tokens = Math.max(1, Math.ceil((fb.fullMatch || fb.rawContent || '').length / 3.5));
            const isStructure = attrs?.mode === 'structure' || fb.attrStr.includes('mode="structure"') || fb.attrStr.includes('mode="definitions-only"');
            return {
                path: filePath,
                tokens,
                isStructure,
                isProtected: isProtectedFile(filePath),
                muted: false
            };
        }).filter(c => c.path && !c.isProtected)
          .sort((a, b) => b.tokens - a.tokens);

        const provider = this.contextManager.getContextStateProvider();
        const shrunkToStructure: string[] = [];
        const mutedPrevious: string[] = [];
        let filesSavedTok = 0;

        // Pass A: Convert full project files to definitions-only
        const urisForDefs: vscode.Uri[] = [];
        for (const cand of candidates) {
            if (totalEstimated <= targetBudget) break;
            if (cand.isStructure || !isProjectFile(cand.path)) continue;
            const res = await this.contextManager.resolveWorkspaceFromPath(cand.path).catch(() => null);
            if (!res) continue;

            try {
                const defs = await this.contextManager.extractDefinitions(res.uri);
                if (!defs || defs === '(No definitions found)' || defs === '(No significant definitions found)') continue;
                const defTokens = Math.max(1, Math.ceil(defs.length / 3.5));
                if (defTokens < cand.tokens - 40) {
                    const saved = cand.tokens - defTokens;
                    cand.tokens = defTokens;
                    cand.isStructure = true;
                    totalEstimated = Math.max(0, totalEstimated - saved);
                    filesSavedTok += saved;
                    urisForDefs.push(res.uri);
                    shrunkToStructure.push(cand.path);

                    if (Array.isArray((this.currentDiscussion as any).includedFiles)) {
                        const entry = (this.currentDiscussion as any).includedFiles.find((f: any) => arePathsEqual(typeof f === 'string' ? f : f.path, cand.path));
                        if (entry && typeof entry === 'object') {
                            entry.state = 'definitions-only';
                        }
                    }
                }
            } catch {}
        }

        if (provider && urisForDefs.length > 0) {
            await provider.setStateForUris(urisForDefs, 'definitions-only');
            for (const u of urisForDefs) {
                this.contextManager.refreshFileInCache(u);
            }
        }

        // Pass B: Mute previous files if still above targetBudget
        if (totalEstimated > targetBudget) {
            if (!this.currentDiscussion.mutedFiles) this.currentDiscussion.mutedFiles = [];
            for (const cand of candidates) {
                if (totalEstimated <= targetBudget) break;
                if (cand.muted) continue;
                cand.muted = true;
                totalEstimated = Math.max(0, totalEstimated - cand.tokens);
                filesSavedTok += cand.tokens;
                mutedPrevious.push(cand.path);
                if (!this.currentDiscussion.mutedFiles.some(m => arePathsEqual(m, cand.path))) {
                    this.currentDiscussion.mutedFiles.push(cand.path);
                }
            }
            if (this.currentDiscussion.capabilities) {
                this.currentDiscussion.capabilities.mutedFiles = [...this.currentDiscussion.mutedFiles];
            }
        }

        if (shrunkToStructure.length > 0) {
            actionsLog.push(`- **Previous Files Compacted to Structure [D]**: ${shrunkToStructure.map(f => `\`${f}\``).join(', ')}`);
        }
        if (mutedPrevious.length > 0) {
            actionsLog.push(`- **Previous Files Muted [M]** (~${filesSavedTok.toLocaleString()} tok saved; kept just-added files [${justAddedFiles.join(', ') || 'active'}]): ${mutedPrevious.map(f => `\`${f}\``).join(', ')}`);
        }

        if (actionsLog.length > 0) {
            if (!this.currentDiscussion.id.startsWith('temp-') && !this.currentDiscussion.id.startsWith('remote-')) {
                await this.discussionManager.saveDiscussion(this.currentDiscussion);
            }
            const summaryMsg = `🗜️ **Agent Context Budget Cleared** (~${initialTotal.toLocaleString()} → ~${totalEstimated.toLocaleString()} tokens / ${maxTokens.toLocaleString()} limit)\n${actionsLog.join('\n')}`;
            this.completedActionsHistory.push(summaryMsg);
            await this.ui.addMessageToDiscussion({
                role: 'system',
                content: summaryMsg,
                skipInPrompt: true
            });
        }
    }

    private async deactivateAgent() {
        this.isActive = false;
        if (this.currentPlan) {
            this.currentPlan.status = 'stale';
        }
        this.ui.updateAgentMode(false);
    }

    private async runVerifierAgent(objective: string, signal: AbortSignal): Promise<void> {
        const verifierMsgId = 'verifier_report_' + Date.now();
        await this.ui.addMessageToDiscussion({ 
            id: verifierMsgId, 
            role: 'system', 
            content: `**🛡️ Phase 4: Verifier**\n*Performing logical audit...*` 
        });

        const model = this.currentDiscussion?.model || this.lollmsApi.getModelName();
        const systemPrompt = `You are the **Senior Quality Verifier**. 
Your goal is to perform a cold, critical audit of the work done by the Worker and Debugger.

### 🛡️ AUDIT CHECKLIST:
1. **REQUIREMENT COVERAGE**: Does the final code actually fulfill ALL parts of the original request: "${objective}"?
2. **LOGIC CONSISTENCY**: Are there any new logical contradictions or edge cases introduced by the fixes?
3. **REGRESSION CHECK**: Did the fix for the bug accidentally break a different feature?
4. **COMPLIANCE**: Does the solution follow all the Team Briefing facts?

If you find a logic flaw, you MUST provide a final SEARCH/REPLACE fix.
If the code is perfect, output a "VERIFICATION PASSED" report.`;

        const chatHistory: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            ...this.chatHistory,
            { role: 'user', content: "The code is written and verified at runtime. Perform a final logical audit. Does it meet the objective perfectly?" }
        ];

        const response = await this.lollmsApi.sendChat(chatHistory, null, signal, model);
        if (this.ui.updateMessageContent) {
            await this.ui.updateMessageContent(verifierMsgId, response);
        }
    }
}
