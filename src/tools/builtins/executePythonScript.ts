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
        async execute(params: { env_name?: string, script_path: string, args?: string, timeout_s?: number, is_gui?: boolean }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
            if (!params.script_path) {
                return { success: false, output: "Error: 'script_path' is required." };
            }

            let actualEnvName = params.env_name || "";
            const rootPath = env.workspaceRoot?.uri.fsPath || "";

            // --- SMART VENV DETECTION ---
            if (!actualEnvName && rootPath) {
                const possibleEnvs = ['.venv', 'venv', 'env', 'virtualenv'];
                const fs = require('fs/promises');
                for (const e of possibleEnvs) {
                    try {
                        await fs.access(path.join(rootPath, e));
                        actualEnvName = e;
                        break;
                    } catch {}
                }
            }

            // If still no venv found, fallback to system python
            const pythonScriptExec = actualEnvName 
                ? (os.platform() === 'win32' ? path.join(actualEnvName, 'Scripts', 'python.exe') : path.join(actualEnvName, 'bin', 'python'))
                : 'python';

            // --- HEADLESS / GUI SAFETY ---
            let commandPrefix = "";
            if (params.is_gui) {
                if (process.platform === 'linux') commandPrefix = "xvfb-run ";
                // On Windows/Mac, we assume the environment has a display unless specified
            } else {
                // Force dummy driver for Pygame/SDL to prevent timeouts in headless environments
                commandPrefix = os.platform() === 'win32' ? "$env:SDL_VIDEODRIVER='dummy'; " : "export SDL_VIDEODRIVER=dummy; ";
            }
            
        const argsStr = params.args ? ` ${params.args}` : '';
        const timeoutMs = params.timeout_s ? params.timeout_s * 1000 : 900000; // 15 minute default

        return env.agentManager!.runCommand(`"${pythonScriptExec}" "${params.script_path}"${argsStr}`, signal, { timeoutMs });
    }
};
