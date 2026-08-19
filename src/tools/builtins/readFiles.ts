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

        const docExtensions = new Set(['.pdf', '.docx', '.xlsx', '.xls', '.pptx', '.msg', '.odt', '.rtf', '.ipynb']);
        const binaryExtensions = new Set(['.exe', '.dll', '.so', '.dylib', '.bin', '.pkl', '.onnx', '.pt', '.pth', '.pyc']);

        for (const filePath of params.paths) {
            if (signal.aborted) break;

            try {
                let cleanPath = filePath.trim();
                if (cleanPath.startsWith('/') || cleanPath.startsWith('\\')) cleanPath = cleanPath.substring(1);

                const ext = path.extname(cleanPath).toLowerCase();

                if (binaryExtensions.has(ext)) {
                    results.push(`\`\`\`plaintext:${cleanPath} (Binary Excluded)\n(Binary file cannot be read as text)\n\`\`\``);
                    continue;
                }

                const fileUri = vscode.Uri.joinPath(env.workspaceRoot.uri, cleanPath);
                const fileContent = await vscode.workspace.fs.readFile(fileUri);

                let text = "";
                if (docExtensions.has(ext)) {
                    text = await env.contextManager.processFile(cleanPath, Buffer.from(fileContent).toString('base64'));
                } else {
                    text = Buffer.from(fileContent).toString('utf8');
                }

                const lang = ext ? ext.substring(1) : 'txt';
                const label = docExtensions.has(ext) ? `${cleanPath} (Extracted Text - Read-Only)` : cleanPath;
                results.push(`\`\`\`${lang}:${label}\n${text}\n\`\`\``);
                addedToContext.push(cleanPath);
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