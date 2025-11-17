import * as path from 'path';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const listFilesTool: ToolDefinition = {
    name: "list_files",
    description: "Lists files and directories recursively from a specified path within the workspace.",
    isAgentic: false,
    isDefault: true,
    parameters: [
        { name: "path", type: "string", description: "The relative path to list files from. Defaults to the workspace root '.'.", required: false }
    ],
    async execute(params: { path?: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot) {
            return { success: false, output: "Error: No active workspace folder." };
        }
        const listPath = params.path || '.';
        const targetPath = path.join(env.workspaceRoot.uri.fsPath, listPath);

        try {
            const resolvedPath = path.resolve(targetPath);
            const resolvedWorkspaceRoot = path.resolve(env.workspaceRoot.uri.fsPath);
            if (!resolvedPath.startsWith(resolvedWorkspaceRoot)) {
                return { success: false, output: "Error: Access to paths outside the workspace is not allowed." };
            }

            const fileTree = await env.agentManager.generateFileTree(targetPath);
            return { success: true, output: `File listing for '${listPath}':\n${fileTree}` };
        } catch (error: any) {
            return { success: false, output: `Error listing files: ${error.message}` };
        }
    }
};
