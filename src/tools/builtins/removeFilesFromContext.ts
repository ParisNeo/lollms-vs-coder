import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const removeFilesFromContextTool: ToolDefinition = {
    name: "remove_files_from_context",
    description: "Removes specific files from the AI's context to save tokens, setting them back to 'tree-only' state. Use this if your context is getting full and you no longer need to see the content of these files.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "paths", type: "array", description: "Array of relative file paths to remove from context.", required: true }
    ],
    async execute(params: { paths: string[] }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.paths || !Array.isArray(params.paths)) {
            return { success: false, output: "Error: 'paths' parameter (array) is required." };
        }
        const fileTreeProvider = env.contextManager.getContextStateProvider();
        if (!fileTreeProvider) {
            return { success: false, output: "Error: Context provider not available." };
        }
        if (!env.workspaceRoot) {
            return { success: false, output: "Error: No active workspace folder." };
        }

        const uris = params.paths.map(p => vscode.Uri.joinPath(env.workspaceRoot!.uri, p));
        await fileTreeProvider.setStateForUris(uris, 'tree-only');

        return { success: true, output: `Successfully removed ${params.paths.length} files from context.` };
    }
};