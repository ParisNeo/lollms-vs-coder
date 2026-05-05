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
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Lollms Flow Studio</title>
    <link rel="stylesheet" href="https://unpkg.com/@xyflow/react/dist/style.css">
    <style>
        body { margin: 0; display: flex; flex-direction: column; height: 100vh; background: #1e1e1e; color: #fff; font-family: sans-serif; }
        #app { flex: 1; position: relative; }
        .toolbar { padding: 10px; background: #2d2d2d; border-bottom: 1px solid #333; display: flex; gap: 10px; }
        .node-palette { width: 200px; background: #252526; border-right: 1px solid #333; padding: 10px; }
        .node-type { padding: 8px; background: #3c3c3c; border-radius: 4px; margin-bottom: 8px; cursor: grab; font-size: 12px; }
        .node-type:hover { background: #505050; }
        button { background: #007acc; color: white; border: none; padding: 6px 12px; border-radius: 2px; cursor: pointer; }
    </style>
    </head>
    <body>
    <div class="toolbar">
        <button id="runBtn">▶ Run Protocol</button>
        <button id="saveBtn">💾 Save Mission Profile</button>
        <button id="aiBuildBtn" style="background: #6a1b9a;">✨ Build with AI</button>
    </div>
    <div style="display: flex; flex: 1; overflow: hidden;">
        <div class="node-palette">
            <h3>Building Blocks</h3>
            <div class="node-type" draggable="true" data-type="agent">👤 Specialist Agent</div>
            <div class="node-type" draggable="true" data-type="tool">🛠️ Execution Tool</div>
            <div class="node-type" draggable="true" data-type="condition">⚖️ Logic Gate</div>
            <div class="node-type" draggable="true" data-type="parallel">🌿 Parallel Fork</div>
            <div class="node-type" draggable="true" data-type="loop">🔄 Iterative Loop</div>
        </div>
        <div id="app" style="width: 100%; height: 100%;"></div>
    </div>

    <!-- Load as Module to support ESM imports from CDN -->
    <script type="module">
        // Fix: Use pinned versions and force dependency sharing to prevent "useState is null" errors
        import React, { useState, useCallback } from 'https://esm.sh/react@18.2.0';
        import ReactDOM from 'https://esm.sh/react-dom@18.2.0?deps=react@18.2.0';
        import { ReactFlow, Background, Controls } from 'https://esm.sh/@xyflow/react?deps=react@18.2.0';

        // Fix: Idempotent VSCode API acquisition
        if (!window.vscode) {
            window.vscode = acquireVsCodeApi();
        }
        const vscode = window.vscode;

        const initialNodes = [
          { id: '1', type: 'input', data: { label: 'Start Mission' }, position: { x: 250, y: 5 } },
        ];

        function Flow() {
          const [nodes, setNodes] = useState(initialNodes);
          const [edges, setEdges] = useState([]);

          return React.createElement('div', { style: { width: '100%', height: '100%' } }, 
            React.createElement(ReactFlow, {
              nodes: nodes,
              edges: edges,
              fitView: true
            }, 
              React.createElement(Background),
              React.createElement(Controls)
            )
          );
        }

        const root = ReactDOM.createRoot(document.getElementById('app'));
        root.render(React.createElement(Flow));

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

        const runBtn = document.getElementById('runBtn');
        if (runBtn) {
            runBtn.addEventListener('click', () => {
                log('Sending workflow to engine...');
                vscode.postMessage({ command: 'runWorkflow', workflow: demoWorkflow });
            });
        }

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
