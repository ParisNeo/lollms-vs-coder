import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const editImageAssetTool: ToolDefinition = {
    name: "edit_image_asset",
    description: "Edits an existing image in the workspace using AI image editing. PRIMARY USE: Changing background colors, replacing backgrounds, modifying colors/styles, or adding/removing elements from existing images. MANDATORY: You MUST output the result using the XML tag format: <edit_image_asset><input_file>path</input_file><prompt>...</prompt><output_file>path</output_file></edit_image_asset>. Use this INSTEAD of generate_image when you need to modify an existing image file.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'filesystem_write',
    parameters: [
        { name: "paths", type: "array", description: "An array of relative paths to images. The first is the base image to edit; others are used for style reference.", required: true },
        { name: "prompt", type: "string", description: "Detailed editing instructions. For background color changes, use: 'Change the background color to [COLOR]' or 'Replace the background with [DESCRIPTION]'.", required: true },
        { name: "output_path", type: "string", description: "Relative path where the edited image will be saved (e.g., 'assets/edited_image.png').", required: true }
    ],
    async execute(params: { paths: string[], prompt?: string, instructions?: string, output_path: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot || !params.paths || !params.paths.length) return { success: false, output: "Error: No source paths provided." };

        // Ensure the prompt is captured regardless of how the architect named the parameter
        const finalPrompt = params.prompt || params.instructions;
        if (!finalPrompt || finalPrompt.trim() === "") {
            return { success: false, output: "Error: No editing instructions (prompt) provided. You must specify what changes to make to the image." };
        }

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

            // Trigger the API endpoint with the full array of base64 images.
            const resultB64 = await env.lollmsApi.editImage(finalPrompt, imageParts);
            
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