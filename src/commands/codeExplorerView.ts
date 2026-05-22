import * as vscode from 'vscode';
import * as path from 'path';
import { CodeGraphManager } from '../codeGraphManager';
import { ChatPanel } from './chatPanel/chatPanel';
import { LollmsAPI } from '../lollmsAPI';

export class CodeExplorerPanel {
    public static currentPanel: CodeExplorerPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private readonly graphManager: CodeGraphManager;
    private readonly lollmsApi?: LollmsAPI;

    static createOrShow(extensionUri: vscode.Uri, graphManager: CodeGraphManager, lollmsApi?: LollmsAPI) {
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

        CodeExplorerPanel.currentPanel = new CodeExplorerPanel(panel, extensionUri, graphManager, lollmsApi);
    }

    public focusSymbol(label: string, type: string) {
        this.panel.webview.postMessage({ command: 'focusNode', label, type });
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, graphManager: CodeGraphManager, lollmsApi?: LollmsAPI) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.graphManager = graphManager;
        this.lollmsApi = lollmsApi;

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
                    this.focusSymbol(targetNode.label, targetNode.type);
                } else {
                    vscode.window.showWarningMessage(`Symbol "${msg.symbol}" not found in graph.`);
                }
            }

            if (msg.command === 'translateNLQuery') {
                if (!this.lollmsApi) {
                    this.panel.webview.postMessage({ command: 'nlTranslationResult', error: 'AI engine not configured.' });
                    return;
                }

                const systemPrompt = `You are a SPARQL-lite Translation Expert.
Your only job is to translate a natural language query into a single valid SPARQL-lite query based on the LoLLMs Source Code Ontology.

### ONTOLOGY SPECIFICATION:
Classes:
- s:File (e.g. ?x type 'file')
- s:Class (e.g. ?x type 'class')
- s:Function (e.g. ?x type 'function')
- s:Method (e.g. ?x type 'method')
- s:Library (e.g. ?x type 'library')

Properties:
- s:contains (e.g. ?x contains ?y)
- s:imports (e.g. ?x imports ?y)
- s:calls (e.g. ?x calls ?y)
- s:inherits (e.g. ?x inherits ?y)
- s:name (e.g. ?x name 'filename')
- s:path (e.g. ?x path 'relative/path')

### RULES:
1. Output ONLY the SPARQL-lite query. No explanations, no markdown code blocks.
2. If a specific name is mentioned, use single quotes (e.g. 'auth.py').
3. Keep it simple.

### EXAMPLES:
- "find all files that import utils" -> SELECT ?x WHERE { ?x imports ?y . ?y name 'utils' }
- "what calls main" -> SELECT ?x WHERE { ?x calls 'main' }
- "all functions in auth" -> SELECT ?x WHERE { ?y name 'auth' . ?y contains ?x . ?x type 'function' }

Translate: "${msg.text}"`;

                try {
                    const response = await this.lollmsApi.sendChat([
                        { role: 'system', content: systemPrompt }
                    ]);
                    const query = response.trim().replace(/```sparql|```/g, '').trim();
                    this.panel.webview.postMessage({ command: 'nlTranslationResult', query });
                } catch(e: any) {
                    this.panel.webview.postMessage({ command: 'nlTranslationResult', error: e.message });
                }
            }

            if (msg.command === 'ready') {
                const folders = vscode.workspace.workspaceFolders;
                if (folders && folders.length > 0) {
                    this.graphManager.setWorkspaceRoot(folders[0].uri);
                }

                const activeEditor = vscode.window.activeTextEditor;
                const focusPath = (activeEditor && activeEditor.document.uri.scheme === 'file') 
                    ? vscode.workspace.asRelativePath(activeEditor.document.uri) 
                    : undefined;

                if (this.graphManager.getGraphData().nodes.length === 0 && this.graphManager.getBuildState() === 'idle') {
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

            if (msg.command === 'regenerate') {
                this.graphManager.reset();
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
                
                vscode.commands.executeCommand('lollms-vs-coder.showChatTab');

                if (ChatPanel.currentPanel) {
                    ChatPanel.currentPanel.addMessageToDiscussion({
                        role: 'user',
                        content: prompt
                    });
                    ChatPanel.currentPanel._panel.reveal();
                    vscode.window.showInformationMessage("Architecture graph added to active chat.");
                } else {
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
            functionSignatures: this.graphManager.generateMermaid('function_signatures'),
            moduleDependencyGraph: this.graphManager.generateMermaid('module_dependency_graph'),
            externalLibraryGraph: this.graphManager.generateMermaid('external_library_graph')
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
        flex-wrap: wrap;
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
        display: none;
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
        display: none;
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
            <option value="module_dependency_graph">Module/Folder Dependency Graph</option>
            <option value="external_library_graph">External Library Graph</option>
            <option value="hotspot_complexity_graph">Complexity Hotspot Map</option>
            <option value="class_diagram">Inheritance Diagram</option>
            <option value="function_signatures">Function Signatures</option>
        </select>
        
        <select id="layout-style" title="Arrangement Style">
            <option value="organic">Organic (Force-Directed)</option>
            <option value="hierarchical_ud">Hierarchical (Up-Down)</option>
            <option value="hierarchical_lr">Hierarchical (Left-Right)</option>
            <option value="circular">Circular</option>
            <option value="grid">Grid</option>
        </select>

        <select id="grouping-mode" title="Grouping Mode">
            <option value="none">No Grouping</option>
            <option value="file">Group by File</option>
            <option value="type">Group by Type</option>
        </select>

        <label style="display:flex; align-items:center; gap:4px; font-size:11px; cursor:pointer; user-select:none;">
            <input type="checkbox" id="hide-orphans" style="width:auto; margin:0;" /> Hide Orphans
        </label>

        <div style="position:relative; flex:1; display:flex; gap:5px; min-width:180px;">
            <input type="text" id="symbol-search" list="symbols-list" placeholder="Search, SPARQL, or ask in plain English...">
            <datalist id="symbols-list"></datalist>
            <button id="run" title="Run manual query">Query</button>
            <button id="ai-translate-btn" title="Translate plain English to SPARQL with AI" style="background-color: var(--vscode-charts-purple); color: white; display: ${this.lollmsApi ? 'inline-block' : 'none'};"><span class="codicon codicon-sparkle"></span> Translate</button>
            <select id="sparql-examples" style="max-width:100px;">
                <option value="">Examples</option>
                <option value="SELECT ?x WHERE { ?x type 'class' }">All Classes</option>
                <option value="SELECT ?x WHERE { ?x imports ?y . ?y name 'utils' }">Imports 'utils'</option>
                <option value="SELECT ?target WHERE { 'main' calls ?target }">Called by Main</option>
                <option value="SELECT ?method WHERE { ?class name 'authservice' . ?class contains ?method . ?method type 'method' }">AuthService Methods</option>
                <option value="SELECT ?file WHERE { ?file imports ?lib . ?lib type 'library' }">Uses Ext Libraries</option>
                <option value="SELECT ?child WHERE { ?child inherits ?parent . ?parent name 'base' }">Inherits from 'Base'</option>
            </select>
        </div>
        <button id="rebuild" title="Update current view with new changes">Refresh</button>
        <button id="regenerate" style="background-color: var(--vscode-charts-blue); color: white;" title="Wipe cache and force full project re-index">Regenerate</button>
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
