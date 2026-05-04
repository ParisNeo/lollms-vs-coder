import * as vscode from 'vscode';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { ContextManager } from './contextManager';
import { GitIntegration } from './gitIntegration';
import { InfoPanel } from './commands/infoPanel';
import { PlanParser } from './planParser';
import { stripThinkingTags, getProcessedSystemPrompt } from './utils';
import { ProcessManager } from './processManager';
import { DiscussionManager, Discussion } from './discussionManager';
import * as fs from 'fs/promises';
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


// Interface decoupling the UI from the logic
export interface IAgentUI {
    addMessageToDiscussion(message: ChatMessage): Promise<void>;
    updateMessageContent?(messageId: string, newContent: string): Promise<void>;
    displayPlan(plan: Plan | null): void;
    updateGeneratingState(): void;
    requestUserInput(question: string, signal: AbortSignal, options?: { isAgentZone?: boolean }): Promise<string>;
    updateAgentMode(isActive: boolean): void;
    // New methods to allow the Manager to control the pipeline stages
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
    private isDebugging: boolean = false;
    public projectMemoryManager?: any; // Required for ChatPanel to process memory tags
    public personalityManager?: PersonalityManager;
    
    /**
     * Explicitly track completed actions for prompt injection to prevent
     * the Architect from planning steps it has already finished.
     */
    private completedActionsHistory: string[] = [];

    public rlmDb?: RLMDatabaseManager;
    /**
     * Chapter 2: State Management Layers
     * Explicit tracking of different time horizons for the agent.
     */
    public sessionState: {
        activeEnv?: string;
        replVariables: Record<string, any>; 
        installedPackages: string[];
        environmentHistory: string[];
        workingMemory: string[]; 
        projectMemory: string[]; 
        secureCredentials: Record<string, string>;
        isSafetyCheckPassed: boolean;
        unverifiedFiles: Set<string>; 
        backgroundProcesses: Map<string, { pid: number, logFile: string, startTime: number }>; // NEW
    } = {
        replVariables: {},
        installedPackages: [],
        environmentHistory: [],
        workingMemory: [],
        projectMemory: [],
        secureCredentials: {},
        isSafetyCheckPassed: false,
        unverifiedFiles: new Set(),
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
        rlmDb?: RLMDatabaseManager
    ) {
        this.codeGraphManager = codeGraphManager;
        this.skillsManager = skillsManager;
        this.toolManager = new ToolManager();
        this.planParser = new PlanParser(this.lollmsApi, this.contextManager, this.toolManager);
        this.rlmDb = rlmDb;

        // --- MITIGATION: ANTI-NESTING PROTOCOL ---
        this.sessionState.workingMemory.push(
            "LESSON: Avoid nesting shells. Do not use 'powershell -Command' or 'bash -c' inside 'execute_command'. " +
            "Submit the raw command directly. For complex logic involving pipes or variables, always generate a temporary .py or .sh script first."
        );
        this.sessionState.workingMemory.push(
            "DIAGNOSTIC: If you see 'isort server crashed', it is an Extension Host failure, NOT a code bug. MANDATORY: Do not edit user code to fix this. Tell the user to 'Reload Window' or check the Python Interpreter selection."
        );
        this.sessionState.workingMemory.push(
            "LESSON: Avoid nesting shells. Do not use 'powershell -Command' or 'bash -c' inside 'execute_command'. " +
            "Submit the raw command directly. For complex logic involving pipes or variables, always generate a temporary .py or .sh script first."
        );
        this.sessionState.workingMemory.push(
            "ENVIRONMENT: If 'isort' crashes (5 times in 3 minutes), the Python Environment is likely misconfigured. MANDATORY ACTION: Use 'execute_command' to run 'python --version' and 'pip show isort'."
        );
        this.sessionState.workingMemory.push(
            "FIX: If 'isort' client fails to connect, trigger 'workbench.action.reloadWindow' via 'execute_command'. Ensure the user has selected a Python interpreter in the status bar."
        );
        this.sessionState.workingMemory.push(
            "DIAGNOSTIC: If you see 'OS ERROR: Output capture file missing', this is a Windows File Lock issue. Do NOT refactor your code. Simply 'wait' for 2 seconds and retry the command exactly as it was. It is not a logic error."
        );

        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            this.currentWorkspaceFolder = vscode.workspace.workspaceFolders[0];
        }

