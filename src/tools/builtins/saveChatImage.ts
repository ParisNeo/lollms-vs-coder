import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const saveChatImageTool: ToolDefinition = {
    name: "save_chat_image",
    description: "Saves an image provided by the user in the chat history to a file in the workspace. Use this when the user attaches a screenshot, design doc, or asset that you need to use in the code, rather than regenerating it with AI.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'filesystem_write',
    parameters: [
        { name: "target_path", type: "string", description: "The relative path where the image should be saved (e.g., 'assets/ui/background.png').", required: true },
        { name: "image_index", type: "number", description: "The index of the image to save if multiple images were provided (0-indexed). Defaults to 0.", required: false }
    ],
    async execute(params: { target_path: string, image_index?: number }, env: ToolExecutionEnv): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot || !env.agentManager) {
            return { success: false, output: "Error: Workspace or Agent Manager not available." };
        }

        const discussion = env.agentManager.getCurrentDiscussion();
        if (!discussion || !discussion.messages) {
            return { success: false, output: "Error: No chat history found to extract image from." };
        }

        // 1. Find all images in the chat history
        const images: string[] = [];
        discussion.messages.forEach(msg => {
            if (Array.isArray(msg.content)) {
                msg.content.forEach((part: any) => {
                    if (part.type === 'image_url' && part.image_url?.url) {
                        images.push(part.image_url.url);
                    }
                });
            }
        });

        if (images.length === 0) {
            return { success: false, output: "No images found in the chat history. Ensure the user has attached an image before using this tool." };
        }

        const index = params.image_index || 0;
        if (index < 0 || index >= images.length) {
            return { success: false, output: `Invalid image index: ${index}. There are only ${images.length} image(s) available in the chat.` };
        }

        const dataUri = images[index];

        try {
            // 2. Extract base64 data from Data URI
            // Format: data:image/png;base64,iVBOR...
            const matches = dataUri.match(/^data:image\/([a-zA-Z+]+);base64,(.+)$/);
            if (!matches || matches.length !== 3) {
                return { success: false, output: "Error: Image data is not in a valid base64 format." };
            }

            const base64Data = matches[2];
            const buffer = Buffer.from(base64Data, 'base64');
            
            // 3. Write to Workspace
            const fileUri = vscode.Uri.joinPath(env.workspaceRoot.uri, params.target_path);
            const parentDir = vscode.Uri.joinPath(fileUri, '..');
            
            await vscode.workspace.fs.createDirectory(parentDir);
            await vscode.workspace.fs.writeFile(fileUri, buffer);

            return { 
                success: true, 
                output: `Successfully saved chat image #${index} to \`${params.target_path}\`. You can now reference this file in your code.` 
            };
        } catch (e: any) {
            return { success: false, output: `Failed to save image: ${e.message}` };
        }
    }
};