import { ToolDefinition, ToolExecutionEnv } from '../tool';
import * as path from 'path';
import * as os from 'os';

export const executePythonScriptTool: ToolDefinition = {
    name: "execute_python_script",
    description: "Executes a Python script using a specified virtual environment.",
    isAgentic: false,
    isDefault: true,
    parameters: [
        { name: "env_name", type: "string", description: "The name of the virtual environment folder.", required: true },
        { name: "script_path", type: "string", description: "The relative path to the Python script to execute.", required: true }
    ],
    async execute(params: { env_name: string, script_path: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.env_name || !params.script_path) {
            return { success: false, output: "Error: 'env_name' and 'script_path' are required." };
        }
        const pythonScriptExec = os.platform() === 'win32'
            ? path.join(params.env_name, 'Scripts', 'python.exe')
            : path.join(params.env_name, 'bin', 'python');
        return env.agentManager.runCommand(`"${pythonScriptExec}" ${params.script_path}`, signal);
    }
};
