import * as vscode from 'vscode';
import { ChatPanel } from './commands/chatPanel';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { ContextManager } from './contextManager';
import { GitIntegration } from './gitIntegration';
import * as os from 'os';
import * as path from 'path';
import { exec } from 'child_process';
import { InfoPanel } from './commands/infoPanel';
import { Plan, PlanParser } from './planParser';
import { getProcessedSystemPrompt } from './utils';
import { ProcessManager } from './processManager';

interface Task {
    id: number;
    task_type: 'simple_action' | 'agentic_action';
    action: string;
    description: string;
    parameters: { [key: string]: any };
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    result: string | null;
    retries: number;
}

export class AgentManager {
    private isActive: boolean = false;
    private currentPlan: Plan | null = null;
    private chatHistory: ChatMessage[] = [];
    private planParser: PlanParser;
    private processManager?: ProcessManager;

    constructor(
        private chatPanel: ChatPanel,
        private lollmsApi: LollmsAPI,
        private contextManager: ContextManager,
        private gitIntegration: GitIntegration,
        private extensionUri: vscode.Uri
    ) {
        this.planParser = new PlanParser(this.lollmsApi, this.contextManager);
    }

    public setProcessManager(processManager: ProcessManager) {
        this.processManager = processManager;
    }

    public getIsActive(): boolean {
        return this.isActive;
    }

    public toggleAgentMode() {
        this.isActive = !this.isActive;
        if (this.isActive) {
            this.chatPanel.addMessageToDiscussion({ role: 'system', content: `🤖 **Agent Mode Activated.** Using model: \`${this.lollmsApi.getModelName()}\`. Please provide your goal.` });
        } else {
            this.chatPanel.addMessageToDiscussion({ role: 'system', content: '🤖 **Agent Mode Deactivated.**' });
            this.chatPanel.displayPlan(null); // Clear the plan view
        }
    }

    public async run(initialObjective: string, fullChatHistory: ChatMessage[]) {
        if (!this.isActive) return;

        this.chatHistory = [...fullChatHistory];
        this.chatHistory.push({ role: 'user', content: initialObjective });
        
        this.chatPanel.displayPlan({ 
            objective: initialObjective,
            scratchpad: "🧠 Thinking... Generating the initial execution plan.",
            tasks: []
        });

        try {
            const planResult = await this.planParser.generateAndParsePlan(initialObjective);
            
            if (!planResult.plan) {
                 const failedPlanState = {
                    objective: initialObjective,
                    scratchpad: `❌ **Plan Generation Failed:** Could not generate a valid plan, even after self-correction attempts. \n\n**Error:** ${planResult.error}\n\n**Final Raw Response from Model:**\n\`\`\`\n${planResult.rawResponse}\n\`\`\``,
                    tasks: []
                };
                this.chatPanel.displayPlan(failedPlanState);
                this.deactivateAgent();
                return;
            }
            
            this.currentPlan = planResult.plan;
            this.chatPanel.displayPlan(this.currentPlan);
            await this.executePlan();

        } catch (error: any) {
            this.chatPanel.addMessageToDiscussion({ role: 'system', content: `❌ **Critical Error during planning:** ${error.message}` });
            this.deactivateAgent();
            return;
        }
    }

