import * as vscode from 'vscode';
import { WorkflowEngine } from '../workflow/engine';
import { LollmsAPI } from '../lollmsAPI';

export class WorkflowStudioPanel {
    public static currentPanel: WorkflowStudioPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _engine: WorkflowEngine;

    public static createOrShow(extensionUri: vscode.Uri, lollms: LollmsAPI) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (WorkflowStudioPanel.currentPanel) {
            WorkflowStudioPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'lollmsWorkflowStudio',
            'Lollms Flow Studio',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
                retainContextWhenHidden: true
            }
        );

        WorkflowStudioPanel.currentPanel = new WorkflowStudioPanel(panel, extensionUri, lollms);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, lollms: LollmsAPI) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._engine = new WorkflowEngine(lollms);

        this._panel.webview.html = this._getHtmlForWebview();
        this._panel.onDidDispose(() => this.dispose(), null, []);
        
        this._panel.webview.onDidReceiveMessage(async message => {
            switch (message.command) {
                case 'runWorkflow':
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders) {
                        await this._engine.executeWorkflow(message.workflow, workspaceFolders[0].uri.fsPath, (msg) => {
                            this._panel.webview.postMessage({ command: 'log', message: msg });
                        });
                    } else {
                        vscode.window.showErrorMessage("No workspace open.");
                    }
                    break;
                case 'saveWorkflow':
                    // Implement saving logic
                    break;
            }
        });
    }

    public dispose() {
        WorkflowStudioPanel.currentPanel = undefined;
        this._panel.dispose();
    }

    private _getHtmlForWebview(): string {
        // This is a placeholder for a complex graph editor like Rete.js or React Flow.
        // Since we can't bundle those easily here, we provide a conceptual JSON editor + Visualization placeholder.
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Lollms Flow Studio</title>
    <style>
        body { font-family: var(--vscode-font-family); background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); display: flex; flex-direction: column; height: 100vh; margin: 0; }
        .toolbar { padding: 10px; background: var(--vscode-editorWidget-background); border-bottom: 1px solid var(--vscode-widget-border); display: flex; gap: 10px; }
        .main { flex: 1; display: flex; }
        .palette { width: 200px; border-right: 1px solid var(--vscode-widget-border); padding: 10px; }
        .canvas { flex: 1; position: relative; background-image: radial-gradient(var(--vscode-widget-border) 1px, transparent 1px); background-size: 20px 20px; }
        .console { height: 150px; border-top: 1px solid var(--vscode-widget-border); padding: 10px; overflow-y: auto; background: var(--vscode-terminal-background); font-family: monospace; }
        
        /* Node Styling Placeholder */
        .node { 
            position: absolute; width: 150px; background: var(--vscode-editorWidget-background); 
            border: 1px solid var(--vscode-focusBorder); border-radius: 5px; padding: 10px; 
            box-shadow: 0 4px 6px rgba(0,0,0,0.3); cursor: move;
        }
        .node-header { font-weight: bold; border-bottom: 1px solid var(--vscode-widget-border); margin-bottom: 5px; padding-bottom: 2px; }
        .socket { width: 10px; height: 10px; background: var(--vscode-textLink-foreground); border-radius: 50%; margin: 5px 0; }
        
        button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; cursor: pointer; }
        button:hover { background: var(--vscode-button-hoverBackground); }
    </style>
</head>
<body>
    <div class="toolbar">
        <button id="runBtn">▶ Run Workflow</button>
        <button id="saveBtn">💾 Save</button>
        <span style="margin-left: auto;">Photo Organization Demo</span>
    </div>
    <div class="main">
        <div class="palette">
            <h3>Nodes</h3>
            <div>📄 File Iterator</div>
            <div>👁️ Lollms Vision</div>
            <div>📂 Move File</div>
            <div>🐍 Code Exec</div>
        </div>
        <div class="canvas" id="canvas">
            <!-- Mockup of the Photo Workflow -->
            <div class="node" style="top: 50px; left: 50px;">
                <div class="node-header">File Iterator</div>
                <div class="socket" style="float: right;"></div>
                <small>Folder: /photos</small>
            </div>
            
            <div class="node" style="top: 50px; left: 300px;">
                <div class="node-header">Lollms Vision</div>
                <div class="socket" style="float: left;"></div>
                <div class="socket" style="float: right;"></div>
                <small>Prompt: Extract Date</small>
            </div>

            <div class="node" style="top: 50px; left: 550px;">
                <div class="node-header">Move File</div>
                <div class="socket" style="float: left;"></div>
                <small>Target: /organized</small>
            </div>
            
            <!-- SVG lines would go here -->
        </div>
    </div>
    <div class="console" id="console">
        <div>> System Ready.</div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const consoleDiv = document.getElementById('console');

        function log(msg) {
            const line = document.createElement('div');
            line.textContent = '> ' + msg;
            consoleDiv.appendChild(line);
            consoleDiv.scrollTop = consoleDiv.scrollHeight;
        }

        // Hardcoded Example Workflow Data for the "Run" button
        const demoWorkflow = {
            id: "photo-org",
            name: "Photo Organizer",
            nodes: [
                { 
                    id: "n1", type: "file_iterator", 
                    data: { folderPath: "family_photos" } 
                },
                { 
                    id: "n2", type: "lollms_vision", 
                    data: { prompt: "Analyze this image. Return JSON with 'event' and 'year'. Example: {\\"event\\": \\"Birthday\\", \\"year\\": \\"2023\\"}" } 
                },
                { 
                    id: "n3", type: "move_file", 
                    data: {} 
                }
            ],
            edges: [
                { source: "n1", sourceHandle: "currentFile", target: "n2", targetHandle: "imagePath" },
                { source: "n1", sourceHandle: "currentFile", target: "n3", targetHandle: "sourcePath" }, // Pass file path through
                { source: "n2", sourceHandle: "event", target: "n3", targetHandle: "targetFolder" } // Use event as folder name
            ]
        };

        document.getElementById('runBtn').addEventListener('click', () => {
            log('Sending workflow to engine...');
            vscode.postMessage({ command: 'runWorkflow', workflow: demoWorkflow });
        });

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'log') {
                log(message.message);
            }
        });
    </script>
</body>
</html>`;
    }
}
