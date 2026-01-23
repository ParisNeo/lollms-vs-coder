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

    public async run(initialObjective: string, discussion: Discussion, workspaceFolder: vscode.WorkspaceFolder, modelOverride?: string) {
        if (!this.isActive || !this.processManager) return;
        
        const { id: processId, controller } = this.processManager.register(discussion.id, `Agent Planning...`);
        
        try {
            this.currentWorkspaceFolder = workspaceFolder;
            this.currentDiscussion = discussion;
            this.chatHistory = [...discussion.messages];
            this.globalFailureLog = []; 
            
            const initialPlanState: Plan = { 
                objective: initialObjective,
                scratchpad: "🧠 Architect is gathering project intelligence...",
                tasks: []
            };
            this.displayAndSavePlan(initialPlanState);
    
            const config = vscode.workspace.getConfiguration('lollmsVsCoder');
            const architectModel = config.get<string>('architectModelName') || modelOverride;

            const planResult = await this.planParser.generateAndParsePlan(
                initialObjective, 
                undefined, 
                undefined, 
                undefined, 
                controller.signal, 
                architectModel,
                this.chatHistory,
                this.toolManager.getEnabledTools()
            );
            
            if (controller.signal.aborted) {
                this.deactivateAgent();
                return;
            }

            if (!planResult.plan) {
                 const failedPlanState: Plan = {
                    objective: initialObjective,
                    scratchpad: `❌ **Planning Failed:** ${planResult.error}`,
                    tasks: []
                };
                this.displayAndSavePlan(failedPlanState);
                this.deactivateAgent();
                return;
            }
            
            this.displayAndSavePlan(planResult.plan);
            await this.executePlan(0, controller.signal, modelOverride);

        } catch (error: any) {
            if (error.name !== 'AbortError') {
                this.chatPanel.addMessageToDiscussion({ role: 'system', content: `❌ **Critical Error:** ${error.message}` });
            }
            this.deactivateAgent();
        } finally {
            this.processManager.unregister(processId);
        }
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
                this.deactivateAgent();
            }
        } catch (error: any) {
            this.deactivateAgent();
        } finally {
            this.processManager.unregister(processId);
        }
    }

    private async executePlan(startIndex: number = 0, signal: AbortSignal, modelOverride?: string) {
        if (!this.currentPlan) return;
    
        this.currentTaskIndex = startIndex;
        while (this.currentTaskIndex < this.currentPlan.tasks.length) {
            if (signal.aborted) {
                this.deactivateAgent();
                return;
            }
            const task = this.currentPlan.tasks[this.currentTaskIndex];
    
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
                    this.globalFailureLog.push(`Task ${task.id} (${task.action}) failed: ${result.output.substring(0, 200)}`);

                    const maxRetries = vscode.workspace.getConfiguration('lollmsVsCoder').get<number>('agentMaxRetries') || 1;
                    if (task.retries < maxRetries) {
                        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
                        const architectModel = config.get<string>('architectModelName') || modelOverride;
                        
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
                        this.deactivateAgent();
                        return;
                    }
                }
            }
            this.currentTaskIndex++;
        }
    
        this.deactivateAgent();
    }

    /**
     * Verifies if the agent has global permission to run a specific tool.
     */
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
                message: `🛑 **Global Permission Denied:** The action '${tool.name}' requires '${tool.permissionGroup}' access, which is currently disabled in your global Lollms settings. Please enable it in Settings -> Agent & Tools -> Permissions if you want the agent to perform this task.`
            };
        }

        return { allowed: true };
    }

    private async executeTask(action: string, params: any, signal: AbortSignal): Promise<{ success: boolean, output: string }> {
        const tool = this.toolManager.getTool(action);
        if (!tool) return { success: false, output: `Unknown action: ${action}` };

        // --- GLOBAL PERMISSION CHECK ---
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
            // Handle OS-level permission denied errors (EACCES / EPERM)
            if (error.message && (error.message.includes('EACCES') || error.message.includes('permission denied'))) {
                return { 
                    success: false, 
                    output: `❌ **OS Permission Error:** The operating system denied access to perform this action. This often happens if the project folder is read-only, or if the agent tried to access a system-protected file.\n\nRaw Error: ${error.message}` 
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
        const regex = /\{\{tasks\[(\d+)\]\.result\}\}/g;

        for (const key in task.parameters) {
            let value = task.parameters[key];
            if (typeof value === 'string') {
                let resolvedValue = value;
                let match;
                while ((match = regex.exec(value)) !== null) {
                    const taskId = parseInt(match[1], 10);
                    const sourceTask = this.currentPlan.tasks.find(t => t.id === taskId);
                    if (sourceTask && sourceTask.result !== null) {
                        resolvedValue = resolvedValue.replace(match[0], sourceTask.result);
                    } else {
                        throw new Error(`Dependency error: Task ${taskId} not executed yet.`);
                    }
                }
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
