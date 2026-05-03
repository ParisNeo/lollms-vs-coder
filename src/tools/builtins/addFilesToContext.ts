import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const addFilesToContextTool: ToolDefinition = {
    name: "add_files_to_context",
    description: "Adds specific files to the AI's persistent context ('vision'). Use this when you see a file in the tree that you need to read entirely to understand the logic. The contents will be available in the 'ACCESSIBLE FILE CONTENTS' block in subsequent turns.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'filesystem_read',
    parameters: [
        { name: "paths", type: "array", description: "Array of relative paths to the files to add to context.", required: true }
    ],
    async execute(params: { paths: string[] }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.paths || !Array.isArray(params.paths)) {
            return { success: false, output: "Error: 'paths' parameter (array) is required." };
        }
        if (!env.workspaceRoot) {
            return { success: false, output: "Error: No active workspace folder." };
        }

        const provider = env.contextManager.getContextStateProvider();
        if (!provider) {
            return { success: false, output: "Error: Context provider not available." };
        }

        try {
            await provider.addFilesToContext(params.paths);
            return { 
                success: true, 
                output: `Successfully added ${params.paths.length} files to context: [${params.paths.join(', ')}]. Their contents will be visible in your next turn.` 
            };
        } catch (e: any) {
            return { success: false, output: `Failed to add files: ${e.message}` };
        }
    }
};