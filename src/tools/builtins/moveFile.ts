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
        if (!env.workspaceRoot) return { success: false, output: "No workspace." };

        let srcPath = params.source.trim();
        let destPath = params.destination.trim();
        if (srcPath.startsWith('/') || srcPath.startsWith('\\')) srcPath = srcPath.substring(1);
        if (destPath.startsWith('/') || destPath.startsWith('\\')) destPath = destPath.substring(1);

        try {
            const srcUri = vscode.Uri.joinPath(env.workspaceRoot.uri, srcPath);
            const destUri = vscode.Uri.joinPath(env.workspaceRoot.uri, destPath);

            // Ensure source exists
            try { await vscode.workspace.fs.stat(srcUri); } 
            catch { return { success: false, output: `Source file not found: ${srcPath}` }; }

            // Ensure dest folder exists
            const destFolder = vscode.Uri.joinPath(destUri, '..');
            await vscode.workspace.fs.createDirectory(destFolder);

            await vscode.workspace.fs.rename(srcUri, destUri, { overwrite: false });
            return { success: true, output: `Moved: ${srcPath} -> ${destPath}` };
        } catch (e: any) {
            return { success: false, output: `Move failed: ${e.message}` };
        }
    }
};
