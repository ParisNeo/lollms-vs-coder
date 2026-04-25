import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const editImageAssetTool: ToolDefinition = {
    name: "edit_image_asset",
    description: "Modifies an existing image asset in the workspace using AI. Use this to change colors, styles, or add/remove elements from icons, logos, and UI assets.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'filesystem_write',
    parameters: [
        { name: "paths", type: "array", description: "An array of relative paths to images. The first is usually the base; others are used for character/style reference.", required: true },
        { name: "prompt", type: "string", description: "Detailed instructions (e.g., 'Replace the background of paths[0] with the landscape in paths[1]').", required: true },
        { name: "output_path", type: "string", description: "Relative path for the resulting composite.", required: true }
    ],
    async execute(params: { paths: string[], prompt: string, output_path: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot || !params.paths.length) return { success: false, output: "Error: No source paths provided." };

        try {
            // Read and format all provided sources as Data URIs
            const imageParts = await Promise.all(params.paths.map(async (p) => {
                const uri = vscode.Uri.joinPath(env.workspaceRoot!.uri, p);
                const data = await vscode.workspace.fs.readFile(uri);
                const base64 = data.toString('base64');

                // Detect MIME type from extension
                const ext = p.split('.').pop()?.toLowerCase() || 'png';
                const mime = ext === 'jpg' ? 'jpeg' : (ext === 'svg' ? 'svg+xml' : ext);

                return `data:image/${mime};base64,${base64}`;
            }));

            // The primary image is used as the 'image' parameter for the Edit API
            const primaryImage = imageParts[0];

            // Trigger the API endpoint
            // If the LLM prompt refers to other images, they are already present in the chat context
            const resultB64 = await env.lollmsApi.editImage(params.prompt, primaryImage);
            
            const outUri = vscode.Uri.joinPath(env.workspaceRoot.uri, params.output_path);
            const outDir = vscode.Uri.joinPath(outUri, '..');
            await vscode.workspace.fs.createDirectory(outDir);
            await vscode.workspace.fs.writeFile(outUri, Buffer.from(resultB64, 'base64'));

            return { 
                success: true, 
                output: `Successfully modified image. Saved to \`${params.output_path}\`.\n\n<image_result path="${params.output_path}" />` 
            };
        } catch (e: any) {
            return { success: false, output: `Image editing failed: ${e.message}` };
        }
    }
};