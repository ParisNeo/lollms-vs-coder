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

    // --- RLM & STATE ENHANCEMENTS ---
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
        skillsManager: SkillsManager
    ) {
        this.codeGraphManager = codeGraphManager;
        this.skillsManager = skillsManager;
        this.toolManager = new ToolManager();
        this.planParser = new PlanParser(this.lollmsApi, this.contextManager, this.toolManager);
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

        // If RLM is disabled, filter out the rlm_repl tool if it exists in the list
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
            this.displayAndSavePlan(null);
        }
        this.ui.updateAgentMode(this.isActive);
    }

    private async displayAndSavePlan(plan: Plan | null) {
        this.currentPlan = plan;
        if (this.currentDiscussion && !this.currentDiscussion.id.startsWith('temp-') && !this.currentDiscussion.id.startsWith('remote-')) {
            this.currentDiscussion.plan = plan;
            await this.discussionManager.saveDiscussion(this.currentDiscussion);
        }
        this.ui.displayPlan(plan);
    }

    public async handleUserMessage(
        content: string, 
        discussion: Discussion, 
        workspaceFolder: vscode.WorkspaceFolder,
        permissions: UserPermissions = { canExecute: true, canRead: true }
    ) {
        // Auto-activate if not active
        if (!this.isActive) this.isActive = true;

        if (!this.processManager) return;

        this.currentWorkspaceFolder = workspaceFolder;
        this.currentDiscussion = discussion;
        this.chatHistory = [...discussion.messages];
        this.currentUserPermissions = permissions;

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
            if (error.name !== 'AbortError') {
                this.ui.addMessageToDiscussion({ role: 'system', content: `❌ **Critical Error:** ${error.message}` });
            }
        } finally {
            this.processManager.unregister(processId);
            this.ui.updateGeneratingState();
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

    private async runArchitectLoop(objective: string, signal: AbortSignal, modelOverride?: string): Promise<Plan | null> {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const architectModel = config.get<string>('architectModelName') || modelOverride || this.currentDiscussion?.model;
        
        // Use getEnabledTools() which now filters RLM based on config
        const enabledTools = this.getEnabledTools();
        
        const systemPromptMsg = await this.planParser.getArchitectSystemPrompt(enabledTools);
        const moltbookKeyed = await this.checkMoltbookKeyExists();
        
        const investigationHistory: any[] = [];
        
        await this.displayAndSavePlan({
            objective,
            scratchpad: "🧠 Architect is analyzing the objective and environment...",
            tasks: [],
            investigation: investigationHistory
        });

        const workingMemoryContext = this.sessionState.workingMemory.length > 0 
            ? `\n[WORKING MEMORY (FINDINGS)]\n${this.sessionState.workingMemory.join('\n---\n')}\n`
            : "";

        const augmentedObjective = `${objective}
        
[ENVIRONMENT STATUS]
- Active Python Env: ${this.sessionState.activeEnv || 'None'}
- Moltbook Connectivity: ${moltbookKeyed ? 'CONFIGURED' : 'UNCONFIGURED'}
- User Permissions: Execute=${this.currentUserPermissions.canExecute}, Read=${this.currentUserPermissions.canRead}
${workingMemoryContext}`;
        
        const historyContext: ChatMessage[] = [
            systemPromptMsg,
            ...this.chatHistory.filter(m => m.role !== 'system'), 
            { role: 'user', content: `Objective: ${augmentedObjective}\n\nStart investigation or output JSON Plan.` }
        ];

        let loopCount = 0;
        const MAX_LOOPS = 10; 

        while (loopCount < MAX_LOOPS) {
            if (signal.aborted) return null;
            loopCount++;

            this.ui.updateGeneratingState(); 

            let response = "";
            try {
                response = await this.lollmsApi.sendChat(historyContext, null, signal, architectModel);
            } catch (e: any) {
                return null;
            }
            
            const cleanResponse = stripThinkingTags(response);

            await this.displayAndSavePlan({
                objective,
                scratchpad: `🧠 **Architect Update:**\n${cleanResponse.substring(0, 500)}${cleanResponse.length > 500 ? '...' : ''}`,
                tasks: [],
                investigation: investigationHistory
            });

            const jsonStr = this.planParser.extractJson(cleanResponse);
            if (jsonStr) {
                try {
                    const plan = JSON.parse(jsonStr) as Plan;
                    if (plan.tasks && Array.isArray(plan.tasks)) {
                        this.planParser.validateAndInitializePlan(plan, enabledTools);
                        plan.investigation = investigationHistory;
                        return plan;
                    }
                } catch (e) { }
            }

            const toolMatch = this.parseToolCall(cleanResponse);
            
            if (toolMatch) {
                historyContext.push({ role: 'assistant', content: response });
                
                const invItem = {
                    action: toolMatch.name,
                    parameters: toolMatch.params,
                    status: 'in_progress',
                    result: null
                };
                investigationHistory.push(invItem);
                
                await this.displayAndSavePlan({
                    objective,
                    scratchpad: "🧠 Architect is executing a tool to gather information...",
                    tasks: [],
                    investigation: investigationHistory
                });
                
                try {
                    const tempEnv: ToolExecutionEnv = {
                        workspaceRoot: this.currentWorkspaceFolder,
                        lollmsApi: this.lollmsApi,
                        contextManager: this.contextManager,
                        codeGraphManager: this.codeGraphManager,
                        skillsManager: this.skillsManager,
                        currentPlan: { objective: objective, scratchpad: "Architect Investigation", tasks: [] },
                        agentManager: this
                    };

                    const result = await this.executeTask(toolMatch.name, toolMatch.params, signal, tempEnv);
                    
                    if (result.success && result.output.length > 50) {
                        this.sessionState.workingMemory.push(`Observation from ${toolMatch.name}:\n${result.output.substring(0, 1500)}`);
                        if (this.sessionState.workingMemory.length > 10) this.sessionState.workingMemory.shift();
                    }

                    historyContext.push({ 
                        role: 'user', 
                        content: `[TOOL OUTPUT]\n${result.output}\n\nContinue investigation or output final JSON Plan.` 
                    });

                    invItem.status = 'completed';
                    invItem.result = result.output;
                    
                    await this.displayAndSavePlan({
                        objective,
                        scratchpad: "🧠 Architect is processing findings...",
                        tasks: [],
                        investigation: investigationHistory
                    });

                } catch (e: any) {
                    historyContext.push({ role: 'user', content: `Tool Execution Failed: ${e.message}` });
                    invItem.status = 'failed';
                    invItem.result = e.message;
                    await this.displayAndSavePlan({
                        objective,
                        scratchpad: "⚠️ Architect encountered a tool failure. Retrying strategy...",
                        tasks: [],
                        investigation: investigationHistory
                    });
                }
            } else {
                historyContext.push({ role: 'assistant', content: response });
                
                if (jsonStr) {
                     historyContext.push({ role: 'user', content: "Invalid Plan Format. Must contain 'tasks' array. Please retry." });
                } else if (loopCount > 8) {
                     historyContext.push({ role: 'user', content: "Enough investigation. Please output the final JSON Plan now." });
                }
            }
        }
        
        return null;
    }

    private parseToolCall(content: string): { name: string, params: any } | null {
        const match = content.match(/```json\s*(\{[\s\S]*?"tool"[\s\S]*?\})\s*```/);
        if (match) {
            try {
                const obj = JSON.parse(match[1]);
                if (obj.tool) {
                    return { name: obj.tool, params: obj.params || {} };
                }
            } catch (e) { return null; }
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
        
        while (this.currentTaskIndex < this.currentPlan.tasks.length) {
            if (signal.aborted) return;
            
            const task = this.currentPlan.tasks[this.currentTaskIndex];
            const config = vscode.workspace.getConfiguration('lollmsVsCoder');
            const architectModel = config.get<string>('architectModelName') || modelOverride;
    
            if (task.status === 'pending') {
                if (task.action === 'generate_code' || task.action === 'execute_command') {
                    await this.performGitBackup(`Before task ${task.id} (${task.action})`);
                }

                task.status = 'in_progress';
                // CRITICAL FIX: Ensure UI receives the update before tool starts execution
                await this.displayAndSavePlan(this.currentPlan);
                // Allow UI thread time to render spinner
                await new Promise(resolve => setTimeout(resolve, 50)); 
    
                let result: { success: boolean; output: string; };
                try {
                    const resolvedParams = this.resolveParameters(task);
                    result = await this.executeTask(task.action, resolvedParams, signal);
                } catch (error: any) {
                    result = { success: false, output: error.message };
                }
    
                task.result = result.output;
                task.status = result.success ? 'completed' : 'failed';
                await this.displayAndSavePlan(this.currentPlan);
    
                if (!result.success) {
                    this.globalFailureLog.push(`Task ${task.id} (${task.action}) failed: ${result.output.substring(0, 200)}`);
                    const maxRetries = config.get<number>('agentMaxRetries') || 1;

                    if (task.retries < maxRetries) {
                        const revisionSucceeded = await this.revisePlanForFailure(task, signal, architectModel);
                        if (revisionSucceeded) continue;
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
                    const significantTools = ['execute_command', 'read_file', 'search_web', 'run_file', 'scrape_website', 'search_files', 'rlm_repl', 'request_user_input', 'moltbook_action', 'research_web_page', 'analyze_image'];
                    const isLastTask = this.currentTaskIndex === this.currentPlan.tasks.length - 1;
                    const isInputRequest = task.action === 'request_user_input';

                    if (result.success && result.output.length > 50) {
                        this.sessionState.workingMemory.push(`Confirmed fact from ${task.action}:\n${result.output.substring(0, 1500)}`);
                        if (this.sessionState.workingMemory.length > 10) this.sessionState.workingMemory.shift();
                    }

                    if (significantTools.includes(task.action) || isInputRequest) {
                         if (isInputRequest && isLastTask) {
                             const replanResult = await this.replan(`User provided input: "${result.output}". Update plan to process this.`, signal, architectModel);
                             if (replanResult.success) {
                                 continue; 
                             }
                         } else {
                             const observation = await this.analyzeStepResult(task, result.output, architectModel, signal);
                             
                             if (observation.decision === 'replan') {
                                 this.ui.addMessageToDiscussion({ 
                                     role: 'system', 
                                     content: `🧠 **Observation:** ${observation.reasoning}\n\n🔄 **Adapting Plan...**` 
                                 });
                                 
                                 const replanResult = await this.replan(observation.new_instruction || "Adapt plan based on output.", signal, architectModel);
                                 if (replanResult.success) { }
                             }
                         }
                    }
                }
            }
            this.currentTaskIndex++;
        }
    }

    private async analyzeStepResult(task: Task, output: string, model: string | undefined, signal: AbortSignal): Promise<{ decision: 'continue' | 'replan', reasoning: string, new_instruction?: string }> {
        if (!this.currentPlan) return { decision: 'continue', reasoning: "No plan." };

        const truncatedOutput = output.length > 3000 ? output.substring(0, 3000) + "... [truncated]" : output;
        const memoryContext = this.sessionState.workingMemory.length > 0 
            ? `\n**WORKING MEMORY:**\n${this.sessionState.workingMemory.join('\n')}\n`
            : "";

        const analysisPrompt = `You are the Agent Supervisor.
An agent just executed a task. Analyze the result against the OBJECTIVE and WORKING MEMORY.

**OBJECTIVE:** "${this.currentPlan.objective}"
${memoryContext}

**TASK EXECUTED:**
Action: ${task.action}
Description: ${task.description}

**RESULT / OUTPUT:**
${truncatedOutput}

**DECISION TIME:**
1. **CONTINUE**: If the result is just a step and we need to proceed with the existing plan.
2. **REPLAN**: 
    - If the result contains NEW CRUCIAL INFORMATION that changes what we should do next.
    - If the plan is finished but the objective isn't fully achieved.
    - If you found specific content (like book details) that needs to be used in the next step.

**OUTPUT JSON ONLY:**
\`\`\`json
{
  "decision": "continue" | "replan",
  "reasoning": "Brief explanation",
  "new_instruction": "If replan, provide the new instruction using the specific data found."
}
\`\`\`
`;
        try {
            const response = await this.lollmsApi.sendChat([
                { role: 'system', content: analysisPrompt }
            ], null, signal, model);

            const jsonMatch = response.match(/```json\s*(\{[\s\S]*?\})\s*```/) || response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[1] || jsonMatch[0]);
            }
        } catch (e) {
            console.error("Analysis failed", e);
        }
        
        return { decision: 'continue', reasoning: "Analysis failed, defaulting to continue." };
    }

    private checkGlobalPermission(tool: ToolDefinition): { allowed: boolean, message?: string } {
        if (!tool.permissionGroup) return { allowed: true };

        // 1. User-specific permissions (Remote User or Default User)
        if (tool.permissionGroup === 'shell_execution' && !this.currentUserPermissions.canExecute) {
            return { allowed: false, message: `🛑 **Access Denied:** Current user not authorized for shell execution.` };
        }
        if (tool.permissionGroup === 'filesystem_write' && !this.currentUserPermissions.canExecute) {
            return { allowed: false, message: `🛑 **Access Denied:** Current user not authorized for file modification.` };
        }

        // 2. Global Extension Config permissions
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const permissions = config.get<any>('agent.permissions') || {};

        const map: Record<ToolPermissionGroup, string> = {
            'shell_execution': 'shellExecution',
            'filesystem_write': 'filesystemWrite',
            'filesystem_read': 'filesystemRead',
            'internet_access': 'internetAccess'
        };

        const key = map[tool.permissionGroup];
        if (key && permissions[key] === false) {
            return { 
                allowed: false, 
                message: `🛑 **Global Permission Denied:** The action '${tool.name}' requires '${tool.permissionGroup}' access (Disabled in Settings).`
            };
        }

        return { allowed: true };
    }

    private async executeTask(
        action: string, 
        params: any, 
        signal: AbortSignal, 
        overrideEnv?: ToolExecutionEnv
    ): Promise<{ success: boolean, output: string }> {
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
                return { 
                    success: false, 
                    output: `❌ **OS Permission Error.**\nRaw Error: ${error.message}` 
                };
            }
            throw error;
        }
    }

    public async submitFinalMessage(message: ChatMessage) {
        await this.ui.addMessageToDiscussion(message);
    }
    
    private async revisePlanForFailure(failedTask: Task, signal: AbortSignal, modelOverride?: string): Promise<boolean> {
        if (!this.currentPlan || !this.currentDiscussion) return false;
        
        failedTask.retries++;
        this.currentPlan.scratchpad += `\n\n⚠️ **Task ${failedTask.id} Failed.** Attempting self-correction...`;
        this.displayAndSavePlan(this.currentPlan);

        const planResult = await this.planParser.generateAndParsePlan(
            this.currentPlan.objective,
            this.currentPlan,
            failedTask.id,
            failedTask.result,
            signal,
            modelOverride,
            this.chatHistory,
            this.getEnabledTools(),
            this.currentDiscussion?.importedSkills
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

    private resolveParameters(task: Task): { [key: string]: any } {
        if (!this.currentPlan) throw new Error("No active plan.");
        const resolvedParams: { [key: string]: any } = {};

        const tagRegex = /\{\{(?:[\s(]*)(tasks\[(\d+)\]\.result(?:.*?))(?:\s*[\)|]*)\}\}/g;

        for (const key in task.parameters) {
            let value = task.parameters[key];
            if (typeof value === 'string') {
                let resolvedValue = value.replace(tagRegex, (match, fullMatch, idStr) => {
                    const id = parseInt(idStr, 10);
                    const sourceTask = this.currentPlan?.tasks.find(t => t.id === id);
                    
                    if (!sourceTask || sourceTask.result === null) {
                         return match; 
                    }
                    
                    let result = sourceTask.result || "";

                    if (match.includes('regex_search')) {
                        const regexMatch = match.match(/regex_search\s*\(\s*(['"])(.*?)\1\s*(?:,\s*(\d+))?\s*\)/);
                        if (regexMatch) {
                            try {
                                const pattern = regexMatch[2];
                                const group = regexMatch[3] ? parseInt(regexMatch[3], 10) : 0;
                                const re = new RegExp(pattern, 'm');
                                const found = result.match(re);
                                if (found && found[group]) return found[group];
                            } catch (e) { }
                        }
                    }
                    
                    return result;
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
        this.currentPlan.scratchpad += `\n\n🔄 **Replanning requested:** ${instruction}`;
        this.displayAndSavePlan(this.currentPlan);
        
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const plannerModel = config.get<string>('architectModelName') || modelOverride;

        if (this.currentDiscussion) {
             this.chatHistory = [...this.currentDiscussion.messages];
        }

        try {
            const planResult = await this.planParser.generateAndParsePlan(
                `${this.currentPlan.objective} (Update: ${instruction})`,
                this.currentPlan,
                undefined,
                undefined,
                signal,
                plannerModel,
                this.chatHistory,
                this.getEnabledTools(),
                this.currentDiscussion?.importedSkills
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

            // Sync investigation history from old plan
            planResult.plan.investigation = this.currentPlan.investigation;

            this.displayAndSavePlan(this.currentPlan);
            return { success: true, output: "Plan modified successfully." };

        } catch (error: any) {
            return { success: false, output: `Error: ${error.message}` };
        }
    }

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
        return runCommandInTerminal(command, this.currentWorkspaceFolder.uri.fsPath, `Agent Task`, signal);
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