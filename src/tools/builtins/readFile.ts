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
        
        let filePath = params.path.trim();
        if (filePath.startsWith('/') || filePath.startsWith('\\')) filePath = filePath.substring(1);

        const fileUri = vscode.Uri.joinPath(env.workspaceRoot.uri, filePath);
        let retries = 3;
        let lastError = "";

        while (retries > 0) {
            try {
                const fileContent = await vscode.workspace.fs.readFile(fileUri);
                
                if (env.contextManager.getContextStateProvider()) {
                    await env.contextManager.getContextStateProvider()!.addFilesToContext([filePath]);
                }

                return { success: true, output: Buffer.from(fileContent).toString('utf8') };
            } catch (error: any) {
                lastError = error.message;
                retries--;
                if (retries > 0) {
                    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s for FS
                }
            }
        }
        return { success: false, output: `Error reading file ${filePath} after retries: ${lastError}` };
    }
};
