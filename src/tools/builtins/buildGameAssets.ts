import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const buildGameAssetsTool: ToolDefinition = {
    name: "build_game_assets",
    description: "Generates world-building assets (tilesets, backgrounds, HUD, decorations). Automates image generation and technical coordinate extraction for tiling or UI placement.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "asset_type", type: "string", description: "The category: 'tileset' (bricks/walls), 'background' (scenery), 'hud' (UI/icons), 'decoration' (moving plants/objects).", required: true },
        { name: "theme", type: "string", description: "The visual style (e.g., 'cyberpunk laboratory', 'pixel art forest').", required: true },
        { name: "description", type: "string", description: "Detailed description of the specific assets (e.g., 'cracked blue bricks', 'health bar with crystal icons').", required: true },
        { name: "target_path", type: "string", description: "Relative path to save the asset (e.g., 'assets/world/bricks.png').", required: true }
    ],
    async execute(params: { asset_type: string, theme: string, description: string, target_path: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot) return { success: false, output: "Workspace required." };
        const model = env.lollmsApi.getModelName();

        // 1. Refine Image Prompt based on Type
        let imgPrompt = "";
        let visionMission = "";

        switch (params.asset_type.toLowerCase()) {
            case 'tileset':
                imgPrompt = `A 2D pixel art tileset sheet for ${params.theme}. Subject: ${params.description}. Format: A clean 4x4 grid of seamless tiling blocks on a solid #FF00FF magenta background. Professional game assets.`;
                visionMission = "Identify the grid size (e.g. 32x32 or 64x64) and provide the [x, y, w, h] coordinates for each unique tile in the grid.";
                break;
            case 'background':
                imgPrompt = `A high-quality 2D game background for ${params.theme}. Subject: ${params.description}. Style: Parallax-ready, wide format, no characters. ${params.theme} atmosphere.`;
                visionMission = "Analyze the image layers and suggest how to slice this for a 3-layer parallax effect (Background, Midground, Foreground).";
                break;
            case 'hud':
                imgPrompt = `A 2D game UI / HUD kit for ${params.theme}. Include: health bars, mana bars, inventory slots, and action icons. Subject: ${params.description}. Solid background color for keying.`;
                visionMission = "Identify the bounding boxes [x, y, w, h] for the Health Bar, Mana Bar, and at least 3 unique icons found in the sheet.";
                break;
            case 'decoration':
                imgPrompt = `A 2D pixel art prop sheet for ${params.theme}. Subject: ${params.description}. Format: Multiple small objects (moving decorations) on a solid background.`;
                visionMission = "Identify each individual object and provide its bounding box and center point.";
                break;
            default:
                return { success: false, output: `Unsupported asset_type: ${params.asset_type}` };
        }

        // 2. Generate Image
        const genResult = await env.lollmsApi.generateImage(imgPrompt);
        const fileUri = vscode.Uri.joinPath(env.workspaceRoot.uri, params.target_path);
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(fileUri, '..'));
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(genResult, 'base64'));

        // 3. Technical Vision Analysis
        const visionPrompt = [
            { role: "system", content: `You are a Game Engine Pre-processor. ${visionMission} Also identify the transparency Color Key (hex).` },
            { 
                role: "user", 
                content: [
                    { type: "text", text: `Extract technical coordinates for this ${params.asset_type} asset.` },
                    { type: "image_url", image_url: { url: `data:image/png;base64,${genResult}` } }
                ]
            }
        ];
        const technicalMetadata = await env.lollmsApi.sendChat(visionPrompt as any, null, signal, model);

        // 4. Build Final Manifest
        const manifest = `
### 🧱 WORLD ASSET MANIFEST: ${params.asset_type.toUpperCase()}
**Theme/Style**: ${params.theme}
**Description**: ${params.description}

**Asset Path**: \`${params.target_path}\`
**Engine Implementation Details**:
${technicalMetadata}

**Visual Confirmation**: <image_result path="${params.target_path}" />
        `.trim();

        return { success: true, output: manifest };
    }
};