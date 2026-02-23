import * as vscode from 'vscode';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { ContextManager } from './contextManager';
import { GitIntegration } from './gitIntegration';
import { InfoPanel } from './commands/infoPanel';
import { PlanParser } from './planParser';
import { stripThinkingTags } from './utils';
import { ProcessManager } from './processManager';
import { DiscussionManager, Discussion } from './discussionManager';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ToolManager } from './tools/toolManager';
import { ToolExecutionEnv, ToolDefinition, Plan, ToolPermissionGroup } from './tools/tool';
import { CodeGraphManager } from './codeGraphManager';
import { SkillsManager } from './skillsManager';
import { runCommandInTerminal } from './extensionState';
import { RLMDatabaseManager } from './rlmDatabaseManager';
import { FailureMemory } from './agent/failureHandling'; 

// Interface decoupling the UI from the logic
export interface IAgentUI {
    addMessageToDiscussion(message: ChatMessage): Promise<void>;
    displayPlan(plan: Plan | null): void;
    updateGeneratingState(): void;
    requestUserInput(question: string, signal: AbortSignal): Promise<string>;
    updateAgentMode(isActive: boolean): void;
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
    private currentDiscussion?: Discussion;
    private toolManager: ToolManager;
    private codeGraphManager: CodeGraphManager;
    private skillsManager: SkillsManager;
    private globalFailureLog: string[] = []; 
    private currentUserPermissions: UserPermissions = { canExecute: true, canRead: true };
    private consecutiveTaskFailures: Map<number, number> = new Map();
    private readonly MAX_TASK_REVISIONS = 3;

    private failureMemory: FailureMemory = new FailureMemory();
    
    /**
     * Explicitly track completed actions for prompt injection to prevent
     * the Architect from planning steps it has already finished.
     */
    private completedActionsHistory: string[] = [];