    private async executePlan() {
        if (!this.currentPlan) return;

        let currentTaskIndex = 0;
        while (currentTaskIndex < this.currentPlan.tasks.length) {
            const task = this.currentPlan.tasks[currentTaskIndex];

            if (task.status === 'pending') {
                task.status = 'in_progress';
                this.chatPanel.displayPlan(this.currentPlan);
                
                let result: { success: boolean; output: string; };
                try {
                    const resolvedParams = this.resolveParameters(task);
                    const taskWithResolvedParams = { ...task, parameters: resolvedParams };
                    result = await this.executeTask(taskWithResolvedParams);
                } catch (error: any) {
                    result = { success: false, output: error.message };
                }

                task.result = result.output;
                task.status = result.success ? 'completed' : 'failed';
                
                this.currentPlan.scratchpad += `\n\nTask ${task.id} (${task.action}) ${task.status}. Result:\n${result.output}`;
                this.chatPanel.displayPlan(this.currentPlan);

                if (!result.success) {
                    const maxRetries = vscode.workspace.getConfiguration('lollmsVsCoder').get<number>('agentMaxRetries') || 1;
                    if (task.retries < maxRetries) {
                        task.retries++;
                        const revisionSucceeded = await this.revisePlanForFailure(task);
                        if (!revisionSucceeded) {
                            this.chatPanel.addMessageToDiscussion({ role: 'system', content: `🛑 **Execution Halted:** Failed to generate a revised plan.` });
                            this.deactivateAgent();
                            return;
                        }
                        continue; 
                    } else {
                        let userChoice: string | undefined = '';
                        while (userChoice !== 'Stop' && userChoice !== 'Continue Anyway') {
                            userChoice = await vscode.window.showErrorMessage(
                                `Agent task "${task.description}" failed after ${task.retries} self-correction attempts. What should I do?`,
                                { modal: true },
                                'Stop', 'Continue Anyway', 'View Log'
                            );

                            if (userChoice === 'View Log') {
                                InfoPanel.createOrShow(this.extensionUri, `Log for Failed Task: ${task.id}`, `## Task Description\n${task.description}\n\n## Failure Log\n\`\`\`\n${task.result || 'No output available.'}\n\`\`\``);
                            } else if (userChoice === undefined) {
                                userChoice = 'Stop';
                            }
                        }

                        if (userChoice === 'Stop') {
                            this.chatPanel.addMessageToDiscussion({ role: 'system', content: `🛑 **Execution Halted:** User chose to stop after ${task.retries} failed attempts.` });
                            this.deactivateAgent();
                            return;
                        }
                    }
                }
            }
            currentTaskIndex++;
        }

        this.chatPanel.addMessageToDiscussion({ role: 'system', content: '✅ **Plan Complete:** All tasks have been executed.' });
        this.deactivateAgent();
    }

    private async revisePlanForFailure(failedTask: Task): Promise<boolean> {
        if (!this.currentPlan) return false;
        
        this.currentPlan.scratchpad += `\n\n---\n⚠️ **Task ${failedTask.id} Failed.** Attempting to self-correct (Attempt ${failedTask.retries})...\n---`;
        this.chatPanel.displayPlan(this.currentPlan);

        const planResult = await this.planParser.generateAndParsePlan(
            this.currentPlan.objective,
            this.currentPlan,
            failedTask.id,
            failedTask.result
        );

        if (!planResult.plan) {
            this.currentPlan.scratchpad += `\n\n❌ **Self-Correction Failed:** The fixer agent's response was invalid.\n\n**Raw Response:**\n${planResult.rawResponse}`;
            this.chatPanel.displayPlan(this.currentPlan);
            return false;
        }

        const revisedPlanFragment = planResult.plan;
        
        const failedTaskIndex = this.currentPlan.tasks.findIndex(t => t.id === failedTask.id);
        if (failedTaskIndex === -1) return false;

        this.currentPlan.tasks.splice(failedTaskIndex);

        let nextId = this.currentPlan.tasks.length > 0 ? Math.max(...this.currentPlan.tasks.map(t => t.id)) + 1 : 1;
        for (const newTask of revisedPlanFragment.tasks) {
            newTask.id = nextId++;
            this.currentPlan.tasks.push(newTask);
        }
        
        this.currentPlan.scratchpad += `\n\n--- PLAN REVISED after failure of task ${failedTask.id} ---`;
        this.chatPanel.displayPlan(this.currentPlan);
        return true;
    }
    
