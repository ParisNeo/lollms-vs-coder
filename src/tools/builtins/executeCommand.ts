import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const executeCommandTool: ToolDefinition = {
    name: "execute_command",
    description: "Executes a shell command in the workspace root.",
    isAgentic: false,
    isDefault: true,
    permissionGroup: 'shell_execution',
    parameters: [
        { name: "command", type: "string", description: "The shell command to execute.", required: true },
        { name: "shell", type: "string", description: "Optional: 'powershell', 'cmd', or 'bash'. Defaults to system default.", required: false }
    ],
    async execute(params: { command: string, shell?: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.command) {
            return { success: false, output: "Error: 'command' parameter is required." };
        }
        if (!env.agentManager) {
            return { success: false, output: "Error: Agent capabilities not available." };
        }
        
        // Pass the explicit shell choice if the agent provided one
        return (env.agentManager as any).runCommand(params.command, signal, { shell: params.shell });
    }
};
