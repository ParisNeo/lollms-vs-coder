import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const setVscodePythonInterpreterTool: ToolDefinition = {
    name: "set_vscode_python_interpreter",
    description: "Sets the VS Code Python interpreter path for the current workspace.",
    isAgentic: false,
    isDefault: true,
    parameters: [
        { name: "env_name", type: "string", description: "The name of the virtual environment folder.", required: true }
    ],
    async execute(params: { env_name: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.env_name) {
            return { success: false, output: "Error: 'env_name' is required." };
        }
        if (!env.workspaceRoot) {
            return { success: false, output: "Error: No active workspace folder." };
        }

        const pythonExecutable = os.platform() === 'win32'
            ? path.join(params.env_name, 'Scripts', 'python.exe')
            : path.join(params.env_name, 'bin', 'python');

        const fullPath = path.join(env.workspaceRoot.uri.fsPath, pythonExecutable);
        const config = vscode.workspace.getConfiguration('python', env.workspaceRoot.uri);
        await config.update('defaultInterpreterPath', fullPath, vscode.ConfigurationTarget.WorkspaceFolder);

        return { success: true, output: `Successfully set VS Code Python interpreter to: ${fullPath}` };
    }
};
