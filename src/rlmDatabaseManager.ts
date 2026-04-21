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
    private _onDidChange = new vscode.EventEmitter<void>();
    public readonly onDidChange = this._onDidChange.event;

    constructor(private context: vscode.ExtensionContext) {}

    public async switchWorkspace(folder: vscode.Uri) {
        this._onDidChange.fire();
    }

    private async getGlobalData(): Promise<Record<string, KnowledgeNode>> {
        return this.context.globalState.get<Record<string, KnowledgeNode>>('rlm_global_db', {});
    }

    private async getLocalData(): Promise<Record<string, KnowledgeNode>> {
        const folders = vscode.workspace.workspaceFolders ||[];
        if (folders.length === 0) return {};
        
        let mergedData: Record<string, KnowledgeNode> = {};
        
        for (const folder of folders) {
            const localPath = vscode.Uri.joinPath(folder.uri, '.lollms', 'rlm_database.json');
            try {
                const content = await vscode.workspace.fs.readFile(localPath);
                const data = JSON.parse(Buffer.from(content).toString('utf8'));
                this.deepMerge(mergedData, data);
            } catch {
                // Ignore
            }
        }
        return mergedData;
    }

    private deepMerge(target: any, source: any) {
        for (const key of Object.keys(source)) {
            if (source[key] instanceof Object && key in target && target[key] instanceof Object) {
                this.deepMerge(target[key], source[key]);
            } else {
                // Resolve conflict by timestamp
                if (target[key] && target[key].timestamp && source[key].timestamp) {
                    if (source[key].timestamp > target[key].timestamp) {
                        target[key] = source[key];
                    }
                } else {
                    target[key] = source[key];
                }
            }
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
        } else {
            const folders = vscode.workspace.workspaceFolders ||[];
            for (const folder of folders) {
                const localPath = vscode.Uri.joinPath(folder.uri, '.lollms', 'rlm_database.json');
                try {
                    const dir = vscode.Uri.file(path.dirname(localPath.fsPath));
                    await vscode.workspace.fs.createDirectory(dir);
                    await vscode.workspace.fs.writeFile(localPath, Buffer.from(JSON.stringify(data, null, 2)));
                } catch (e) {
                    // Ignore
                }
            }
        }
        this._onDidChange.fire();
    }

    public async getHierarchy(isGlobal: boolean) {
        return isGlobal ? await this.getGlobalData() : await this.getLocalData();
    }
}
