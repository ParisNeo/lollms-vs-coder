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
        const pythonCode = `
try:
    from PIL import Image
    import os
    
    img = Image.open("${params.source_path}")
    action = "${params.action}"
    p = ${JSON.stringify(params.params)}
    
    if action == "resize":
        img = img.resize((p.get("width", img.width), p.get("height", img.height)), Image.Resampling.LANCZOS)
    elif action == "thumbnail":
        img.thumbnail((p.get("width", 128), p.get("height", 128)))
    elif action == "convert":
        # Handled by save format
        pass
    
    os.makedirs(os.path.dirname("${params.target_path}"), exist_ok=True)
    img.save("${params.target_path}", format=p.get("format"))
    print("PROCESS_OK")
except ImportError:
    print("ERROR: Pillow not installed. Run 'pip install Pillow'")
except Exception as e:
    print(f"ERROR: {e}")
        `.trim();

        const result = await env.agentManager!.runCommand(`python -c '${pythonCode.replace(/'/g, "'\\''")}'`, signal);
        
        if (result.output.includes("PROCESS_OK")) {
            return { success: true, output: `Image processed and saved to \`${params.target_path}\`.` };
        }
        return { success: false, output: "Processing failed: " + result.output };
    }
};