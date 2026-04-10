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

    public focusSymbol(label: string, type: string) {
        this.panel.webview.postMessage({ command: 'focusNode', label, type });
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
            if (msg.command === 'runSymbol') {
                const nodes = this.graphManager.getGraphData().nodes;
                const targetNode = nodes.find(n => 
                    n.label === msg.symbol || n.id === msg.symbol
                );
                
                if (targetNode) {
                    // Switch from "Execute" to "Focus Visual"
                    this.focusSymbol(targetNode.label, targetNode.type);
                } else {
                    vscode.window.showWarningMessage(`Symbol "${msg.symbol}" not found in graph.`);
                }
            }

            if (msg.command === 'ready') {
                // Ensure manager is synchronized with the actual workspace root before building
                const folders = vscode.workspace.workspaceFolders;
                if (folders && folders.length > 0) {
                    this.graphManager.setWorkspaceRoot(folders[0].uri);
                }

                const activeEditor = vscode.window.activeTextEditor;
                const focusPath = (activeEditor && activeEditor.document.uri.scheme === 'file') 
                    ? vscode.workspace.asRelativePath(activeEditor.document.uri) 
                    : undefined;

                if (this.graphManager.getGraphData().nodes.length === 0 && this.graphManager.getBuildState() === 'idle') {
                    // Start build asynchronously, focusing on current file if possible
                    this.graphManager.buildGraph(focusPath).then(() => this.update());
                    this.update();
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
                const prompt = `Here is the current code structure for analysis:\n\n\`\`\`mermaid\n${mermaid}\n\`\`\``;
                
                // 1. Switch sidebar focus to Chat
                vscode.commands.executeCommand('lollms-vs-coder.showChatTab');

                if (ChatPanel.currentPanel) {
                    // 2a. Add to existing chat
                    ChatPanel.currentPanel.addMessageToDiscussion({
                        role: 'user',
                        content: prompt
                    });
                    ChatPanel.currentPanel._panel.reveal();
                    vscode.window.showInformationMessage("Architecture graph added to active chat.");
                } else {
                    // 2b. Create new chat and inject content
                    // We use the existing command that handles creation and initial prompt injection
                    vscode.commands.executeCommand('lollms-vs-coder.newDiscussionFromClipboard', prompt);
                    vscode.window.showInformationMessage("Starting new discussion with architecture graph.");
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
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        this.panel.webview.postMessage({
            command: 'graph',
            config: {
                zoomSensitivity: config.get('graph.zoomSensitivity', 0.5),
                panningEnabled: config.get('graph.panningEnabled', true),
                zoomToCursor: config.get('graph.zoomToCursor', true)
            },
            graph: this.graphManager.getGraphData(),
            state: this.graphManager.getBuildState(),
            lastError: this.graphManager.getLastError(),
            classDiagram: this.graphManager.generateMermaid('class_diagram'),
            functionSignatures: this.graphManager.generateMermaid('function_signatures')
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
    select, button, input {
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none;
        padding: 4px 10px;
        border-radius: 2px;
        cursor: pointer;
        font-family: inherit;
    }
    input {
        background-color: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border);
        cursor: text;
        flex: 1;
        max-width: 300px;
    }
    select {
        background-color: var(--vscode-dropdown-background);
        color: var(--vscode-dropdown-foreground);
        border: 1px solid var(--vscode-dropdown-border);
    }
    button:hover {
        background-color: var(--vscode-button-hoverBackground);
    }
    #run {
        background-color: var(--vscode-charts-orange);
        color: white;
        font-weight: bold;
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
        width: 40px; height: 40px;
        border: 4px solid var(--vscode-button-background);
        border-top-color: transparent;
        border-radius: 50%;
        animation: spin 1s cubic-bezier(0.4, 0, 0.2, 1) infinite;
        box-shadow: 0 0 15px var(--vscode-button-background);
    }
    #loading span {
        font-weight: 600;
        letter-spacing: 1px;
        text-transform: uppercase;
        font-size: 11px;
        margin-top: 15px;
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
            <option value="class_diagram">Inheritance Diagram</option>
            <option value="function_signatures">Function Signatures</option>
        </select>
        <div style="position:relative; flex:1; display:flex; gap:5px;">
            <input type="text" id="symbol-search" list="symbols-list" placeholder="Search symbol or SPARQL...">
            <datalist id="symbols-list"></datalist>
            <button id="run">Run / Query</button>
            <select id="sparql-examples" style="max-width:100px;">
                <option value="">Examples</option>
                <option value="SELECT ?x WHERE { ?x type 'class' }">All Classes</option>
                <option value="SELECT ?x WHERE { ?x imports 'auth.py' }">Imports Auth</option>
                <option value="SELECT ?target WHERE { 'main' calls ?target }">Called by Main</option>
            </select>
        </div>
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