        this.setupDreamScheduler();
        }

        private setupDreamScheduler() {
        // Check every hour
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
        }, 60000); // Check once a minute
        }
    // Add this helper method inside the AgentManager class
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
        const activeIds = (this.sessionState as any).activeToolIds as Set<string> | undefined;

        const attachments = this.currentDiscussion?.messages
            .filter(m => (m as any).attachmentData).length || 0;

        const tools = this.toolManager.getAllTools().filter(t => {
            // --- HIDE read_discussion_file IF NO ATTACHMENTS ---
            if (t.name === 'read_discussion_file' && attachments === 0) return false;

            // If the agent is in an autonomous loop, only tools in the "equipped" active list are available.
            if (this.isActive && activeIds && !activeIds.has(t.name)) {
                return false;
            }
            // Determine default if not set
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

        if (!useRLM) {
            return tools.filter(t => t.name !== 'rlm_repl');
        }
        return tools;
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
            // PRESERVE THE PLAN: We no longer nullify currentPlan here.
            // We only stop the active loop.
            if (this.currentPlan) {
                this.currentPlan.status = 'stale';
                this.displayAndSavePlan(this.currentPlan);
            }
        }
        this.ui.updateAgentMode(this.isActive);
    }

    public getMetrics() {
        // Calculate raw data weights for the Brain Bar
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

    private async displayAndSavePlan(plan: Plan | null) {
        this.currentPlan = plan;
        if (this.currentDiscussion && !this.currentDiscussion.id.startsWith('temp-') && !this.currentDiscussion.id.startsWith('remote-')) {
            this.currentDiscussion.plan = plan;
            await this.discussionManager.saveDiscussion(this.currentDiscussion);
        }

        // Inject metrics into the UI update
        const metrics = this.getMetrics();
        this.ui.displayPlan(plan ? { ...plan, metrics } : null);
    }

    /**
     * Generates a self-contained HTML report of the entire mission.
     */
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
/**
     * Programmatic implementation of Phase 0.
     * Ensures the Genie never works on a dangerous or unstable environment without consent.
     */
    private async preFlightSafetyCheck(folder: vscode.WorkspaceFolder, signal: AbortSignal): Promise<boolean> {
        if (this.sessionState.isSafetyCheckPassed) {
            Logger.info(`[Phase 0] Safety check already passed for this session. Skipping.`);
            return true;
        }

        Logger.info(`[Phase 0] Starting Pre-Flight Safety Check for: ${folder.name}`);
        
        // --- FIXED: Use a managed timeout helper to prevent unhandled rejections ---
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

        // Ensure we have a plan object to show the form in the sidebar
        if (!this.currentPlan) {
            this.currentPlan = {
                objective: "Initializing Safety Protocols...",
                current_sub_goal: "Verify Workspace Integrity",
                observations: [],
                scratchpad: "Safety check initiated.",
                tasks: [],
                status: 'active'
            };
        }

        if (!isRepo) {
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
            await this.displayAndSavePlan(this.currentPlan);

            const response = await this.ui.requestUserInput(formPrompt, signal, { isAgentZone: true });

            // Remove the form task from sidebar immediately
            if (this.currentPlan) {
                this.currentPlan.tasks = this.currentPlan.tasks.filter(t => t.id !== -1);
                await this.displayAndSavePlan(this.currentPlan);
            }

            let choice = this.parseFormResponse(response, "no_git_repo");

            const safeChoice = (choice || "").toLowerCase().trim();

            if (safeChoice === 'init') {
                this.ui.addMessageToDiscussion({ role: 'system', content: `⚙️ **Initializing Atomic Clean Repository...**` });

                // Use the same timeout safety for init
                const initPromise = this.runCommand('git init', signal);
                let timeoutHandle: NodeJS.Timeout;
                const timeoutP = new Promise<any>((_, reject) => timeoutHandle = setTimeout(() => reject(new Error("Git init timed out")), 15000));
                
                try {
                    await Promise.race([initPromise, timeoutP]);
                } finally {
                    // @ts-ignore
                    clearTimeout(timeoutHandle);
                }

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
                "/bin/",
                "/lib/",
                "/include/",
                "/share/",
                "pyvenv.cfg",
                "",
                "# Build & System",
                "dist/",
                "build/",
                "out/",
                "target/",
                ".vscode/",
                ".idea/",
                ".DS_Store",
                "Thumbs.db",
                "",
                "# Temp Files",
                "*.log",
                "*.tmp",
                "*.bak"
                ].join('\n');

                const ignorePath = path.join(folder.uri.fsPath, '.gitignore');

                // 1. Write the file
                await fs.writeFile(ignorePath, ignoreContent, 'utf8');

                // 2. COMMIT THE IGNORE FIRST (Phase 1)
                // This makes the ignore rules the "law" of the repo before any mass add
                await this.runCommand('git add .gitignore', signal);
                await this.runCommand('git commit -m "chore: establish ignore rules"', signal);

                // 3. PURGE AND RE-ADD (Phase 2)
                // We reset the index to be absolutely sure nothing is lingering from a previous failed attempt
                await this.runCommand('git reset', signal);
                await this.runCommand('git add .', signal);

                await this.runCommand('git commit -m "Initial commit (clean content)"', signal);

                this.ui.addMessageToDiscussion({ role: 'system', content: `🛡️ **Repository Secured**: Ignore rules established and confirmed. \`venv\` is excluded.` });
                isRepo = true;
            } else if (safeChoice === 'continue') {
                this.ui.addMessageToDiscussion({ role: 'system', content: `⚠️ **Proceeding without Git.** Automatic rollbacks are disabled.` });
                return true;
            } else {
                // stop, cancelled, or any other value
                this.ui.addMessageToDiscussion({ role: 'system', content: `🛑 **Operation cancelled** — no Git repository and user declined to continue.` });
                return false;
            }
        }

        // If we're proceeding without git (continue path), we already returned above.
        // From here on, we assume git is available.
        if (!isRepo) {
            // Defensive: should never reach here, but prevents downstream errors
            return false;
        }

        let currentBranch = await this.gitIntegration.getCurrentBranch(folder);
        const isClean = await this.gitIntegration.isClean(folder);
        const isMain = ['main', 'master', 'prod', 'production'].includes(currentBranch.toLowerCase());

        if (!isClean) {
            const formPrompt = `
        <lollms_form id="preflight_safety" title="Uncommitted Changes Detected">
        <input type="radio" name="decision" label="Stash changes and create a clean AI branch" value="stash" checked="true" />
        <input type="radio" name="decision" label="Commit them now" value="commit" />
        <input type="radio" name="decision" label="Proceed anyway (Dangerous)" value="proceed" />
        <submit label="Confirm Safety Action" />
        </lollms_form>`.trim();

            const safetyTask: Task = {
                id: -1,
                task_type: 'safety_check',
                description: "🛡️ Uncommitted changes. Decision required.",
                action: "safety_check",
                parameters: { lollms_form: formPrompt },
                status: 'pending',
                result: null,
                retries: 0
            };
            // Clear tasks to ensure the safety check is the ONLY thing visible
            this.currentPlan!.tasks = [safetyTask];
            await this.displayAndSavePlan(this.currentPlan);

            Logger.info(`[Phase 0] Requesting Safety Action via Form in Sidebar...`);
            const response = await this.ui.requestUserInput(formPrompt, signal, { isAgentZone: true });
            Logger.info(`[Phase 0] Raw response received from UI: "${response}"`);

            // Remove the form task from sidebar immediately
            if (this.currentPlan) {
                this.currentPlan.tasks = this.currentPlan.tasks.filter(t => t.id !== -1);
                await this.displayAndSavePlan(this.currentPlan);
            }

            let choice = this.parseFormResponse(response, "preflight_safety");
            const safeChoice = (choice || "").toLowerCase().trim();
            Logger.info(`[Phase 0] Parsed safeChoice: "${safeChoice}"`);

            if (safeChoice === 'stash') {
                await this.gitIntegration.stash(folder, "Genie: Stashed before mission");
                this.completedActionsHistory.push(`[GIT] 📦 STASHED: Uncommitted changes moved to stash to ensure a clean mission start.`);
                const stillDirty = !(await this.gitIntegration.isClean(folder));
                if (stillDirty) {
                    this.ui.addMessageToDiscussion({ role: 'system', content: `❌ **Stash failed** — working tree still dirty. Aborting for safety.` });
                    return false;
                }
                this.sessionState.isSafetyCheckPassed = true;
            } else if (safeChoice === 'commit') {
                this.ui.addMessageToDiscussion({ role: 'system', content: `⚙️ **Backing up workspace...**` });

                // Fetch commit message but skip the manual staging modal
                const msg = await this.gitIntegration.generateCommitMessage(folder);
                const finalMsg = msg?.trim() || "Genie: pre-flight backup";

                // Bypass UI entirely
                await this.gitIntegration.stageAllAndCommit(finalMsg, folder);

                this.completedActionsHistory.push(`[GIT] 💾 COMMITTED ALL: Permanent backup created with message: "${finalMsg}"`);

                const stillDirty = !(await this.gitIntegration.isClean(folder));
                if (stillDirty) {
                    this.ui.addMessageToDiscussion({ role: 'system', content: `❌ **Commit failed** — Workspace still contains changes. Aborting.` });
                    return false;
                }
                this.sessionState.isSafetyCheckPassed = true;
            } else if (safeChoice === 'proceed' || safeChoice === 'continue') {
                this.ui.addMessageToDiscussion({ role: 'system', content: `⚠️ **Safety Bypass**: Proceeding with uncommitted changes on \`${currentBranch}\`.` });
                this.completedActionsHistory.push(`[GIT] ⚠️ BYPASS: User chose to proceed with a dirty workspace.`);
                this.sessionState.isSafetyCheckPassed = true;
                return true; 
            } else {
                this.ui.addMessageToDiscussion({ role: 'system', content: `🛑 **Operation cancelled** by user.` });
                return false;
            }
        }

        currentBranch = await this.gitIntegration.getCurrentBranch(folder);

        if (!currentBranch.startsWith('ai-task-')) {
            const branchName = `ai-task-${Date.now()}`;
            await this.gitIntegration.createAndCheckoutBranch(folder, branchName);
            this.completedActionsHistory.push(`[GIT] 🌿 BRANCHED: Switched from \`${currentBranch}\` to isolated workspace \`${branchName}\`.`);
        } else {
            // Log to timeline only
            this.completedActionsHistory.push(`[GIT] ℹ️ Persistence: Already on isolated branch \`${currentBranch}\`.`);
        }

        this.sessionState.isSafetyCheckPassed = true;
        return true;
    }

    /**
     * Helper to parse form responses consistently.
     */
    private parseFormResponse(response: string, context: string): string {
        if (response.startsWith('FORM_SUBMISSION:')) {
            try {
                const data = JSON.parse(response.substring(16));
                Logger.info(`[AgentManager] Parsed ${context} form data:`, data);
                // Return 'decision' or the first available value if 'decision' is missing
                if (data.decision) return String(data.decision);
                const values = Object.values(data);
                return values.length > 0 ? String(values[0]) : "";
            } catch (e) {
                Logger.error(`[AgentManager] Failed to parse ${context} form JSON: ${response}`, e);
                console.error(`[AgentManager] Failed to parse ${context} form data:`, e);
                return "";
            }
        }
        return response;
    }

    /**
     * Handles user messages with enhanced "Briefing" (Prime Directive) priority.
     * The briefing acts as the 'extra argument' ensuring architectural compliance.
     */
    public async handleUserMessage(
        content: string, 
        discussion: Discussion, 
        workspaceFolder: vscode.WorkspaceFolder,
        permissions: UserPermissions = { canExecute: true, canRead: true }
    ) {
        const isDebugActive = discussion.capabilities?.debugMode || false;
        if (!this.processManager) return;

        this.currentWorkspaceFolder = workspaceFolder;
        this.currentDiscussion = discussion;
        this.chatHistory = [...discussion.messages];
        this.currentUserPermissions = permissions;

        // --- RELOAD GENIE PERSISTENT SESSION ---
        if (discussion.agentSession) {
            this.sessionState.replVariables = discussion.agentSession.replVariables || {};
            this.sessionState.workingMemory = discussion.agentSession.workingMemory ||[];
            this.sessionState.secureCredentials = discussion.agentSession.secureCredentials || {};
            this.sessionState.isSafetyCheckPassed = discussion.agentSession.isSafetyCheckPassed || false;
            this.completedActionsHistory = discussion.agentSession.completedActionsHistory ||[];
        }
        
        if (!this.sessionState.secureCredentials) {
            this.sessionState.secureCredentials = {};
        }

        if (!this.currentPlan) {
            this.failureMemory.clear();
            this.consecutiveTaskFailures.clear();
            this.sessionState.isSafetyCheckPassed = false; // Reset for new mission
        } else {
            // --- CONTINUITY PROTOCOL ---
            // If a plan already exists, treat the incoming user message as a "Direct Intervention"
            this.isActive = true; // Ensure agent is set to active to resume the loop
            this.completedActionsHistory.push(`[USER INTERVENTION]\n- FEEDBACK: "${content}"\n- ACTION: Adjusting strategy based on user input.`);
            this.ui.addMessageToDiscussion({ role: 'system', content: '🔄 **Integrating feedback...** Resuming mission.' });
            this.ui.updateAgentMode(true);
        }

        // --- DEBUG MODE GIT SANDBOX ---
        if (isDebugActive && workspaceFolder) {
            const isRepo = await this.gitIntegration.isGitRepo(workspaceFolder);
            if (isRepo) {
                const clean = await this.gitIntegration.isClean(workspaceFolder);
                if (!clean) {
                    // Logically happens after the prompt is already in history
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

        // Register the primary orchestrator process
        const { id: processId, controller } = this.processManager.register(discussion.id, `Orchestrator: Initializing...`);
        this.ui.updateGeneratingState();

        try {
            // --- PHASE 0: HYGIENE & SAFETY CHECK ---
            const safetyPassed = await this.preFlightSafetyCheck(workspaceFolder, controller.signal);
            if (!safetyPassed) return;

            // --- BLOCKING DEBUG FLOW ---
            if (isDebugActive) {
                this.processManager.updateDescription(processId, "🛰️ Orchestrator: Initializing Debug Sandbox...");
                await this.runDebuggingOrchestrator(content, controller.signal);
                // After Debug finishes, we synthesize.
                await this.synthesizeFinalResponse(content, controller.signal, this.currentDiscussion.model);
                return; 
            }

            // --- CONTINUOUS AUTONOMOUS AGENT FLOW ---
            // Initialize the REPL variables with empty containers if they don't exist
            if (!this.sessionState.replVariables) {
                this.sessionState.replVariables = {};
            }

            await this.runAutonomousLoop(content, controller.signal, processId, this.currentDiscussion.model);

        } catch (error: any) {
            if (error.name !== 'AbortError' && error.message !== 'AbortError') {
                this.ui.addMessageToDiscussion({ role: 'system', content: `❌ **Critical Error:** ${error.message}` });
            }
        } finally {
            // --- PERSIST GENIE SESSION ---
            if (this.currentDiscussion) {
                this.currentDiscussion.agentSession = {
                    replVariables: this.sessionState.replVariables,
                    workingMemory: this.sessionState.workingMemory,
                    secureCredentials: this.sessionState.secureCredentials,
                    isSafetyCheckPassed: this.sessionState.isSafetyCheckPassed,
                    completedActionsHistory: this.completedActionsHistory
                };
                await this.discussionManager.saveDiscussion(this.currentDiscussion);
            }

            this.processManager.unregister(processId);
            this.ui.updateGeneratingState();
        }
    }

    /**
     * 🧞 THE GENIE'S MODERN LOOP (RE-ACT)
     * Replaces static planning with an iterative Discover-Reason-Act-Observe cycle.
     */
    private async runAutonomousLoop(
        objective: string, 
        signal: AbortSignal, 
        processId: string, 
        modelOverride?: string,
        extraHistory: ChatMessage[] = []
    ) {
        if (!this.currentDiscussion) return;

        // Initialize a "Living Plan" object to track the timeline in the UI
        if (!this.currentPlan) {
            this.currentPlan = {
                objective: objective,
                current_sub_goal: "Discovery",
                observations: [],
                scratchpad: "Mission started. Initializing discovery...",
                tasks: [],
                status: 'active'
            };
            await this.displayAndSavePlan(this.currentPlan);
        }

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        let maxSteps = config.get<number>('agent.maxSteps') || 100;
        let stepCount = 0;
        const model = modelOverride || this.currentDiscussion.model;

        while (stepCount < maxSteps) {
            if (signal.aborted) break;
            stepCount++;

            this.processManager?.updateDescription(processId, `Genie: Reasoning (Step ${stepCount})...`);
            this.ui.updateGeneratingState();

            // 1. Get Project Context for this specific step
            const contextData = await this.contextManager.getContextContent({ 
                includeTree: true, 
                modelName: model,
                signal 
            });

            // 2. Build the ReAct prompt
            const availableSpecialists = this.personalityManager?.getPersonalities().map(p => p.id) || [];
            const systemPrompt = await this.planParser.getArchitectSystemPrompt(
                this.getEnabledTools(), 
                this.currentDiscussion.importedSkills,
                availableSpecialists
            );

            // Generate Context Inventory
            const includedFiles = this.contextManager.getContextStateProvider()?.getIncludedFiles() || [];
            const inventory = includedFiles.length > 0 
                ? includedFiles.map(f => `- ${f.path} [${f.state === 'included' ? 'FULL CONTENT LOADED' : 'DEFINITIONS ONLY'}]`).join('\n')
                : "No project files loaded into memory yet.";

            // --- IMPORTED DISCUSSION DATA (PDFs/Web) ---
            const attachments = this.currentDiscussion?.messages
                .filter(m => (m as any).attachmentData)
                .map(m => (m as any).attachmentData.name) || [];

            const discussionFilesBlock = attachments.length > 0 
                ? `\n### 📚 IMPORTED DISCUSSION DATA (ATTACHMENTS)\n` + 
                  attachments.map(name => `- ${name} (Use 'read_discussion_file' to see content)`).join('\n')
                : "";

            const historyContext = `
            ### 📦 ACTIVE CONTEXT INVENTORY
            ${inventory}
            ${discussionFilesBlock}
            **STRICT RULE**: Do NOT use 'read_file' or 'read_files' for anything listed above. Use the provided content directly.

            ### 🕒 MISSION TIMELINE (EXECUTED ACTIONS)
            ${this.completedActionsHistory.length > 0 ? this.completedActionsHistory.slice(-12).join('\n\n') : "No actions taken yet."}

            **Current Status**: You have completed ${this.completedActionsHistory.length} steps. 
**Constraint**: Review the 'AUDIT REPORT' in the last observation. You MUST update your internal scratchpad or project memory with any significant technical discoveries or architectural fixes before proceeding.

### 🛑 REFLEXIVE MEMORY (MISTAKES TO AVOID)
${this.failureMemory.getMemoryContext()}

### 🛠️ CURRENT WORLD STATE (PROJECT STRUCTURE)
${contextData.projectTree}

### 📄 ACCESSIBLE FILE CONTENTS
${contextData.selectedFilesContent || "(No files read into context yet)"}
`;

            // --- ANTI-HALLUCINATION GUARD ---
            // If the tree shows files but no content is loaded, explicitly nudge the agent
            const structuralNudge = (contextData.projectTree.includes('├──') || contextData.projectTree.includes('└──')) && !contextData.selectedFilesContent
                ? "\n**⚠️ LIBRARIAN NOTICE**: The Project Tree above lists all files. Stop using 'search_files' with complex regex. Look at the tree, find the exact paths that match the user's request, and use 'add_files' immediately."
                : "";

            // --- MISSION BUDGET AWARENESS ---
            const remainingSteps = maxSteps - stepCount;
            let budgetBlock = `### ⏳ MISSION BUDGET\n- **Current Step**: ${stepCount} of ${maxSteps}\n- **Remaining Turns**: ${remainingSteps}\n`;
            
            if (remainingSteps <= 3) {
                budgetBlock += `\n**🚨 CRITICAL WARNING: LOW BUDGET**\nYou are about to run out of turns. You are FORBIDDEN from starting new deep research, long tests, or complex refactors. You MUST use your remaining turns to:\n1. Wrap up your current work safely.\n2. Use the \`submit_response\` tool to explain to the user what you accomplished and what remains to be done before you are forcefully terminated.\n`;
            }

            // --- VISION STACK ASSEMBLY ---
            const visionParts: any[] = [];
            // 1. Add Textual Context
            visionParts.push({ type: 'text', text: `${historyContext}${structuralNudge}\n\n${budgetBlock}\n\n**OBJECTIVE:** ${objective}\n\nWhat is your next technical action? Output JSON only.` });

            // Helper to ensure image data is a valid Data URI
            const ensureDataUri = (data: string) => {
                if (!data) return "";
                if (data.startsWith('data:') || data.startsWith('http')) return data;
                // Default to png if prefix is missing
                return `data:image/png;base64,${data}`;
            };

            // 2. Add Project Images (Librarian/Context)
            contextData.images.forEach(img => {
                const safeUrl = ensureDataUri(img.data);
                if (safeUrl) {
                    visionParts.push({ type: 'image_url', image_url: { url: safeUrl } });
                }
            });

            // 3. Add Discussion Images (History)
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

            const messages: ChatMessage[] =[
                systemPrompt,
                ...this.chatHistory,
                ...extraHistory,
                { role: 'user', content: visionParts }
            ];

            let task: Task | null = null;
            const lastTask = this.currentPlan!.tasks.length > 0 ? this.currentPlan!.tasks[this.currentPlan!.tasks.length - 1] : null;

            if (lastTask && lastTask.status === 'pending' && (lastTask as any).needsApproval === false) {
                // Task was approved manually by the user. Skip LLM generation.
                task = lastTask;
                this.processManager?.updateDescription(processId, `Genie: Executing approved task...`);
                this.ui.updateGeneratingState();
            } else {
                // 3. Ask Genie for the next action
                let fullResponse = "";
                const response = await this.lollmsApi.sendChat(messages, (chunk) => {
                    fullResponse += chunk;
                    if (this.currentPlan) {
                        // Update internal state only. DO NOT call displayAndSavePlan here.
                        // This prevents the high-frequency UI blinking.
                        this.currentPlan.scratchpad = fullResponse;
                    }
                }, signal, model);

                const cleanResponse = stripThinkingTags(response);

                // --- AUTO-COMPRESSION CHECK ---
                if (this.currentPlan!.observations && this.currentPlan!.observations.length > 15) {
                    this.processManager?.updateDescription(processId, `Genie: Compressing memories...`);
                    await this.condenseObservations(model || "default", signal);
                }

                const toolCall = this.planParser.extractJson(cleanResponse);
                if (!toolCall) {
                    // If no JSON tool is found, check if it's a "Coding Mode" response (contains code blocks)
                    if (cleanResponse.includes('```')) {
                        this.processManager?.updateDescription(processId, `Genie: Extracting and applying code...`);

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

                        // --- PRE-WRITE SANITIZATION ---
                        await (this.ui as any).executeAutomationPipeline(cleanResponse, `agent_step_${stepCount}`, signal, processId);

                        codingTask.status = 'completed';
                        codingTask.result = "Code extracted and applied.";
                        this.completedActionsHistory.push(`[STEP ${codingTask.id}] COMPLETED: Applied code changes via Markdown Coding Mode.`);

                        await this.displayAndSavePlan(this.currentPlan);
                        continue;
                    }

                    // Conversational fallback
                    if (cleanResponse.length < 1000) {
                        this.ui.addMessageToDiscussion({ role: 'assistant', content: cleanResponse, model });
                        break; 
                    }
                    continue; 
                }

                let action;
                try {
                    action = JSON.parse(toolCall);
                    if (stepCount === 1 && action.milestones) {
                        this.currentPlan.milestones = action.milestones.map((m: any) => ({ label: m, status: 'pending' }));
                    }
                } catch (jsonErr: any) {
                    this.completedActionsHistory.push(`[SYSTEM ERROR] Malformed JSON.`);
                    continue;
                }
                
                // 4. Update UI Timeline (Incremental)
                if (action.new_remark) {
                    if (!this.currentPlan.observations) this.currentPlan.observations =[];
                    this.currentPlan.observations.push(action.new_remark);
                }
                if (action.current_sub_goal) {
                    this.currentPlan.current_sub_goal = action.current_sub_goal;
                }

                task = {
                    id: stepCount,
                    task_type: 'simple_action',
                    description: action.thought || action.new_remark || "Executing tool...",
                    action: action.tool,
                    parameters: action.params || {},
                    status: 'in_progress',
                    result: null,
                    retries: 0
                };

                this.currentPlan!.tasks.push(task);
                await this.displayAndSavePlan(this.currentPlan);
            }

            // 5. Execute Action
            this.processManager?.updateDescription(processId, `Genie: Executing ${task.action}...`);
            this.ui.updateGeneratingState();

            if (task.action === 'submit_response') {
                task.status = 'completed';
                task.result = "Response submitted to chat.";
                await this.displayAndSavePlan(this.currentPlan);

                const reflectionPrompt = this.failureMemory.getReflectionPrompt(task.action, task.parameters);
                if (reflectionPrompt && this.projectMemoryManager) {
                    const evolutionResponse = await this.lollmsApi.sendChat([
                        { role: 'system', content: "You are the Genie's Reflexive Memory. Analyze the success and update Project Memory." },
                        { role: 'user', content: reflectionPrompt }
                    ], null, signal, model);
                    await this.projectMemoryManager.processTags(evolutionResponse);
                }

                await this.ui.addMessageToDiscussion({
                    id: `agent_final_${Date.now()}`,
                    role: 'assistant',
                    content: task.parameters.response,
                    model: model
                });
                break;
            }

            // --- GRANULAR SECURITY POLICY ENFORCEMENT ---
            const toolPolicies = this.currentDiscussion?.capabilities?.toolPolicies || {};
            const toolDef = this.toolManager.getTool(task.action);

            const sensitiveGroups = ['shell_execution', 'filesystem_write'];
            const isSensitive = toolDef?.permissionGroup && sensitiveGroups.includes(toolDef.permissionGroup);

            const specificPolicy = toolPolicies[task.action] || (isSensitive ? 'manual' : 'autonomous');

            // Block ONLY IF it hasn't just been approved
            if (specificPolicy === 'manual' && (task as any).needsApproval !== false) {
                task.status = 'pending'; 
                (task as any).needsApproval = true;
                this.ui.addMessageToDiscussion({ 
                    role: 'system', 
                    content: `🛡️ **Safety Gate:** The Architect wants to use \`${task.action}\`. Please review the parameters in the sidebar and click **Run Task & Continue** to allow this specific action.` 
                });
                await this.displayAndSavePlan(this.currentPlan);
                this.isActive = false; // Halt autonomic loop
                this.ui.updateAgentMode(false);
                break; // Stop here and wait for UI event
            }
            
            task.status = 'in_progress';
            (task as any).needsApproval = false; // Reset for next potential run
            await this.displayAndSavePlan(this.currentPlan);

            // --- WRAP EXECUTION IN TIMEOUT ---
            const resultPromise = this.runSingleTask(task, signal, model);
            const timeoutPromise = new Promise<{success: boolean, output: string}>((_, reject) => 
                setTimeout(() => reject(new Error("EXECUTION_TIMEOUT")), 905000)
            );

            let result;
            try {
                result = await Promise.race([resultPromise, timeoutPromise]);

                // --- AUTOMATED EDIT REPAIR LOOP ---
                const isEditAction = ['edit_code', 'generate_code', 'markdown_coding'].includes(task.action);
                if (!result.success && isEditAction) {
                    const editBudget = config.get<number>('agent.maxEditRetries') || 3;
                    const currentRetries = this.taskEditRetries.get(task.id) || 0;

                    if (currentRetries < editBudget) {
                        this.taskEditRetries.set(task.id, currentRetries + 1);
                        // Log to timeline only to keep chat clean
                        this.completedActionsHistory.push(`[REPAIR ATTEMPT ${currentRetries + 1}] Target: ${task.parameters.file_path || 'unknown'}. Error: ${result.output}`);

                        // We remove the failed task from the list so the agent re-proposes it in the next loop iteration
                        this.currentPlan!.tasks.pop(); 
                        continue; // Re-run reasoning with failure in context
                    }
                }
            } catch (e: any) {
                task.status = 'failed';
                task.result = e.message === "EXECUTION_TIMEOUT" ? "Hanging Error: The terminal did not return a result within the expected time." : e.message;
                await this.displayAndSavePlan(this.currentPlan);
                this.isActive = false;
                this.ui.updateAgentMode(false);
                return; // Stop the loop and let user see the RED card
            }

            // --- 🛡️ CONTEXT GOVERNANCE (NEW) ---
            // After every action, check if we are approaching the context limit
            const currentData = await this.contextManager.getContextContent({ modelName: model, signal });
            const tokenInfo = await this.lollmsApi.tokenize(currentData.text, model);
            const limitInfo = await this.lollmsApi.getContextSize(model);

            const usageRatio = tokenInfo.count / limitInfo.context_size;
            if (usageRatio > 0.85) {
                const pruneWarning = `[SYSTEM WARNING] Context usage is at ${Math.round(usageRatio * 100)}%. Your next turn may fail due to overflow. You should use 'remove_files' in your next step to eject unnecessary files, or switch to 'signatures' mode for reference files.`;
                this.completedActionsHistory.push(pruneWarning);
                this.ui.addMessageToDiscussion({ role: 'system', content: `⚖️ **Context Governor:** Usage at ${Math.round(usageRatio * 100)}%. Nudging Architect to prune context.` });
            }

            // --- PATIENCE & PERSISTENCE PROTOCOL ---
            // If the agent is monitoring or has background tasks, refuel the turn budget.
            const hasBackgroundTasks = this.sessionState.backgroundProcesses.size > 0;
            const isMonitoring = task.action === 'wait' || 
                               task.action === 'read_output_tail' || 
                               task.action === 'is_process_active';

            if (result.success && (isMonitoring || hasBackgroundTasks) && stepCount > (maxSteps * 0.7)) {
                const bonus = 15;
                maxSteps += bonus; 
                this.ui.addMessageToDiscussion({ 
                    role: 'system', 
                    content: `⏳ **Mission Budget Refueled**: Active background processes detected. Turn limit extended by ${bonus} to allow continued monitoring.` 
                });
            }

            // If the loop detects a terminal success or stop condition
            if (signal.aborted) break;
        }

        if (stepCount >= maxSteps) {
            this.ui.addMessageToDiscussion({ 
                role: 'system', 
                content: `⚠️ **Mission Timeout:** Reached maximum steps (${maxSteps}) without a final response.` 
            });
        }
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

            // LOGIC: If we are already on an isolated branch (from Phase 0), 
            // just perform a quick checkpoint commit. DO NOT try to stash or re-branch.
            if (isAiBranch) {
                Logger.info(`[GitBackup] Already on isolated branch: ${currentBranch}. Creating checkpoint.`);
                try {
                    await this.gitIntegration.stageAllAndCommit(`Checkpoint: ${reason}`, this.currentWorkspaceFolder);
                } catch (commitErr) {
                    // Ignore "nothing to commit" errors during checkpoints
                    Logger.debug(`[GitBackup] Checkpoint skipped: nothing to commit.`);
                }
                return;
            }

            // FALLBACK: If for some reason we aren't on an AI branch but edit is requested
            const config = vscode.workspace.getConfiguration('lollmsVsCoder');
            if (config.get<boolean>('agent.createBranchOnEdit') === false) {
                 await this.gitIntegration.stageAllAndCommit(`Auto-backup: ${reason}`, this.currentWorkspaceFolder);
                 return;
            }

            // Create new branch only if strictly necessary (usually handled by Phase 0)
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
        task.status = 'pending'; // Leave it as pending so runAutonomousLoop picks it up
        await this.displayAndSavePlan(this.currentPlan);

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
        
        await this.displayAndSavePlan(this.currentPlan);

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
            await this.displayAndSavePlan(this.currentPlan);

            const msg = `Manual Override: User re-ran ${task.action} with ${JSON.stringify(newParams)}.\nResult:\n${res.output}\nPlease continue your autonomous loop based on this new result.`;
            await this.runAutonomousLoop(this.currentPlan.objective + `\n${msg}`, controller.signal, processId, this.currentDiscussion.model, [{ role: 'user', content: msg }]);

        } catch (e: any) {
            task.status = 'failed';
            task.result = e.message;
            await this.displayAndSavePlan(this.currentPlan);
        } finally {
            this.processManager.unregister(processId);
            this.ui.updateGeneratingState();
        }
    }

    private async synthesizeFinalResponse(originalObjective: string, signal: AbortSignal, modelOverride?: string) {
        if (signal.aborted || !this.currentPlan || !this.currentDiscussion) return;

        // Don't synthesize if there are still pending tasks (meaning it was stopped/deadlocked)
        const pendingTasks = this.currentPlan.tasks.filter(t => t.status === 'pending' || t.status === 'in_progress');
        if (pendingTasks.length > 0) return;

        // Only synthesize if we actually executed something
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
            
            // Scan the final summary for memory updates
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
            this.displayAndSavePlan(this.currentPlan);
            
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

        // Reset leftover in_progress tasks back to pending if we are resuming an interrupted plan
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
                break; // Everything is finished
            }

            const availableTasks = pendingTasks.filter(t => {
                if (!t.dependencies || t.dependencies.length === 0) {
                    // Backwards compatibility check: If NO task in the entire plan uses dependencies, 
                    // enforce strictly sequential execution to avoid breaking older weak models.
                    const hasAnyDeps = this.currentPlan!.tasks.some(x => x.dependencies && x.dependencies.length > 0);
                    if (!hasAnyDeps) {
                        return t.id === pendingTasks[0].id;
                    }
                    return true; // Explicitly empty array means run immediately in parallel
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
                this.displayAndSavePlan(this.currentPlan);
                
                startedNewTask = true;
                
                const taskPromise = this.runSingleTask(task, signal, modelOverride).then(async (result) => {
                    activePromises = activePromises.filter(p => p !== taskPromise);
                    
                    if (!result.success) {
                        planAborted = true; // Prevent new tasks from launching
                        
                        // Await running siblings to gracefully finish
                        if (activePromises.length > 0) {
                            await Promise.all(activePromises);
                        }
                        
                        // We are now alone. Let's decide how to handle the failure.
                        if (task.retries < maxRetries) {
                            this.ui.addMessageToDiscussion({ 
                                role: 'system', 
                                content: `⚠️ **Task ${task.id} Failed.** Lead Architect is revising the strategy...`,
                                skipInPrompt: true 
                            });

                            const revisionSucceeded = await this.revisePlanForFailure(task, signal, architectModel);
                            if (revisionSucceeded) {
                                planAborted = false; // Unblock to resume the loop with the newly generated plan
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
                // Wait for at least one active task to finish before evaluating the while loop again
                await Promise.race(activePromises);
            }
        }
    }

    private async runSingleTask(task: Task, signal: AbortSignal, modelOverride?: string): Promise<{ success: boolean, output: string }> {
        if (!this.currentPlan) return { success: false, output: "" };
        const specialistModel = task.model || modelOverride || this.currentDiscussion?.model;
        
        if (['generate_code', 'delete_file', 'move_file'].includes(task.action)) {
            await this.performGitBackup(`Checkpoint: Task ${task.id} - ${task.description}`);
        }

        let result: { success: boolean; output: string; } = { success: false, output: "" };
        let resolvedParams: any = {};

        try {
            resolvedParams = this.resolveParameters(task);
            task.parameters = resolvedParams; 
            await this.displayAndSavePlan(this.currentPlan); 

            // --- SECURE CREDENTIAL INJECTION ---
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

            // --- REPETITION & LOOP DETECTION ---
            const includedFiles = this.contextManager.getContextStateProvider()?.getIncludedFiles() || [];
            let redundantPath = "";

            if (task.action === 'read_file') {
                const checkPath = (resolvedParams.path || resolvedParams.file || "").replace(/\\/g, '/');
                // BYPASS: If the file has been modified in this session, allow the read to verify results
                if (!this.sessionState.unverifiedFiles.has(checkPath)) {
                    if (includedFiles.some(f => f.path === checkPath && f.state === 'included')) {
                        redundantPath = checkPath;
                    }
                }
            } else if (task.action === 'read_files') {
                const paths = (resolvedParams.paths || []).map((p: string) => p.replace(/\\/g, '/'));
                for (const p of paths) {
                    // BYPASS: Only block if the file is NOT dirty
                    if (!this.sessionState.unverifiedFiles.has(p)) {
                        if (includedFiles.some(f => f.path === p && f.state === 'included')) {
                            redundantPath = p;
                            break;
                        }
                    }
                }
            }

            const pastTasks = this.currentPlan.tasks.filter(t => t.id !== task.id && (t.status === 'completed' || t.status === 'failed'));

            // --- 🛡️ REDUNDANCY HARNESS ---
            const recentTasks = pastTasks.slice(-10);
            let redundantSuccess = recentTasks.find(t => 
                t.status === 'completed' && 
                t.action === task.action && 
                JSON.stringify(t.parameters) === JSON.stringify(resolvedParams)
            );

            // --- STATE-AWARE INVALIDATION ---
            // 1. Explicit Bypass: If the agent is reading a file it recently modified, it's NOT redundant.
            if (redundantSuccess && (task.action === 'read_file' || task.action === 'read_files')) {
                const checkPath = (resolvedParams.path || resolvedParams.file || (resolvedParams.paths && resolvedParams.paths[0]) || "").replace(/\\/g, '/');
                if (this.sessionState.unverifiedFiles.has(checkPath)) {
                    Logger.info(`[Harness] Redundancy bypassed for Task ${task.id}: Reading dirty file ${checkPath} for verification.`);
                    redundantSuccess = undefined;
                }
            }

            // 2. Chronological Invalidation: Check if any "Write" actions happened in between.
            if (redundantSuccess) {
                const intermediateTasks = pastTasks.filter(t => t.id > redundantSuccess!.id);
                const filesystemModified = intermediateTasks.some(t => 
                    ['edit_code', 'generate_code', 'replaceCode', 'applyFileContent', 'delete_file', 'move_file', 'markdown_coding'].includes(t.action)
                );

                if (filesystemModified) {
                    Logger.info(`[Harness] Redundancy ignored for Task ${task.id}: Filesystem was modified since Task ${redundantSuccess.id}.`);
                    redundantSuccess = undefined; // Force re-execution
                }
            }

            // Stuck in a rut detector (high failure rate on same tool consecutively)
            const recentFailures = pastTasks.slice(-3).filter(t => t.status === 'failed');
            const isStuck = recentFailures.length >= 3 && recentFailures.every(t => t.action === task.action);

            // --- 🛡️ VERIFICATION ENFORCEMENT PROTOCOL ---
            const isWriteAction = ['edit_code', 'generate_code', 'replaceCode', 'applyFileContent', 'markdown_coding'].includes(task.action);
            const isVerifyAction = ['execute_command', 'run_file', 'execute_python_script', 'run_tests_and_fix', 'test_web_page', 'secure_run'].includes(task.action);
            const targetFile = resolvedParams.file_path || resolvedParams.path || "";

            // --- SURGICAL ENFORCEMENT GUARD ---
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

            // --- SURGICAL ENFORCEMENT GUARD ---
            if (task.action === 'generate_code' && resolvedParams.file_path) {
                const normalizedPath = resolvedParams.file_path.replace(/\\/g, '/');
                const fileExists = includedFiles.some(f => f.path === normalizedPath);

                if (fileExists) {
                    result = {
                        success: false,
                        output: `🛑 RESOURCE VIOLATION: You are attempting to use 'generate_code' to rewrite \`${resolvedParams.file_path}\`, but this file already exists in the tree. 

                        STRICT PROTOCOL:
                        1. You MUST use 'edit_code' with SEARCH/REPLACE blocks for existing files.
                        2. Rewriting a full file is a waste of context and dangerous.
                        3. Switch to 'edit_code' now.`
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
            } else if (this.failureMemory.hasFailedBefore(task.action, resolvedParams)) {
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
                    output: `🛑 SYSTEM OVERRIDE: You have failed to use the '${task.action}' tool successfully 3 times in a row. You are stuck in a loop. You MUST step back, use 'read_file' to gather more context, use 'execute_command' to run a diagnostic, or ask the user for help using 'submit_response'. DO NOT use '${task.action}' again this turn.`
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
                // Snapshot state BEFORE
                const varsBefore = JSON.stringify(this.sessionState.replVariables);
                const memBefore = this.sessionState.workingMemory.length;

                result = await this.executeTask(task.action, secureParams, signal, undefined, specialistModel, task.agent_persona, task.agent_skills, task.agent_files);

                // --- PROACTIVE ERROR TRIAGE ---
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
                                    // Remove local file paths to make the query generic for the web
                                    const genericQuery = errorLine.replace(/[A-Za-z]:\\[^\s]+|\/[^\s]+/g, '').substring(0, 150);
                                    const searchRes = await searchTool.execute({ query: genericQuery }, tempEnv, signal);
                                    if (searchRes.success && !searchRes.output.includes('No results found') && !searchRes.output.includes('No relevant')) {
                                        result.output += `\n\n--- 🌐 PROACTIVE WEB RESEARCH ---\nI automatically searched the web for this error. Here are potential clues:\n${searchRes.output.substring(0, 1500)}`;
                                        this.completedActionsHistory.push(`[PROACTIVE RESEARCH] Automatically searched for error: "${genericQuery}"`);
                                    }
                                }
                            } catch (e) {
                                // Ignore search errors to not override the original execution error
                            }
                        }
                    }
                }
                // --- END PROACTIVE ERROR TRIAGE ---

                // Calculate Delta AFTER
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

                // --- SANITIZE OUTPUT (Hide real values) ---
                if (Object.keys(credentials).length > 0 && result.output) {
                    for (const [secId, secVal] of Object.entries(credentials)) {
                        if (secVal && secVal.length > 2) { // Only sanitize meaningful secrets
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
        task.status = result.success ? 'completed' : 'failed';

        // --- STATE UPDATE: VERIFICATION TRACKING ---
        if (result.success) {
            const isWriteAction = ['edit_code', 'generate_code', 'replaceCode', 'applyFileContent', 'markdown_coding'].includes(task.action);
            const isVerifyAction = ['execute_command', 'run_file', 'execute_python_script', 'run_tests_and_fix', 'test_web_page', 'secure_run'].includes(task.action);

            if (isWriteAction) {
                const targetFile = resolvedParams.file_path || resolvedParams.path;
                if (targetFile) this.sessionState.unverifiedFiles.add(targetFile);
            }

            if (isVerifyAction) {
                // If a test/execution runs, we assume the agent is checking all dirty files
                this.sessionState.unverifiedFiles.clear();
                this.completedActionsHistory.push(`[SYSTEM] All file modifications marked as 'Verified' by execution of \`${task.action}\`.`);
            }
        }

        // --- STRIP REDUNDANT PREAMBLES FROM LOGGING ---
        // If the LLM still generates a preamble, we trim it for the prompt history 
        // to prevent the "Summary Snowball" effect.
        let conciseThought = task.description;
        const objectiveStart = this.currentPlan?.objective.substring(0, 30);
        if (objectiveStart && conciseThought.includes(objectiveStart)) {
            const parts = conciseThought.split(/now I need to|therefore,|next step is/i);
            if (parts.length > 1) conciseThought = "Decision: " + parts[parts.length - 1].trim();
        }
        
        // 📊 DASHBOARD UPDATE
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

        // 📊 STRUCTURED TIMELINE
        // Optimization: Provide a larger observation window (3000 chars) 
        // but explicitly label it so the agent understands it's a preview.
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
            // --- DELTA DETECTION & MILESTONE ENFORCEMENT ---
            const isImplementationSuccess = ['edit_code', 'generate_code', 'replaceCode', 'markdown_coding'].includes(task.action);
            if (isImplementationSuccess && result.output.includes("Successfully")) {
                this.completedActionsHistory.push(`[MANDATE] PROGRESS DETECTED: You just modified the codebase. You MUST now use 'record_milestone' or update '<project_memory>' to document this fix before moving to the next file.`);
            }

            // --- EVOLVING INTELLIGENCE: ARTIFACT GENERATION ---
            const isCodeEdit = ['edit_code', 'generate_code', 'markdown_coding'].includes(task.action);
            const reflectionPrompt = this.failureMemory.getReflectionPrompt(task.action, resolvedParams);

            // --- MEMORY POLLUTION GUARD ---
            // Check current memory weight before allowing the Historian to add more "Lessons"
            const currentMemories = await this.projectMemoryManager.getMemories();
            const workingMemTokens = currentMemories
                .filter((m: any) => m.importance >= 25)
                .reduce((acc: number, m: any) => acc + (m.content.length / 4), 0);

            const limit = (await this.lollmsApi.getContextSize()).context_size;
            const isMemoryFull = (workingMemTokens / limit) > 0.15; // Cap lessons at 15% of context

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

                    // Process tags so they appear in the UI and persistent storage
                    if (this.projectMemoryManager) {
                        await this.projectMemoryManager.processTags(artifactResponse);
                    }

                    // ATTACH TO TASK INSTEAD OF CHAT
                    if (!task.artifacts) task.artifacts = [];
                    task.artifacts.push(artifactResponse);
                } catch (e) {
                    Logger.error("Artifact generation failed", e);
                }
            }
        }
        
        // Scan task output (or evolution response) for memory updates
        if (this.projectMemoryManager) {
            await this.projectMemoryManager.processTags(result.output);
        }

        await this.displayAndSavePlan(this.currentPlan);
        return result;
    }

    private async handleTaskFailureUserChoice(task: Task) {
        if (!this.currentPlan) return;
        task.can_retry = true;
        await this.displayAndSavePlan(this.currentPlan);

        const userChoice = await vscode.window.showErrorMessage(
            `Task "${task.description}" failed.`,
            { modal: true },
            'Stop', 'Continue Anyway', 'View Log'
        );

        if (userChoice === 'View Log') {
            InfoPanel.createOrShow(this.extensionUri, `Task ${task.id} Log`, `## Result\n${task.result}`);
        }
        if (userChoice === 'Continue Anyway') {
            task.status = 'completed'; // Force completion so pipeline continues
            await this.displayAndSavePlan(this.currentPlan);
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
        
        // "None" selected case
        if (this.currentDiscussion.capabilities.selectedFolders.includes('__none__')) {
            if (filePath.startsWith('.lollms/sandbox')) return { allowed: true };
            return { allowed: false, message: "Permission Denied: Discussion is in Sandbox mode. AI can only access .lollms/sandbox." };
        }

        const normalizedPath = path.resolve(this.currentWorkspaceFolder!.uri.fsPath, filePath);
        const allowedRoots = (vscode.workspace.workspaceFolders || [])
            .filter(f => this.currentDiscussion!.capabilities!.selectedFolders!.includes(f.uri.toString()))
            .map(f => f.uri.fsPath);

        const isAllowed = allowedRoots.some(root => normalizedPath.startsWith(root));
        return isAllowed 
            ? { allowed: true } 
            : { allowed: false, message: `Permission Denied: Access to ${filePath} is outside the selected workspace scope.` };
    }

    private checkGlobalPermission(tool: ToolDefinition, params?: any): { allowed: boolean, message?: string } {
        // 1. Check Project-Level Whitelist
        if (params?.path || params?.file_path || params?.source || params?.destination) {
            const pathsToCheck = [params.path, params.file_path, params.source, params.destination].filter(Boolean);
            for (const p of pathsToCheck) {
                const boundaryCheck = this.checkProjectBoundary(p);
                if (!boundaryCheck.allowed) return boundaryCheck;
            }
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
    private async executeTask(action: string, params: any, signal: AbortSignal, overrideEnv?: ToolExecutionEnv, taskModel?: string, taskPersona?: string, taskSkills?: string[], taskFiles?: string[]): Promise<{ success: boolean, output: string }> {
        const tool = this.toolManager.getTool(action);
        if (!tool) return { success: false, output: `Unknown action: ${action}` };

        const perm = this.checkGlobalPermission(tool, params);
        if (!perm.allowed) {
            return { success: false, output: perm.message || "Permission denied." };
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
            taskModel: taskModel,
            taskPersona: taskPersona,
            taskSkills: taskSkills,
            taskFiles: taskFiles
        };
        
        try {
            return await tool.execute(params, env, signal);
        } catch (error: any) {
            console.error(`[Tool Failure] ${action}:`, error);
            Logger.error(`Tool '${action}' crashed with exception:`, error);

            if (error.message && (error.message.includes('EACCES') || error.message.includes('permission denied'))) {
                return { success: false, output: `❌ **OS Permission Error.**\nRaw Error: ${error.message}` };
            }
            throw error;
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
        this.displayAndSavePlan(this.currentPlan);

        // PASS THE COMPLETED ACTIONS HISTORY TO PLAN PARSER
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
            this.completedActionsHistory // <--- KEY CHANGE
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
        this.displayAndSavePlan(this.currentPlan);
        return true;
    }
    
    // ... (formatValueForDisplay, resolveParameters - kept same) ...
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
        this.displayAndSavePlan(this.currentPlan);
        
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const plannerModel = config.get<string>('architectModelName') || modelOverride;
        const failureContext = this.failureMemory.getMemoryContext();
        const augmentedInstruction = `${instruction}\n\n${failureContext}\n\nSTRICT REQUIREMENT: The previous errors prove your current approach is blocked. YOU MUST CHANGE TOOLS OR LOGIC.`;

        try {
            // PASS THE COMPLETED ACTIONS HISTORY
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
                this.completedActionsHistory // <--- KEY CHANGE
            );

            if (!planResult.plan) return { success: false, output: "Failed to generate new plan." };

            // Remove all currently pending tasks, we will replace them with the Architect's new plan
            this.currentPlan.tasks = this.currentPlan.tasks.filter(t => t.status !== 'pending');

            let nextId = this.currentPlan.tasks.length > 0 ? Math.max(...this.currentPlan.tasks.map(t => t.id)) + 1 : 1;
            const minGeneratedId = Math.min(...planResult.plan.tasks.map(t => t.id));
            const idOffset = nextId - minGeneratedId;

            for (const newTask of planResult.plan.tasks) {
                // Keep dependency references intact internally for the newly generated tasks
                newTask.id += idOffset;
                if (newTask.dependencies) {
                    newTask.dependencies = newTask.dependencies.map(d => d + idOffset);
                }

                newTask.status = 'pending';
                this.currentPlan.tasks.push(newTask);
            }

            planResult.plan.investigation = this.currentPlan.investigation;

            this.displayAndSavePlan(this.currentPlan);
            return { success: true, output: "Plan modified successfully." };

        } catch (error: any) {
            return { success: false, output: `Error: ${error.message}` };
        }
    }
    
    // ... (generateFileTree, runCommand, requestUserInput, deactivateAgent - kept same) ...
    /**
     * Generates a safe, truncated file tree for the AI.
     * Respects user exclusions and prevents recursion into heavy dependency folders.
     */
    public async generateFileTree(startPath: string, prefix: string = ''): Promise<string> {
        let result = '';
        let entries;

        // Define folders that are visible but MUST NOT be traversed recursively
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

            // 1. BLOCK: Check if user has excluded this file/folder from the tree
            if (provider && provider.isStrictlyIgnored(uri)) {
                continue; 
            }

            if (entry.isDirectory()) {
                // 2. TRUNCATE: If it's a heavy folder, show it exists but don't descend
                if (TRUNCATE_FOLDERS.includes(entry.name.toLowerCase())) {
                    result += `${prefix}${connector}${entry.name}/ ... (contents truncated, use specialized tools to inspect)\n`;
                } else {
                    // Standard recursion for safe project folders
                    result += `${prefix}${connector}${entry.name}/\n`;
                    result += await this.generateFileTree(fullPath, prefix + (isLast ? '    ' : '│   '));
                }
            } else {
                result += `${prefix}${connector}${entry.name}\n`;
            }
        }
        return result;
    }

    public async runCommand(command: string, signal: AbortSignal, options?: { shell?: any, timeoutMs?: number }): Promise<{ success: boolean, output: string }> {
        if (!this.currentWorkspaceFolder) return { success: false, output: "No workspace." };
        
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const activationScript = config.get<string>('agent.envActivationScript');
        let finalCommand = command;
        const isWin = process.platform === 'win32';

        // --- MSVC / GLOBAL ENV ACTIVATION ---
        if (activationScript) {
            if (isWin) {
                finalCommand = `cmd /c "${activationScript} && ${command}"`;
            } else {
                finalCommand = `source ${activationScript} && ${command}`;
            }
        }

        // --- VIRTUAL ENV ACTIVATION ---
        if (this.sessionState.activeEnv && (command.startsWith('python') || command.startsWith('pip'))) {
            const envPath = this.sessionState.activeEnv;
            if (isWin) {
                finalCommand = `& "${path.join(envPath, 'Scripts', 'Activate.ps1')}"; ${finalCommand}`;
            } else {
                finalCommand = `. "${path.join(envPath, 'bin', 'activate')}" && ${finalCommand}`;
            }
        }
        
        // Use a descriptive task name so the user sees what is running in the status bar/terminal tab
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

    /**
     * The Debugging Orchestrator:
     * Phase 1: Mandatory Librarian Grounding (Independent)
     * Phase 2: Architect fixes code based on grounded context.
     */
    public async runDebuggingOrchestrator(
        objective: string, 
        signal: AbortSignal
    ): Promise<string> {
        if (!this.currentWorkspaceFolder || !this.currentDiscussion || !this.processManager) {
            throw new Error("Debugger context missing (workspace or discussion).");
        }
        const processId = this.processManager.getForDiscussion(this.currentDiscussion.id)?.id || "orchestrator";

        // 0. Cleanup
        this.displayAndSavePlan(null);

        // 1. Setup Sandbox
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
            
            // Unregister immediately to stop the UI overlay
            this.processManager.unregister(processId);
            this.ui.updateGeneratingState();
            return "Workspace dirty";
        }
        const debugBranch = `debug/sandbox-${Date.now()}`;
        await this.gitIntegration.createAndCheckoutBranch(this.currentWorkspaceFolder, debugBranch);
        this.ui.addMessageToDiscussion({ role: 'system', content: `**🛰️ Orchestrator**\n*Sandbox Ready: Switched to branch \`${debugBranch}\`.*` });

        // 2. Step 1: Worker Drafting (Grounded in context)
        this.processManager.updateDescription(processId, "Phase 1: Worker drafting solution...");
        this.ui.updateGeneratingState();
        
        const model = this.currentDiscussion.model || this.lollmsApi.getModelName();
        
        // Fetch current context so the worker can actually see the code
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

        // 3. Step 2: Verifier Audit (Guardian)
        this.processManager.updateDescription(processId, "Phase 2: Verifier auditing logic...");
        this.ui.updateGeneratingState();
        // Ensure the call matches the implementation added to ChatPanel
        const auditedResponse = await this.ui.runVerificationAgent(workerResponse, signal);

        // 4. Step 3: Apply to Disk (Guardian Shield Enabled)
        this.processManager.updateDescription(processId, "Phase 2: Applying fixes & verifying integrity...");
        this.ui.updateGeneratingState();
        
        const workerMsgId = 'worker_final_' + Date.now();
        await this.ui.addMessageToDiscussion({
            id: workerMsgId,
            role: 'assistant',
            content: auditedResponse,
            model: model
        });

        // executeAutomationPipeline now internally runs the "Guardian" repair loop
        await this.ui.executeAutomationPipeline(auditedResponse, workerMsgId, signal, processId);

        // 5. Phase 3: Specialized Debugger Loop (Files are now on disk)
        if (this.currentDiscussion.capabilities?.debugMode) {
            this.processManager.updateDescription(processId, "Phase 3: Debugger starting validation...");
            this.ui.updateGeneratingState();
            
            // Re-sync context so Debugger sees the new files
            await this.contextManager.getContextContent({ includeTree: true, modelName: model, signal });

            return await this.runDebuggerAgent(objective, signal);
        }
        
        return "Complete";
    }

    /**
     * Dedicated Debugger Agent Loop: Iterative Fix & Verify
     */
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

        // Maintain internal loop history to prevent amnesia
        const loopHistory: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            ...this.chatHistory.slice(-3) // Keep some recent context
        ];

        let step = 0;
        while (step < maxSteps) {
            if (signal.aborted) break;
            step++;

            // 1. Provide Current State (Disk is truth)
            const currentData = await this.contextManager.getContextContent({ includeTree: true, modelName: model, signal });
            const diskStateMsg: ChatMessage = { 
                role: 'system', 
                content: `[CURRENT DISK STATE]\n${currentData.projectTree}\n${currentData.selectedFilesContent}`, 
                skipInPrompt: true 
            };

            // Prepare prompt for this specific step
            const currentStepPrompt: ChatMessage[] = [
                ...loopHistory,
                diskStateMsg,
                { role: 'user', content: step === 1 ? `Begin the debug mission.` : `Previous tool result received. Analyze and decide next step (Step ${step}/${maxSteps}).` }
            ];

            // 2. Generate Next Action
            const response = await this.lollmsApi.sendChat(currentStepPrompt, null, signal, model);
            loopHistory.push({ role: 'assistant', content: response });

            const cleanResponse = stripThinkingTags(response);
            const toolMatch = this.parseToolCall(cleanResponse);

            if (toolMatch) {
                // 3. Execute Action
                const res = await this.executeTask(toolMatch.name, toolMatch.params, signal);
                
                // Record observation in history
                loopHistory.push({ role: 'user', content: `[OBSERVATION]\n${res.output}` });
                fullDebugHistoryDisplay.push(`**Step ${step}:** \`${toolMatch.name}\`\n${res.output}`);

                // 4. Update UI
                if (this.ui.updateMessageContent) {
                    const logContent = fullDebugHistoryDisplay.map((entry, i) => {
                        const title = entry.split('\n')[0];
                        return `<details><summary>${title}</summary>\n\n${entry}\n\n</details>`;
                    }).join('\n');
                    
                    await this.ui.updateMessageContent(dbgMsgId, `**🧪 Debug Specialist**\n*Objective: "${objective}"*\n\n${logContent}`);
                }

                // 5. If disk was touched, force a context refresh for next loop iteration
                if (['generate_code', 'replaceCode', 'applyFileContent', 'delete_file', 'move_file'].includes(toolMatch.name)) {
                    await this.contextManager.getContextContent({ includeTree: true, modelName: model, signal });
                }
            } else if (cleanResponse.toLowerCase().includes("mission accomplished") || cleanResponse.toLowerCase().includes("verified")) {
                if (this.ui.updateMessageContent) {
                    this.ui.updateMessageContent(dbgMsgId, `**🧪 Debug Specialist**\n\n${cleanResponse}`);
                }
                return "Complete";
            } else {
                loopHistory.push({ role: 'user', content: "No tool call detected. You must use a tool to progress or state 'Mission Accomplished'." });
            }
        }
        
        const finalReport = `🛑 **Debugger Stopped**: Reached maximum iteration limit (${maxSteps} steps) without reaching a verified conclusion.`;
        if (this.ui.updateMessageContent) this.ui.updateMessageContent(dbgMsgId, finalReport);
        return "Max steps reached";
    }

    private async deactivateAgent() {
        this.isActive = false;
        // PRESERVE THE PLAN: Do not wipe plan or session on deactivation
        if (this.currentPlan) {
            this.currentPlan.status = 'stale';
        }
        this.ui.updateAgentMode(false);
    }
    /**
     * Final Verification Agent.
     * Performs a logical audit against the original objective.
     */
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
