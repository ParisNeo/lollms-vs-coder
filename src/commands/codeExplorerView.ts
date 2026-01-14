import * as vscode from 'vscode';
import { CodeGraphManager } from '../codeGraphManager';
import { ChatPanel } from './chatPanel/chatPanel';

export class CodeExplorerPanel {
    public static currentPanel: CodeExplorerPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private readonly graphManager: CodeGraphManager;

    static createOrShow(extensionUri: vscode.Uri, graphManager: CodeGraphManager) {
        const column = vscode.window.activeTextEditor?.viewColumn;

        if (CodeExplorerPanel.currentPanel) {
            CodeExplorerPanel.currentPanel.panel.reveal(column);
            // Trigger update on reveal
            CodeExplorerPanel.currentPanel.update();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'lollmsCodeExplorer',
            'Code Explorer',
            column ?? vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'out')
                ]
            }
        );

        CodeExplorerPanel.currentPanel = new CodeExplorerPanel(panel, extensionUri, graphManager);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, graphManager: CodeGraphManager) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.graphManager = graphManager;

        this.panel.webview.html = this.html(this.panel.webview);
        this.panel.onDidDispose(() => CodeExplorerPanel.currentPanel = undefined);
        this.listen();
    }

    private listen() {
        this.panel.webview.onDidReceiveMessage(async msg => {
            if (msg.command === 'ready') {
                // If graph is empty, try building it automatically
                if (this.graphManager.getGraphData().nodes.length === 0 && this.graphManager.getBuildState() === 'idle') {
                    await this.graphManager.buildGraph();
                }
                this.update();
            }

            if (msg.command === 'open') {
                const ws = vscode.workspace.workspaceFolders?.[0];
                if (!ws) return;
                const uri = vscode.Uri.joinPath(ws.uri, msg.file);
                try {
                    const doc = await vscode.workspace.openTextDocument(uri);
                    await vscode.window.showTextDocument(doc, {
                        selection: new vscode.Range(msg.line, 0, msg.line, 0)
                    });
                } catch(e) {
                    vscode.window.showErrorMessage(`Could not open file: ${msg.file}`);
                }
            }

            if (msg.command === 'rebuild') {
                await this.graphManager.buildGraph();
                this.update();
            }

            if (msg.command === 'addToChat') {
                const mermaid = this.graphManager.generateMermaid(msg.view);
                if (ChatPanel.currentPanel) {
                    ChatPanel.currentPanel.addMessageToDiscussion({
                        role: 'user',
                        content: `Here is the code structure:\n\`\`\`mermaid\n${mermaid}\n\`\`\``
                    });
                    vscode.window.showInformationMessage("Graph added to chat.");
                } else {
                    vscode.window.showErrorMessage("No active chat to add graph to.");
                }
            }
        });
    }

    private update() {
        this.panel.webview.postMessage({
            command: 'graph',
            graph: this.graphManager.getGraphData(),
            state: this.graphManager.getBuildState(),
            lastError: this.graphManager.getLastError()
        });
    }

    private html(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'out', 'webview', 'codeGraph.bundle.js'));
        const csp = `default-src 'none'; script-src ${webview.cspSource} 'unsafe-inline'; style-src ${webview.cspSource} 'unsafe-inline'; connect-src 'none'; img-src data:;`;

        return `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Code Explorer</title>
<style>
    body {
        margin: 0;
        height: 100vh;
        display: flex;
        flex-direction: column;
        background-color: var(--vscode-editor-background);
        color: var(--vscode-editor-foreground);
        font-family: var(--vscode-font-family);
    }
    #toolbar {
        padding: 8px 16px;
        background-color: var(--vscode-editorWidget-background);
        border-bottom: 1px solid var(--vscode-panel-border);
        display: flex;
        gap: 10px;
        align-items: center;
        flex-shrink: 0;
    }
    #content-area {
        flex: 1;
        position: relative;
        overflow: hidden;
    }
    #cy {
        width: 100%;
        height: 100%;
        background-color: var(--vscode-editor-background);
    }
    #mermaid-container {
        width: 100%;
        height: 100%;
        overflow: auto;
        display: none;
        padding: 20px;
        box-sizing: border-box;
    }
    select, button {
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none;
        padding: 4px 10px;
        border-radius: 2px;
        cursor: pointer;
        font-family: inherit;
    }
    select {
        background-color: var(--vscode-dropdown-background);
        color: var(--vscode-dropdown-foreground);
        border: 1px solid var(--vscode-dropdown-border);
    }
    button:hover {
        background-color: var(--vscode-button-hoverBackground);
    }
    #status {
        margin-left: auto;
        font-size: 0.9em;
        opacity: 0.8;
    }
    .loading-overlay {
        position: absolute;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.5);
        color: white;
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 100;
        display: none;
    }
</style>
</head>
<body>
    <div id="toolbar">
        <select id="view">
            <option value="call_graph">Call Graph</option>
            <option value="import_graph">Import Graph</option>
            <option value="class_diagram">Class Diagram</option>
        </select>
        <button id="rebuild">Refresh/Rebuild</button>
        <button id="add">Add to Chat</button>
        <span id="status">Ready</span>
    </div>
    
    <div id="content-area">
        <div id="cy"></div>
        <div id="mermaid-container"></div>
        <div id="loading" class="loading-overlay">Building Graph...</div>
    </div>

<script src="${scriptUri}"></script>
</body>
</html>
`;
    }
}
