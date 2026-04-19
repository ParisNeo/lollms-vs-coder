import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const createSvgAssetTool: ToolDefinition = {
    name: "create_svg_asset",
    description: "Creates a vector graphic (SVG) asset. The agent provides the XML/SVG code, and it is saved as a file. Useful for icons, logos, and illustrations.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'filesystem_write',
    parameters: [
        { name: "path", type: "string", description: "The relative path to save the .svg file (e.g., 'assets/logo.svg').", required: true },
        { name: "svg_code", type: "string", description: "The complete <svg>...</svg> XML code.", required: true }
    ],
    async execute(params: { path: string, svg_code: string }, env: ToolExecutionEnv): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot) return { success: false, output: "No workspace." };

        try {
            const fileUri = vscode.Uri.joinPath(env.workspaceRoot.uri, params.path);
            
            // Basic validation
            if (!params.svg_code.includes('<svg')) {
                return { success: false, output: "Error: The provided code does not appear to contain a valid <svg> tag." };
            }

            const parentDir = vscode.Uri.joinPath(fileUri, '..');
            await vscode.workspace.fs.createDirectory(parentDir);
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(params.svg_code, 'utf8'));

            return { 
                success: true, 
                output: `SVG asset created at \`${params.path}\`.\n\n<generate_image path="${params.path}" width="200" height="200">SVG Preview</generate_image>` 
            };
        } catch (e: any) {
            return { success: false, output: `Failed to create SVG: ${e.message}` };
        }
    }
};