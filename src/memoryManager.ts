import * as vscode from 'vscode';

export class MemoryManager {
    private storageUri: vscode.Uri;
    private memoryFile: vscode.Uri;
    private _onDidChange = new vscode.EventEmitter<string>();
    public readonly onDidChange = this._onDidChange.event;

    constructor(globalStorageUri: vscode.Uri) {
        this.storageUri = globalStorageUri;
        this.memoryFile = vscode.Uri.joinPath(globalStorageUri, 'user_memory.md');
        this.initialize();
    }

    private async initialize() {
        try {
            await vscode.workspace.fs.createDirectory(this.storageUri);
        } catch { /* exists */ }

        try {
            await vscode.workspace.fs.stat(this.memoryFile);
        } catch {
            await this.resetMemory();
        }
    }

    public async getMemory(): Promise<string> {
        try {
            const bytes = await vscode.workspace.fs.readFile(this.memoryFile);
            return Buffer.from(bytes).toString('utf8');
        } catch {
            return "";
        }
    }

    public async updateMemory(newContent: string) {
        const encoded = Buffer.from(newContent, 'utf8');
        await vscode.workspace.fs.writeFile(this.memoryFile, encoded);
        this._onDidChange.fire(newContent);
    }

    public async appendMemory(fragment: string) {
        const current = await this.getMemory();
        const updated = current + "\n" + fragment;
        await this.updateMemory(updated);
    }

    public async resetMemory() {
        const defaultMemory = "User Preferences & Facts:\n- No specific preferences recorded yet.";
        await this.updateMemory(defaultMemory);
    }

    public async showMemoryEditor() {
        try {
            // Ensure file exists
            await this.getMemory();
            const doc = await vscode.workspace.openTextDocument(this.memoryFile);
            await vscode.window.showTextDocument(doc);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to open memory file: ${e.message}`);
        }
    }
}
