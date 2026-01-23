import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const readFileTool: ToolDefinition = {
    name: "read_file",
    description: "Reads the content of a file from the workspace.",
    isAgentic: false,
    isDefault: true,
    permissionGroup: 'filesystem_read',
    parameters: [
        { name: "path", type: "string", description: "The relative path to the file to be read.", required: true }
    ],
    async execute(params: { path: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.path) {
            return { success: false, output: "Error: 'path' parameter is required." };
        }
        if (!env.workspaceRoot) {
            return { success: false, output: "Error: No active workspace folder." };
        }

        try {
            const fileUri = vscode.Uri.joinPath(env.workspaceRoot.uri, params.path);
            const fileContent = await vscode.workspace.fs.readFile(fileUri);
            return { success: true, output: Buffer.from(fileContent).toString('utf8') };
        } catch (error: any) {
            return { success: false, output: `Error reading file ${params.path}: ${error.message}` };
        }
    }
};
