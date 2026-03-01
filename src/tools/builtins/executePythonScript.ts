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
        
        let actualEnvName = params.env_name;
        
        if (env.workspaceRoot) {
            const fs = require('fs/promises');
            const rootPath = env.workspaceRoot.uri.fsPath;
            try {
                await fs.access(path.join(rootPath, actualEnvName));
            } catch {
                const possibleEnvs = ['.venv', 'venv', 'env'];
                for (const e of possibleEnvs) {
                    try {
                        await fs.access(path.join(rootPath, e));
                        actualEnvName = e;
                        break;
                    } catch {}
                }
            }
        }

        const pythonScriptExec = os.platform() === 'win32'
            ? path.join(actualEnvName, 'Scripts', 'python.exe')
            : path.join(actualEnvName, 'bin', 'python');
        return env.agentManager!.runCommand(`"${pythonScriptExec}" ${params.script_path}`, signal);
    }
};
