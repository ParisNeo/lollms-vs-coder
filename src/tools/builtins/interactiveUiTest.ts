import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { ToolDefinition, ToolExecutionEnv } from '../tool';
import { stripThinkingTags } from '../../utils';

export const interactiveUiTestTool: ToolDefinition = {
    name: "interactive_ui_test",
    description: "The safest way to test GUI apps. Launches the app in the background, prompts the user to interact with it manually, and waits indefinitely. Once the user finishes, it captures, compresses (if too large), and returns the terminal logs.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'shell_execution',
    parameters: [
        { name: "command", type: "string", description: "The command to launch the UI app (e.g., 'python main.py').", required: true },
        { name: "user_instructions", type: "string", description: "Clear instructions for the user (e.g., 'Please click the Submit button and then close the window').", required: true },
        { name: "log_handle", type: "string", description: "A unique name for this test run (e.g., 'auth_ui_test_1').", required: true }
    ],
    async execute(params: { command: string, user_instructions: string, log_handle: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot || !env.agentManager) return { success: false, output: "Error: Agent environment not initialized." };

        const logFileName = `.lollms/logs/${params.log_handle}_${Date.now()}.log`;
        const logPath = path.join(env.workspaceRoot.uri.fsPath, logFileName);
        await fs.mkdir(path.dirname(logPath), { recursive: true });

        // 1. Launch the process in background with redirection
        const isWin = process.platform === 'win32';
        let launchCmd = "";
        if (isWin) {
            launchCmd = `Start-Process powershell.exe -ArgumentList "-NoProfile -Command ${params.command} > ${logFileName} 2>&1" -WindowStyle Normal`;
        } else {
            launchCmd = `nohup ${params.command} > "${logFileName}" 2>&1 & echo $!`;
        }

        env.agentManager.ui.addMessageToDiscussion({ 
            role: 'system', 
            content: `🚀 **Launching UI Application**: \`${params.command}\`...` 
        });

        const launchResult = await env.agentManager.runCommand(launchCmd, signal);
        if (!launchResult.success) return launchResult;

        // 2. Prompt user for interaction and WAIT
        const formXml = `
<lollms_form id="interactive_ui_${params.log_handle}" title="Interactive UI Test: ${params.log_handle}">
    <div style="margin-bottom:15px; line-height:1.5;">
        <strong>Instructions for User:</strong><br>
        ${params.user_instructions}
    </div>
    <p style="font-size:11px; opacity:0.8;">The terminal output is being recorded to <code>${logFileName}</code>. 
    Close the application and click the button below once you have finished the test.</p>
    <submit label="Test Finished: Capture & Process Logs" />
</lollms_form>`.trim();

        try {
            // This blocks the tool execution until the user clicks submit
            await env.agentManager.ui.requestUserInput(formXml, signal, { isAgentZone: true });
        } catch (e) {
            return { success: false, output: "User cancelled the interactive test session." };
        }

        // 3. Kill the process (optional cleanup, usually user closes the app)
        // If it was a web server or hung process, we try a soft kill
        if (isWin) {
            await env.agentManager.runCommand(`Get-Process | Where-Object { $_.MainWindowTitle -ne "" } | Stop-Process -ErrorAction SilentlyContinue`, signal);
        }

        // 4. Read and Compress Logs
        try {
            const rawLog = await fs.readFile(logPath, 'utf8');
            if (!rawLog || rawLog.trim().length === 0) {
                return { success: true, output: "The application ran but produced no console output." };
            }

            const modelName = env.agentManager.getCurrentDiscussion()?.model || env.lollmsApi.getModelName();
            const limitInfo = await env.lollmsApi.getContextSize(modelName);
            const logTokens = Math.ceil(rawLog.length / 3.5);

            // If log takes up more than 15% of the total context window, compress it.
            if (logTokens > (limitInfo.context_size * 0.15)) {
                env.agentManager.ui.addMessageToDiscussion({ 
                    role: 'system', 
                    content: `⚖️ **Librarian Notice**: Log file is large (${logTokens.toLocaleString()} tokens). Performing intelligent compression...` 
                });

                const compressionPrompt = `
You are the Technical Log Analyst. 
I have a massive terminal log from a UI test interaction. I need to summarize it for the Lead Architect.

**USER OBJECTIVE WAS:** ${params.user_instructions}

**TASK:**
1. Identify any "ERROR", "Exception", "Traceback", or "Warning" blocks.
2. Identify successful state transitions (e.g., "Logged in successfully", "Window loaded").
3. Strip repetitive boilerplate or redundant polling logs.
4. Provide a high-density technical summary of what happened during the run.

**LOG CONTENT:**
${rawLog.substring(0, 50000)} ... [Truncated for Analyzer]
`;
                const summary = await env.lollmsApi.sendChat([
                    { role: 'system', content: "You are a specialized log compression engine. Output only the distilled technical findings." },
                    { role: 'user', content: compressionPrompt }
                ], null, signal, modelName);

                return { 
                    success: true, 
                    output: `### 📊 COMPRESSED UI TEST LOG (${params.log_handle})\nOriginal size: ${logTokens.toLocaleString()} tokens. Distilled below:\n\n${summary}\n\n**Full Log Reference**: \`${logFileName}\`` 
                };
            }

            return { success: true, output: `### 📊 UI TEST LOG (${params.log_handle})\n\n\`\`\`\n${rawLog}\n\`\`\`` };

        } catch (e: any) {
            return { success: false, output: `Failed to retrieve logs from ${logFileName}: ${e.message}` };
        }
    }
};