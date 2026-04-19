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

// Interface decoupling the UI from the logic
export interface IAgentUI {
    addMessageToDiscussion(message: ChatMessage): Promise<void>;
    updateMessageContent?(messageId: string, newContent: string): Promise<void>;
    displayPlan(plan: Plan | null): void;
    updateGeneratingState(): void;
    requestUserInput(question: string, signal: AbortSignal): Promise<string>;
    updateAgentMode(isActive: boolean): void;
    // New methods to allow the Manager to control the pipeline stages
    runVerificationAgent(content: string, signal: AbortSignal): Promise<string>;
    executeAutomationPipeline(content: string, messageId: string, signal: AbortSignal, processId: string): Promise<void>;
}

export interface UserPermissions {
    canExecute: boolean;
    canRead: boolean;
}

interface Task {
    id: number;
    task_type: 'simple_action' | 'agentic_action';
    action: string;
    description: string;
    parameters: { [key: string]: any };
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    result: string | null;
    save_as?: string; 
    retries: number;
    can_retry?: boolean;
}

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
    private readonly MAX_TASK_REVISIONS = 3;

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
        workingMemory: string[]; // Ephemeral State (current session)
        projectMemory: string[]; // Project State (persists in .lollms)
        secureCredentials?: Record<string, string>;
    } = {
        replVariables: {},
        installedPackages: [],
        environmentHistory: [],
        workingMemory: [],
        secureCredentials: {}
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

        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            this.currentWorkspaceFolder = vscode.workspace.workspaceFolders[0];
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
        const tools = this.toolManager.getEnabledTools();
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
            this.currentPlan = null;
            this.displayAndSavePlan(null);
        }
        this.ui.updateAgentMode(this.isActive);
        // CRITICAL: We NO LONGER call updateGeneratingState() here. 
        // Simply toggling the mode should update badges, but not show the loading overlay.
    }

    private async displayAndSavePlan(plan: Plan | null) {
        this.currentPlan = plan;
        if (this.currentDiscussion && !this.currentDiscussion.id.startsWith('temp-') && !this.currentDiscussion.id.startsWith('remote-')) {
            this.currentDiscussion.plan = plan;
            await this.discussionManager.saveDiscussion(this.currentDiscussion);
        }
        this.ui.displayPlan(plan);
    }

    private archiveCurrentPlanState(reason: string) {
        if (!this.currentPlan) return;
        if (!this.currentPlan.attempts) {
            this.currentPlan.attempts = [];
        }
        const archive: Plan = {
            objective: this.currentPlan.objective,
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
        let isRepo = await this.gitIntegration.isGitRepo(folder);

        if (!isRepo) {
            const formPrompt = `
<lollms_form id="no_git_repo" title="No Git Repository Detected">
  <input type="radio" name="decision" label="Stop" value="stop" checked="true" />
  <input type="radio" name="decision" label="Continue anyway (No automatic rollbacks)" value="continue" />
  <input type="radio" name="decision" label="Create a new repository locally and start" value="init" />
  <submit label="Confirm Action" />
</lollms_form>`.trim();

            const response = await this.ui.requestUserInput(formPrompt, signal);
            let choice = response;

            if (response.startsWith('FORM_SUBMISSION:')) {
                try {
                    const data = JSON.parse(response.substring(16));
                    choice = data.decision;
                } catch(e) {}
            }

            if (choice === 'stop' || (!choice.toLowerCase().includes('continue') && !choice.toLowerCase().includes('init') && !['stop', 'continue', 'init'].includes(choice))) {
                return false;
            } else if (choice === 'init' || choice.toLowerCase().includes('init')) {
                await this.runCommand('git init', signal);
                await this.runCommand('git add .', signal);
                await this.runCommand('git commit -m "Initial commit"', signal);
                this.ui.addMessageToDiscussion({ role: 'system', content: `🛡️ **Git Repository Initialized.**` });
                isRepo = true;
            } else {
                this.ui.addMessageToDiscussion({ role: 'system', content: `⚠️ **Proceeding without Git.** Automatic rollbacks are disabled.` });
                return true;
            }
        }

        if (!isRepo) return true;

        const isClean = await this.gitIntegration.isClean(folder);
        const currentBranch = await this.gitIntegration.getCurrentBranch(folder);
        const isMain = ['main', 'master', 'prod', 'production'].includes(currentBranch.toLowerCase());

        if (!isClean) {
            const formPrompt = `
<lollms_form id="preflight_safety" title="Uncommitted Changes Detected">
  <input type="radio" name="decision" label="Stash changes and create a clean AI branch" value="1" checked="true" />
  <input type="radio" name="decision" label="Commit them now" value="2" />
  <input type="radio" name="decision" label="Proceed anyway (Dangerous)" value="3" />
  <submit label="Confirm Safety Action" />
</lollms_form>`.trim();

            const response = await this.ui.requestUserInput(formPrompt, signal);
            let choice = response;

            if (response.startsWith('FORM_SUBMISSION:')) {
                try {
                    const data = JSON.parse(response.substring(16));
                    choice = data.decision;
                } catch(e) {}
            }
            
            if (choice === '1' || choice.includes('1')) {
                await this.gitIntegration.stash(folder, "Genie: Stashed before mission");
            } else if (choice === '2' || choice.includes('2')) {
                const msg = await this.gitIntegration.generateCommitMessage(folder);
                await this.gitIntegration.commitWithMessage(msg || "Genie: pre-flight backup", folder);
            } else if (!choice.toLowerCase().includes('proceed') && !choice.includes('3')) {
                return false; // Cancelled
            }
        }

        // Automatic Branching for isolation
        if (!currentBranch.startsWith('ai-task-')) {
            const branchName = `ai-task-${Date.now()}`;
            this.ui.addMessageToDiscussion({ role: 'system', content: `🛡️ **Safety Protocol**: Creating isolated branch \`${branchName}\`...` });
            await this.gitIntegration.createAndCheckoutBranch(folder, branchName);
        }

        return true;
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
            this.sessionState.workingMemory = discussion.agentSession.workingMemory || [];
            this.sessionState.secureCredentials = discussion.agentSession.secureCredentials || {};
            this.completedActionsHistory = discussion.agentSession.completedActionsHistory || [];
        }
        
        if (!this.sessionState.secureCredentials) {
            this.sessionState.secureCredentials = {};
        }

        if (!this.currentPlan) {
            this.failureMemory.clear();
            this.consecutiveTaskFailures.clear();
            // We preserve completedActionsHistory so the Architect remembers what was already done
            // in previous turn cycles of this same discussion.
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
            const systemPrompt = await this.planParser.getArchitectSystemPrompt(this.getEnabledTools(), this.currentDiscussion.importedSkills);
            
            const historyContext = `
### 🕒 MISSION TIMELINE (EXECUTED ACTIONS)
${this.completedActionsHistory.length > 0 ? this.completedActionsHistory.slice(-12).join('\n\n') : "No actions taken yet."}

**Current Status**: You have completed ${this.completedActionsHistory.length} steps. 
**Constraint**: Do NOT repeat the reasoning or summaries found above. State only the NEW reasoning for the next step.

### 🛑 REFLEXIVE MEMORY (MISTAKES TO AVOID)
${this.failureMemory.getMemoryContext()}

### 🛠️ CURRENT WORLD STATE (PROJECT STRUCTURE)
${contextData.projectTree}

### 📄 ACCESSIBLE FILE CONTENTS
${contextData.selectedFilesContent || "(No files read into context yet)"}
`;

            const messages: ChatMessage[] = [
                systemPrompt,
                ...this.chatHistory,
                ...extraHistory,
                { role: 'user', content: `${historyContext}\n\n**OBJECTIVE:** ${objective}\n\nWhat is your next technical action? Output JSON only.` }
            ];

            // 3. Ask Genie for the next action
            const response = await this.lollmsApi.sendChat(messages, null, signal, model);
            const cleanResponse = stripThinkingTags(response);
            const toolCall = this.planParser.extractJson(cleanResponse);

            if (!toolCall) {
                // If the Genie just "talked" without a tool, we treat it as a conversational failure or a request for more info.
                if (cleanResponse.length < 500) {
                    this.ui.addMessageToDiscussion({ role: 'assistant', content: cleanResponse, model });
                    break; 
                }
                continue; 
            }

            let action;
            try {
                action = JSON.parse(toolCall);
            } catch (jsonErr: any) {
                // Self-Healing Turn: Nudge the AI to fix the JSON
                this.completedActionsHistory.push(`[SYSTEM ERROR] Your last JSON output was malformed: ${jsonErr.message}. Please repeat your action with valid JSON escaping.`);
                continue;
            }
            
            // 4. Update UI Timeline
            const taskId = stepCount;
            const task: Task = {
                id: taskId,
                description: action.thought || "Executing tool...",
                action: action.tool,
                parameters: action.params || {},
                status: 'in_progress',
                result: null,
                retries: 0
            };
            
            this.currentPlan.tasks.push(task);
            this.currentPlan.scratchpad = action.thought || this.currentPlan.scratchpad;
            await this.displayAndSavePlan(this.currentPlan);

            // 5. Execute Action
            this.processManager?.updateDescription(processId, `Genie: Executing ${action.tool}...`);
            this.ui.updateGeneratingState();

            if (action.tool === 'submit_response') {
                task.status = 'completed';
                task.result = "Response submitted to chat.";
                await this.displayAndSavePlan(this.currentPlan);
                
                // Directly add the agent's response to the discussion
                await this.ui.addMessageToDiscussion({
                    id: `agent_final_${Date.now()}`,
                    role: 'assistant',
                    content: action.params.response,
                    model: model
                });
                break;
            }

            const result = await this.runSingleTask(task, signal, model);
            
            // --- PATIENCE & PERSISTENCE PROTOCOL ---
            // If the agent is explicitly monitoring a long process (like training),
            // and the action was successful, we give it a "bonus turn" to prevent timeout.
            const isMonitoring = task.action === 'wait' || 
                               task.action === 'read_output_tail' || 
                               task.action === 'is_process_active';
                               
            if (result.success && isMonitoring && stepCount > (maxSteps * 0.8)) {
                maxSteps += 10; // "Refuel" the mission length for patience
                this.ui.addMessageToDiscussion({ 
                    role: 'system', 
                    content: `⏳ **Mission Extended**: The Architect is monitoring a live process. Turn limit increased to ${maxSteps}.` 
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

    // Logic updated in main agentManager.ts file implementation

    private parseToolCall(content: string): { name: string, params: any, scratchpad?: string, thought?: string } | null {
        // 1. Try Markdown Code Block
        const match = content.match(/```json\s*(\{[\s\S]*?"tool"[\s\S]*?\})\s*```/);
        if (match) {
            try {
                const obj = JSON.parse(match[1]);
                if (obj.tool) return { name: obj.tool, params: obj.params || {}, scratchpad: obj.scratchpad || obj.thought, thought: obj.thought };
            } catch (e) { }
        }

        // 2. Scan for raw JSON objects
        const jsonObjects: string[] = [];
        let braceCount = 0;
        let startIndex = -1;
        
        for (let i = 0; i < content.length; i++) {
            if (content[i] === '{') {
                if (braceCount === 0) startIndex = i;
                braceCount++;
            } else if (content[i] === '}') {
                braceCount--;
                if (braceCount === 0 && startIndex !== -1) {
                    jsonObjects.push(content.substring(startIndex, i + 1));
                    startIndex = -1;
                }
            }
        }
        
        for (const json of jsonObjects) {
            try {
                const obj = JSON.parse(json);
                if (obj.tool) return { name: obj.tool, params: obj.params || {}, scratchpad: obj.scratchpad || obj.thought, thought: obj.thought };
            } catch (e) { }
        }

        return null;
    }
    
    public async run(initialObjective: string, discussion: Discussion, workspaceFolder: vscode.WorkspaceFolder, modelOverride?: string) {
        await this.handleUserMessage(initialObjective, discussion, workspaceFolder);
    }
    
    private async performGitBackup(reason: string) {
        if (!this.currentWorkspaceFolder) return;
        try {
            const isRepo = await this.gitIntegration.isGitRepo(this.currentWorkspaceFolder);
            if (!isRepo) return;

            const config = vscode.workspace.getConfiguration('lollmsVsCoder');
            if (config.get<boolean>('agent.createBranchOnEdit') === false) {
                 await this.gitIntegration.stageAllAndCommit(`Auto-backup: ${reason}`, this.currentWorkspaceFolder);
                 return;
            }

            const currentBranch = await this.gitIntegration.getCurrentBranch(this.currentWorkspaceFolder);
            
            // If we are already on an ai-generated branch, just commit to save state.
            if (currentBranch.startsWith('ai-task-')) {
                await this.gitIntegration.stageAllAndCommit(`Checkpoint: ${reason}`, this.currentWorkspaceFolder);
                return;
            }

            // Commit pending changes first before branching
            const status = await this.gitIntegration.getGitStatus(this.currentWorkspaceFolder);
            if (status.unstaged.length > 0 || status.untracked.length > 0 || status.staged.length > 0) {
                await this.gitIntegration.stageAllAndCommit(`Auto-backup before AI intervention`, this.currentWorkspaceFolder);
            }

            const branchName = `ai-task-${Date.now()}`;
            await this.gitIntegration.createAndCheckoutBranch(this.currentWorkspaceFolder, branchName);
            
            this.ui.addMessageToDiscussion({ 
                role: 'system', 
                content: `🔒 **Safety Mechanism Triggered:** Created and checked out to branch \`${branchName}\`.\nIf things break, you can safely switch back to \`${currentBranch}\`.` 
            });

            // Update UI Git Status
            if (this.currentDiscussion) {
                this.currentDiscussion.gitState = { originalBranch: currentBranch, tempBranch: branchName };
                await this.discussionManager.saveDiscussion(this.currentDiscussion);
            }

        } catch (e) {
            console.error("Agent Git branching failed", e);
        }
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
            const isRedundantRead = task.action === 'read_file' && 
                                   this.contextManager.getContextStateProvider()?.getIncludedFiles().some(f => f.path === resolvedParams.path);
                                   
            const pastTasks = this.currentPlan.tasks.filter(t => t.id !== task.id && (t.status === 'completed' || t.status === 'failed'));
            
            // Smarter identical check (looks back up to 5 tasks to catch alternating loops)
            const recentTasks = pastTasks.slice(-5);
            const recentIdentical = recentTasks.find(t => t.action === task.action && JSON.stringify(t.parameters) === JSON.stringify(resolvedParams));

            // Stuck in a rut detector (high failure rate on same tool consecutively)
            const recentFailures = pastTasks.slice(-3).filter(t => t.status === 'failed');
            const isStuck = recentFailures.length >= 3 && recentFailures.every(t => t.action === task.action);

            if (this.failureMemory.hasFailedBefore(task.action, resolvedParams)) {
                result = { 
                    success: false, 
                    output: `🛑 CRITICAL ERROR: LOOP BLOCKED.
You are attempting to execute '${task.action}' with parameters you have ALREADY tried and which ALREADY failed. 
FAILED PARAMS: ${JSON.stringify(resolvedParams)}

STRICT PROTOCOL: 
1. You are FORBIDDEN from calling this tool with these parameters again.
2. You must now use 'read_file' or 'search_files' to investigate why your previous assumption was wrong.
3. If you are stuck, use 'submit_response' to ask the user for clarification.` 
                };
            } else if (recentIdentical) {
                result = {
                    success: false,
                    output: `⚠️ REPETITIVE ACTION: You executed this exact same action with the same parameters in step ${recentIdentical.id}. You MUST change your strategy or parameters to avoid an infinite loop.`
                };
            } else if (isStuck) {
                result = {
                    success: false,
                    output: `🛑 SYSTEM OVERRIDE: You have failed to use the '${task.action}' tool successfully 3 times in a row. You are stuck in a loop. You MUST step back, use 'read_file' to gather more context, use 'execute_command' to run a diagnostic, or ask the user for help using 'submit_response'. DO NOT use '${task.action}' again this turn.`
                };
            } else if (isRedundantRead) {
                result = {
                    success: true,
                    output: `ℹ️ NOTE: This file is already in your 'ACCESSIBLE FILE CONTENTS'. Reading it again is a wasted turn. Please analyze the code you already have and propose a fix.`
                };
            } else {
                result = await this.executeTask(task.action, secureParams, signal, undefined, specialistModel, task.agent_persona, task.agent_skills, task.agent_files);

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
            result = { success: false, output: `Specialist Runtime Error:\n${error.stack || error.message}` };
        }

        task.result = result.output;
        task.status = result.success ? 'completed' : 'failed';

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
        // Record the action and the observation for the next prompt iteration.
        const observation = result.output.substring(0, 1000) + (result.output.length > 1000 ? '...' : '');
        const statusEmoji = result.success ? '✅ SUCCESS' : '❌ FAILURE';
        
        this.completedActionsHistory.push(
            `[STEP ${task.id}]
- ACTION: ${task.action}
- INTENT: ${conciseThought}
- STATUS: ${statusEmoji}
- OBSERVATION: "${observation}"
- CONSEQUENCE: ${result.success ? 'Proceed with next step.' : 'CRITICAL: You must analyze why this failed and change approach immediately.'}`
        );

        if (!result.success) {
            this.failureMemory.recordFailure(task.action, resolvedParams, result.output);
        } else {
            // --- EVOLVING INTELLIGENCE: META-REFLECTION ---
            // If this tool has failed before in this session, trigger a reflection to "patch" the harness
            const reflectionPrompt = this.failureMemory.getReflectionPrompt(task.action, resolvedParams);
            if (reflectionPrompt) {
                this.ui.addMessageToDiscussion({ 
                    role: 'system', 
                    content: `🧬 **Meta-Harness:** Success detected after previous failures. Evolving logic...`,
                    skipInPrompt: true 
                });

                try {
                    const evolutionResponse = await this.lollmsApi.sendChat([
                        { 
                            role: 'system', 
                            content: `You are the Genie's Reflexive Memory. 
Analyze why the recent fix worked where others failed. 
Output a <project_memory action="add" importance="2.0"> tag describing the technical lesson (e.g. "Lesson: In PyQt6, always use .exec() not .exec_()"). 
A high importance (2.0+) ensures this lesson is prioritized in every prompt to prevent the bug from returning.` 
                        },
                        { role: 'user', content: reflectionPrompt }
                    ], null, signal, specialistModel);

                    if (this.projectMemoryManager) {
                        await this.projectMemoryManager.processTags(evolutionResponse);
                    }
                } catch (e) {
                    console.error("Harness evolution failed", e);
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
    
    // ... (analyzeStepResult, checkGlobalPermission, executeTask, submitFinalMessage - kept same) ...
    private async analyzeStepResult(task: Task, output: string, model: string | undefined, signal: AbortSignal): Promise<{ decision: 'continue' | 'replan', reasoning: string, new_instruction?: string }> {
        if (output.includes("RLM_REPL_ERROR") || output.includes("NameError")) {
            return { decision: 'replan', reasoning: "Technical error detected. Must adjust code or imports.", new_instruction: "Fix the reported python error before continuing." };
        }
        return { decision: 'continue', reasoning: "Step successful." };
    }

    private checkGlobalPermission(tool: ToolDefinition): { allowed: boolean, message?: string } {
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

        const perm = this.checkGlobalPermission(tool);
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
    public async generateFileTree(startPath: string, prefix: string = ''): Promise<string> {
        let result = '';
        let entries;
        try { entries = await fs.readdir(startPath, { withFileTypes: true }); } catch (e) { return ` (error)\n`; }
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (['node_modules', '.git', '.lollms', 'venv'].includes(entry.name)) continue;
            const isLast = i === entries.length - 1;
            result += prefix + (isLast ? '└── ' : '├── ') + entry.name + '\n';
            if (entry.isDirectory()) {
                result += await this.generateFileTree(path.join(startPath, entry.name), prefix + (isLast ? '    ' : '│   '));
            }
        }
        return result;
    }

    public async runCommand(command: string, signal: AbortSignal, options?: { shell?: any, timeoutMs?: number }): Promise<{ success: boolean, output: string }> {
        if (!this.currentWorkspaceFolder) return { success: false, output: "No workspace." };
        
        let finalCommand = command;
        const isWin = process.platform === 'win32';

        // Automatically handle Python Environment if one is active in the session
        if (this.sessionState.activeEnv && (command.startsWith('python') || command.startsWith('pip'))) {
            const envPath = this.sessionState.activeEnv;
            if (isWin) {
                finalCommand = `& "${path.join(envPath, 'Scripts', 'Activate.ps1')}"; ${command}`;
            } else {
                finalCommand = `. "${path.join(envPath, 'bin', 'activate')}" && ${command}`;
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
        if(this.currentDiscussion && !this.currentDiscussion.id.startsWith('temp-')){
            this.currentDiscussion.plan = null;
            // Wipe the persistent session if the user explicitly turns off Agent Mode
            this.currentDiscussion.agentSession = undefined;
            await this.discussionManager.saveDiscussion(this.currentDiscussion);
        }
        this.currentPlan = null;
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
