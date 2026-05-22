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
        { name: "width", type: "number", description: "Target width in pixels (e.g. 1280).", required: false },
        { name: "height", type: "number", description: "Target height in pixels (e.g. 720).", required: false },
        { name: "chroma_key", type: "string", description: "Standard key color (e.g. 'pure green #00FF00' or 'magenta #FF00FF') for easy transparency. Default: 'pure green #00FF00'.", required: false }
    ],
    async execute(params: { prompt: string, file_path: string, width?: number, height?: number, verify?: boolean, chroma_key?: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.prompt || !params.file_path) return { success: false, output: "Error: 'prompt' and 'file_path' are required." };
        
        // --- SOVEREIGN ASSET PATH RESOLUTION ---
        // If we have a discussionId, save to .lollms/assets/[id]/filename.png 
        // This ensures the image persists even if the user didn't specify a project folder.
        let fileUri: vscode.Uri;
        if (env.assetDirectory) {
            fileUri = vscode.Uri.joinPath(env.assetDirectory, path.basename(params.file_path));
        } else if (env.workspaceRoot) {
            fileUri = vscode.Uri.joinPath(env.workspaceRoot.uri, params.file_path);
        } else {
            return { success: false, output: "Error: No workspace or asset directory available." };
        }

        try {
            const keyColor = params.chroma_key || "pure green #00FF00";
            const enhancedPrompt = `[CHROMA KEY: ${keyColor}]. Background MUST be a 100% solid, flat, non-textured ${keyColor}. No gradients or shadows on background. Subject: ${params.prompt}`;

            const sizeStr = (params.width && params.height) ? `${params.width}x${params.height}` : "1024x1024";
            const b64Json = await env.lollmsApi.generateImage(enhancedPrompt, { size: sizeStr }, signal as any);

            // --- PERSISTENT ASSET BUFFERING ---
            let fileUri: vscode.Uri;
            if (env.assetDirectory) {
                // Buffer inside discussion folder: .lollms/assets/[uuid]/filename
                fileUri = vscode.Uri.joinPath(env.assetDirectory, path.basename(params.file_path));
            } else {
                fileUri = vscode.Uri.joinPath(env.workspaceRoot.uri, params.file_path);
            }

            // Ensure the directory exists (e.g. .lollms/assets/discussion_id/)
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(fileUri, '..'));

            // If the file already exists (v2, v3 of same prompt), we append a timestamp to the filename 
            // used internally to avoid overwriting previous drafts.
            let finalUri = fileUri;
            try {
                await vscode.workspace.fs.stat(fileUri);
                const ext = path.extname(params.file_path);
                const name = path.basename(params.file_path, ext);
                finalUri = vscode.Uri.joinPath(fileUri, '..', `${name}_${Date.now()}${ext}`);
            } catch (e) {
                // File doesn't exist, proceed with original path
            }

            await vscode.workspace.fs.writeFile(finalUri, Buffer.from(b64Json, 'base64'));

            // Refresh cache so Librarian sees the new asset
            env.contextManager.refreshFileInCache(finalUri);
            const relativeToRoot = vscode.workspace.asRelativePath(fileUri);

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
