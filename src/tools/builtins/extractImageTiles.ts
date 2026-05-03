import { ToolDefinition, ToolExecutionEnv } from '../tool';
import * as path from 'path';

export const extractImageTilesTool: ToolDefinition = {
    name: "extract_image_tiles",
    description: "Slices a spritesheet or large concept image into multiple individual tile/sprite files. Useful for generating assets from a single design document.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'filesystem_write',
    parameters: [
        { name: "source_path", type: "string", description: "Relative path to the source spritesheet/image.", required: true },
        { name: "output_dir", type: "string", description: "Folder where extracted tiles will be saved (e.g., 'assets/hero/idle').", required: true },
        { name: "tile_width", type: "number", description: "Width of each tile in pixels.", required: true },
        { name: "tile_height", type: "number", description: "Height of each tile in pixels.", required: true },
        { name: "padding_x", type: "number", description: "Internal horizontal inset to avoid borders.", required: false },
        { name: "padding_y", type: "number", description: "Internal vertical inset to avoid borders.", required: false },
        { name: "prefix", type: "string", description: "Filename prefix for tiles (e.g., 'frame'). Result: 'frame_0.png', 'frame_1.png'...", required: false }
        ],
        async execute(params: { source_path: string, output_dir: string, tile_width: number, tile_height: number, padding_x?: number, padding_y?: number, prefix?: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot) return { success: false, output: "No workspace." };

        const srcRes = await env.contextManager.resolveWorkspaceFromPath(params.source_path);
        const dstRes = await env.contextManager.resolveWorkspaceFromPath(params.output_dir);
        if (!srcRes) return { success: false, output: `Source not found: ${params.source_path}` };

        const fs = require('fs/promises');
        const path = require('path');
        const scriptDir = path.join(env.workspaceRoot.uri.fsPath, ".lollms", "scripts");
        await fs.mkdir(scriptDir, { recursive: true });
        const scriptPath = path.join(scriptDir, `tile_extract_${Date.now()}.py`);

        const pythonCode = `
        import sys
        import os
        import json
        from PIL import Image

        def extract():
        try:
        source = r"${srcRes.uri.fsPath}"
        out_dir = r"${path.join(env.workspaceRoot.uri.fsPath, params.output_dir)}"
        tw, th = ${params.tile_width}, ${params.tile_height}
        px, py = ${params.padding_x || 0}, ${params.padding_y || 0}
        prefix = "${params.prefix || 'tile'}"

        if not os.path.exists(source):
            print(f"ERROR: Source not found: {source}")
            return

        os.makedirs(out_dir, exist_ok=True)
        img = Image.open(source)
        w, h = img.size

        count = 0
        for y in range(0, h, th):
            for x in range(0, w, tw):
                if x + tw <= w and y + th <= h:
                    # Apply Padding/Extrusion to the crop box
                    box = (x + px, y + py, x + tw - px, y + th - py)
                    tile = img.crop(box)
                    if tile.getbbox():
                        tile.save(os.path.join(out_dir, f"{prefix}_{count}.png"))
                        count += 1

        print(f"EXTRACTION_OK: {count} tiles saved")
    except Exception as e:
        print(f"ERROR: {str(e)}")

    if __name__ == "__main__":
    extract()
    `.trim();

        await fs.writeFile(scriptPath, pythonCode, 'utf8');
        const result = await env.agentManager!.runCommand(`python "${scriptPath}"`, signal);

        // Cleanup
        try { await fs.unlink(scriptPath); } catch(e) {}
        
        if (result.output.includes("EXTRACTION_OK")) {
            return { success: true, output: result.output };
        }
        return { success: false, output: "Failed to extract tiles: " + result.output };
    }
};