import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const manageExtensionTool: ToolDefinition = {
    name: "manage_extension",
    description: "Installs or uninstalls a VS Code extension by its ID (e.g., 'ms-vscode.cpptools').",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "extension_id", type: "string", description: "The full ID of the extension.", required: true },
        { name: "action", type: "string", description: "'install' or 'uninstall'.", required: true }
    ],
    async execute(params: { extension_id: string, action: 'install' | 'uninstall' }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        const policy = vscode.workspace.getConfiguration('lollmsVsCoder').get<string>('agent.executionPolicy');
        
        if (policy === 'blocked') return { success: false, output: "Error: Extension management is blocked by security policy." };
        
        if (policy === 'manual') {
            const choice = await env.agentManager?.requestUserInput(
                `🛡️ **Security Request:** The agent wants to ${params.action} the extension \`${params.extension_id}\`. Allow? (yes/no)`, 
                signal
            );
            if (!choice?.toLowerCase().startsWith('y')) return { success: false, output: "User denied extension installation." };
        }

        try {
            const command = params.action === 'install' ? 'workbench.extensions.installExtension' : 'workbench.extensions.uninstallExtension';
            await vscode.commands.executeCommand(command, params.extension_id);
            return { success: true, output: `Extension ${params.extension_id} ${params.action}ed successfully.` };
        } catch (e: any) {
            return { success: false, output: `Failed to manage extension: ${e.message}` };
        }
    }
};