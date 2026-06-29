import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const navigateToCodeTool: ToolDefinition = {
    name: "navigate_to_code",
    description: "Surgically opens a file in the user's active editor, focuses on a specific line and column, and highlights the code.",
    permissionGroup: "filesystem_read",
    parameters: [
        {
            name: "path",
            type: "string",
            description: "The relative workspace path of the file to open (e.g. 'src/auth/handler.ts')",
            required: true
        },
        {
            name: "line",
            type: "number",
            description: "The target line number to focus (1-indexed).",
            required: true
        },
        {
            name: "column",
            type: "number",
            description: "Optional. The target column index to place the cursor (1-indexed). Defaults to 1.",
            required: false
        }
    ],
    async execute(params: { path: string; line: number; column?: number }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string }> {
        if (!params.path || params.line === undefined) {
            return { success: false, output: "Error: Both 'path' and 'line' parameters are required." };
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return { success: false, output: "Error: No active workspace found." };
        }

        const resolution = await env.contextManager.resolveWorkspaceFromPath(params.path);
        if (!resolution) {
            return { success: false, output: `Error: Could not resolve file path: ${params.path}` };
        }

        try {
            const document = await vscode.workspace.openTextDocument(resolution.uri);
            const editor = await vscode.window.showTextDocument(document, {
                preview: false,
                preserveFocus: false
            });

            const line = Math.max(1, Math.min(params.line, document.lineCount));
            const col = Math.max(1, params.column || 1) - 1; // 0-indexed internally

            const position = new vscode.Position(line - 1, col);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);

            return { 
                success: true, 
                output: `Success: Navigated to ${resolution.relativePath} at Line ${line}, Column ${col + 1}.` 
            };
        } catch (e: any) {
            return { success: false, output: `Error executing navigate_to_code: ${e.message}` };
        }
    }
};
