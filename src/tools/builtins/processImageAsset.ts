import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const processImageAssetTool: ToolDefinition = {
    name: "process_image_asset",
    description: "Optimizes or modifies an existing image asset (resize, convert format, crop) using Python. Requires 'Pillow' installed.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "source_path", type: "string", description: "Relative path to the source image.", required: true },
        { name: "target_path", type: "string", description: "Relative path where the processed image will be saved.", required: true },
        { name: "action", type: "string", description: "Action to perform: 'resize', 'convert', 'thumbnail', 'crop'.", required: true },
        { name: "params", type: "object", description: "Action parameters. e.g., { width: 800, height: 600 } for resize, { format: 'webp' } for convert.", required: true }
    ],
    async execute(params: { source_path: string, target_path: string, action: string, params: any }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot) return { success: false, output: "No workspace." };

        // Resolve paths correctly
        const srcRes = await env.agentManager!.resolveWorkspaceFromPath(params.source_path);
        const dstRes = await env.agentManager!.resolveWorkspaceFromPath(params.target_path);

        if (!srcRes || !dstRes) return { success: false, output: "Path resolution failed." };

        const fs = require('fs/promises');
        const path = require('path');

        const scriptDir = path.join(env.workspaceRoot.uri.fsPath, ".lollms", "scripts");
        await fs.mkdir(scriptDir, { recursive: true });
        const scriptPath = path.join(scriptDir, `img_proc_${Date.now()}.py`);

        const pythonCode = `
    import sys
    import json
    import os
    from PIL import Image

    def process():
    try:
        source = r"${srcRes.uri.fsPath}"
        target = r"${dstRes.uri.fsPath}"
        action = "${params.action}"
        p = json.loads('${JSON.stringify(params.params)}')

        if not os.path.exists(source):
            print(f"ERROR: Source not found: {source}")
            return

        img = Image.open(source)

        if action == "resize":
            img = img.resize((p.get("width", img.width), p.get("height", img.height)), Image.Resampling.LANCZOS)
        elif action == "thumbnail":
            img.thumbnail((p.get("width", 128), p.get("height", 128)))

        os.makedirs(os.path.dirname(target), exist_ok=True)
        img.save(target, format=p.get("format"))
        print("PROCESS_OK")
    except ImportError:
        print("ERROR: Pillow not installed. Run 'pip install Pillow'")
    except Exception as e:
        print(f"ERROR: {str(e)}")

    if __name__ == "__main__":
    process()
    `.trim();

        await fs.writeFile(scriptPath, pythonCode, 'utf8');

        const result = await env.agentManager!.runCommand(`python "${scriptPath}"`, signal);

        // Cleanup
        try { await fs.unlink(scriptPath); } catch(e) {}
        
        if (result.output.includes("PROCESS_OK")) {
            return { success: true, output: `Image processed and saved to \`${params.target_path}\`.` };
        }
        return { success: false, output: "Processing failed: " + result.output };
    }
};