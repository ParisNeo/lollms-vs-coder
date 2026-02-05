import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface KnowledgeNode {
    value?: string;
    summary?: string;
    children?: Record<string, KnowledgeNode>;
    timestamp: number;
}

export class RLMDatabaseManager {
    private localPath?: vscode.Uri;
    private _onDidChange = new vscode.EventEmitter<void>();
    public readonly onDidChange = this._onDidChange.event;

    constructor(private context: vscode.ExtensionContext) {}

    public async switchWorkspace(folder: vscode.Uri) {
        this.localPath = vscode.Uri.joinPath(folder, '.lollms', 'rlm_database.json');
        this._onDidChange.fire();
    }

    private async getGlobalData(): Promise<Record<string, KnowledgeNode>> {
        return this.context.globalState.get<Record<string, KnowledgeNode>>('rlm_global_db', {});
    }

    private async getLocalData(): Promise<Record<string, KnowledgeNode>> {
        if (!this.localPath) return {};
        try {
            const content = await vscode.workspace.fs.readFile(this.localPath);
            return JSON.parse(Buffer.from(content).toString('utf8'));
        } catch {
            return {};
        }
    }

    public async storeKnowledge(keyPath: string[], content: string, summary: string, isGlobal: boolean) {
        const data = isGlobal ? await this.getGlobalData() : await this.getLocalData();
        let current = data;

        for (let i = 0; i < keyPath.length; i++) {
            const segment = keyPath[i];
            if (!current[segment]) current[segment] = { timestamp: Date.now(), children: {} };
            
            if (i === keyPath.length - 1) {
                current[segment].value = content;
                current[segment].summary = summary;
                current[segment].timestamp = Date.now();
            } else {
                if (!current[segment].children) current[segment].children = {};
                current = current[segment].children!;
            }
        }

        if (isGlobal) {
            await this.context.globalState.update('rlm_global_db', data);
        } else if (this.localPath) {
            const dir = vscode.Uri.file(path.dirname(this.localPath.fsPath));
            await vscode.workspace.fs.createDirectory(dir);
            await vscode.workspace.fs.writeFile(this.localPath, Buffer.from(JSON.stringify(data, null, 2)));
        }
        this._onDidChange.fire();
    }

    public async getHierarchy(isGlobal: boolean) {
        return isGlobal ? await this.getGlobalData() : await this.getLocalData();
    }
}
