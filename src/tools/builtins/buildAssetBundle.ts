import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const buildAssetBundleTool: ToolDefinition = {
    name: "build_asset_bundle",
    description: "Master Game Asset Tool. Generates a sprite sheet with a solid Chroma Key background, then performs recursive slicing verification. Returns a dictionary of extraction coordinates for code integration.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'filesystem_write',
    parameters: [
        { name: "prompt", type: "string", description: "Visual description of the character/assets.", required: true },
        { name: "target_path", type: "string", description: "Where to save the sheet (e.g. 'assets/hero.png').", required: true },
        { name: "rows", type: "number", description: "Number of motions (rows).", required: true },
        { name: "cols", type: "number", description: "Number of frames per motion (columns).", required: true },
        { name: "chroma_key", type: "string", description: "Background color for keying (e.g. '#00FF00').", required: false },
        { name: "adjustments", type: "object", description: "Optional: { start_x, start_y, padding_x, padding_y, row_heights: [] } to fix slicing.", required: false }
    ],
    async execute(params: any, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot) return { success: false, output: "No workspace." };
        const model = env.lollmsApi.getModelName();

        // 1. GENERATE OR RETRIEVE SHEET
        const keyColor = params.chroma_key || "pure green #00FF00";
        const genPrompt = `[CHROMA KEY: ${keyColor}]. Sprite sheet grid, ${params.rows} rows by ${params.cols} columns. Solid flat ${keyColor} background. Subject: ${params.prompt}`;
        
        const b64Json = await env.lollmsApi.generateImage(genPrompt, { size: "1024x1024" }, signal as any);
        const fileUri = vscode.Uri.joinPath(env.workspaceRoot.uri, params.target_path);
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(fileUri, '..'));
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(b64Json, 'base64'));

        // 2. EXTRACTION VERIFICATION LOOP (PYTHON)
        const adj = params.adjustments || {};
        const scriptPath = path.join(env.workspaceRoot.uri.fsPath, ".lollms", "scripts", "verify_bundle.py");
        
        const pythonCode = `
import json, os
from PIL import Image

def verify():
    img = Image.open(r"${fileUri.fsPath}").convert("RGBA")
    w, h = img.size
    rows, cols = ${params.rows}, ${params.cols}
    
    # Grid Math
    base_tw, base_th = w // cols, h // rows
    start_x, start_y = ${adj.start_x || 0}, ${adj.start_y || 0}
    row_heights = ${JSON.stringify(adj.row_heights || [])}
    
    samples = []
    os.makedirs(".lollms/bundle_previews", exist_ok=True)

    current_y = start_y
    for r in range(rows):
        row_h = row_heights[r] if r < len(row_heights) else base_th
        # Capture first frame of each row for LLM review
        box = (start_x, current_y, start_x + base_tw, current_y + row_h)
        crop = img.crop(box)
        p = f".lollms/bundle_previews/row_{r}.png"
        crop.save(p)
        samples.push({"row": r, "path": p})
        current_y += row_h

    print(json.dumps({"samples": samples, "base_tw": base_tw, "base_th": base_th}))

verify()`.trim();

        await fs.writeFile(scriptPath, pythonCode);
        const result = await env.agentManager!.runCommand(`python "${scriptPath}"`, signal);
        const metadata = JSON.parse(result.output);

        // 3. MULTIMODAL AUDIT
        const visionParts: any[] = [{ type: "text", text: `I have generated the sheet. Here is Frame 1 from each of the ${params.rows} rows. Are they perfectly centered? If not, provide new 'adjustments' JSON.` }];
        // Add preview images for the LLM to "see"
        for (const s of metadata.samples) {
            const data = await fs.readFile(path.join(env.workspaceRoot.uri.fsPath, s.path));
            visionParts.push({ type: "image_url", image_url: { url: `data:image/png;base64,${data.toString('base64')}` } });
        }

        const audit = await env.lollmsApi.sendChat([{ role: "user", content: visionParts }] as any, null, signal, model);

        return { 
            success: true, 
            output: `### 📦 BUNDLE VERIFICATION REPORT\n\n${audit}\n\n**PROPOSED DICTIONARY**:\n\`\`\`json\n${JSON.stringify({ 
                path: params.target_path, 
                tile_size: [metadata.base_tw, metadata.base_th],
                key: keyColor
            }, null, 2)}\n\`\`\`` 
        };
    }
};