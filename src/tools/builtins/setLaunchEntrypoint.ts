import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const setLaunchEntrypointTool: ToolDefinition = {
    name: "set_launch_entrypoint",
    description: "Sets the main executable file in the project's .vscode/launch.json.",
    isAgentic: false,
    isDefault: true,
    parameters: [
        { name: "file_path", type: "string", description: "The relative path to the entry point file.", required: true }
    ],
    async execute(params: { file_path: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.file_path) {
            return { success: false, output: "Error: 'file_path' parameter is required." };
        }
        if (!env.workspaceRoot) {
            return { success: false, output: "Error: No active workspace folder." };
        }

        const launchJsonPath = vscode.Uri.joinPath(env.workspaceRoot.uri, '.vscode', 'launch.json');
        let launchConfig;

        try {
            const fileContent = await vscode.workspace.fs.readFile(launchJsonPath);
            launchConfig = JSON.parse(fileContent.toString());
        } catch (error) {
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(env.workspaceRoot.uri, '.vscode'));
            launchConfig = { version: '0.2.0', configurations: [] };
        }

        if (!launchConfig.configurations || !Array.isArray(launchConfig.configurations)) {
            launchConfig.configurations = [];
        }

        if (launchConfig.configurations.length === 0) {
            launchConfig.configurations.push({
                name: 'Run Lollms Project',
                request: 'launch',
                type: 'node',
                program: ''
            });
        }

        launchConfig.configurations[0].program = `\${workspaceFolder}/${params.file_path}`;

        try {
            await vscode.workspace.fs.writeFile(launchJsonPath, Buffer.from(JSON.stringify(launchConfig, null, 4), 'utf8'));
            return { success: true, output: `Successfully set launch.json entry point to '${params.file_path}'.` };
        } catch (error: any) {
            return { success: false, output: `Error writing to launch.json: ${error.message}` };
        }
    }
};
