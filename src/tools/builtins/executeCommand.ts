import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const executeCommandTool: ToolDefinition = {
    name: "execute_command",
    description: "Executes a shell command in the workspace root.",
    isAgentic: false,
    isDefault: true,
    parameters: [
        { name: "command", type: "string", description: "The shell command to execute.", required: true }
    ],
    async execute(params: { command: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.command) {
            return { success: false, output: "Error: 'command' parameter is required." };
        }
        return env.agentManager.runCommand(params.command, signal);
    }
};
