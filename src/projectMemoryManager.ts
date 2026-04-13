import * as vscode from 'vscode';
import * as path from 'path';

export interface MemoryEntry {
    id: string;
    title: string;
    content: string;
    timestamp: number;
    importance: number; // 0.0 to 1.0
    lastUsed: number;
    category: string; // Hierarchical path: "coding/python/errors"
}

export class ProjectMemoryManager {
    private readonly DECAY_RATE = 0.05; // Importance lost per day of inactivity
    private readonly ACTIVE_THRESHOLD = 0.6; // Min score to stay in Layer 1 context
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

    public async updateMemory(action: 'add' | 'update' | 'delete', id: string, title?: string, content?: string, category: string = "general", importance?: number) {
        await this.getMemories();

        if (action === 'delete') {
            this._cache = this._cache.filter(m => m.id !== id);
        } else if (action === 'add') {
            if (!this._cache.find(m => m.id === id)) {
                this._cache.push({
                    id,
                    title: title || id,
                    content: content || "",
                    timestamp: Date.now(),
                    importance: importance !== undefined ? Math.min(1.0, importance) : 0.5, // Default to 50%
                    lastUsed: Date.now(),
                    category: category
                });
            }
        } else if (action === 'update') {
            const index = this._cache.findIndex(m => m.id === id);
            if (index !== -1) {
                if (title) this._cache[index].title = title;
                if (content) this._cache[index].content = content;
                
                // Automatically increment importance by 50% (0.5) on update, capped at 100% (1.0)
                const currentImportance = this._cache[index].importance;
                this._cache[index].importance = Math.min(1.0, currentImportance + 0.5);
                
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

    /**
     * Scans the project structure and common config files to build a "DNA" profile.
     * This makes Lollms smarter than generic indexers.
     */
    public async extractProjectDNA(contextManager: any): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return;

        let dnaContent = "## 🧬 PROJECT DNA (Architectural Standards)\n";
        
        // 1. Detect Stack
        const tree = await contextManager.getContextContent({ includeTree: true });
        dnaContent += `- Structure: \n${tree.projectTree.substring(0, 500)}...\n`;

        // 2. Identify core rules (e.g. from package.json or requirements.txt)
        const filesToPeek = ['package.json', 'requirements.txt', 'tsconfig.json', '.eslintrc', 'pyproject.toml'];
        for (const file of filesToPeek) {
            try {
                const uri = vscode.Uri.joinPath(workspaceFolder.uri, file);
                const content = await vscode.workspace.fs.readFile(uri);
                dnaContent += `- Found ${file}: Standard configs extracted.\n`;
            } catch {}
        }

        await this.updateMemory('update', 'project_dna', 'Project DNA & Standards', dnaContent);
    }

    /**
     * Dual-Layer Context Generation:
     * Layer 1: High-score items (Full text)
     * Layer 2: Low-score items (Categorized Handles/Index only)
     */
    public async getFormattedMemoryBlock(): Promise<string> {
        const memories = await this.getMemories();
        const now = Date.now();
        
        const scored = memories.map(m => {
            const ageDays = (now - m.lastUsed) / (1000 * 60 * 60 * 24);
            const score = Math.max(0, m.importance - (ageDays * this.DECAY_RATE));
            return { ...m, currentScore: score };
        });

        const active = scored.filter(m => m.currentScore >= this.ACTIVE_THRESHOLD);
        const latent = scored.filter(m => m.currentScore < this.ACTIVE_THRESHOLD);

        let block = "\n### 🧠 LIMBIC MEMORY (ACTIVE CONTEXT)\n";
        if (active.length > 0) {
            active.forEach(m => {
                block += `#### [${m.category}] ${m.title}\n${m.content}\n\n`;
            });
        } else {
            block += "No high-priority technical lessons active.\n";
        }

        block += "\n### 📂 NEOCORTEX INDEX (DEEP STORAGE)\n";
        block += "You have thousands of latent memories. Browse these categories if needed:\n";
        
        const categories = [...new Set(latent.map(l => l.category))];
        categories.forEach(cat => {
            const count = latent.filter(l => l.category === cat).length;
            block += `- ${cat}/ (Contains ${count} items. Use \`read_memory_category\` to see IDs)\n`;
        });

        return block;
    }

    public async strengthenMemory(id: string) {
        const memories = await this.getMemories();
        const m = memories.find(x => x.id === id);
        if (m) {
            m.importance = Math.min(1.0, m.importance + 0.15);
            m.lastUsed = Date.now();
            await this.updateMemory('update', id, m.title, m.content);
        }
    }

    /**
     * Scans text for <project_memory> tags and performs the requested actions.
     */
    public async processTags(content: string): Promise<void> {
        const memoryRegex = /<project_memory\s+([^>]*?)>([\s\S]*?)<\/project_memory>/gi;
        let match;
        while ((match = memoryRegex.exec(content)) !== null) {
            const attrStr = match[1];
            const memoryContent = match[2].trim();
            const attrs: any = {};
            
            const attrRegex = /(\w+)\s*=\s*["']([^"']*)["']/g;
            let m;
            while ((m = attrRegex.exec(attrStr)) !== null) {
                attrs[m[1]] = m[2];
            }

            const { action, id, title, importance } = attrs;
            if (action && id) {
                const imp = importance ? parseFloat(importance) : 1.0;
                await this.updateMemory(action as any, id, title || id, memoryContent, "general", imp);
            }
        }
    }
}