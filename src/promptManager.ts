import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface Prompt {
    id: string;
    groupId: string | null;
    title: string;
    description?: string;
    content: string;
    type: 'chat' | 'code_action';
    action_type?: 'generation' | 'information';
    is_default?: boolean;
}

export interface PromptGroup {
    id: string;
    title: string;
}

export interface PromptData {
    prompts: Prompt[];
    groups: PromptGroup[];
}

const defaultPrompts: PromptData = {
    prompts: [
        // --- CHAT PROMPTS ---
        { 
            id: 'default-chat-1', 
            groupId: null, 
            title: 'Ask a Question', 
            description: 'Ask a general question about the selected code',
            content: 'I have a question about this code:\n\n{{SELECTED_CODE}}\n\n[Your question here]', 
            type: 'chat',
            is_default: true
        },

        // --- CODE ACTION PROMPTS (GENERATION) ---
        { 
            id: 'default-code-1', 
            groupId: null, 
            title: 'Refactor Code', 
            description: 'Improve readability and efficiency', 
            content: 'Refactor the following code to improve its readability and efficiency. Only provide the refactored code block as a direct replacement.\n\n{{SELECTED_CODE}}', 
            type: 'code_action', 
            action_type: 'generation',
            is_default: true
        },
        { 
            id: 'default-code-2', 
            groupId: null, 
            title: 'Add Comments', 
            description: 'Add inline and block comments to the code', 
            content: 'Add concise, helpful comments to the following code. Explain complex parts. Only provide the commented code block as a direct replacement.\n\n{{SELECTED_CODE}}', 
            type: 'code_action', 
            action_type: 'generation',
            is_default: true
        },
        { 
            id: 'default-code-3', 
            groupId: null, 
            title: 'Write Unit Tests', 
            description: 'Generate unit tests for the selected code', 
            content: 'Write unit tests for the following code. Use the most popular testing framework for the language. Only provide the test code block.\n\n{{SELECTED_CODE}}', 
            type: 'code_action', 
            action_type: 'generation',
            is_default: true
        },
        { 
            id: 'default-code-4', 
            groupId: null, 
            title: 'Optimize Performance', 
            description: 'Rewrite the code to be more performant', 
            content: 'Optimize the following code for maximum performance. Focus on algorithmic efficiency and language-specific best practices. Only provide the optimized code block.\n\n{{SELECTED_CODE}}', 
            type: 'code_action', 
            action_type: 'generation',
            is_default: true
        },

        // --- CODE ACTION PROMPTS (INFORMATION) ---
        { 
            id: 'default-info-1', 
            groupId: null, 
            title: 'Explain Code', 
            description: 'Get a detailed explanation of the code', 
            content: 'Provide a detailed, step-by-step explanation of what the following code does. Describe its purpose, logic, inputs, and outputs.\n\n{{SELECTED_CODE}}', 
            type: 'code_action', 
            action_type: 'information',
            is_default: true
        },
        { 
            id: 'default-info-2', 
            groupId: null, 
            title: 'Find Bugs', 
            description: 'Analyze the code for potential bugs and errors', 
            content: 'Analyze the following code for potential bugs, logic errors, or security vulnerabilities. Describe any issues you find and suggest fixes.\n\n{{SELECTED_CODE}}', 
            type: 'code_action', 
            action_type: 'information',
            is_default: true
        },
        { 
            id: 'default-info-3', 
            groupId: null, 
            title: 'Generate Documentation', 
            description: 'Create a docblock for the selected function/class', 
            content: 'Generate a comprehensive documentation block (e.g., JSDoc, DocString) for the following code. Include descriptions for the function, parameters, and return value.\n\n{{SELECTED_CODE}}', 
            type: 'code_action', 
            action_type: 'information',
            is_default: true
        },
    ],
    groups: []
};

export class PromptManager {
    private promptsFilePath: vscode.Uri;
    private data: PromptData | null = null;

    constructor(storageUri: vscode.Uri) {
        this.promptsFilePath = vscode.Uri.joinPath(storageUri, 'prompts.json');
    }

    public getPromptsFilePath(): vscode.Uri {
        return this.promptsFilePath;
    }

    private async createDefaultPromptsFile(): Promise<PromptData> {
        await vscode.workspace.fs.writeFile(this.promptsFilePath, Buffer.from(JSON.stringify(defaultPrompts, null, 2), 'utf8'));
        return defaultPrompts;
    }

    public async getData(): Promise<PromptData> {
        if (this.data) {
            return this.data;
        }
    
        let loadedData: PromptData;
    
        try {
            const fileContents = await vscode.workspace.fs.readFile(this.promptsFilePath);
            const parsedData = JSON.parse(fileContents.toString());
            
            if (typeof parsedData === 'object' && parsedData !== null && Array.isArray(parsedData.prompts) && Array.isArray(parsedData.groups)) {
                 loadedData = parsedData;
            } else {
                loadedData = await this.createDefaultPromptsFile();
            }
    
        } catch (error) {
            if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound' || error instanceof SyntaxError) {
                loadedData = await this.createDefaultPromptsFile();
            } else {
                console.error('Error reading prompts file:', error);
                loadedData = { prompts: [], groups: [] };
            }
        }
        
        this.data = loadedData;
        return this.data;
    }

    public async saveData(data: PromptData): Promise<void> {
        this.data = data;
        await vscode.workspace.fs.writeFile(this.promptsFilePath, Buffer.from(JSON.stringify(data, null, 2), 'utf8'));
    }
    
    public async getChatPrompts(): Promise<Prompt[]> {
        const data = await this.getData();
        return data.prompts.filter(p => p.type === 'chat');
    }

    public async getCodeActionPrompts(): Promise<Prompt[]> {
        const data = await this.getData();
        return data.prompts.filter(p => p.type === 'code_action');
    }
}