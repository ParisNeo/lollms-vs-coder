import * as vscode from 'vscode';
import { ChatPanel } from './commands/chatPanel';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { ContextManager } from './contextManager';
import { GitIntegration } from './gitIntegration';
import * as os from 'os';
import { exec } from 'child_process';

// Defines the structure of a tool call parsed from the AI's response
interface ToolCall {
    tool_name: string;
    [key: string]: string; // For arguments like 'path', 'code', 'command'
}

export class AgentManager {
    private isActive: boolean = false;
    private scratchpad: string = "I have a new objective. I need to think step-by-step. First, I will explore the project structure to understand the context.";
    private chatHistory: ChatMessage[] = [];

    constructor(
        private chatPanel: ChatPanel,
        private lollmsApi: LollmsAPI,
        private contextManager: ContextManager,
        private gitIntegration: GitIntegration
    ) {}

    public getIsActive(): boolean {
        return this.isActive;
    }

    public toggleAgentMode() {
        this.isActive = !this.isActive;
        if (this.isActive) {
            this.chatPanel.addMessageToDiscussion({ role: 'system', content: '🤖 Agent Mode Activated. I will now perform multi-step operations to achieve your objectives. I will ask for confirmation before executing commands or modifying files.' });
        } else {
            this.chatPanel.addMessageToDiscussion({ role: 'system', content: '🤖 Agent Mode Deactivated.' });
        }
    }

    public async run(initialObjective: string, fullChatHistory: ChatMessage[]) {
        if (!this.isActive) return;

        this.chatHistory = [...fullChatHistory]; // Use a copy of the discussion history
        this.chatHistory.push({ role: 'user', content: initialObjective });

        // Add a message to the UI that the agent is starting
        this.chatPanel.addMessageToDiscussion({ role: 'system', content: `🎯 **Objective:** ${initialObjective}\n\nThinking...` });

        let step = 0;
        const maxSteps = 10; // Safety brake

        while (step < maxSteps) {
            const agentResponse = await this.executeStep();
            if (!agentResponse || agentResponse.finish) {
                this.chatPanel.addMessageToDiscussion({ role: 'system', content: '✅ Agent has finished the task.' });
                this.isActive = false; // Automatically deactivate on finish
                this.chatPanel.updateAgentMode(false);
                break;
            }
            step++;
            if (step >= maxSteps) {
                this.chatPanel.addMessageToDiscussion({ role: 'system', content: '⚠️ Agent reached maximum steps. Deactivating.' });
                this.isActive = false;
                this.chatPanel.updateAgentMode(false);
            }
        }
    }

    private async executeStep(): Promise<{ finish: boolean } | null> {
        const systemPrompt = this.getSystemPrompt();
        const responseText = await this.lollmsApi.sendChat([systemPrompt, ...this.chatHistory]);

        // 1. Parse the response
        const userVisibleText = responseText.substring(0, responseText.indexOf('<scratchpad>')).trim();
        const scratchpadText = this.parseTag(responseText, 'scratchpad');
        const toolCalls = this.parseToolCalls(responseText);

        // 2. Update internal state and UI
        if (scratchpadText) {
            this.scratchpad = scratchpadText;
        }
        if (userVisibleText) {
            this.chatPanel.addMessageToDiscussion({ role: 'assistant', content: userVisibleText });
        }
        this.chatHistory.push({ role: 'assistant', content: responseText });

        // 3. Execute tools
        if (toolCalls.length === 0) {
            return null; // The agent might just be thinking
        }

        let toolResults = '';
        for (const call of toolCalls) {
            if (call.tool_name === 'finish') {
                return { finish: true };
            }
            const result = await this.executeTool(call);
            toolResults += `Tool: ${call.tool_name}\nResult:\n${result}\n\n`;
        }
        
        // 4. Add tool results to history for the next step
        const toolResponseMessage: ChatMessage = { role: 'system', content: `TOOL_RESULTS:\n${toolResults}` };
        this.chatHistory.push(toolResponseMessage);
        this.chatPanel.addMessageToDiscussion({ role: 'system', content: "Executing tool..." }); // Let the user know something is happening

        return { finish: false };
    }

