import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const deselectContextFilesTool: ToolDefinition = {
    name: "deselect_context_files",
    description: "Deselects files from the AI's context to save tokens, setting them to 'tree-only' state.",
    isAgentic: false,
    isDefault: true,
    parameters: [
        { name: "files", type: "array", description: "An array of relative file paths to deselect.", required: true }
    ],
    async execute(params: { files: string[] }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.files || !Array.isArray(params.files)) {
            return { success: false, output: "Error: 'files' parameter (an array of strings) is required." };
        }
        const fileTreeProvider = env.contextManager.getContextStateProvider();
        if (!fileTreeProvider) {
            return { success: false, output: "Error: File Tree Provider is not available." };
        }
        if (!env.workspaceRoot) {
            return { success: false, output: "Error: No active workspace folder." };
        }
        const urisToDeselect: vscode.Uri[] = params.files.map((f: string) => vscode.Uri.joinPath(env.workspaceRoot!.uri, f));
        await fileTreeProvider.setStateForUris(urisToDeselect, 'tree-only');

        const fileListString = params.files.map((f: string) => `- ${f}`).join('\n');
        return { success: true, output: `Successfully deselected ${params.files.length} files from the context:\n${fileListString}` };
    }
};
