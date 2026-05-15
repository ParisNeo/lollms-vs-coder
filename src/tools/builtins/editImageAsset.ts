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
        { name: "prompt", type: "string", description: "Detailed editing instructions.", required: true },
        { name: "output_path", type: "string", description: "Relative path where the edited image will be saved.", required: true },
        { name: "output_size", type: "string", description: "The target dimensions for the edit (e.g., '1280x720', '1024x1024').", required: false },
        { name: "chroma_key", type: "string", description: "Standard key color (e.g. 'pure green #00FF00' or 'magenta #FF00FF'). Use this to force a consistent background across all edited assets.", required: false }
    ],
    async execute(params: { paths: string[], prompt: string, output_path: string, output_size?: string, verify?: boolean, is_style_reference?: boolean, chroma_key?: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot || !params.paths || !params.paths.length) return { success: false, output: "Error: No source paths provided." };

        try {
            // 1. Prepare Inputs (The first path is the SUBJECT, subsequent are STYLE REFERENCES)
            const imageParts = await Promise.all(params.paths.map(async (p) => {
                const res = await env.contextManager.resolveWorkspaceFromPath(p);
                if (!res) throw new Error(`Could not find source: ${p}`);
                const data = await vscode.workspace.fs.readFile(res.uri);
                const ext = p.split('.').pop()?.toLowerCase() || 'png';
                return `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${data.toString('base64')}`;
            }));

            // 2. Execute Edit via API
            // 2. Execute Edit via API
            const keyColor = params.chroma_key || "pure green #00FF00";
            let refinedPrompt = `[CHROMA KEY: ${keyColor}] REPLACE THE BACKGROUND WITH A 100% FLAT SOLID ${keyColor}. NO SHADOWS ON BACKGROUND. ${params.prompt}`;

            if (params.is_style_reference) {
                refinedPrompt = `Maintain character design from the reference image. Redraw the subject on a FLAT SOLID ${keyColor} background. ${params.prompt}`;
            }

            const resultB64 = await env.lollmsApi.editImage(refinedPrompt, imageParts, undefined, undefined, signal as any);

            // 3. Persist to Disk
            const outRes = await env.contextManager.resolveWorkspaceFromPath(params.output_path);
            if (!outRes) throw new Error("Invalid output path.");
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(outRes.uri, '..'));
            await vscode.workspace.fs.writeFile(outRes.uri, Buffer.from(resultB64, 'base64'));
            env.contextManager.refreshFileInCache(outRes.uri);

            let output = `✅ Image modified and saved to \`${params.output_path}\`.\n<image_result path="${params.output_path}" />`;

            // 4. AUTOMATIC VERIFICATION LOOP
            if (params.verify !== false) {
                const verifyPrompt = [
                    { role: "system", content: "You are a Visual Quality Auditor. Compare the result with the original instruction." },
                    { 
                        role: "user", 
                        content: [
                            { type: "text", text: `Instruction was: "${params.prompt}". Does the attached resulting image successfully fulfill this? Explain what you see.` },
                            { type: "image_url", image_url: { url: `data:image/png;base64,${resultB64}` } }
                        ]
                    }
                ];
                const audit = await env.lollmsApi.sendChat(verifyPrompt as any, null, signal);
                output += `\n\n### 🔬 VISUAL VERIFICATION REPORT:\n${audit}`;
            }

            return { success: true, output };
        } catch (e: any) {
            return { success: false, output: `Image editing failed: ${e.message}` };
        }
    }
};