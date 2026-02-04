import * as vscode from 'vscode';
import * as path from 'path';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const analyzeImageTool: ToolDefinition = {
    name: "analyze_image",
    description: "Analyzes an image file from the workspace using the AI's vision capabilities. Useful for organizing photos or understanding visual assets.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "file_path", type: "string", description: "The relative path to the image file.", required: true },
        { name: "prompt", type: "string", description: "Specific question about the image (e.g., 'What is the date in this photo?', 'Describe the landscape').", required: false }
    ],
    async execute(params: { file_path: string, prompt?: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.file_path || !env.workspaceRoot) {
            return { success: false, output: "Error: file_path and active workspace required." };
        }

        try {
            const uri = vscode.Uri.joinPath(env.workspaceRoot.uri, params.file_path);
            const data = await vscode.workspace.fs.readFile(uri);
            const base64 = Buffer.from(data).toString('base64');
            const ext = path.extname(params.file_path).replace('.', '').toLowerCase();
            const mime = ext === 'svg' ? 'svg+xml' : (ext === 'jpg' ? 'jpeg' : ext);

            const userPrompt = params.prompt || "Describe this image in detail.";

            // Lollms / OpenAI Multimodal Format
            const message = [
                { role: "system", content: "You are an expert Vision AI. Analyze the image accurately." },
                { 
                    role: "user", 
                    content: [
                        { type: "text", text: userPrompt },
                        { type: "image_url", image_url: { url: `data:image/${mime};base64,${base64}` } }
                    ]
                }
            ];

            const response = await env.lollmsApi.sendChat(message as any, null, signal);
            return { success: true, output: response };

        } catch (e: any) {
            return { success: false, output: `Vision analysis failed: ${e.message}` };
        }
    }
};
