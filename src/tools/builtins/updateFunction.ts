import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const updateFunctionTool: ToolDefinition = {
    name: "update_function",
    description: "Surgically replaces the body of a specific function, method, or class. Does not require Aider blocks. Best for refactoring known symbols.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'filesystem_write',
    parameters: [
        { name: "file_path", type: "string", description: "Namespaced path to the file.", required: true },
        { name: "symbol_name", type: "string", description: "Name of the function/method to replace.", required: true },
        { name: "new_content", type: "string", description: "The full new code for this symbol.", required: true }
    ],
    async execute(params: { file_path: string, symbol_name: string, new_content: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        const res = await env.contextManager.resolveWorkspaceFromPath(params.file_path);
        if (!res) return { success: false, output: "File not found." };

        // 1. Fetch symbols for the file
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider', 
            res.uri
        );

        if (!symbols) return { success: false, output: "Could not parse symbols in file." };

        // 2. Locate the specific symbol (Recursive search)
        const findSymbol = (list: vscode.DocumentSymbol[]): vscode.DocumentSymbol | undefined => {
            for (const s of list) {
                if (s.name === params.symbol_name) return s;
                const child = findSymbol(s.children);
                if (child) return child;
            }
        };

        const target = findSymbol(symbols);
        if (!target) return { success: false, output: `Symbol '${params.symbol_name}' not found.` };

        // 3. Apply Edit
        const edit = new vscode.WorkspaceEdit();
        edit.replace(res.uri, target.range, params.new_content);
        const success = await vscode.workspace.applyEdit(edit);
        
        if (success) {
            const doc = await vscode.workspace.openTextDocument(res.uri);
            await doc.save();
            return { success: true, output: `Successfully updated ${params.symbol_name} in ${params.file_path}.` };
        }
        return { success: false, output: "Failed to apply workspace edit." };
    }
};
