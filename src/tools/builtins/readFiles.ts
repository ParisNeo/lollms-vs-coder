import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const readFilesTool: ToolDefinition = {
    name: "read_files",
    description: "Reads the content of multiple files from the workspace in a single turn. Returns a combined block of code files. Use this to gather dependencies quickly.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'filesystem_read',
    parameters: [
        { name: "paths", type: "array", description: "An array of relative paths to the files to be read.", required: true }
    ],
    async execute(params: { paths: string[] }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.paths || !Array.isArray(params.paths)) {
            return { success: false, output: "Error: 'paths' parameter (array) is required." };
        }
        if (!env.workspaceRoot) {
            return { success: false, output: "Error: No active workspace folder." };
        }

        const results: string[] = [];
        const addedToContext: string[] = [];
        const errors: string[] = [];

        for (const filePath of params.paths) {
            if (signal.aborted) break;
            
            try {
                let cleanPath = filePath.trim();
                if (cleanPath.startsWith('/') || cleanPath.startsWith('\\')) cleanPath = cleanPath.substring(1);

                const fileUri = vscode.Uri.joinPath(env.workspaceRoot.uri, cleanPath);
                const fileContent = await vscode.workspace.fs.readFile(fileUri);
                const text = Buffer.from(fileContent).toString('utf8');

                // Determine language for the block
                const ext = filePath.split('.').pop() || 'txt';
                results.push(`\`\`\`${ext}:${filePath}\n${text}\n\`\`\``);
                addedToContext.push(filePath);
            } catch (error: any) {
                errors.push(`Failed to read ${filePath}: ${error.message}`);
            }
        }

        // Auto-add successfully read files to context so the next turn sees them automatically
        if (addedToContext.length > 0 && env.contextManager.getContextStateProvider()) {
            await env.contextManager.getContextStateProvider()!.addFilesToContext(addedToContext);
        }

        let output = results.join('\n\n');
        if (errors.length > 0) {
            output += `\n\n### ⚠️ PARTIAL ERRORS:\n${errors.join('\n')}`;
        }

        if (results.length === 0 && errors.length > 0) {
            return { success: false, output: "Failed to read any of the requested files." };
        }

        return { success: true, output };
    }
};