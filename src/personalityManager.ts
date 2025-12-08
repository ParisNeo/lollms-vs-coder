import * as vscode from 'vscode';

export interface Personality {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
    isDefault?: boolean;
}

export class PersonalityManager {
    private storagePath: vscode.Uri;
    private personalitiesFilePath: vscode.Uri;
    private personalities: Personality[] = [];
    private _onDidChange = new vscode.EventEmitter<void>();
    public readonly onDidChange = this._onDidChange.event;

    constructor(globalStorageUri: vscode.Uri) {
        this.storagePath = globalStorageUri;
        this.personalitiesFilePath = vscode.Uri.joinPath(this.storagePath, 'personalities.json');
        this.initialize();
    }

    private async initialize() {
        try {
            await vscode.workspace.fs.stat(this.storagePath);
        } catch {
            await vscode.workspace.fs.createDirectory(this.storagePath);
        }

        try {
            const fileContent = await vscode.workspace.fs.readFile(this.personalitiesFilePath);
            this.personalities = JSON.parse(fileContent.toString());
        } catch {
            await this.resetToDefaults();
        }
        this._onDidChange.fire();
    }

    private async resetToDefaults() {
        this.personalities = [
            {
                id: 'default_coder',
                name: 'Lollms Coder (Default)',
                description: 'The standard helpful AI coding assistant.',
                systemPrompt: 'You are Lollms, a helpful AI coding assistant integrated into VS Code. Be helpful and concise.',
                isDefault: true
            },
            {
                id: 'python_expert',
                name: 'Python Expert',
                description: 'Specialized in Python development, focusing on efficiency and typing.',
                systemPrompt: 'You are a Python expert. You write pythonic, efficient, and well-documented code. Always use type hints and docstrings. Prefer modern Python features.',
            },
            {
                id: 'senior_architect',
                name: 'Senior Architect',
                description: 'Focuses on design patterns, scalability, and high-level architecture.',
                systemPrompt: 'You are a Senior Software Architect. Focus on scalability, maintainability, SOLID principles, and design patterns. Constructively criticize bad architectural decisions.',
            },
            {
                id: 'code_reviewer',
                name: 'Code Reviewer',
                description: 'Strict code reviewer focusing on security and best practices.',
                systemPrompt: 'You are a strict code reviewer. Analyze the code for security vulnerabilities, bugs, and style violations. Be thorough and critical.',
            },
            {
                id: 'teacher',
                name: 'Coding Tutor',
                description: 'Explains concepts simply and guides the user.',
                systemPrompt: 'You are a patient Coding Tutor. Explain concepts clearly and simply. Don\'t just give the answer; explain the "why" and "how". Use analogies.',
            }
        ];
        await this.save();
    }

    public async save() {
        const content = Buffer.from(JSON.stringify(this.personalities, null, 2), 'utf8');
        await vscode.workspace.fs.writeFile(this.personalitiesFilePath, content);
        this._onDidChange.fire();
    }

    public getPersonalities(): Personality[] {
        return this.personalities;
    }

    public getPersonality(id: string): Personality | undefined {
        return this.personalities.find(p => p.id === id);
    }

    public async addPersonality(personality: Personality) {
        this.personalities.push(personality);
        await this.save();
    }

    public async updatePersonality(updated: Personality) {
        const index = this.personalities.findIndex(p => p.id === updated.id);
        if (index !== -1) {
            this.personalities[index] = updated;
            await this.save();
        }
    }

    public async deletePersonality(id: string) {
        this.personalities = this.personalities.filter(p => p.id !== id);
        await this.save();
    }
}
