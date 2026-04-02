import * as vscode from 'vscode';
import * as path from 'path';

export interface MemoryEntry {
    id: string;
    title: string;
    content: string;
    timestamp: number;
}

export class ProjectMemoryManager {
    private localPath?: vscode.Uri;
    private _onDidChange = new vscode.EventEmitter<void>();
    public readonly onDidChange = this._onDidChange.event;

    constructor(private context: vscode.ExtensionContext) {}

    public async switchWorkspace(folder: vscode.Uri) {
        this.localPath = vscode.Uri.joinPath(folder, '.lollms', 'project_memory.json');
        await this.getMemories(); // Pre-load cache
        this._onDidChange.fire();
    }

    private _cache: MemoryEntry[] = [];

    public async getMemories(): Promise<MemoryEntry[]> {
        if (!this.localPath) {
            this._cache = [];
            return [];
        }
        try {
            const content = await vscode.workspace.fs.readFile(this.localPath);
            const data = JSON.parse(Buffer.from(content).toString('utf8'));
            this._cache = Array.isArray(data) ? data : [];
        } catch (error) {
            // If file doesn't exist or is corrupted, start with an empty cache for this workspace
            this._cache = [];
        }
        return this._cache;
    }

    public async updateMemory(action: 'add' | 'update' | 'delete', id: string, title?: string, content?: string) {
        // 1. Sync cache with disk first
        await this.getMemories();

        if (action === 'delete') {
            this._cache = this._cache.filter(m => m.id !== id);
        } else if (action === 'add') {
            if (!this._cache.find(m => m.id === id)) {
                this._cache.push({
                    id,
                    title: title || id,
                    content: content || "",
                    timestamp: Date.now()
                });
            }
        } else if (action === 'update') {
            const index = this._cache.findIndex(m => m.id === id);
            if (index !== -1) {
                if (title) this._cache[index].title = title;
                if (content) this._cache[index].content = content;
                this._cache[index].timestamp = Date.now();
            }
        }

        // 2. Persist
        if (this.localPath) {
            try {
                const dir = vscode.Uri.joinPath(this.localPath, '..');
                await vscode.workspace.fs.createDirectory(dir);
                const buffer = Buffer.from(JSON.stringify(this._cache, null, 2), 'utf8');
                await vscode.workspace.fs.writeFile(this.localPath, buffer);
            } catch (e) {
                console.error("Failed to save project memory", e);
            }
        }

        // 3. Notify UI (Both Sidebar Tree and Webview Panel)
        this._onDidChange.fire();
        
        // Force the Webview to update if it's open
        const { ProjectMemoryPanel } = require('./commands/projectMemoryPanel');
        if (ProjectMemoryPanel.currentPanel) {
            // This is a hacky but effective way to trigger the private _update in the currentPanel
            (ProjectMemoryPanel.currentPanel as any)._update();
        }
    }

    public async getFormattedMemoryBlock(): Promise<string> {
        const memories = await this.getMemories();
        if (memories.length === 0) return "";

        let block = "\n### 🧠 PROJECT MEMORY (LONG-TERM CONTEXT)\n";
        block += "You have saved the following critical project knowledge. Prioritize this over general knowledge.\n\n";
        memories.forEach(m => {
            block += `#### ${m.title} (ID: ${m.id})\n${m.content}\n\n`;
        });
        return block;
    }
}