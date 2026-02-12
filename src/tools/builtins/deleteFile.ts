import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const deleteFileTool: ToolDefinition = {
    name: "delete_file",
    description: "Deletes one or more files from the workspace. Use with caution.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'filesystem_write',
    parameters: [
        { name: "paths", type: "array", description: "An array of relative file paths to delete.", required: true }
    ],
    async execute(params: { paths: string[] }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot) return { success: false, output: "No workspace." };
        if (!params.paths || !Array.isArray(params.paths) || params.paths.length === 0) {
            return { success: false, output: "Error: 'paths' parameter (array) is required." };
        }

        const edit = new vscode.WorkspaceEdit();
        const deleted: string[] = [];
        const failed: string[] = [];

        for (const p of params.paths) {
            let relPath = p.trim();
            if (relPath.startsWith('/') || relPath.startsWith('\\')) relPath = relPath.substring(1);
            
            const uri = vscode.Uri.joinPath(env.workspaceRoot.uri, relPath);
            try {
                await vscode.workspace.fs.stat(uri);
                edit.deleteFile(uri, { ignoreIfNotExists: true, recursive: true });
                deleted.push(relPath);
            } catch {
                failed.push(relPath);
            }
        }

        if (deleted.length === 0) {
            return { success: false, output: `No files found to delete. Checked: ${params.paths.join(', ')}` };
        }

        const success = await vscode.workspace.applyEdit(edit);
        if (success) {
            let output = `Successfully deleted: ${deleted.join(', ')}`;
            if (failed.length > 0) output += `\nFailed to find: ${failed.join(', ')}`;
            return { success: true, output };
        } else {
            return { success: false, output: "Failed to apply file deletions. Check workspace permissions." };
        }
    }
};
