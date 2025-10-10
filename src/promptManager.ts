import * as vscode from 'vscode';
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
    version: number;
    prompts: Prompt[];
    groups: PromptGroup[];
}

const DEFAULT_PROMPTS: Prompt[] = [
    { id: 'default-explain', groupId: null, title: 'Explain Selection', description: 'Explains the selected code snippet.', content: 'Explain the following code:\n\n{{SELECTED_CODE}}', type: 'code_action', action_type: 'information', is_default: true },
    { id: 'default-refactor', groupId: null, title: 'Refactor Selection', description: 'Refactors code for readability and performance.', content: 'Refactor the following code to improve readability and performance. Only output the modified code in a single code block.', type: 'code_action', action_type: 'generation', is_default: true },
    { id: 'default-bug-finder', groupId: null, title: 'Find Bugs', description: 'Analyzes code for bugs and vulnerabilities.', content: 'Analyze the following code for potential bugs or security vulnerabilities and suggest fixes. Explain each issue clearly.', type: 'code_action', action_type: 'information', is_default: true },
    { 
        id: 'default-doc', 
        groupId: null, 
        title: 'Generate Documentation', 
        description: 'Generates language-appropriate documentation (e.g., Python Docstrings, Javadoc, Doxygen for C/C++).', 
        content: `Based on the language of the provided code, generate the appropriate documentation for the selected functions, classes, or variables.

- If the code is Python, use a standard format like Google Style or reStructuredText for the docstring.
- If the code is Java, use Javadoc comments.
- If the code is C, C++, or a header file (.h, .hpp), use Doxygen-style comments.
- For other languages like TypeScript or JavaScript, use TSDoc/JSDoc.

Return only the fully modified code block with the added documentation. Do not add any explanations or conversational text outside of the code block.

{{SELECTED_CODE}}`, 
        type: 'code_action', 
        action_type: 'generation', 
        is_default: true 
    }
];

export class PromptManager {
    private storagePath: vscode.Uri;
    private promptsFilePath: vscode.Uri;
    private data: PromptData | null = null;

    constructor(globalStorageUri: vscode.Uri) {
        this.storagePath = globalStorageUri;
        this.promptsFilePath = vscode.Uri.joinPath(this.storagePath, 'prompts.json');
        this.initialize();
    }

    private async initialize() {
        try {
            await vscode.workspace.fs.stat(this.storagePath);
        } catch {
            await vscode.workspace.fs.createDirectory(this.storagePath);
        }

        try {
            await vscode.workspace.fs.stat(this.promptsFilePath);
        } catch {
            await this.resetToDefaults();
        }
    }

    private async resetToDefaults() {
        const defaultData: PromptData = {
            version: 1,
            groups: [],
            prompts: DEFAULT_PROMPTS
        };
        await this.saveData(defaultData);
        this.data = defaultData;
    }

    public getPromptsFilePath(): vscode.Uri {
        return this.promptsFilePath;
    }

    public async getData(): Promise<PromptData> {
        if (this.data) {
            return this.data;
        }

        try {
            const fileContent = await vscode.workspace.fs.readFile(this.promptsFilePath);
            const loadedData = JSON.parse(fileContent.toString());
            let needsSave = false;
            
            // FIX: Ensure all default prompts exist in the user's data.
            // This adds new default prompts from updates without overwriting user changes.
            DEFAULT_PROMPTS.forEach(defaultPrompt => {
                const promptExists = loadedData.prompts.some((p: Prompt) => p.id === defaultPrompt.id);
                if (!promptExists) {
                    loadedData.prompts.unshift(defaultPrompt); // Add missing default to the beginning
                    needsSave = true;
                }
            });

            // Handle migration if necessary
            if (!loadedData.version) {
                loadedData.prompts.forEach((p: any) => {
                    p.type = p.content.includes('{{SELECTED_CODE}}') ? 'code_action' : 'chat';
                    if (p.type === 'code_action' && !p.action_type) {
                        p.action_type = 'generation'; // Default for old prompts
                    }
                });
                loadedData.version = 1;
                needsSave = true;
            }

            if (needsSave) {
                await this.saveData(loadedData);
            }

            this.data = loadedData;
            return this.data as PromptData;
        } catch (error) {
            console.error("Error reading prompts file, resetting to defaults:", error);
            await this.resetToDefaults();
            return this.data!;
        }
    }

    public async saveData(data: PromptData): Promise<void> {
        this.data = data;
        const fileContent = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
        await vscode.workspace.fs.writeFile(this.promptsFilePath, fileContent);
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