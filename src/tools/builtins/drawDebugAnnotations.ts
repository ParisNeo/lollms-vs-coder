import { ToolDefinition, ToolExecutionEnv } from '../tool';
import * as path from 'path';
import * as fs from 'fs/promises';

export const drawDebugAnnotationsTool: ToolDefinition = {
    name: "draw_debug_annotations",
    description: "Draws red bounding boxes on an image based on provided coordinates. Used by the agent to verify if its coordinate extraction assumptions match the actual visual layout of a sprite sheet.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "source_path", type: "string", description: "Path to the original image.", required: true },
        { name: "output_path", type: "string", description: "Where to save the annotated version (e.g. 'debug_view.png').", required: true },
        { name: "rects", type: "array", description: "Array of [x, y, w, h] coordinates.", required: true },
        { name: "padding_x", type: "number", description: "Internal horizontal inset to visualize.", required: false },
        { name: "padding_y", type: "number", description: "Internal vertical inset to visualize.", required: false }
        ],
    async execute(params: { source_path: string, output_path: string, rects: number[][] }, env: ToolExecutionEnv): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot) return { success: false, output: "No workspace." };

        const srcRes = await env.contextManager.resolveWorkspaceFromPath(params.source_path);
        const dstRes = await env.contextManager.resolveWorkspaceFromPath(params.output_path);
        if (!srcRes || !dstRes) return { success: false, output: "Path resolution failed." };

        const scriptPath = path.join(env.workspaceRoot.uri.fsPath, ".lollms", "scripts", `debug_draw_${Date.now()}.py`);
        await fs.mkdir(path.dirname(scriptPath), { recursive: true });

        const pythonCode = `
import sys
import json
from PIL import Image, ImageDraw

def run():
    try:
        img = Image.open(r"${srcRes.uri.fsPath}").convert("RGB")
        draw = ImageDraw.Draw(img)
        rects = json.loads('${JSON.stringify(params.rects)}')
        px, py = ${params.padding_x || 0}, ${params.padding_y || 0}

        for r in rects:
            # 1. Draw Grid Cell (Red - the full area)
            draw.rectangle([r[0], r[1], r[0]+r[2], r[1]+r[3]], outline="red", width=1)

            # 2. Draw Padded Extraction (Green - what actually gets cut)
            if px > 0 or py > 0:
                draw.rectangle([r[0]+px, r[1]+py, r[0]+r[2]-px, r[1]+r[3]-py], outline="#00FF00", width=2)
        
        img.save(r"${dstRes.uri.fsPath}")
        print("DRAW_OK")
    except Exception as e:
        print(f"ERROR: {str(e)}")

if __name__ == "__main__":
    run()
`.trim();

        await fs.writeFile(scriptPath, pythonCode, 'utf8');
        const result = await env.agentManager!.runCommand(`python "${scriptPath}"`, new AbortController().signal);
        
        if (result.output.includes("DRAW_OK")) {
            return { 
                success: true, 
                output: `✅ Debug annotations rendered to \`${params.output_path}\`.\n\n<image_result path="${params.output_path}" />\n\n**Action**: Inspect the image above. If the red boxes are not perfectly centered, provide corrected offsets.` 
            };
        }
        return { success: false, output: result.output };
    }
};