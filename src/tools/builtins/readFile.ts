import * as vscode from 'vscode';
import * as path from 'path';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const readFileTool: ToolDefinition = {
    name: "read_file",
    description: "Reads the content of a file from the workspace without permanently adding it to context. Use this for temporary inspection or peeking.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'filesystem_read',
    parameters: [
        { name: "path", type: "string", description: "The relative path to the file to be read.", required: true }
    ],
    async execute(params: { path: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        const rawPath = params.path || (params as any).file_path || (params as any).filePath || (params as any).file || "";
        if (!rawPath) {
            return { success: false, output: "Error: 'path' parameter is required." };
        }
        if (!env.workspaceRoot) {
            return { success: false, output: "Error: No active workspace folder." };
        }
        
        let filePath = rawPath.trim();
        if (filePath.startsWith('/') || filePath.startsWith('\\')) filePath = filePath.substring(1);

        const res = await env.contextManager.resolveWorkspaceFromPath(filePath);
        const fileUri = res ? res.uri : vscode.Uri.joinPath(env.workspaceRoot.uri, filePath);
        let retries = 3;
        let lastError = "";

        while (retries > 0) {
            if (signal?.aborted) {
                return { success: false, output: "Read file operation cancelled." };
            }

            try {
                const fileContent = await vscode.workspace.fs.readFile(fileUri);
                const ext = path.extname(filePath).toLowerCase();

                let outputText = "";
                const docExtensions = new Set(['.pdf', '.docx', '.xlsx', '.xls', '.pptx', '.msg', '.odt', '.rtf', '.ipynb']);
                const binaryExtensions = new Set(['.exe', '.dll', '.so', '.dylib', '.bin', '.pkl', '.onnx', '.pt', '.pth', '.pyc']);

                if (binaryExtensions.has(ext)) {
                    return { success: false, output: `Error: File '${filePath}' is a binary artifact and cannot be read as text.` };
                }

                if (docExtensions.has(ext)) {
                    outputText = await env.contextManager.processFile(filePath, Buffer.from(fileContent).toString('base64'));
                } else {
                    outputText = Buffer.from(fileContent).toString('utf8');
                }

                return { success: true, output: outputText };
            } catch (error: any) {
                lastError = error.message;
                retries--;
                if (retries > 0) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
        }
        return { success: false, output: `Error reading file ${filePath} after retries: ${lastError}` };
    }
};