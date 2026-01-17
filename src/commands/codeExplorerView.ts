import * as vscode from 'vscode';
import * as path from 'path';
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
                // Only build if the graph is empty AND we aren't already building
                if (this.graphManager.getGraphData().nodes.length === 0 && this.graphManager.getBuildState() === 'idle') {
                    // Start build asynchronously
                    this.graphManager.buildGraph().then(() => this.update());
                    this.update(); // Push updated state (building)
                } else {
                    this.update();
                }
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
                this.update(); 
                this.graphManager.buildGraph().then(() => this.update());
                this.update();
            }

            if (msg.command === 'stop') {
                this.graphManager.cancel();
                this.update();
            }

            if (msg.command === 'addToChat') {
                const mermaid = this.graphManager.generateMermaid(msg.view);
                if (ChatPanel.currentPanel) {
                    ChatPanel.currentPanel.addMessageToDiscussion({
                        role: 'user',
                        content: `Here is the code structure:\n\`\`\`mermaid\n${mermaid}\n\`\`\``
                    });
                    
                    // Reveal the chat panel so the user sees the added graph immediately
                    ChatPanel.currentPanel._panel.reveal();
                    
                    vscode.window.showInformationMessage("Graph added to chat.");
                } else {
                    vscode.window.showErrorMessage("No active chat to add graph to.");
                }
            }

            if (msg.command === 'requestExport') {
                const format = await vscode.window.showQuickPick(['PNG Image', 'SVG Image', 'Mermaid Text'], {
                    placeHolder: 'Select export format'
                });
                if (!format) return;
            
                if (format === 'Mermaid Text') {
                    const mermaid = this.graphManager.generateMermaid(msg.view);
                    const uri = await vscode.window.showSaveDialog({
                        filters: { 'Mermaid': ['mmd', 'mermaid'] },
                        saveLabel: 'Export Mermaid',
                        defaultUri: vscode.Uri.file(`${msg.view}.mmd`)
                    });
                    if (uri) {
                        await vscode.workspace.fs.writeFile(uri, Buffer.from(mermaid, 'utf8'));
                        vscode.window.showInformationMessage('Mermaid diagram exported.');
                    }
                } else {
                    // Delegate visual exports to webview
                    this.panel.webview.postMessage({ 
                        command: 'triggerExport', 
                        format: format === 'PNG Image' ? 'png' : 'svg',
                        view: msg.view
                    });
                }
            }
            
            if (msg.command === 'saveContent') {
                const { name, content, format } = msg; 
                const filters: {[key:string]: string[]} = {};
                if (format === 'png') filters['Images'] = ['png'];
                else if (format === 'svg') filters['SVG'] = ['svg'];
                
                const uri = await vscode.window.showSaveDialog({
                    filters,
                    defaultUri: vscode.Uri.file(name),
                    saveLabel: 'Export Graph'
                });
                
                if (uri) {
                    let buffer: Buffer;
                    if (format === 'png') {
                        // Remove header "data:image/png;base64,"
                        const base64Data = content.replace(/^data:image\/png;base64,/, "");
                        buffer = Buffer.from(base64Data, 'base64');
                    } else {
                        buffer = Buffer.from(content, 'utf8');
                    }
                    await vscode.workspace.fs.writeFile(uri, buffer);
                    vscode.window.showInformationMessage(`Graph exported to ${path.basename(uri.fsPath)}`);
                }
            }
        });
    }

    private update() {
        this.panel.webview.postMessage({
            command: 'graph',
            graph: this.graphManager.getGraphData(),
            state: this.graphManager.getBuildState(),
            lastError: this.graphManager.getLastError(),
            classDiagram: this.graphManager.generateMermaid('class_diagram')
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
        display: none; /* Hidden by default until render */
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
        display: none; /* Hidden by default */
        justify-content: center;
        align-items: center;
        z-index: 100;
        flex-direction: column;
        gap: 10px;
    }
    .spinner {
        width: 20px; height: 20px;
        border: 2px solid white;
        border-top-color: transparent;
        border-radius: 50%;
        animation: spin 1s linear infinite;
    }
    @keyframes spin { 100% { transform: rotate(360deg); } }
    
    #stop {
        background-color: var(--vscode-charts-red);
        color: white;
        display: none;
    }
    #stop:hover { opacity: 0.8; }
</style>
</head>
<body>
    <div id="toolbar">
        <select id="view">
            <option value="call_graph">Call Graph</option>
            <option value="import_graph">Import Graph</option>
            <option value="class_diagram">Class Diagram</option>
        </select>
        <button id="rebuild">Refresh</button>
        <button id="stop">Stop</button>
        <button id="add">Add to Chat</button>
        <button id="export">Export</button>
        <span id="status">Idle</span>
    </div>
    
    <div id="content-area">
        <div id="cy"></div>
        <div id="mermaid-container"></div>
        <div id="loading" class="loading-overlay">
            <div class="spinner"></div>
            <span>Building Graph...</span>
        </div>
    </div>

<script src="${scriptUri}"></script>
</body>
</html>
`;
    }
}
