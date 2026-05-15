import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const generateImageTool: ToolDefinition = {
    name: "generate_image",
    description: "Generates a bitmap image (PNG/JPG) using AI based on a prompt. Use this to create website backgrounds, hero sections, textures, or UI placeholder images.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "prompt", type: "string", description: "The description of the image to generate.", required: true },
        { name: "file_path", type: "string", description: "The relative path where the image should be saved (e.g., 'assets/image.png').", required: true },
        { name: "chroma_key", type: "string", description: "Standard key color (e.g. 'pure green #00FF00' or 'magenta #FF00FF') for easy transparency. Default: 'pure green #00FF00'.", required: false }
    ],
    async execute(params: { prompt: string, file_path: string, size?: string, verify?: boolean, chroma_key?: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.prompt || !params.file_path) return { success: false, output: "Error: 'prompt' and 'file_path' are required." };
        if (!env.workspaceRoot) return { success: false, output: "Error: No workspace." };

        try {
            const keyColor = params.chroma_key || "pure green #00FF00";
            const enhancedPrompt = `[CHROMA KEY: ${keyColor}]. Background MUST be a 100% solid, flat, non-textured ${keyColor}. No gradients or shadows on background. Subject: ${params.prompt}`;

            const b64Json = await env.lollmsApi.generateImage(enhancedPrompt, { size: params.size }, signal as any);
            const fileUri = vscode.Uri.joinPath(env.workspaceRoot.uri, params.file_path);

            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(fileUri, '..'));
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(b64Json, 'base64'));
            env.contextManager.refreshFileInCache(fileUri);

            let output = `✅ Image generated: \`${params.file_path}\`\n<image_result path="${params.file_path}" />`;

            if (params.verify !== false) {
                const auditRes = await env.lollmsApi.sendChat([
                    { role: "system", content: "Verify if the generated image matches the prompt." },
                    { role: "user", content: [
                        { type: "text", text: `Prompt was: "${params.prompt}". Verify the result.` },
                        { type: "image_url", image_url: { url: `data:image/png;base64,${b64Json}` } }
                    ]}
                ] as any, null, signal);
                output += `\n\n### 🔬 VISUAL VERIFICATION:\n${auditRes}`;
            }

            return { success: true, output };
        } catch (error: any) {
            return { success: false, output: `Image generation failed: ${error.message}` };
        }
    }
};
