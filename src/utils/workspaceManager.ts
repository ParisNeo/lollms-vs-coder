import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';

export interface WorkspaceMetadata {
    id: string;
    name: string;
    originalPath: string;
    lastUsed: number;
    sizeBytes?: number;
}

export class WorkspaceManager {
    private static getRootUri(): vscode.Uri {
        return vscode.Uri.joinPath(vscode.Uri.file(os.homedir()), '.lollms', 'workspaces');
    }

    public static async listStoredWorkspaces(): Promise<WorkspaceMetadata[]> {
        const root = this.getRootUri();
        const results: WorkspaceMetadata[] = [];

        try {
            const entries = await vscode.workspace.fs.readDirectory(root);
            for (const [name, type] of entries) {
                if (type === vscode.FileType.Directory) {
                    const infoUri = vscode.Uri.joinPath(root, name, 'workspace_info.json');
                    try {
                        const content = await vscode.workspace.fs.readFile(infoUri);
                        const meta = JSON.parse(Buffer.from(content).toString('utf8')) as WorkspaceMetadata;
                        
                        // Calculate size (simplified)
                        const stats = await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, name));
                        meta.sizeBytes = stats.size; 
                        
                        results.push(meta);
                    } catch (e) {
                        // Folder exists but no metadata (orphan)
                        results.push({ id: name, name: `Orphaned Workspace (${name})`, originalPath: 'Unknown', lastUsed: 0 });
                    }
                }
            }
        } catch (e) {}

        return results.sort((a, b) => b.lastUsed - a.lastUsed);
    }

    public static async deleteWorkspace(id: string): Promise<void> {
        const target = vscode.Uri.joinPath(this.getRootUri(), id);
        await vscode.workspace.fs.delete(target, { recursive: true, useTrash: true });
    }
}