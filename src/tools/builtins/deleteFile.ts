import * as vscode from 'vscode';
import * as path from 'path';
import { ToolDefinition, ToolExecutionEnv } from '../tool';
import { AgentSecurityGuard } from '../../security/agentSecurityGuard';

export const deleteFileTool: ToolDefinition = {
    name: "delete_file",
    description: "Deletes one or more files or folders from the workspace safely (moves to Trash). Use with caution.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'filesystem_write',
    parameters: [
        { name: "paths", type: "array", description: "An array of relative paths (files or directories) to delete.", required: true }
    ],
    async execute(params: { paths: string[] }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot) return { success: false, output: "No workspace." };
        if (!params.paths || !Array.isArray(params.paths) || params.paths.length === 0) {
            return { success: false, output: "Error: 'paths' parameter (array) is required." };
        }

        const deleted: string[] = [];
        const failed: string[] = [];
        const blocked: string[] = [];
        const rootResolved = path.resolve(env.workspaceRoot.uri.fsPath);

        for (const p of params.paths) {
            const raw = String(p || '').trim();
            const prot = AgentSecurityGuard.isProtectedPath(raw);
            if (prot.protected) {
                blocked.push(`${raw} (${prot.reason})`);
                continue;
            }

            let relPath = raw.replace(/^[/\\]+/, '');
            const uri = vscode.Uri.joinPath(env.workspaceRoot.uri, relPath);
            const targetResolved = path.resolve(uri.fsPath);

            if (targetResolved === rootResolved || !targetResolved.startsWith(rootResolved + path.sep)) {
                blocked.push(`${raw} (Outside workspace root)`);
                continue;
            }

            try {
                await vscode.workspace.fs.stat(uri);
                await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
                env.contextManager?.refreshFileInCache(uri);
                deleted.push(relPath);
            } catch {
                failed.push(relPath);
            }
        }

        if (blocked.length > 0 && deleted.length === 0) {
            return { success: false, output: `🛑 SECURITY VIOLATION: Blocked deletion of protected paths:\n${blocked.join('\n')}` };
        }

        if (deleted.length === 0) {
            return { success: false, output: `No files found to delete. Checked: ${params.paths.join(', ')}` };
        }

        let output = `Successfully moved to Trash: ${deleted.join(', ')}`;
        if (failed.length > 0) output += `\nFailed to find: ${failed.join(', ')}`;
        if (blocked.length > 0) output += `\nBlocked protected paths: ${blocked.join(', ')}`;
        return { success: true, output };
    }
};
