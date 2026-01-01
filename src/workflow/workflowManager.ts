import * as vscode from 'vscode';
import * as path from 'path';
import { Workflow } from './types';

export class WorkflowManager {
    private storageUri: vscode.Uri;
    private workflowsDir: vscode.Uri;
    private _onDidChange = new vscode.EventEmitter<void>();
    public readonly onDidChange = this._onDidChange.event;

    constructor(globalStorageUri: vscode.Uri) {
        this.storageUri = globalStorageUri;
        this.workflowsDir = vscode.Uri.joinPath(globalStorageUri, 'workflows');
        this.initialize();
    }

    private async initialize() {
        try {
            await vscode.workspace.fs.createDirectory(this.workflowsDir);
        } catch (e) {
            // directory exists
        }
        
        // Create a default example workflow if none exists
        const workflows = await this.getWorkflows();
        if (workflows.length === 0) {
            await this.saveWorkflow({
                id: 'photo-organizer-demo',
                name: 'Photo Organizer Demo',
                nodes: [
                    { id: "n1", type: "file_iterator", position: {x: 50, y: 50}, data: { folderPath: "family_photos" }, inputs: {}, outputs: {} },
                    { id: "n2", type: "lollms_vision", position: {x: 300, y: 50}, data: { prompt: "Extract date and event" }, inputs: {"imagePath": "n1"}, outputs: {} },
                    { id: "n3", type: "move_file", position: {x: 550, y: 50}, data: {}, inputs: {"sourcePath": "n1", "targetFolder": "n2"}, outputs: {} }
                ],
                edges: [
                    { id: "e1", source: "n1", sourceHandle: "currentFile", target: "n2", targetHandle: "imagePath" },
                    { id: "e2", source: "n1", sourceHandle: "currentFile", target: "n3", targetHandle: "sourcePath" },
                    { id: "e3", source: "n2", sourceHandle: "event", target: "n3", targetHandle: "targetFolder" }
                ]
            });
        }
    }

    public async getWorkflows(): Promise<Workflow[]> {
        try {
            const entries = await vscode.workspace.fs.readDirectory(this.workflowsDir);
            const workflows: Workflow[] = [];
            
            for (const [name, type] of entries) {
                if (type === vscode.FileType.File && name.endsWith('.json')) {
                    const content = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.workflowsDir, name));
                    try {
                        const wf = JSON.parse(Buffer.from(content).toString('utf8'));
                        workflows.push(wf);
                    } catch (e) {
                        console.error(`Error parsing workflow ${name}:`, e);
                    }
                }
            }
            return workflows;
        } catch (e) {
            return [];
        }
    }

    public async saveWorkflow(workflow: Workflow): Promise<void> {
        const filePath = vscode.Uri.joinPath(this.workflowsDir, `${workflow.id}.json`);
        await vscode.workspace.fs.writeFile(filePath, Buffer.from(JSON.stringify(workflow, null, 2), 'utf8'));
        this._onDidChange.fire();
    }

    public async deleteWorkflow(id: string): Promise<void> {
        const filePath = vscode.Uri.joinPath(this.workflowsDir, `${id}.json`);
        try {
            await vscode.workspace.fs.delete(filePath);
            this._onDidChange.fire();
        } catch (e) {
            console.error(`Error deleting workflow ${id}:`, e);
        }
    }

    public createNewWorkflow(name: string): Workflow {
        return {
            id: Date.now().toString(),
            name: name,
            nodes: [],
            edges: []
        };
    }
}