    private async executeTool(call: ToolCall): Promise<string> {
        try {
            switch (call.tool_name) {
                case 'list_project_tree':
                    const allFiles = await this.contextManager.getFileTreeProvider()?.getAllVisibleFiles() || [];
                    const filteredTree = allFiles.filter(f => !f.includes('node_modules') && !f.includes('__pycache__') && !/venv/i.test(f));
                    return `Project structure:\n${filteredTree.join('\n')}`;

                case 'show_file_content':
                    const content = await this.contextManager.getContextContent();
                    return content.text;

                case 'rewrite_file':
                    const { path, code } = call;
                    if (!path || !code) return "Error: 'path' and 'code' arguments are required for rewrite_file.";

                    const confirmRewrite = await vscode.window.showWarningMessage(
                        `The AI agent wants to completely rewrite the file: \`${path}\`. Do you approve?`,
                        { modal: true }, "Approve"
                    );
                    if (confirmRewrite !== 'Approve') return "User denied file modification.";
                    
                    if (await this.gitIntegration.isGitRepo()) {
                        await this.gitIntegration.commitWithMessage(`lollms-agent: pre-modification snapshot before rewriting ${path}`);
                    }
                    
                    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                    if (workspaceFolder) {
                        const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, path);
                        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(code, 'utf8'));
                        return `Successfully rewrote file: ${path}`;
                    }
                    return "Error: No active workspace folder.";

                case 'execute_command':
                    const { command } = call;
                    if (!command) return "Error: 'command' argument is required.";

                    const confirmExec = await vscode.window.showWarningMessage(
                        `The AI agent wants to execute the following terminal command:\n\n\`${command}\`\n\nDo you approve?`,
                        { modal: true }, "Approve"
                    );
                    if (confirmExec !== 'Approve') return "User denied command execution.";

                    return new Promise(resolve => {
                        exec(command, { cwd: vscode.workspace.workspaceFolders?.[0].uri.fsPath }, (error, stdout, stderr) => {
                            if (error) {
                                resolve(`Error executing command:\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
                                return;
                            }
                            resolve(`Command executed successfully:\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
                        });
                    });

                default:
                    return `Error: Unknown tool '${call.tool_name}'.`;
            }
        } catch (e: any) {
            return `Error executing tool '${call.tool_name}': ${e.message}`;
        }
    }

    private parseTag(text: string, tagName: string): string | null {
        const regex = new RegExp(`<${tagName}>(.*?)</${tagName}>`, 's');
        const match = text.match(regex);
        return match ? match[1] : null;
    }
    
    private parseToolCalls(text: string): ToolCall[] {
        const calls: ToolCall[] = [];
        const regex = /<tool_call>(.*?)<\/tool_call>/gs;
        let match;
        while ((match = regex.exec(text)) !== null) {
            const innerXml = match[1];
            const toolNameMatch = innerXml.match(/<tool_name>(.*?)<\/tool_name>/);
            if (!toolNameMatch) continue;
            
            const toolName = toolNameMatch[1];
            const call: ToolCall = { tool_name: toolName };
            
            const argRegex = /<(\w+)>(.*?)<\/(\w+)>/gs;
            let argMatch;
            while ((argMatch = argRegex.exec(innerXml)) !== null) {
                if (argMatch[1] !== 'tool_name') {
                    call[argMatch[1]] = argMatch[2];
                }
            }
            calls.push(call);
        }
        return calls;
    }

    private getSystemPrompt(): ChatMessage {
        return {
            role: 'system',
            content: `You are an autonomous AI agent integrated into VS Code, currently in "Agent Mode". Your goal is to achieve the user's objective by thinking step-by-step and using the tools provided. The user has authorized you but will be asked for final confirmation on any file modifications or command executions.
            
OS: ${os.platform()}

**Your Thought Process:**
At each step, you must first update your scratchpad. Then, think about what to do next. Finally, decide if you need to call one or more tools.

**Available Tools:**
You can call tools using the XML format: <tool_call>...</tool_call>

1.  **list_project_tree**: Shows the project's file structure.
    -   Usage: \`<tool_call><tool_name>list_project_tree</tool_name></tool_call>\`

2.  **show_file_content**: Shows the content of all files currently in the AI's context.
    -   Usage: \`<tool_call><tool_name>show_file_content</tool_name></tool_call>\`

3.  **rewrite_file**: Completely replaces the content of a file. **CRITICAL**: The user will be asked to approve this.
    -   Usage: \`<tool_call><tool_name>rewrite_file</tool_name><path>path/to/file.ext</path><code>... full new content ...</code></tool_call>\`

4.  **execute_command**: Executes a shell command. **CRITICAL**: The user will be asked to approve this.
    -   Usage: \`<tool_call><tool_name>execute_command</tool_name><command>npm install</command></tool_call>\`

5.  **finish**: Use this tool when you believe the objective is fully complete.
    -   Usage: \`<tool_call><tool_name>finish</tool_name></tool_call>\`

**Response Format (You MUST follow this structure):**
1.  **Reasoning (User-Visible):** First, write your reasoning and next steps in a user-friendly way.
2.  **Scratchpad (Hidden):** Update your thoughts and plan inside <scratchpad> tags.
3.  **Tool Calls (Hidden):** Finally, list all tool calls you want to make inside <tool_call> tags.

**Example Response:**
I see the file structure. Now I need to read the main 'index.js' file to understand the application's entry point.

<scratchpad>
Objective: Refactor the main server file.
Plan:
1.  List project tree (done).
2.  Read 'src/index.js' to understand its content.
3.  Rewrite the file with better comments and structure.
4.  Finish.
Current Step: Reading the file.
</scratchpad>
<tool_call>
    <tool_name>show_file_content</tool_name>
    <path>src/index.js</path>
</tool_call>
`
        };
    }
}