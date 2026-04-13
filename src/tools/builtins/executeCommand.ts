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
        { name: "timeout_s", type: "number", description: "Optional: Execution timeout in seconds. Default: 120s.", required: false }
    ],
    async execute(params: { command: string, shell?: string, timeout_s?: number }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.command) {
            return { success: false, output: "Error: 'command' parameter is required." };
        }
        if (!env.agentManager) {
            return { success: false, output: "Error: Agent capabilities not available." };
        }
        
        const timeoutMs = params.timeout_s ? params.timeout_s * 1000 : undefined;
        return (env.agentManager as any).runCommand(params.command, signal, { shell: params.shell, timeoutMs });
    }
};
