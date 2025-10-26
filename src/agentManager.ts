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
import { DiscussionManager, Discussion } from './discussionManager';
import * as fs from 'fs/promises';

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
    private planParser: PlanParser;
    private processManager?: ProcessManager;
    private currentWorkspaceFolder?: vscode.WorkspaceFolder;
    private currentTaskIndex: number = 0;
    private currentDiscussion?: Discussion;

    constructor(
        private chatPanel: ChatPanel,
        private lollmsApi: LollmsAPI,
        private contextManager: ContextManager,
        private gitIntegration: GitIntegration,
        private discussionManager: DiscussionManager,
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
        
        const { id: processId, controller } = this.processManager.register(discussion.id, `Agent: ${initialObjective.substring(0, 40)}...`);
        
        try {
            this.currentWorkspaceFolder = workspaceFolder;
            this.currentDiscussion = discussion;
    
            this.chatHistory = [...discussion.messages];
            
            const initialPlanState = { 
                objective: initialObjective,
                scratchpad: "🧠 Thinking... Generating the initial execution plan.",
                tasks: []
            };
            this.displayAndSavePlan(initialPlanState);
    
            const planResult = await this.planParser.generateAndParsePlan(initialObjective, undefined, undefined, undefined, controller.signal, modelOverride);
            
            if (controller.signal.aborted) {
                this.chatPanel.addMessageToDiscussion({ role: 'system', content: '🛑 **Execution Halted:** User cancelled during planning.' });
                this.deactivateAgent();
                return;
            }

            if (!planResult.plan) {
                 const failedPlanState = {
                    objective: initialObjective,
                    scratchpad: `❌ **Plan Generation Failed:** Could not generate a valid plan, even after self-correction attempts. \n\n**Error:** ${planResult.error}\n\n**Final Raw Response from Model:**\n\`\`\`\n${planResult.rawResponse}\n\`\`\``,
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
                this.chatPanel.addMessageToDiscussion({ role: 'system', content: `❌ **Critical Error during planning:** ${error.message}` });
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
                    const taskWithResolvedParams = { ...task, parameters: resolvedParams };
                    result = await this.executeTask(taskWithResolvedParams, signal, modelOverride);
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
                            // Loop will continue from the corrected task index
                            continue;
                        } else {
                            // Self-correction failed, now we ask the user
                            task.can_retry = true;
                            this.displayAndSavePlan(this.currentPlan);
                            return; // Halt for user intervention
                        }
                    } else {
                        task.can_retry = true; // Allow one final manual retry
                        this.displayAndSavePlan(this.currentPlan);
    
                        let userChoice: string | undefined = '';
                        while (userChoice !== 'Stop' && userChoice !== 'Continue Anyway') {
                            userChoice = await vscode.window.showErrorMessage(
                                `Agent task "${task.description}" failed after ${task.retries} attempt(s). What should I do?`,
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
                            this.chatPanel.addMessageToDiscussion({ role: 'system', content: `🛑 **Execution Halted:** User chose to stop after failed attempts.` });
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

    private async revisePlanForFailure(failedTask: Task, signal: AbortSignal, modelOverride?: string): Promise<boolean> {
        if (!this.currentPlan) return false;
        
        failedTask.retries++;
        this.currentPlan.scratchpad += `\n\n---\n⚠️ **Task ${failedTask.id} Failed.** Attempting to self-correct (Attempt ${failedTask.retries})...\n---`;
        this.displayAndSavePlan(this.currentPlan);

        const planResult = await this.planParser.generateAndParsePlan(
            this.currentPlan.objective,
            this.currentPlan,
            failedTask.id,
            failedTask.result,
            signal,
            modelOverride
        );

        if (signal.aborted) { return false; }

        if (!planResult.plan) {
            this.currentPlan.scratchpad += `\n\n❌ **Self-Correction Failed:** The fixer agent's response was invalid.\n\n**Raw Response:**\n${planResult.rawResponse}`;
            this.displayAndSavePlan(this.currentPlan);
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
        this.displayAndSavePlan(this.currentPlan);
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

    private async executeTask(task: Task, signal: AbortSignal, modelOverride?: string): Promise<{ success: boolean; output: string }> {
        try {
            switch (task.task_type) {
                case 'simple_action':
                    return await this.executeSimpleAction(task, signal);
                case 'agentic_action':
                    return await this.executeAgenticAction(task, signal, modelOverride);
                default:
                    return { success: false, output: `Unknown task type: ${task.task_type}` };
            }
        } catch (e: any) {
            return { success: false, output: e.message };
        }
    }
    
    private async generateFileTree(startPath: string, prefix: string = ''): Promise<string> {
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

    private async executeSimpleAction(task: Task, signal: AbortSignal): Promise<{ success: boolean, output: string }> {
        const { command, path: filePath, code, env_name, dependencies, script_path, question } = task.parameters;
        
        try {
            switch (task.action) {
                case 'get_environment_details': {
                    const commands = {
                        python: 'python --version',
                        node: 'node --version',
                        npm: 'npm --version',
                        git: 'git --version'
                    };
                    let detailsOutput = 'Environment Details:\n';
                    const promises = Object.entries(commands).map(async ([tool, command]) => {
                        const result = await this.runCommand(command, signal);
                        if (signal.aborted) return `- ${tool}: Cancelled`;
                        const output = result.output.replace(/STDOUT:|STDERR:/g, '').trim();
                        if (result.success && output) {
                            return `- ${tool}: ${output.split('\n')[0]}`; // Take first line
                        } else {
                            return `- ${tool}: Not found or error`;
                        }
                    });
                
                    const results = await Promise.all(promises);
                    detailsOutput += results.join('\n');
                    return { success: true, output: detailsOutput };
                }
                case 'list_files': {
                    if (!this.currentWorkspaceFolder) {
                        return { success: false, output: "Error: No active workspace folder." };
                    }
                    const listPath = task.parameters.path || '.';
                    const targetPath = path.join(this.currentWorkspaceFolder.uri.fsPath, listPath);
                    
                    try {
                        const resolvedPath = path.resolve(targetPath);
                        const resolvedWorkspaceRoot = path.resolve(this.currentWorkspaceFolder.uri.fsPath);
                        if (!resolvedPath.startsWith(resolvedWorkspaceRoot)) {
                             return { success: false, output: "Error: Access to paths outside the workspace is not allowed." };
                        }
                        
                        const fileTree = await this.generateFileTree(targetPath);
                        return { success: true, output: `File listing for '${listPath}':\n${fileTree}` };
                    } catch (error: any) {
                        return { success: false, output: `Error listing files: ${error.message}` };
                    }
                }
                case 'request_user_input':
                    if (!question) return { success: false, output: "Error: 'question' parameter is required." };
                    const userInput = await vscode.window.showInputBox({ prompt: question, title: "Agent is requesting input" });
                    if (userInput === undefined) {
                        return { success: false, output: "User cancelled the input request." };
                    }
                    return { success: true, output: `User provided input: ${userInput}` };

                case 'read_file':
                    if (!filePath) return { success: false, output: "Error: 'path' parameter is required." };
                    const wsFolderReadFile = this.currentWorkspaceFolder;
                    if (wsFolderReadFile) {
                        try {
                            const fileUri = vscode.Uri.joinPath(wsFolderReadFile.uri, filePath);
                            const fileContent = await vscode.workspace.fs.readFile(fileUri);
                            return { success: true, output: Buffer.from(fileContent).toString('utf8') };
                        } catch (error: any) {
                             return { success: false, output: `Error reading file ${filePath}: ${error.message}` };
                        }
                    }
                     return { success: false, output: "Error: No active workspace folder." };

                case 'create_python_environment':
                    if (!env_name) return { success: false, output: "Error: 'env_name' is required." };
                    return this.runCommand(`python -m venv ${env_name}`, signal);

                case 'set_vscode_python_interpreter':
                    if (!env_name) return { success: false, output: "Error: 'env_name' is required." };
                    const workspaceFolder = this.currentWorkspaceFolder;
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
                    return this.runCommand(`"${pythonExec}" -m pip install ${deps}`, signal);
                
                case 'execute_python_script':
                    if (!env_name || !script_path) return { success: false, output: "Error: 'env_name' and 'script_path' are required." };
                    const pythonScriptExec = os.platform() === 'win32'
                        ? path.join(env_name, 'Scripts', 'python.exe')
                        : path.join(env_name, 'bin', 'python');
                    return this.runCommand(`"${pythonScriptExec}" ${script_path}`, signal);

                case 'execute_command':
                    if (!command) return { success: false, output: "Error: 'command' argument is required." };
                    return await this.runCommand(command, signal);
                
                case 'set_launch_entrypoint':
                        if (!task.parameters.file_path) {
                            return { success: false, output: "Error: 'file_path' parameter is required." };
                        }
                        const root = this.currentWorkspaceFolder;
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

    private async executeAgenticAction(task: Task, signal: AbortSignal, modelOverride?: string): Promise<{ success: boolean, output: string }> {
        if (!this.currentPlan) {
            return { success: false, output: "Cannot execute agentic action without a plan." };
        }

        switch (task.action) {
            case 'generate_code': {
                const projectContext = await this.contextManager.getContextContent();
                let userPromptContent = task.parameters.user_prompt || `Generate code for ${task.parameters.file_path}`;

                const workspaceFolder = this.currentWorkspaceFolder;
                const filePath = task.parameters.file_path;
                if (!filePath) {
                    return { success: false, output: "Error: 'file_path' parameter is required for generate_code action." };
                }

                if (workspaceFolder) {
                    try {
                        const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
                        const fileContentBytes = await vscode.workspace.fs.readFile(fileUri);
                        const existingContent = Buffer.from(fileContentBytes).toString('utf8');
                        userPromptContent = `I am working on the file \`${filePath}\`. Here is its current content:\n\n\`\`\`\n${existingContent}\n\`\`\`\n\nMy instruction is: ${userPromptContent}`;
                    } catch (error) {
                        // File doesn't exist, which is fine for creation.
                    }
                }

                const coderSystemPrompt = this.getCoderSystemPrompt(task.parameters.system_prompt, this.currentPlan, projectContext.text);
                const coderUserPrompt: ChatMessage = { role: 'user', content: userPromptContent };
                const responseText = await this.lollmsApi.sendChat([coderSystemPrompt, coderUserPrompt], null, signal, modelOverride);
                
                const codeBlockRegex = /```(?:[\w-]*)\n([\s\S]+?)\n```/s;
                const match = responseText.match(codeBlockRegex);
                const generatedCode = match ? match[1].trim() : responseText.trim();

                if (!generatedCode) {
                    return { success: false, output: `Coder agent failed to produce any valid code. Full response:\n${responseText}` };
                }

                if (!workspaceFolder) {
                    return { success: false, output: "Error: No active workspace folder to write the file." };
                }
                
                try {
                    const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
                    const parentUri = vscode.Uri.joinPath(fileUri, '..');
                    await vscode.workspace.fs.createDirectory(parentUri);
                    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(generatedCode, 'utf8'));
                    return { success: true, output: `Successfully generated and wrote code to file: ${filePath}` };
                } catch (error: any) {
                    return { success: false, output: `Error writing generated code to file ${filePath}: ${error.message}` };
                }
            }
            
            case 'auto_select_context_files':
                if (!task.parameters.objective) {
                    return { success: false, output: "Error: 'objective' parameter is required for auto-selecting files." };
                }
            
                const fileTreeProvider = this.contextManager.getContextStateProvider();
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

    private async runCommand(command: string, signal: AbortSignal): Promise<{ success: boolean, output: string }> {
        return new Promise(resolve => {
            if (!this.currentWorkspaceFolder) {
                resolve({ success: false, output: "Error: Agent has no active workspace folder to run command in." });
                return;
            }
            const child = exec(command, { cwd: this.currentWorkspaceFolder.uri.fsPath }, (error, stdout, stderr) => {
                const stdoutContent = stdout.trim();
                const stderrContent = stderr.trim();
                let output = '';
    
                if (stdoutContent) {
                    output += `STDOUT:\n${stdoutContent}\n\n`;
                }
                if (stderrContent) {
                    output += `STDERR:\n${stderrContent}`;
                }
    
                if (error) {
                    resolve({ success: false, output: `Error during command execution:\n${output.trim()}\n\nError Object:\n${error.message}` });
                    return;
                }
                resolve({ success: true, output: `Command executed successfully.\n${output.trim() || '(No output)'}` });
            });
            
            signal.addEventListener('abort', () => {
                child.kill();
                resolve({ success: false, output: 'Command cancelled by user.' });
            });
        });
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