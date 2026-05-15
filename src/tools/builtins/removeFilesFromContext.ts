import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const removeFilesFromContextTool: ToolDefinition = {
    name: "remove_files_from_context",
    description: "Ejects files from the AI's 'vision' (context window) to improve attention and save tokens. Mandatory use: Call this as soon as a file is no longer actively being modified or analyzed to keep the reasoning sharp and high-density.",
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