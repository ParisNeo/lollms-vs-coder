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
- s:File (e.g. ?x s:type s:File)
- s:Class (e.g. ?x s:type s:Class)
- s:Function (e.g. ?x s:type s:Function)
- s:Method (e.g. ?x s:type s:Method)
- s:Library (e.g. ?x s:type s:Library)

Properties:
- s:type (e.g. ?x s:type s:File)
- s:name (e.g. ?x s:name 'filename')
- s:path (e.g. ?x s:path 'relative/path')
- s:contains (e.g. ?x s:contains ?y)
- s:imports (e.g. ?x s:imports ?y)
- s:calls (e.g. ?x s:calls ?y)
- s:inherits (e.g. ?x s:inherits ?y)

### RULES:
1. Output ONLY the SPARQL-lite query. No explanations, no markdown code blocks.
2. If a specific name is mentioned, use single quotes (e.g. 'auth.py').
3. Always prefix types and properties with the 's:' namespace prefix.
4. Keep it simple.

### EXAMPLES:
- "find all files that import utils" -> SELECT ?x WHERE { ?x s:imports ?y . ?y s:name 'utils' }
- "what calls main" -> SELECT ?x WHERE { ?x s:calls 'main' }
- "all functions in auth" -> SELECT ?x WHERE { ?y s:name 'auth' . ?y s:contains ?x . ?x s:type s:Function }

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
                    this.triggerGraphBuild(focusPath);
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
                this.triggerGraphBuild();
            }

            if (msg.command === 'regenerate') {
                this.graphManager.reset();
                this.triggerGraphBuild();
            }

            if (msg.command === 'stop') {
                this.graphManager.cancel();
                this.update();
            }

            if (msg.command === 'addToChat') {
                const runAdd = async () => {
                    // Check if graph needs building
                    const graphData = this.graphManager.getGraphData();
                    const isEmpty = graphData.nodes.length <= 1;

                    if (isEmpty) {
                        await vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: "Lollms: Building full architecture map for chat context...",
                            cancellable: false
                        }, async () => {
                            await this.graphManager.buildGraph(); // Force full project re-index
                        });
                    }

                    // Export as Cytoscape JSON (Machine-readable & renders interactively with no edge limits)
                    const jsonGraph = this.graphManager.generateCytoscapeJson();

                    const prompt = `Here is the current code structure representing the workspace architecture (files, classes, and function dependencies). 
Analyze this graph structure to locate entry points or architectural components:

\`\`\`cytoscape
${jsonGraph}
\`\`\``;

                    vscode.commands.executeCommand('lollms-vs-coder.showChatTab');

                    if (ChatPanel.currentPanel) {
                        ChatPanel.currentPanel.addMessageToDiscussion({
                            role: 'user',
                            content: prompt
                        });
                        ChatPanel.currentPanel._panel.reveal();
                        vscode.window.showInformationMessage("High-scale Cytoscape graph added to active chat.");
                    } else {
                        vscode.commands.executeCommand('lollms-vs-coder.newDiscussionFromClipboard', prompt);
                        vscode.window.showInformationMessage("Starting new discussion with Cytoscape graph.");
                    }
                };

                runAdd();
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

    private async triggerGraphBuild(focusPath?: string) {
        this.panel.webview.postMessage({ command: 'buildProgress', percentage: 5, status: 'Scanning workspace directory...' });

        // Build graph with progressive updates
        await this.graphManager.buildGraph(focusPath, (progress) => {
            this.panel.webview.postMessage({
                command: 'buildProgress',
                percentage: progress.percentage,
                status: progress.status
            });

            // Incremental Rendering: If Pass 1 is finished, push early file nodes to the webview
            if (progress.percentage === 40) {
                this.update(true); // Send intermediate file nodes
            }
        });

        this.update();
    }

    private update(isIncremental: boolean = false) {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        this.panel.webview.postMessage({
            command: 'graph',
            config: {
                zoomSensitivity: config.get('graph.zoomSensitivity', 0.5),
                panningEnabled: config.get('graph.panningEnabled', true),
                zoomToCursor: config.get('graph.zoomToCursor', true)
            },
            graph: this.graphManager.getGraphData(),
            state: isIncremental ? 'building' : this.graphManager.getBuildState(),
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
    /* Real-time Progress Bar & Overlay */
    .progress-bar-container {
        width: 100%;
        max-width: 320px;
        height: 6px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 3px;
        overflow: hidden;
        margin-top: 12px;
        border: 1px solid rgba(255, 255, 255, 0.15);
    }
    .progress-bar-fill {
        height: 100%;
        background: var(--vscode-charts-blue);
        width: 0%;
        transition: width 0.3s ease-out;
        box-shadow: 0 0 10px var(--vscode-charts-blue);
    }
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
        gap: 12px;
        align-items: center;
        flex-shrink: 0;
        flex-wrap: wrap;
    }
    #content-area {
        flex: 1;
        display: flex;
        flex-direction: row;
        overflow: hidden;
        position: relative;
    }
    #graph-pane {
        flex: 1;
        position: relative;
        overflow: hidden;
        display: flex;
        flex-direction: column;
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
    #sidebar-right {
        width: 300px;
        background-color: var(--vscode-sideBar-background);
        border-left: 1px solid var(--vscode-panel-border);
        display: flex;
        flex-direction: column;
        padding: 16px;
        box-sizing: border-box;
        gap: 16px;
        overflow-y: auto;
        flex-shrink: 0;
    }
    .sidebar-section {
        display: flex;
        flex-direction: column;
        gap: 8px;
        background-color: var(--vscode-editorWidget-background);
        padding: 12px;
        border-radius: 6px;
        border: 1px solid var(--vscode-widget-border);
    }
    .sidebar-section h3 {
        margin: 0 0 4px 0;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        opacity: 0.7;
        color: var(--vscode-foreground);
    }
    select, button, input, textarea {
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none;
        padding: 6px 10px;
        border-radius: 2px;
        cursor: pointer;
        font-family: inherit;
        font-size: 12px;
    }
    input, textarea {
        background-color: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border);
        cursor: text;
    }
    textarea {
        resize: vertical;
        height: 80px;
        font-family: var(--vscode-editor-font-family), monospace;
    }
    select {
        background-color: var(--vscode-dropdown-background);
        color: var(--vscode-dropdown-foreground);
        border: 1px solid var(--vscode-dropdown-border);
    }
    button:hover {
        background-color: var(--vscode-button-hoverBackground);
    }
    #status-box {
        padding: 8px 12px;
        background-color: var(--vscode-editor-inactiveSelectionBackground);
        border: 1px solid var(--vscode-widget-border);
        border-radius: 4px;
        font-size: 11px;
        line-height: 1.4;
        word-break: break-all;
    }
    .context-menu-item:hover {
        background-color: var(--vscode-menu-selectionBackground) !important;
        color: var(--vscode-menu-selectionForeground) !important;
    }
    .loading-overlay {
        position: absolute;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.75); /* Darken backplate for visual depth */
        backdrop-filter: blur(4px);
        color: white;
        display: none;
        justify-content: center;
        align-items: center;
        z-index: 100;
        flex-direction: column;
        gap: 8px;
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
        <select id="view" title="Graph View Perspective">
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

        <select id="detail-level" title="Ontological Filter Level">
            <option value="all">Full Ontology (All Relations)</option>
            <option value="calls_only">Direct Calls Only (Invocations)</option>
            <option value="params_only">Signature Types (Parameters/Returns)</option>
            <option value="variables_only">Local Variables & Instantiations</option>
        </select>

        <label style="display:flex; align-items:center; gap:4px; font-size:11px; cursor:pointer; user-select:none;">
            <input type="checkbox" id="hide-orphans" style="width:auto; margin:0;" /> Hide Orphans
        </label>

        <div style="flex:1"></div>

        <button id="rebuild" title="Update current view with new changes">Refresh</button>
        <button id="stop" style="display:none;">Stop</button>
        
        <select id="action-select" style="max-width:140px;" title="More Actions">
            <option value="" disabled selected>More Actions...</option>
            <option value="regenerate">⚡ Regenerate Cache</option>
            <option value="add">💬 Add to Chat</option>
            <option value="export">📤 Export Diagram</option>
            <option value="isolate-connected">🔗 Isolate Connections</option>
            <option value="isolate-neighbors">👥 Isolate Neighbors</option>
        </select>
    </div>
    
    <div id="content-area">
        <div id="graph-pane">
            <div id="cy"></div>
            <div id="mermaid-container"></div>
            <div id="loading" class="loading-overlay">
                <div class="spinner"></div>
                <span id="loading-status" style="font-weight: 600; letter-spacing: 0.5px; font-size: 11px;">Building Graph...</span>
                <div class="progress-bar-container">
                    <div id="loading-progress" class="progress-bar-fill"></div>
                </div>
            </div>
        </div>

        <div id="sidebar-right">
            <!-- Section 1: Local Navigation/Search -->
            <div class="sidebar-section">
                <h3>🔍 Symbol Filter</h3>
                <input type="text" id="symbol-search" list="symbols-list" placeholder="Filter nodes by name..." style="width:100%;">
                <datalist id="symbols-list"></datalist>
                <button id="clear-highlights" style="display:none; background-color: var(--vscode-charts-orange); color: white; width:100%; margin-top:8px;" title="Clear all active highlights and pathfinders">Clear Highlights</button>
            </div>

            <!-- Section 2: SPARQL Queries -->
            <div class="sidebar-section">
                <h3>⚡ SPARQL Query</h3>
                <textarea id="sparql-query-input" placeholder="SELECT ?x WHERE { ?x type 'class' }"></textarea>

                <div style="display:flex; gap:6px; margin-top:4px;">
                    <button id="run-sparql-btn" style="background-color: var(--vscode-charts-orange); color: white; font-weight: bold; flex: 1;" title="Execute SPARQL-lite query on graph">Run SPARQL</button>
                    <select id="sparql-examples" style="flex: 1;" title="Predefined SPARQL templates">
                        <option value="">Examples</option>
                        <option value="SELECT ?class WHERE { ?class s:type s:Class }">All Classes</option>
                        <option value="SELECT ?func WHERE { ?func s:type s:Function }">All Global Functions</option>
                        <option value="SELECT ?file WHERE { ?file s:imports ?lib . ?lib s:type s:Library }">Files using External Libraries</option>
                        <option value="SELECT ?caller ?callee WHERE { ?caller s:calls ?callee }">All Invocations (Caller -> Callee)</option>
                        <option value="SELECT ?method WHERE { ?class s:name 'Player' . ?class s:contains ?method . ?method s:type s:Method }">Methods of 'Player' Class</option>
                        <option value="SELECT ?target WHERE { ?caller s:name 'start_game' . ?caller s:calls ?target }">Symbols Called by 'start_game'</option>
                        <option value="SELECT ?class WHERE { ?func s:name 'load_enemy_sprite_sheets' . ?func s:localVariable ?class . ?class s:type s:Class }">Classes Instantiated in 'load_enemy_sprite_sheets'</option>
                        <option value="SELECT ?type WHERE { ?method s:name '_play_story_sound' . ?method s:inputParam ?type }">Parameter Types of '_play_story_sound'</option>
                        <option value="SELECT ?type WHERE { ?func s:name 'get_frame_count' . ?func s:outputParam ?type }">Return Type of 'get_frame_count'</option>
                        <option value="SELECT ?child WHERE { ?child s:inherits ?parent . ?parent s:name 'Sprite' }">Classes Inheriting from 'Sprite'</option>
                        <option value="SELECT ?file WHERE { ?file s:imports ?target . ?target s:name 'constants.py' }">Files Importing 'constants.py'</option>
                    </select>
                </div>
            </div>

            <!-- Section 3: AI Natural Language Queries -->
            <div class="sidebar-section">
                <h3>🤖 AI Natural Language Query</h3>
                <textarea id="ai-query-input" placeholder="Ask AI in plain English... (e.g. Where is sprite management?)"></textarea>

                <div style="display:flex; gap:6px; margin-top:4px;">
                    <button id="run-ai-btn" style="background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); font-weight: bold; flex: 1;" title="Ask AI to translate and run query">Ask AI</button>
                    <select id="ai-examples" style="flex: 1;" title="Predefined Natural Language questions">
                        <option value="">Examples</option>
                        <option value="which function is the main entry point of the game?">Main Entry Point</option>
                        <option value="where is the sprite animation handled?">Sprite Animation</option>
                        <option value="what is the main game loop flow?">Game Loop Flow</option>
                        <option value="find all classes that inherit from Sprite or Character">Sprite Class Hierarchy</option>
                        <option value="what methods does the Player class contain?">Player Class Methods</option>
                        <option value="which files import pygame or other external game engines?">External Library Imports</option>
                        <option value="what functions instantiate or use the Dungeon class?">Dungeon Instantiations</option>
                        <option value="where is the audio or sound play logic defined?">Sound & Audio Logic</option>
                        <option value="what are the input parameters for start_game?">start_game Parameters</option>
                    </select>
                </div>
            </div>

            <!-- Section 3: Status & Output -->
            <div class="sidebar-section" style="flex:1; display:flex; flex-direction:column; min-height:100px;">
                <h3>📊 System Status</h3>
                <div id="status-box" style="flex:1; overflow-y:auto; font-family:monospace; font-size:10px;">
                    <span id="status">Idle</span>
                </div>
            </div>
        </div>
    </div>

<script src="${scriptUri}"></script>
</body>
</html>
`;
    }
}
