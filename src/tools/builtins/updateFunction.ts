import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const updateFunctionTool: ToolDefinition = {
    name: "update_function",
    description: "Replaces the entire content of a specific function or class method. Use this instead of 'edit_code' when you are changing more than 50% of the function logic to save output tokens and ensure structural integrity.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'filesystem_write',
    parameters: [
        { name: "file_path", type: "string", description: "Relative path to the file containing the function.", required: true },
        { name: "function_name", type: "string", description: "The name of the function or method (e.g., 'calculateTotal' or 'User.save').", required: true },
        { name: "new_code", type: "string", description: "The complete new source code for the function, including the signature/header.", required: true }
    ],
    async execute(params: { file_path: string, function_name: string, new_code: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot) return { success: false, output: "Error: No workspace root." };
        
        const resolution = await env.contextManager.resolveWorkspaceFromPath(params.file_path);
        if (!resolution) return { success: false, output: `File not found: ${params.file_path}` };

        try {
            const document = await vscode.workspace.openTextDocument(resolution.uri);
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider', 
                resolution.uri
            );

            if (!symbols || symbols.length === 0) {
                return { success: false, output: "Could not retrieve symbols for this file type. Please use 'edit_code' with Aider blocks instead." };
            }

            const findSymbolRecursive = (nodes: vscode.DocumentSymbol[], targetName: string): vscode.DocumentSymbol | undefined => {
                for (const node of nodes) {
                    if (node.name === targetName) return node;
                    if (node.children && node.children.length > 0) {
                        const found = findSymbolRecursive(node.children, targetName);
                        if (found) return found;
                    }
                }
                return undefined;
            };

            const targetSymbol = findSymbolRecursive(symbols, params.function_name);
            if (!targetSymbol) {
                return { success: false, output: `Symbol '${params.function_name}' not found in ${params.file_path}. Available symbols: ${symbols.map(s => s.name).join(', ')}` };
            }

            const edit = new vscode.WorkspaceEdit();
            edit.replace(resolution.uri, targetSymbol.range, params.new_code);
            
            const success = await vscode.workspace.applyEdit(edit);
            if (success) {
                await document.save();
                return { success: true, output: `Successfully updated function '${params.function_name}' in \`${params.file_path}\`.` };
            }
            return { success: false, output: "Failed to apply editor change." };

        } catch (e: any) {
            return { success: false, output: `Internal Error: ${e.message}` };
        }
    }
};