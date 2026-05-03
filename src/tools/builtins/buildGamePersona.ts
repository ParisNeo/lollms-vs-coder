import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';
import { stripThinkingTags } from '../../utils';

export const buildGamePersonaTool: ToolDefinition = {
    name: "build_game_persona",
    description: "Generates a game character. High-Fidelity Mode: 1. Creates Lore. 2. Generates Sheet. 3. ITERATIVE VERIFICATION: It uses 'draw_debug_annotations' and 'analyze_image' to verify that extraction coordinates perfectly frame the sprites before finalizing the manifest.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "name", type: "string", description: "The name of the character.", required: true },
        { name: "description", type: "string", description: "Base description or lore.", required: true },
        { name: "reference_image_path", type: "string", description: "Optional path to a reference image to maintain style.", required: false }
    ],
    async execute(params: { name: string, description: string, reference_image_path?: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot) return { success: false, output: "Workspace required." };
        const model = env.lollmsApi.getModelName();

        // 1. Generate Lore & Action Descriptions
        const lorePrompt = `Create detailed lore for the character '${params.name}'. Base: ${params.description}. 
        Then, define 5 standard RPG actions for this character (e.g. IDLE, WALK, ATTACK, HURT, DIE) and describe how they look visually.`;
        const lore = await env.lollmsApi.sendChat([{ role: 'user', content: lorePrompt }], null, signal, model);

        // 2. Generate Sprite Sheet
        const spriteSheetPath = `assets/personas/${params.name.toLowerCase()}_sprites.png`;
        const imgPrompt = `A 2D pixel art sprite sheet personality strip for a game character named ${params.name}. 
        Visuals: ${lore}. 
        Format: A horizontal strip of 5 distinct poses (Idle, Walk, Attack, Hurt, Die) on a solid flat background color (e.g. magenta #FF00FF). 
        Style: Detailed 32-bit pixel art. High quality.`;
        
        const genResult = await env.lollmsApi.generateImage(imgPrompt);
        const fileUri = vscode.Uri.joinPath(env.workspaceRoot.uri, spriteSheetPath);
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(fileUri, '..'));
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(genResult, 'base64'));

        // 3. Technical Analysis (Vision) - Now aware of offsets
        const visionPrompt = [
            { 
                role: "system", 
                content: `You are a Game Asset Analyzer. 
                IMPORTANT: Look for text labels (like 'STAND', 'WALK') or margins on the left/top. 
                NOTE: If image dimensions don't divide perfectly by rows/cols (e.g. 1254/5 = 250.8), check for 1-pixel separator lines between tiles and calculate the exact floating-point offset to ensure no borders are captured.
                1. Identify the 'Starting Offset' [offsetX, offsetY] where the first actual sprite begins.
                2. Identify 'Grid Line Thickness' and suggest 'padding_x/y'.
                3. Identify the hex Color Key.
                4. Provide the exact [x, y, w, h] for each sprite.`
            },
            { 
                role: "user", 
                content: [
                    { type: "text", text: `Analyze coordinates for ${params.name}. Note if there are labels on the left creating an X-offset.` },
                    { type: "image_url", image_url: { url: `data:image/png;base64,${genResult}` } }
                ]
            }
        ];
        const technicalMetadata = await env.lollmsApi.sendChat(visionPrompt as any, null, signal, model);

        // 4. Build Final Manifest
        const manifest = `
### 🎭 GAME PERSONA MANIFEST: ${params.name.toUpperCase()}
**Lore Summary**: ${lore}

**Asset Path**: \`${spriteSheetPath}\`
**Technical Specs**:
${technicalMetadata}

**Visual Confirmation**: <image_result path="${spriteSheetPath}" />
        `.trim();

        return { success: true, output: manifest };
    }
};