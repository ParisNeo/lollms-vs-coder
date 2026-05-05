import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const executeCommandTool: ToolDefinition = {
    name: "execute_command",
    description: "Executes a shell command in the workspace root.",
    isAgentic: false,
    isDefault: true,
    permissionGroup: 'shell_execution',
    parameters: [
        { name: "command", type: "string", description: "The shell command to execute.", required: true },
        { name: "shell", type: "string", description: "Optional: 'powershell', 'cmd', or 'bash'. Defaults to system default.", required: false },
        { name: "timeout_s", type: "number", description: "Optional: Execution timeout in seconds. Default is 900s (15 minutes). Use higher values for long tasks like downloading or training.", required: false }
        ],
        async execute(params: { command: string, shell?: string, timeout_s?: number }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.command) {
            return { success: false, output: "Error: 'command' parameter is required." };
        }
        if (!env.agentManager) {
            return { success: false, output: "Error: Agent capabilities not available." };
        }
        
        const timeoutMs = params.timeout_s ? params.timeout_s * 1000 : 900000; // 15 minute default

        // --- 🛡️ SOVEREIGN SECURITY AUDIT ---
        const audit = await (env.agentManager as any).performSecurityAudit(params.command, signal);
        if (!audit.safe) {
            Logger.error(`[SECURITY BLOCK] Command: ${params.command}. Reason: ${audit.reason}`);
            return { 
                success: false, 
                output: `🛑 SECURITY VIOLATION: Execution blocked by Sovereign Auditor.\nReason: ${audit.reason}` 
            };
        }

        // MITIGATION: Prevent the agent from accidentally staging internal extension files
        if (params.command === "workbench.action.reloadWindow") {
            await vscode.commands.executeCommand(params.command);
            return { success: true, output: "Window reload triggered." };
        }

        if (params.command.includes("git add") && !params.command.includes(".gitignore")) {
            const warning = "\n[SYSTEM ADVICE]: You are using 'git add'. Ensure you have a proper .gitignore to avoid staging internal folders like .lollms/ or venv/.";
            const result = await (env.agentManager as any).runCommand(params.command, signal, { shell: params.shell, timeoutMs });
            result.output += warning;
            return result;
        }

        return (env.agentManager as any).runCommand(params.command, signal, { shell: params.shell, timeoutMs });
        }
};
