import * as vscode from 'vscode';
import * as path from 'path';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const manageSelectionsTool: ToolDefinition = {
    name: "manage_selections",
    description: "Manage saved context selections (.lollms-ctx files). Allows saving the current selection or applying/deleting an existing one.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: "filesystem_write",
    parameters: [
        {
            name: "action",
            type: "string",
            description: "The action to perform: 'save' (saves a new selection to disk), 'load' (restores/replaces context selection from a file), or 'delete' (removes a saved selection file).",
            required: true
        },
        {
            name: "name",
            type: "string",
            description: "The name of the context selection profile (e.g. 'auth_subsystem'). The extension automatically appends '.lollms-ctx'.",
            required: true
        },
        {
            name: "paths",
            type: "array",
            description: "List of relative file paths to include (only required if action is 'save').",
            required: false
        }
    ],
    async execute(params: { action: 'save' | 'load' | 'delete', name: string, paths?: string[] }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        const workspaceRoot = env.workspaceRoot;
        if (!workspaceRoot) {
            return { success: false, output: "Error: No active workspace found." };
        }

        const selectionDir = vscode.Uri.joinPath(workspaceRoot.uri, '.lollms', 'selection');
        const cleanName = params.name.replace(/\.lollms-ctx$/, '') + '.lollms-ctx';
        const fileUri = vscode.Uri.joinPath(selectionDir, cleanName);

        try {
            await vscode.workspace.fs.createDirectory(selectionDir);

            if (params.action === 'save') {
                const pathsToSave = params.paths || [];
                if (pathsToSave.length === 0) {
                    return { success: false, output: "Error: Cannot save an empty file selection." };
                }

                const content = JSON.stringify(pathsToSave, null, 2);
                await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));
                
                // Track internally
                if (env.agentManager) {
                    await vscode.commands.executeCommand('lollms-vs-coder.addFilesToContext', pathsToSave);
                }

                return { 
                    success: true, 
                    output: `Success: Context selection saved to '${params.name}' with ${pathsToSave.length} files.` 
                };
            } 

            if (params.action === 'delete') {
                try {
                    await vscode.workspace.fs.delete(fileUri, { recursive: false, useTrash: false });
                    return { success: true, output: `Success: Deleted saved context selection file '${cleanName}'.` };
                } catch {
                    return { success: false, output: `Error: File '${cleanName}' does not exist inside .lollms/selection/.` };
                }
            }

            if (params.action === 'load' || params.action === 'apply') {
                try {
                    const contentBytes = await vscode.workspace.fs.readFile(fileUri);
                    const files = JSON.parse(Buffer.from(contentBytes).toString('utf8'));
                    if (Array.isArray(files) && env.contextManager) {
                        const provider = env.contextManager.getContextStateProvider();
                        if (provider) {
                            await provider.softReset();
                            await provider.addFilesToContext(files);
                            return { success: true, output: `Success: Loaded selection '${cleanName}' with ${files.length} files. Context is now synchronized.` };
                        }
                    }
                    return { success: false, output: "Error: Invalid context file format." };
                } catch (e: any) {
                    return { success: false, output: `Error loading context file: ${e.message}` };
                }
            }

            return { success: false, output: `Unknown action: ${params.action}` };
        } catch (error: any) {
            return { success: false, output: `Runtime Error: ${error.message}` };
        }
    }
};
