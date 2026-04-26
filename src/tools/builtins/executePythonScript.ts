import { ToolDefinition, ToolExecutionEnv } from '../tool';
import * as path from 'path';
import * as os from 'os';

export const executePythonScriptTool: ToolDefinition = {
    name: "execute_python_script",
    description: "Executes a Python script using a specified virtual environment. This is the preferred way to run python files instead of execute_command.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'shell_execution',
    parameters:[
        { name: "env_name", type: "string", description: "The name of the virtual environment folder (e.g., 'venv').", required: true },
        { name: "script_path", type: "string", description: "The relative path to the Python script to execute.", required: true },
        { name: "args", type: "string", description: "Optional: Command line arguments to pass to the script.", required: false },
        { name: "timeout_s", type: "number", description: "Optional: Execution timeout in seconds. Default is 900s (15 minutes). For model training or heavy data processing, set this to 3600 or higher.", required: false }
        ],
        async execute(params: { env_name: string, script_path: string, args?: string, timeout_s?: number }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
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
            
        const argsStr = params.args ? ` ${params.args}` : '';
        const timeoutMs = params.timeout_s ? params.timeout_s * 1000 : 900000; // 15 minute default

        return env.agentManager!.runCommand(`"${pythonScriptExec}" "${params.script_path}"${argsStr}`, signal, { timeoutMs });
    }
};
