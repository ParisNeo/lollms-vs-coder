import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';
import * as path from 'path';

export const moveFileTool: ToolDefinition = {
    name: "move_file",
    description: "Moves or renames a file. Automatically creates destination folders if they don't exist.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'filesystem_write',
    parameters: [
        { name: "source", type: "string", description: "Current relative path of the file.", required: true },
        { name: "destination", type: "string", description: "New relative path (including filename).", required: true }
    ],
    async execute(params: { source: string, destination: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        try {
            // Use namespaced resolution to support cross-project movement
            const srcRes = await env.contextManager.resolveWorkspaceFromPath(params.source);
            const destRes = await env.contextManager.resolveWorkspaceFromPath(params.destination);

            if (!srcRes) return { success: false, output: `Source file not found: ${params.source}` };
            if (!destRes) return { success: false, output: `Could not resolve destination path: ${params.destination}` };

            // Ensure destination parent folder exists
            const destFolder = vscode.Uri.joinPath(destRes.uri, '..');
            await vscode.workspace.fs.createDirectory(destFolder);

            await vscode.workspace.fs.rename(srcRes.uri, destRes.uri, { overwrite: false });
            return { success: true, output: `Successfully moved: ${params.source} -> ${params.destination}` };
        } catch (e: any) {
            return { success: false, output: `Move failed: ${e.message}` };
        }
    }
};
