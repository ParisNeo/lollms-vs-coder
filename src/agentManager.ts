import * as vscode from 'vscode';
import { ChatPanel } from './commands/chatPanel/chatPanel';
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

    // --- RLM & STATE ENHANCEMENTS ---
    // Persistent state for the current session (REPL variables, active envs, etc.)
    public sessionState: {
        activeEnv?: string;
        replVariables: Record<string, any>;
        installedPackages: string[];
        environmentHistory: string[];
    } = {
        replVariables: {},
        installedPackages: [],
        environmentHistory: []
    };

    constructor(
        private chatPanel: ChatPanel,
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
        return this.toolManager.getEnabledTools();
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
            this.chatPanel.addMessageToDiscussion({ role: 'system', content: `🤖 **Agent Mode Activated.** Architect is ready.` });
        } else {
            this.chatPanel.addMessageToDiscussion({ role: 'system', content: '🤖 **Agent Mode Deactivated.**' });
            this.displayAndSavePlan(null);
        }
    }

    private async displayAndSavePlan(plan: Plan | null) {
        this.currentPlan = plan;
        if (this.currentDiscussion && !this.currentDiscussion.id.startsWith('temp-')) {
            this.currentDiscussion.plan = plan;
            await this.discussionManager.saveDiscussion(this.currentDiscussion);
        }
        this.chatPanel.displayPlan(plan);
    }

    public async handleUserMessage(content: string, discussion: Discussion, workspaceFolder: vscode.WorkspaceFolder) {
        if (!this.isActive || !this.processManager) return;

        this.currentWorkspaceFolder = workspaceFolder;
        this.currentDiscussion = discussion;
        this.chatHistory = [...discussion.messages]; // Sync latest

        const { id: processId, controller } = this.processManager.register(discussion.id, `Agent Thinking...`);
        this.chatPanel.updateGeneratingState();

        try {
            const hasActivePlan = this.currentPlan && this.currentPlan.tasks.some(t => t.status === 'pending' || t.status === 'in_progress');

            if (hasActivePlan) {
                // Modify existing plan
                this.chatPanel.addMessageToDiscussion({ role: 'system', content: '🔄 **Updating Plan based on user feedback...**' });
                const result = await this.replan(content, controller.signal);
                if (result.success) {
                    await this.executePlan(this.currentTaskIndex, controller.signal, this.currentDiscussion.model);
                } else {
                    this.chatPanel.addMessageToDiscussion({ role: 'system', content: `❌ Plan update failed: ${result.output}` });
                }
            } else {
                // New Objective
                const objective = content;
                const initialPlanState: Plan = { 
                    objective: objective,
                    scratchpad: "🧠 Architect is analyzing request...",
                    tasks: []
                };
                this.displayAndSavePlan(initialPlanState);
        
                const config = vscode.workspace.getConfiguration('lollmsVsCoder');
                const architectModel = config.get<string>('architectModelName') || this.currentDiscussion.model;

                // Sync persistent state into the planner context via objective augmentation
                const augmentedObjective = `${objective}\n\n[Persistent Context: Active Env: ${this.sessionState.activeEnv || 'None'}, Memory: ${JSON.stringify(this.sessionState.replVariables)}]`;

                const planResult = await this.planParser.generateAndParsePlan(
                    augmentedObjective, 
                    undefined, 
                    undefined, 
                    undefined, 
                    controller.signal, 
                    architectModel,
                    this.chatHistory,
                    this.toolManager.getEnabledTools()
                );
                
                if (controller.signal.aborted) return;

                if (!planResult.plan) {
                     const failedPlanState: Plan = {
                        objective: objective,
                        scratchpad: `❌ **Planning Failed:** ${planResult.error}`,
                        tasks: []
                    };
                    this.displayAndSavePlan(failedPlanState);
                    return;
                }
                
                this.displayAndSavePlan(planResult.plan);
                await this.executePlan(0, controller.signal, this.currentDiscussion.model);
            }

        } catch (error: any) {
            if (error.name !== 'AbortError') {
                this.chatPanel.addMessageToDiscussion({ role: 'system', content: `❌ **Critical Error:** ${error.message}` });
            }
        } finally {
            this.processManager.unregister(processId);
            this.chatPanel.updateGeneratingState();
        }
    }

    public async run(initialObjective: string, discussion: Discussion, workspaceFolder: vscode.WorkspaceFolder, modelOverride?: string) {
        await this.handleUserMessage(initialObjective, discussion, workspaceFolder);
    }

    private async performGitBackup(reason: string) {
        if (!this.currentWorkspaceFolder) return;
        try {
            const isRepo = await this.gitIntegration.isGitRepo(this.currentWorkspaceFolder);
            if (!isRepo) return;
            this.chatPanel.addMessageToDiscussion({ role: 'system', content: `🔒 **Creating safety backup:** ${reason}...` });
            await this.gitIntegration.stageAllAndCommit(`Auto-backup: ${reason}`, this.currentWorkspaceFolder);
        } catch (e) {
            console.error("Backup failed", e);
        }
    }

    public async retryFailedTask(taskId: number) {
        if (!this.currentPlan || !this.processManager || !this.currentDiscussion) return;

        const { id: processId, controller } = this.processManager.register(this.currentDiscussion.id, `Agent: Retrying task ${taskId}...`);
        this.chatPanel.updateGeneratingState();

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
                this.chatPanel.addMessageToDiscussion({ role: 'system', content: `🛑 Failed to generate a revised plan.` });
            }
        } catch (error: any) {
            // Error handling
        } finally {
            this.processManager.unregister(processId);
            this.chatPanel.updateGeneratingState();
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
                this.displayAndSavePlan(this.currentPlan);
    
                let result: { success: boolean; output: string; };
                try {
                    const resolvedParams = this.resolveParameters(task);
                    result = await this.executeTask(task.action, resolvedParams, signal);
                } catch (error: any) {
                    result = { success: false, output: error.message };
                }
    
                task.result = result.output;
                task.status = result.success ? 'completed' : 'failed';
                this.displayAndSavePlan(this.currentPlan);
    
                if (!result.success) {
                    // --- FAILURE HANDLING ---
                    this.globalFailureLog.push(`Task ${task.id} (${task.action}) failed: ${result.output.substring(0, 200)}`);
                    const maxRetries = config.get<number>('agentMaxRetries') || 1;

                    if (task.retries < maxRetries) {
                        const revisionSucceeded = await this.revisePlanForFailure(task, signal, architectModel);
                        if (revisionSucceeded) continue;
                    }
                    
                    task.can_retry = true;
                    this.displayAndSavePlan(this.currentPlan);

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
                    // --- SUCCESS: OBSERVE & REFINE ---
                    // Only analyze for significant tools
                    if (['execute_command', 'read_file', 'search_web', 'run_file', 'scrape_website', 'search_files', 'rlm_repl'].includes(task.action)) {
                         
                         const observation = await this.analyzeStepResult(task, result.output, architectModel, signal);
                         
                         if (observation.decision === 'replan') {
                             this.chatPanel.addMessageToDiscussion({ 
                                 role: 'system', 
                                 content: `🧠 **Observation:** ${observation.reasoning}\n\n🔄 **Adapting Plan...**` 
                             });
                             
                             const replanResult = await this.replan(observation.new_instruction || "Adapt plan based on output.", signal, architectModel);
                             
                             if (replanResult.success) {
                                 // Plan updated. 
                             }
                         }
                    }
                }
            }
            this.currentTaskIndex++;
        }
    }

    /**
     * Analyzes the output of a task to determine if the plan needs adjustment.
     * Crucially, checks if the answer was found.
     */
    private async analyzeStepResult(
        task: Task, 
        output: string, 
        model: string | undefined, 
        signal: AbortSignal
    ): Promise<{ decision: 'continue' | 'replan', reasoning: string, new_instruction?: string }> {
        
        if (!this.currentPlan) return { decision: 'continue', reasoning: "No plan." };

        const truncatedOutput = output.length > 3000 ? output.substring(0, 3000) + "... [truncated]" : output;

        const analysisPrompt = `You are the Agent Supervisor.
An agent just executed a task. You must analyze the result to see if the current plan is still valid or needs changing.

**OBJECTIVE:** "${this.currentPlan.objective}"

**TASK EXECUTED:**
Action: ${task.action}
Description: ${task.description}

**RESULT / OUTPUT:**
${truncatedOutput}

**DECISION TIME:**
1. **CONTINUE**: If the result is just a step and we need to proceed.
2. **REPLAN**: 
    - If the result CHANGES what we need to do next.
    - If the result contains the FINAL ANSWER (e.g. found the IP address, found the file content). In this case, you MUST Extract the answer.

**OUTPUT JSON ONLY:**
\`\`\`json
{
  "decision": "continue" | "replan",
  "reasoning": "Brief explanation",
  "new_instruction": "If replan, provide the new instruction. IF YOU FOUND THE ANSWER, the instruction MUST be: 'Submit the answer: [INSERT THE EXTRACTED ANSWER HERE]'."
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
                message: `🛑 **Global Permission Denied:** The action '${tool.name}' requires '${tool.permissionGroup}' access, which is currently disabled in your global Lollms settings.`
            };
        }

        return { allowed: true };
    }

    private async executeTask(action: string, params: any, signal: AbortSignal): Promise<{ success: boolean, output: string }> {
        const tool = this.toolManager.getTool(action);
        if (!tool) return { success: false, output: `Unknown action: ${action}` };

        const perm = this.checkGlobalPermission(tool);
        if (!perm.allowed) {
            return { success: false, output: perm.message || "Permission denied by user configuration." };
        }

        const env: ToolExecutionEnv = {
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
                    output: `❌ **OS Permission Error:** The operating system denied access.\nRaw Error: ${error.message}` 
                };
            }
            throw error;
        }
    }

    public async submitFinalMessage(message: ChatMessage) {
        await this.chatPanel.addMessageToDiscussion(message);
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
            this.toolManager.getEnabledTools()
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

        // Robust Regex: Matches {{ tasks[1].result }} and variations like {{ (tasks[1].result...) }}
        // Captures: 1=TaskID, 2=Extras
        const tagRegex = /\{\{(?:[\s(]*)(tasks\[(\d+)\]\.result(?:.*?))(?:\s*[\)|]*)\}\}/g;

        for (const key in task.parameters) {
            let value = task.parameters[key];
            if (typeof value === 'string') {
                let resolvedValue = value.replace(tagRegex, (match, fullMatch, idStr) => {
                    const id = parseInt(idStr, 10);
                    const sourceTask = this.currentPlan?.tasks.find(t => t.id === id);
                    
                    if (!sourceTask || sourceTask.result === null) {
                         return match; // Dependency missing
                    }
                    
                    let result = sourceTask.result || "";

                    // Attempt regex search fallback if template is complex
                    // But primary fix is preventing the agent from using this
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

        try {
            const planResult = await this.planParser.generateAndParsePlan(
                `${this.currentPlan.objective} (Update: ${instruction})`,
                this.currentPlan,
                undefined,
                undefined,
                signal,
                plannerModel,
                this.chatHistory,
                this.toolManager.getEnabledTools()
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

            this.displayAndSavePlan(this.currentPlan);
            return { success: true, output: "Plan modified successfully." };

        } catch (error: any) {
            return { success: false, output: `Error: ${error.message}` };
        }
    }

    public async generateFileTree(startPath: string, prefix: string = ''): Promise<string> {
        let result = '';
        let entries;
        try {
            entries = await fs.readdir(startPath, { withFileTypes: true });
        } catch (e) {
            return ` (error reading directory)\n`;
        }
    
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
        return this.chatPanel.requestUserInput(question, signal);
    }

    private deactivateAgent() {
        this.isActive = false;
        if(this.currentDiscussion && !this.currentDiscussion.id.startsWith('temp-')){
            this.currentDiscussion.plan = null;
            this.discussionManager.saveDiscussion(this.currentDiscussion);
        }
        this.currentPlan = null;
        this.chatPanel.updateAgentMode(false);
    }
}