    public rlmDb?: RLMDatabaseManager;
    public sessionState: {
        activeEnv?: string;
        replVariables: Record<string, any>; 
        installedPackages: string[];
        environmentHistory: string[];
        workingMemory: string[]; 
    } = {
        replVariables: {},
        installedPackages: [],
        environmentHistory: [],
        workingMemory: []
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
            this.ui.addMessageToDiscussion({ role: 'system', content: `🤖 **Agent Mode Activated.** Architect is ready.` });
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

    public async handleUserMessage(
        content: string, 
        discussion: Discussion, 
        workspaceFolder: vscode.WorkspaceFolder,
        permissions: UserPermissions = { canExecute: true, canRead: true }
    ) {
        if (!this.isActive) this.isActive = true;
        if (!this.processManager) return;

        this.currentWorkspaceFolder = workspaceFolder;
        this.currentDiscussion = discussion;
        this.chatHistory = [...discussion.messages];
        this.currentUserPermissions = permissions;

        if (!this.currentPlan) {
            this.failureMemory.clear();
            this.consecutiveTaskFailures.clear();
            this.completedActionsHistory = []; // Reset on fresh start
        }

        const { id: processId, controller } = this.processManager.register(discussion.id, `Agent Thinking...`);
        this.ui.updateGeneratingState();

        try {
            const hasActivePlan = this.currentPlan && this.currentPlan.tasks.some(t => t.status === 'pending' || t.status === 'in_progress');

            if (hasActivePlan) {
                this.ui.addMessageToDiscussion({ role: 'system', content: '🔄 **Updating Plan based on user feedback...**' });
                const result = await this.replan(content, controller.signal);
                if (result.success) {
                    await this.executePlan(this.currentTaskIndex, controller.signal, this.currentDiscussion.model);
                } else {
                    this.ui.addMessageToDiscussion({ role: 'system', content: `❌ Plan update failed: ${result.output}` });
                }
            } else {
                const objective = content;
                const plan = await this.runArchitectLoop(objective, controller.signal, this.currentDiscussion.model);
                
                if (controller.signal.aborted) return;

                if (!plan) {
                     const failedPlanState: Plan = {
                        objective: objective,
                        scratchpad: `❌ **Planning Failed.** Architect timed out or failed to provide a valid JSON plan.`,
                        tasks: []
                    };
                    this.displayAndSavePlan(failedPlanState);
                    return;
                }
                
                this.displayAndSavePlan(plan);
                await this.executePlan(0, controller.signal, this.currentDiscussion.model);
            }

        } catch (error: any) {
            if (error.name !== 'AbortError' && error.message !== 'AbortError') {
                this.ui.addMessageToDiscussion({ role: 'system', content: `❌ **Critical Error:** ${error.message}` });
            }
        } finally {
            this.isActive = false; // CRITICAL: Reset activity flag to dismiss overlay
            this.processManager.unregister(processId);
            this.ui.updateGeneratingState();
        }
    }

    // ... (checkMoltbookKeyExists kept same) ...
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

    private async runArchitectLoop(objective: string, signal: AbortSignal, modelOverride?: string): Promise<Plan | null> {
         const enabledTools = this.getEnabledTools();
         const systemPromptMsg = await this.planParser.getArchitectSystemPrompt(enabledTools);
         
         const investigationHistory: any[] = [];
         const existingHistory = this.currentPlan?.attempts || [];
 
         await this.displayAndSavePlan({
             objective,
             scratchpad: "🧠 Architect is analyzing the objective and environment...",
             tasks: [],
             investigation: investigationHistory,
             attempts: existingHistory
         });
         
         const workingMemoryContext = this.sessionState.workingMemory.length > 0 
             ? `\n[WORKING MEMORY]\n${this.sessionState.workingMemory.join('\n---\n')}\n`
             : "";
         
         const failureContext = this.failureMemory.getMemoryContext();
         
         const historyContext: ChatMessage[] = [
             systemPromptMsg,
             ...this.chatHistory.filter(m => m.role !== 'system'), 
             { role: 'user', content: `Objective: ${objective}\n${workingMemoryContext}\n${failureContext}` }
         ];

         let loopCount = 0;
         const MAX_LOOPS = 10;
         
         while (loopCount < MAX_LOOPS) {
             if (signal.aborted) return null;
             loopCount++;
             this.ui.updateGeneratingState();
             
             let response = "";
             try {
                const config = vscode.workspace.getConfiguration('lollmsVsCoder');
                const architectModel = config.get<string>('architectModelName') || modelOverride || this.currentDiscussion?.model;
                response = await this.lollmsApi.sendChat(historyContext, null, signal, architectModel);
             } catch(e: any) {
                 return null;
             }
             
             const cleanResponse = stripThinkingTags(response);
             const jsonStr = this.planParser.extractJson(cleanResponse);
             
             if (jsonStr) {
                 try {
                     const plan = JSON.parse(jsonStr) as Plan;
                     this.planParser.validateAndInitializePlan(plan, enabledTools);
                     return plan;
                 } catch(e) {}
             }
             
             const toolMatch = this.parseToolCall(cleanResponse);
             if (toolMatch) {
                 // Update Web UI if search
                 if (toolMatch.name.includes('search')) {
                    this.ui.addMessageToDiscussion({ 
                        role: 'system', 
                        content: `🔍 **Researching:** ${toolMatch.params.query || '...'} via ${toolMatch.name.split('_')[1] || 'web'}`,
                        skipInPrompt: true
                    });
                 }

                 // Execution logic...
                 historyContext.push({ role: 'assistant', content: response });
                 const tempEnv = {
                     workspaceRoot: this.currentWorkspaceFolder,
                     lollmsApi: this.lollmsApi,
                     contextManager: this.contextManager,
                     codeGraphManager: this.codeGraphManager,
                     skillsManager: this.skillsManager,
                     currentPlan: null,
                     agentManager: this
                 };
                 try {
                     const res = await this.executeTask(toolMatch.name, toolMatch.params, signal, tempEnv as any);
                     historyContext.push({ role: 'user', content: `Tool Output: ${res.output}` });
                 } catch(e: any) {
                     historyContext.push({ role: 'user', content: `Tool Error: ${e.message}` });
                 }
             } else {
                 // If we have history of messages, assume the last response might be conversational.
                 // We push it to history so the model knows what it said.
                 historyContext.push({ role: 'assistant', content: response });
                 // If no JSON plan and no tool, force a prompt
                 historyContext.push({ role: 'user', content: "Please provide a valid JSON plan using the specified format." });
             }
         }
         return null;
    }
    
    private parseToolCall(content: string): { name: string, params: any } | null {
        // 1. Try Markdown Code Block
        const match = content.match(/```json\s*(\{[\s\S]*?"tool"[\s\S]*?\})\s*```/);
        if (match) {
            try {
                const obj = JSON.parse(match[1]);
                if (obj.tool) return { name: obj.tool, params: obj.params || {} };
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
                if (obj.tool) return { name: obj.tool, params: obj.params || {} };
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
            this.ui.addMessageToDiscussion({ role: 'system', content: `🔒 **Creating safety backup:** ${reason}...` });
            await this.gitIntegration.stageAllAndCommit(`Auto-backup: ${reason}`, this.currentWorkspaceFolder);
        } catch (e) {
            console.error("Backup failed", e);
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
        this.currentTaskIndex = startIndex;
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const maxRetries = config.get<number>('agentMaxRetries') || 1;
        const architectModel = config.get<string>('architectModelName') || modelOverride || this.currentDiscussion?.model;

        while (this.currentTaskIndex < this.currentPlan.tasks.length) {
            if (signal.aborted) return;
            const task = this.currentPlan.tasks[this.currentTaskIndex];
            const specialistModel = task.model || modelOverride || this.currentDiscussion?.model;

            if (task.status === 'pending') {
                // Only backup for actions that modify the local filesystem directly.
                // execute_command is excluded by default as it might just be a network tool like curl.
                if (['generate_code', 'delete_file', 'move_file'].includes(task.action)) {
                    await this.performGitBackup(`Checkpoint: Task ${task.id} - ${task.description}`);
                }

                task.status = 'in_progress';
                let result: { success: boolean; output: string; } = { success: false, output: "" };
                let resolvedParams: any = {};

                try {
                    resolvedParams = this.resolveParameters(task);
                    task.parameters = resolvedParams; 
                    await this.displayAndSavePlan(this.currentPlan); 

                    if (this.failureMemory.hasFailedBefore(task.action, resolvedParams)) {
                        result = { 
                            success: false, 
                            output: `CRITICAL FAILURE: The Specialist detected a loop with these parameters. Strategy blocked.` 
                        };
                    } else {
                        result = await this.executeTask(task.action, resolvedParams, signal, undefined, specialistModel, task.agent_persona);
                    }
                } catch (error: any) {
                    result = { success: false, output: `Specialist Runtime Error: ${error.message}` };
                }
    
                task.result = result.output;
                task.status = result.success ? 'completed' : 'failed';

                if (!result.success) {
                    this.failureMemory.recordFailure(task.action, resolvedParams, result.output);

                    if (task.retries < maxRetries) {
                        this.ui.addMessageToDiscussion({ 
                            role: 'system', 
                            content: `⚠️ **Task ${task.id} Failed.** Lead Architect is revising the strategy...`,
                            skipInPrompt: true 
                        });

                        const revisionSucceeded = await this.revisePlanForFailure(task, signal, architectModel);
                        if (revisionSucceeded) {
                            await this.displayAndSavePlan(this.currentPlan);
                            // We stay at the same currentTaskIndex because the old failed task 
                            // was removed and replaced by new tasks at this position.
                            continue; 
                        }
                    }
                    
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
                    if (userChoice === 'Stop' || userChoice === undefined) {
                        return; 
                    }
                } else {
                    // Success logic
                }
            }
            this.currentTaskIndex++;
        }
    }
    
    // ... (analyzeStepResult, checkGlobalPermission, executeTask, submitFinalMessage - kept same) ...
    private async analyzeStepResult(task: Task, output: string, model: string | undefined, signal: AbortSignal): Promise<{ decision: 'continue' | 'replan', reasoning: string, new_instruction?: string }> {
        // ... (existing logic) ...
        return { decision: 'continue', reasoning: "Proceed." };
    }
    private checkGlobalPermission(tool: ToolDefinition): { allowed: boolean, message?: string } {
        // ... (existing logic) ...
        return { allowed: true };
    }
    private async executeTask(action: string, params: any, signal: AbortSignal, overrideEnv?: ToolExecutionEnv): Promise<{ success: boolean, output: string }> {
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
            currentPlan: this.currentPlan,
            agentManager: this
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

            const splitIndex = this.currentTaskIndex + 1;
            this.currentPlan.tasks.splice(splitIndex);

            let nextId = this.currentPlan.tasks.length > 0 ? Math.max(...this.currentPlan.tasks.map(t => t.id)) + 1 : 1;
            for (const newTask of planResult.plan.tasks) {
                newTask.id = nextId++;
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

    public async runCommand(command: string, signal: AbortSignal): Promise<{ success: boolean, output: string }> {
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
        
        return runCommandInTerminal(finalCommand, this.currentWorkspaceFolder.uri.fsPath, `Lollms: ${taskName}`, signal);
    }

    public async requestUserInput(question: string, signal: AbortSignal): Promise<string> {
        return this.ui.requestUserInput(question, signal);
    }

    private deactivateAgent() {
        this.isActive = false;
        if(this.currentDiscussion && !this.currentDiscussion.id.startsWith('temp-')){
            this.currentDiscussion.plan = null;
            this.discussionManager.saveDiscussion(this.currentDiscussion);
        }
        this.currentPlan = null;
        this.ui.updateAgentMode(false);
    }
}
