import * as vscode from 'vscode';
import { ChatPanel } from './commands/chatPanel/chatPanel';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { ContextManager } from './contextManager';
import { GitIntegration } from './gitIntegration';
import * as os from 'os';
import * as path from 'path';
import { exec } from 'child_process';
import { InfoPanel } from './commands/infoPanel';
import { PlanParser } from './planParser';
import { getProcessedSystemPrompt } from './utils';
import { ProcessManager } from './processManager';
import { DiscussionManager, Discussion } from './discussionManager';
import * as fs from 'fs/promises';
import { ToolManager } from './tools/toolManager';
import { ToolExecutionEnv, ToolDefinition, Plan } from './tools/tool';
import { CodeGraphManager } from './codeGraphManager';
import { SkillsManager } from './skillsManager';

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
            this.chatPanel.addMessageToDiscussion({ role: 'system', content: `🤖 **Agent Mode Activated.** Using model: \`${this.lollmsApi.getModelName()}\`. Please provide your goal.` });
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

    /**
     * Filters available tools based on the discussion capabilities.
     * This ensures the planner doesn't try to use tools that are disabled.
     */
    private getContextAwareTools(discussion: Discussion): ToolDefinition[] {
        const baseTools = this.toolManager.getEnabledTools();
        const caps = discussion.capabilities;
        
        if (!caps) return baseTools;

        return baseTools.filter(tool => {
            if (tool.name === 'search_web' && !caps.webSearch) return false;
            if (tool.name === 'search_arxiv' && !caps.arxivSearch) return false;
            if (tool.name === 'generate_image' && !caps.imageGen) return false;
            return true;
        });
    }

    public async run(initialObjective: string, discussion: Discussion, workspaceFolder: vscode.WorkspaceFolder, modelOverride?: string) {
        if (!this.isActive || !this.processManager) return;
        
        const { id: processId, controller } = this.processManager.register(discussion.id, `Agent: ${initialObjective.substring(0, 40)}...`);
        
        try {
            this.currentWorkspaceFolder = workspaceFolder;
            this.currentDiscussion = discussion;
            this.chatHistory = [...discussion.messages];
            
            // Filter tools based on capabilities
            const allowedTools = this.getContextAwareTools(discussion);

            const initialPlanState: Plan = { 
                objective: initialObjective,
                scratchpad: "🧠 Thinking... Generating the initial execution plan.",
                tasks: []
            };
            this.displayAndSavePlan(initialPlanState);
    
            const planResult = await this.planParser.generateAndParsePlan(
                initialObjective, 
                undefined, 
                undefined, 
                undefined, 
                controller.signal, 
                modelOverride,
                this.chatHistory,
                allowedTools // Pass filtered tools
            );
            
            if (controller.signal.aborted) {
                this.chatPanel.addMessageToDiscussion({ role: 'system', content: '🛑 **Execution Halted:** User cancelled during planning.' });
                this.deactivateAgent();
                return;
            }

            if (!planResult.plan) {
                 const failedPlanState: Plan = {
                    objective: initialObjective,
                    scratchpad: `❌ **Plan Generation Failed:** ${planResult.error}\n\nRaw:\n\`\`\`\n${planResult.rawResponse}\n\`\`\``,
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
            return;
        } finally {
            this.processManager.unregister(processId);
        }
    }

    public async retryFailedTask(taskId: number) {
        if (!this.currentPlan || !this.processManager || !this.currentDiscussion) return;

        const { id: processId, controller } = this.processManager.register(this.currentDiscussion.id, `Agent: Retrying task ${taskId}...`);

        try {
            const failedTaskIndex = this.currentPlan.tasks.findIndex(t => t.id === taskId);
            if (failedTaskIndex === -1) return;
            
            const failedTask = this.currentPlan.tasks[failedTaskIndex];
            if (failedTask.status !== 'failed' || !failedTask.can_retry) return;
    
            failedTask.status = 'in_progress';
            failedTask.retries++;
            failedTask.can_retry = false;
            this.displayAndSavePlan(this.currentPlan);
            
            const revisionSucceeded = await this.revisePlanForFailure(failedTask, controller.signal, this.currentDiscussion.model);
            if (revisionSucceeded) {
                await this.executePlan(failedTaskIndex, controller.signal, this.currentDiscussion.model);
            } else {
                this.chatPanel.addMessageToDiscussion({ role: 'system', content: `🛑 **Execution Halted:** Failed to generate a revised plan.` });
                this.deactivateAgent();
            }
        } catch (error: any) {
             if (error.name !== 'AbortError') {
                this.chatPanel.addMessageToDiscussion({ role: 'system', content: `❌ **Critical Error during retry:** ${error.message}` });
            }
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
                this.chatPanel.addMessageToDiscussion({ role: 'system', content: `🛑 **Execution Halted:** User cancelled.` });
                this.deactivateAgent();
                return;
            }
            const task = this.currentPlan.tasks[this.currentTaskIndex];
    
            if (task.status === 'pending') {
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
    
                this.currentPlan.scratchpad += `\n\nTask ${task.id} (${task.action}) ${task.status}. Result:\n${result.output}`;
                this.displayAndSavePlan(this.currentPlan);
    
                if (!result.success) {
                    const maxRetries = vscode.workspace.getConfiguration('lollmsVsCoder').get<number>('agentMaxRetries') || 1;
                    if (task.retries < maxRetries) {
                        const revisionSucceeded = await this.revisePlanForFailure(task, signal, modelOverride);
                        if (revisionSucceeded) {
                            continue;
                        } else {
                            task.can_retry = true;
                            this.displayAndSavePlan(this.currentPlan);
                            return; 
                        }
                    } else {
                        task.can_retry = true;
                        this.displayAndSavePlan(this.currentPlan);
    
                        let userChoice: string | undefined = '';
                        while (userChoice !== 'Stop' && userChoice !== 'Continue Anyway') {
                            userChoice = await vscode.window.showErrorMessage(
                                `Agent task "${task.description}" failed. What should I do?`,
                                { modal: true },
                                'Stop', 'Continue Anyway', 'View Log'
                            );
    
                            if (userChoice === 'View Log') {
                                InfoPanel.createOrShow(this.extensionUri, `Log for Task: ${task.id}`, `## Failure Log\n\`\`\`\n${task.result}\n\`\`\``);
                            } else if (userChoice === undefined) {
                                userChoice = 'Stop';
                            }
                        }
    
                        if (userChoice === 'Stop') {
                            this.chatPanel.addMessageToDiscussion({ role: 'system', content: `🛑 **Execution Halted:** User chose to stop.` });
                            this.deactivateAgent();
                            return;
                        }
                    }
                }
            }
            this.currentTaskIndex++;
        }
    
        this.chatPanel.addMessageToDiscussion({ role: 'system', content: '✅ **Plan Complete:** All tasks have been executed.' });
        this.deactivateAgent();
    }

    private async executeTask(action: string, params: any, signal: AbortSignal): Promise<{ success: boolean, output: string }> {
        const tool = this.toolManager.getTool(action);
        if (!tool) {
            return { success: false, output: `Unknown action: ${action}` };
        }

        // Check again if allowed in discussion (Double safety)
        if (this.currentDiscussion && this.currentDiscussion.capabilities) {
            if (action === 'search_web' && !this.currentDiscussion.capabilities.webSearch) return { success: false, output: "Web Search disabled."};
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
        
        return tool.execute(params, env, signal);
    }
    
    // ... (rest of methods: revisePlanForFailure, replan, etc. - ensure revisePlan passes allowedTools too)
    
    private async revisePlanForFailure(failedTask: Task, signal: AbortSignal, modelOverride?: string): Promise<boolean> {
        if (!this.currentPlan || !this.currentDiscussion) return false;
        
        const allowedTools = this.getContextAwareTools(this.currentDiscussion);

        failedTask.retries++;
        this.currentPlan.scratchpad += `\n\n---\n⚠️ **Task ${failedTask.id} Failed.** Attempting to self-correct...\n---`;
        this.displayAndSavePlan(this.currentPlan);

        const planResult = await this.planParser.generateAndParsePlan(
            this.currentPlan.objective,
            this.currentPlan,
            failedTask.id,
            failedTask.result,
            signal,
            modelOverride,
            this.chatHistory,
            allowedTools
        );

        if (signal.aborted) { return false; }

        if (!planResult.plan) {
            this.currentPlan.scratchpad += `\n\n❌ **Self-Correction Failed:** Invalid response.\n${planResult.rawResponse}`;
            this.displayAndSavePlan(this.currentPlan);
            return false;
        }

        const revisedPlanFragment = planResult.plan;
        const failedTaskIndex = this.currentPlan.tasks.findIndex(t => t.id === failedTask.id);
        
        this.currentPlan.tasks.splice(failedTaskIndex);

        let nextId = this.currentPlan.tasks.length > 0 ? Math.max(...this.currentPlan.tasks.map(t => t.id)) + 1 : 1;
        for (const newTask of revisedPlanFragment.tasks) {
            newTask.id = nextId++;
            this.currentPlan.tasks.push(newTask);
        }
        
        this.currentPlan.scratchpad += `\n\n--- PLAN REVISED ---`;
        this.displayAndSavePlan(this.currentPlan);
        return true;
    }

    public async replan(instruction: string, signal: AbortSignal, modelOverride?: string): Promise<{ success: boolean; output: string; }> {
        if (!this.currentPlan) return { success: false, output: "No active plan." };

        const completedTasks = this.currentPlan.tasks.filter(t => t.status === 'completed');
        const tasksSummary = completedTasks.map(t => `- Task ${t.id} (${t.action}): Completed`).join('\n');
        
        const allowedTools = this.currentDiscussion ? this.getContextAwareTools(this.currentDiscussion) : this.toolManager.getEnabledTools();
        const systemPrompt = this.planParser.getPlannerSystemPrompt(true, allowedTools);
        
        const promptContent = `
The original objective was: "${this.currentPlan.objective}"
Completed tasks:
${tasksSummary}

New Instruction: "${instruction}"

Generate a NEW set of tasks to replace the pending ones.
Start ID from: ${completedTasks.length > 0 ? completedTasks[completedTasks.length-1].id + 1 : 1}.
`;

        try {
            const rawResponse = await this.lollmsApi.sendChat([systemPrompt, { role: 'user', content: promptContent }], null, signal, modelOverride);
            const jsonString = this.planParser.extractJson(stripThinkingTags(rawResponse));
            
            if (!jsonString) return { success: false, output: "Failed to parse new plan." };

            const newPlanFragment = JSON.parse(jsonString) as Plan;
            const splitIndex = this.currentTaskIndex + 1;
            this.currentPlan.tasks.splice(splitIndex);

            let nextId = this.currentPlan.tasks.length > 0 ? Math.max(...this.currentPlan.tasks.map(t => t.id)) + 1 : 1;
            for (const newTask of newPlanFragment.tasks) {
                newTask.id = nextId++;
                newTask.status = 'pending';
                this.currentPlan.tasks.push(newTask);
            }

            this.currentPlan.scratchpad += `\n\n--- PLAN MODIFIED: "${instruction}" ---`;
            this.displayAndSavePlan(this.currentPlan);
            return { success: true, output: "Plan successfully modified." };

        } catch (error: any) {
            return { success: false, output: `Error rewriting plan: ${error.message}` };
        }
    }
    
    private resolveParameters(task: Task): { [key: string]: any } {
        if (!this.currentPlan) throw new Error("No current plan.");
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
                    if (sourceTask && sourceTask.status === 'completed' && sourceTask.result !== null) {
                        resolvedValue = resolvedValue.replace(match[0], sourceTask.result);
                    } else {
                        throw new Error(`Dependant task ${taskId} not completed.`);
                    }
                }
                resolvedParams[key] = resolvedValue;
            } else {
                 resolvedParams[key] = value;
            }
        }
        return resolvedParams;
    }

    public async generateFileTree(startPath: string, prefix: string = ''): Promise<string> {
        let result = '';
        let entries;
        try {
            entries = await fs.readdir(startPath, { withFileTypes: true });
        } catch (e) {
            return ` (could not read directory)\n`;
        }
    
        const sortedEntries = entries.sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
        });
    
        for (let i = 0; i < sortedEntries.length; i++) {
            const entry = sortedEntries[i];
            const isLast = i === sortedEntries.length - 1;
            const connector = isLast ? '└── ' : '├── ';
    
            if (['.git', 'node_modules', '__pycache__', '.vscode', '.lollms', 'venv', '.venv'].includes(entry.name)) {
                continue;
            }
    
            result += prefix + connector + entry.name + '\n';
            
            if (entry.isDirectory()) {
                const newPrefix = prefix + (isLast ? '    ' : '│   ');
                result += await this.generateFileTree(path.join(startPath, entry.name), newPrefix);
            }
        }
        return result;
    }

    public async runCommand(command: string, signal: AbortSignal): Promise<{ success: boolean, output: string }> {
        return new Promise(resolve => {
            if (!this.currentWorkspaceFolder) {
                resolve({ success: false, output: "Error: No active workspace." });
                return;
            }
            const child = exec(command, { cwd: this.currentWorkspaceFolder.uri.fsPath }, (error, stdout, stderr) => {
                let output = '';
                if (stdout.trim()) output += `STDOUT:\n${stdout.trim()}\n\n`;
                if (stderr.trim()) output += `STDERR:\n${stderr.trim()}`;
    
                if (error) {
                    resolve({ success: false, output: `Error:\n${output.trim()}\n\nCode: ${error.code}` });
                    return;
                }
                resolve({ success: true, output: `Success.\n${output.trim() || '(No output)'}` });
            });
            
            signal.addEventListener('abort', () => {
                child.kill();
                resolve({ success: false, output: 'Command cancelled.' });
            });
        });
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
        this.currentWorkspaceFolder = undefined;
        this.currentDiscussion = undefined;
        this.chatPanel.updateAgentMode(false);
    }
}