    private resolveParameters(task: Task): { [key: string]: any } {
        if (!this.currentPlan) {
            throw new Error("Cannot resolve parameters without a current plan.");
        }
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
                        throw new Error(`Could not resolve parameter: Source task ${taskId} has not completed successfully or has no result.`);
                    }
                }
                resolvedParams[key] = resolvedValue;
            } else {
                 resolvedParams[key] = value;
            }
        }
        return resolvedParams;
    }

    private async executeTask(task: Task): Promise<{ success: boolean; output: string }> {
        try {
            switch (task.task_type) {
                case 'simple_action':
                    return await this.executeSimpleAction(task);
                case 'agentic_action':
                    return await this.executeAgenticAction(task);
                default:
                    return { success: false, output: `Unknown task type: ${task.task_type}` };
            }
        } catch (e: any) {
            return { success: false, output: e.message };
        }
    }
    
    private async executeSimpleAction(task: Task): Promise<{ success: boolean, output: string }> {
        const { command, path: filePath, code, env_name, dependencies, script_path, question } = task.parameters;
        
        try {
            switch (task.action) {
                case 'request_user_input':
                    if (!question) return { success: false, output: "Error: 'question' parameter is required." };
                    const userInput = await vscode.window.showInputBox({ prompt: question, title: "Agent is requesting input" });
                    if (userInput === undefined) {
                        return { success: false, output: "User cancelled the input request." };
                    }
                    return { success: true, output: `User provided input: ${userInput}` };

                case 'create_python_environment':
                    if (!env_name) return { success: false, output: "Error: 'env_name' is required." };
                    return this.runCommand(`python -m venv ${env_name}`);

                case 'set_vscode_python_interpreter':
                    if (!env_name) return { success: false, output: "Error: 'env_name' is required." };
                    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                    if (!workspaceFolder) return { success: false, output: "Error: No active workspace folder."};
                    
                    const pythonExecutable = os.platform() === 'win32' 
                        ? path.join(env_name, 'Scripts', 'python.exe') 
                        : path.join(env_name, 'bin', 'python');
                    
                    const fullPath = path.join(workspaceFolder.uri.fsPath, pythonExecutable);
                    
                    const config = vscode.workspace.getConfiguration('python', workspaceFolder.uri);
                    await config.update('defaultInterpreterPath', fullPath, vscode.ConfigurationTarget.WorkspaceFolder);
                    
                    return { success: true, output: `Successfully set VS Code Python interpreter to: ${fullPath}` };

                case 'install_python_dependencies':
                    if (!env_name || !dependencies) return { success: false, output: "Error: 'env_name' and 'dependencies' are required." };
                    const pythonExec = os.platform() === 'win32' 
                        ? path.join(env_name, 'Scripts', 'python.exe') 
                        : path.join(env_name, 'bin', 'python');
                    const deps = (dependencies as string[]).join(' ');
                    return this.runCommand(`"${pythonExec}" -m pip install ${deps}`);
                
                case 'execute_python_script':
                    if (!env_name || !script_path) return { success: false, output: "Error: 'env_name' and 'script_path' are required." };
                    const pythonScriptExec = os.platform() === 'win32'
                        ? path.join(env_name, 'Scripts', 'python.exe')
                        : path.join(env_name, 'bin', 'python');
                    return this.runCommand(`"${pythonScriptExec}" ${script_path}`);

                case 'rewrite_file':
                    if (!filePath || code === undefined) return { success: false, output: "Error: 'path' and 'code' are required." };
                    const wsFolder = vscode.workspace.workspaceFolders?.[0];
                    if (wsFolder) {
                        const fileUri = vscode.Uri.joinPath(wsFolder.uri, filePath);
                        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(code, 'utf8'));
                        return { success: true, output: `Successfully wrote to file: ${filePath}` };
                    }
                    return { success: false, output: "Error: No active workspace folder." };

                case 'execute_command':
                    if (!command) return { success: false, output: "Error: 'command' argument is required." };
                    return await this.runCommand(command);
                
                case 'set_launch_entrypoint':
                        if (!task.parameters.file_path) {
                            return { success: false, output: "Error: 'file_path' parameter is required." };
                        }
                        const root = vscode.workspace.workspaceFolders?.[0];
                        if (!root) {
                            return { success: false, output: "Error: No active workspace folder." };
                        }
                        const launchJsonPath = vscode.Uri.joinPath(root.uri, '.vscode', 'launch.json');
                        let launchConfig;
                
                        try {
                            const fileContent = await vscode.workspace.fs.readFile(launchJsonPath);
                            launchConfig = JSON.parse(fileContent.toString());
                        } catch (error) {
                            // File doesn't exist, create a default one
                            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root.uri, '.vscode'));
                            launchConfig = {
                                version: '0.2.0',
                                configurations: []
                            };
                        }
                
                        if (!launchConfig.configurations || !Array.isArray(launchConfig.configurations)) {
                             launchConfig.configurations = [];
                        }
                
                        if (launchConfig.configurations.length === 0) {
                            launchConfig.configurations.push({
                                name: 'Run Lollms Project',
                                request: 'launch',
                                type: 'node', // A reasonable default
                                program: ''
                            });
                        }
                        
                        launchConfig.configurations[0].program = `\${workspaceFolder}/${task.parameters.file_path}`;
                        
                        try {
                            await vscode.workspace.fs.writeFile(launchJsonPath, Buffer.from(JSON.stringify(launchConfig, null, 4), 'utf8'));
                            return { success: true, output: `Successfully set launch.json entry point to '${task.parameters.file_path}'.` };
                        } catch (error: any) {
                            return { success: false, output: `Error writing to launch.json: ${error.message}` };
                        }

                default:
                    return { success: false, output: `Error: Unknown simple action '${task.action}'.` };
            }
        } catch (e: any) {
            return { success: false, output: `Error executing '${task.action}': ${e.message}` };
        }
    }

    private async executeAgenticAction(task: Task): Promise<{ success: boolean, output: string }> {
        if (!this.currentPlan) {
            return { success: false, output: "Cannot execute agentic action without a plan." };
        }

        switch (task.action) {
            case 'generate_code':
                const projectContext = await this.contextManager.getContextContent();
                let userPromptContent = task.parameters.user_prompt || `Generate code for ${task.parameters.file_path}`;

                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                const filePath = task.parameters.file_path;
                if (workspaceFolder && filePath) {
                    try {
                        const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
                        const fileContentBytes = await vscode.workspace.fs.readFile(fileUri);
                        const existingContent = Buffer.from(fileContentBytes).toString('utf8');
                        userPromptContent = `I am working on the file \`${filePath}\`. Here is its current content:\n\n\`\`\`\n${existingContent}\n\`\`\`\n\nMy instruction is: ${userPromptContent}`;
                    } catch (error) {
                    }
                }

                const coderSystemPrompt = this.getCoderSystemPrompt(task.parameters.system_prompt, this.currentPlan, projectContext.text);
                const coderUserPrompt: ChatMessage = { role: 'user', content: userPromptContent };
                const responseText = await this.lollmsApi.sendChat([coderSystemPrompt, coderUserPrompt]);
                
                const codeBlockRegex = /```(?:[\w-]*)\n([\s\S]+?)\n```/s;
                const match = responseText.match(codeBlockRegex);

                if (match && match[1]) {
                    return { success: true, output: match[1].trim() };
                } else if (responseText.trim().length > 0) {
                    return { success: true, output: responseText.trim() };
                } else {
                    return { success: false, output: `Coder agent failed to produce a valid code block or any content. Full response:\n${responseText}` };
                }
            
            case 'auto_select_context_files':
                if (!task.parameters.objective) {
                    return { success: false, output: "Error: 'objective' parameter is required for auto-selecting files." };
                }
            
                const fileTreeProvider = this.contextManager.getFileTreeProvider();
                if (!fileTreeProvider) {
                    return { success: false, output: "Error: File Tree Provider is not available." };
                }
                
                const fileList = await this.contextManager.getAutoSelectionForContext(task.parameters.objective);
            
                if (fileList && fileList.length > 0) {
                    await fileTreeProvider.addFilesToContext(fileList);
                    const fileListString = fileList.map(f => `- ${f}`).join('\n');
                    return { success: true, output: `Successfully added ${fileList.length} files to the context:\n${fileListString}` };
                } else if (fileList) {
                    return { success: true, output: "AI did not select any files for the given objective." };
                } else {
                    return { success: false, output: "AI failed to select files. The operation was aborted." };
                }

            default:
                return { success: false, output: `Unknown agentic action: ${task.action}` };
        }
    }

    private async runCommand(command: string): Promise<{ success: boolean, output: string }> {
        return new Promise(resolve => {
            exec(command, { cwd: vscode.workspace.workspaceFolders?.[0].uri.fsPath }, (error, stdout, stderr) => {
                const output = `STDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`;
                if (error) {
                    resolve({ success: false, output: `Error during command execution:\n${output}\n\nError Object:\n${error.message}` });
                    return;
                }
                resolve({ success: true, output: `Command executed successfully:\n${output}` });
            });
        });
    }

    private deactivateAgent() {
        this.isActive = false;
        this.currentPlan = null;
        this.chatPanel.updateAgentMode(false);
    }
    
    private getCoderSystemPrompt(customPrompt: string, plan: Plan, projectContext: string): ChatMessage {
        const agentPersonaPrompt = getProcessedSystemPrompt('agent');
        return {
            role: 'system',
            content: `You are a code generation AI. You will be given instructions and context to write or modify a file.
**CRITICAL INSTRUCTIONS:**
1.  **CODE ONLY:** Your entire response MUST be a single markdown code block containing the complete file content.
2.  **NO EXTRA TEXT:** Do not add any explanations, comments, or conversational text outside of the code block.
3.  **COMPLETE FILE:** Your output must be the full and complete code for the file, not just the changed parts.
4.  **NO PLACEHOLDERS:** Do not use placeholders like "...".
**CUSTOM INSTRUCTIONS FOR THIS TASK:**
${customPrompt}
**CONTEXT FOR YOUR TASK:**
- **Main Objective:** ${plan.objective}
- **Shared Scratchpad & History:**
${plan.scratchpad}
- **Project Structure & Context:**
${projectContext}

**Agent Persona:**
${agentPersonaPrompt}
`
        };
    }
}