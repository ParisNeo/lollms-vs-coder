import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const createPythonEnvironmentTool: ToolDefinition = {
    name: "create_python_environment",
    description: "Creates a Python virtual environment.",
    isAgentic: false,
    isDefault: true,
    parameters: [
        { name: "env_name", type: "string", description: "The name of the environment folder (e.g., 'venv').", required: true }
    ],
    async execute(params: { env_name: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.env_name) {
            return { success: false, output: "Error: 'env_name' is required." };
        }
        return env.agentManager.runCommand(`python -m venv ${params.env_name}`, signal);
    }
};
