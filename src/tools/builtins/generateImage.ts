import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const generateImageTool: ToolDefinition = {
    name: "generate_image",
    description: "Generates an image based on a prompt and saves it to a specified path.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "prompt", type: "string", description: "The description of the image to generate.", required: true },
        { name: "file_path", type: "string", description: "The relative path where the image should be saved (e.g., 'assets/image.png').", required: true }
    ],
    async execute(params: { prompt: string, file_path: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.prompt || !params.file_path) {
            return { success: false, output: "Error: 'prompt' and 'file_path' are required." };
        }

        if (!env.workspaceRoot) {
            return { success: false, output: "Error: No active workspace folder." };
        }

        try {
            const b64Json = await env.lollmsApi.generateImage(params.prompt);
            
            const fileUri = vscode.Uri.joinPath(env.workspaceRoot.uri, params.file_path);
            const buffer = Buffer.from(b64Json, 'base64');
            
            // Ensure directory exists
            const parentUri = vscode.Uri.joinPath(fileUri, '..');
            await vscode.workspace.fs.createDirectory(parentUri);
            
            await vscode.workspace.fs.writeFile(fileUri, buffer);
            
            return { success: true, output: `Image generated and saved successfully to '${params.file_path}'.` };
        } catch (error: any) {
            return { success: false, output: `Image generation failed: ${error.message}` };
        }
    }
};
