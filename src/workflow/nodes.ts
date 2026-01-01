import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { NodeExecutionContext, WorkflowNode } from './types';

// Abstract Base for Nodes
export abstract class BaseNode {
    abstract execute(node: WorkflowNode, inputs: any, context: NodeExecutionContext): Promise<any>;
}

// 1. File Iterator Node (The "Loop")
export class FileIteratorNode extends BaseNode {
    async execute(node: WorkflowNode, inputs: any, context: NodeExecutionContext): Promise<any> {
        const folderPath = inputs['folderPath'] || node.data['folderPath'];
        if (!folderPath) throw new Error("FileIterator: Missing folderPath");

        const fullPath = path.isAbsolute(folderPath) ? folderPath : path.join(context.workspaceRoot, folderPath);
        
        try {
            const files = await fs.promises.readdir(fullPath);
            // Filter for images if specified
            const extensions = ['.jpg', '.jpeg', '.png', '.webp'];
            const validFiles = files.filter(f => extensions.includes(path.extname(f).toLowerCase()));
            
            return { 
                files: validFiles.map(f => path.join(fullPath, f)),
                count: validFiles.length
            };
        } catch (e: any) {
            throw new Error(`FileIterator Error: ${e.message}`);
        }
    }
}

// 2. Lollms Vision Node (The "Brain")
export class LollmsVisionNode extends BaseNode {
    async execute(node: WorkflowNode, inputs: any, context: NodeExecutionContext): Promise<any> {
        const filePath = inputs['imagePath'];
        const prompt = node.data['prompt'] || "Analyze this image and extract metadata.";
        
        if (!filePath) throw new Error("LollmsVision: Missing imagePath input");

        context.logger(`Analyzing image: ${path.basename(filePath)}`);

        // Read image as base64
        const bitmap = await fs.promises.readFile(filePath);
        const base64Image = Buffer.from(bitmap).toString('base64');

        // Construct Prompt
        const systemPrompt = `You are an image analysis engine. Return ONLY valid JSON.`;
        const userPrompt = [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
        ];

        try {
            // Access Lollms API from context
            const response = await context.lollms.sendChat([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ]);

            // Extract JSON
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
            return { raw: response };
        } catch (e: any) {
            throw new Error(`LollmsVision Error: ${e.message}`);
        }
    }
}

// 3. File Operations Node (The "Action")
export class MoveFileNode extends BaseNode {
    async execute(node: WorkflowNode, inputs: any, context: NodeExecutionContext): Promise<any> {
        const sourcePath = inputs['sourcePath'];
        const targetFolder = inputs['targetFolder'] || node.data['targetFolder'];
        const newFilename = inputs['newFilename']; // Optional

        if (!sourcePath || !targetFolder) throw new Error("MoveFile: Missing source or target");

        const fileName = newFilename || path.basename(sourcePath);
        const absTargetFolder = path.isAbsolute(targetFolder) ? targetFolder : path.join(context.workspaceRoot, targetFolder);
        const targetPath = path.join(absTargetFolder, fileName);

        // Ensure directory exists
        if (!fs.existsSync(absTargetFolder)) {
            await fs.promises.mkdir(absTargetFolder, { recursive: true });
        }

        await fs.promises.rename(sourcePath, targetPath);
        context.logger(`Moved ${path.basename(sourcePath)} to ${targetPath}`);
        
        return { success: true, newPath: targetPath };
    }
}

export const NODE_REGISTRY: { [key: string]: BaseNode } = {
    'file_iterator': new FileIteratorNode(),
    'lollms_vision': new LollmsVisionNode(),
    'move_file': new MoveFileNode()
};
