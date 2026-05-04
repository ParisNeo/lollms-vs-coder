import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const setVscodePythonInterpreterTool: ToolDefinition = {
    name: "set_default_environment",
    description: "Sets the default environment for the current project. This persists the environment selection (Python venv, Node path, or ROS workspace) into VS Code settings so it remains active across sessions.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'filesystem_write',
    parameters: [
        { name: "platform", type: "string", description: "The platform: 'python', 'node', or 'ros'.", required: true },
        { name: "path", type: "string", description: "The relative path to the environment (e.g. 'venv', 'node_modules', or 'colcon_ws').", required: true }
    ],
    async execute(params: { platform: string, path: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot) return { success: false, output: "No workspace root." };
        const platform = params.platform.toLowerCase();
        const rootUri = env.workspaceRoot.uri;

        try {
            if (platform === 'python') {
                const pythonExec = os.platform() === 'win32'
                    ? path.join(params.path, 'Scripts', 'python.exe')
                    : path.join(params.path, 'bin', 'python');
                const fullPath = path.join(env.workspaceRoot.uri.fsPath, pythonExec);

                await vscode.workspace.getConfiguration('python', rootUri).update('defaultInterpreterPath', fullPath, vscode.ConfigurationTarget.WorkspaceFolder);
                if (env.agentManager) env.agentManager.sessionState.activeEnv = params.path;
                return { success: true, output: `✅ Python environment persisted: ${params.path} is now the default for this workspace.` };
            } 

            if (platform === 'node') {
                // For Node, we often set the runtime version via .nvmrc or specific extension settings
                await vscode.workspace.getConfiguration('javascript', rootUri).update('suggest.paths', true, vscode.ConfigurationTarget.WorkspaceFolder);
                return { success: true, output: `✅ Node environment noted. Ensure 'npm install' is run in ${params.path}.` };
            }

            if (platform === 'ros') {
                const setupPath = path.join(params.path, 'install', 'setup.bash');
                await vscode.workspace.getConfiguration('lollmsVsCoder', rootUri).update('agent.envActivationScript', setupPath, vscode.ConfigurationTarget.WorkspaceFolder);
                return { success: true, output: `✅ ROS Workspace persisted: ${params.path} setup script will now auto-load for all terminal commands.` };
            }

            return { success: false, output: `Unsupported platform: ${platform}` };
        } catch (e: any) {
            return { success: false, output: `Failed to persist environment: ${e.message}` };
        }
    }
};
