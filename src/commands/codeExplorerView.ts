import * as vscode from 'vscode';
import { CodeGraph, CodeGraphManager } from '../codeGraphManager';
import { ChatPanel } from './chatPanel/chatPanel';

export class CodeExplorerPanel {
    public static currentPanel: CodeExplorerPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _codeGraphManager: CodeGraphManager;

    public static createOrShow(extensionUri: vscode.Uri, codeGraphManager: CodeGraphManager) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (CodeExplorerPanel.currentPanel) {
            CodeExplorerPanel.currentPanel.updateGraph();
            CodeExplorerPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'lollmsCodeExplorer',
            'Code Structure Graph',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
                retainContextWhenHidden: true
            }
        );

        CodeExplorerPanel.currentPanel = new CodeExplorerPanel(panel, extensionUri, codeGraphManager);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, codeGraphManager: CodeGraphManager) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._codeGraphManager = codeGraphManager;

        this._panel.webview.html = this._getHtmlForWebview();
        this._panel.onDidDispose(() => this.dispose(), null, []);
        this._setWebviewMessageListener();
        
        // Send initial data
        this.updateGraph();
    }
    
    private _setWebviewMessageListener() {
        this._panel.webview.onDidReceiveMessage(async message => {
            switch (message.command) {
                case 'openFile':
                    if (message.filePath) {
                        const workspaceFolders = vscode.workspace.workspaceFolders;
                        if (workspaceFolders) {
                            const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, message.filePath);
                            try {
                                const document = await vscode.workspace.openTextDocument(fileUri);
                                await vscode.window.showTextDocument(document, {
                                    selection: new vscode.Range(message.line, 0, message.line, 0)
                                });
                            } catch (e) {
                                vscode.window.showErrorMessage(`Could not open file: ${message.filePath}`);
                            }
                        }
                    }
                    break;
                case 'rebuildGraph':
                    await this._codeGraphManager.buildGraph();
                    this.updateGraph();
                    vscode.window.showInformationMessage("Code graph rebuilt successfully.");
                    break;
                case 'addToContext':
                    const type = message.graphType; // 'import_graph' | 'class_diagram' | 'call_graph'
                    const mermaid = this._codeGraphManager.generateMermaid(type);
                    if (ChatPanel.currentPanel) {
                        const msg = {
                            role: 'user',
                            content: `Here is the ${type.replace('_', ' ')} of the project:\n\`\`\`mermaid\n${mermaid}\n\`\`\``
                        };
                        // @ts-ignore
                        ChatPanel.currentPanel.addMessageToDiscussion(msg);
                        vscode.window.showInformationMessage(`${type} added to chat context.`);
                    } else {
                        vscode.window.showErrorMessage("No active chat panel to add context to.");
                    }
                    break;
            }
        });
    }

    public updateGraph() {
        const graphData = this._codeGraphManager.getGraphData();
        const buildState = this._codeGraphManager.getBuildState();
        this._panel.webview.postMessage({ command: 'updateGraph', data: graphData, state: buildState });
    }

    public dispose() {
        CodeExplorerPanel.currentPanel = undefined;
        this._panel.dispose();
    }

    private _getHtmlForWebview(): string {
        const l10n = {
            viewLabel: vscode.l10n.t('view.codeGraph.viewLabel', "View:"),
            callGraph: vscode.l10n.t('view.codeGraph.callGraph', "Call Graph"),
            importGraph: vscode.l10n.t('view.codeGraph.importGraph', "Import Graph"),
            classDiagram: vscode.l10n.t('view.codeGraph.classDiagram', "Class Diagram"),
            emptyState: vscode.l10n.t('view.codeGraph.emptyState', "Graph is empty."),
            tooltipType: vscode.l10n.t('tooltip.node.type', "Type:")
        };

        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Code Structure Graph</title>
    <script src="https://unpkg.com/cytoscape/dist/cytoscape.min.js"></script>
    <style>
        :root {
            --bg-color: var(--vscode-editor-background);
            --fg-color: var(--vscode-editor-foreground);
            --border-color: var(--vscode-panel-border);
            --toolbar-bg: var(--vscode-editorWidget-background);
            --toolbar-border: var(--vscode-widget-border);
            --accent-color: var(--vscode-textLink-foreground);
            --node-bg: var(--vscode-editor-background);
            --node-border: var(--vscode-widget-border);
            --node-file-bg: var(--vscode-sideBar-background);
            --node-file-border: var(--vscode-sideBar-border);
        }
        body, html {
            font-family: var(--vscode-font-family);
            background-color: var(--bg-color);
            color: var(--fg-color);
            margin: 0;
            padding: 0;
            height: 100%;
            width: 100%;
            overflow: hidden;
        }
        #cy { width: 100%; height: 100%; display: block; background-color: var(--bg-color); }
        .empty-state {
            position: absolute;
            top: 50%; left: 50%;
            transform: translate(-50%, -50%);
            text-align: center;
            color: var(--vscode-descriptionForeground);
        }
        #toolbar {
            position: absolute;
            top: 15px;
            left: 15px;
            z-index: 20;
            background-color: var(--toolbar-bg);
            padding: 8px 12px;
            border-radius: 6px;
            border: 1px solid var(--toolbar-border);
            display: flex;
            gap: 12px;
            align-items: center;
            flex-wrap: wrap;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        #tooltip {
            position: absolute;
            display: none;
            padding: 8px 12px;
            background-color: var(--vscode-editorHoverWidget-background);
            color: var(--vscode-editorHoverWidget-foreground);
            border: 1px solid var(--vscode-editorHoverWidget-border);
            border-radius: 4px;
            max-width: 350px;
            z-index: 100;
            pointer-events: none;
            font-size: 13px;
            white-space: pre-wrap;
            word-wrap: break-word;
            box-shadow: 0 4px 8px rgba(0,0,0,0.2);
        }
        #tooltip h4 { margin: 0 0 4px 0; font-size: 14px; font-weight: 600; }
        #tooltip p { margin: 0; opacity: 0.9; }
        
        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            border-radius: 3px;
            cursor: pointer;
            font-family: var(--vscode-font-family);
            font-size: 12px;
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .secondary-btn {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .secondary-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        select {
            background-color: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            padding: 5px;
            border-radius: 3px;
            font-family: var(--vscode-font-family);
            outline: none;
            color: var(--vscode-editor-foreground);
        }
        select:focus {
            border-color: var(--vscode-focusBorder);
        }
        label { font-size: 12px; font-weight: 500; }
    </style>
</head>
<body>
    <div id="toolbar">
        <div>
            <label for="view-selector">${l10n.viewLabel} </label>
            <select id="view-selector">
                <option value="call_graph" selected>${l10n.callGraph}</option>
                <option value="import_graph">${l10n.importGraph}</option>
                <option value="class_diagram">${l10n.classDiagram}</option>
            </select>
        </div>
        <button id="recreate-btn">Recreate Graph</button>
        <button id="add-context-btn" class="secondary-btn">Add View to Chat</button>
    </div>
    
    <div id="cy"></div>
    <div id="tooltip"></div>
    
    <div id="empty-state-container" class="empty-state" style="display: none;">
        <p>${l10n.emptyState}</p>
        <button id="build-btn-empty">Build Graph</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let cy;
        let fullGraphData = { nodes: [], edges: [] };
        const tooltip = document.getElementById('tooltip');
        const viewSelector = document.getElementById('view-selector');
        const emptyState = document.getElementById('empty-state-container');
        const container = document.getElementById('cy');

        document.getElementById('recreate-btn').addEventListener('click', () => {
            vscode.postMessage({ command: 'rebuildGraph' });
        });
        
        document.getElementById('build-btn-empty').addEventListener('click', () => {
            vscode.postMessage({ command: 'rebuildGraph' });
        });

        document.getElementById('add-context-btn').addEventListener('click', () => {
            vscode.postMessage({ command: 'addToContext', graphType: viewSelector.value });
        });

        function applyViewFilter() {
            if (!fullGraphData || !fullGraphData.nodes) return [];

            const selectedView = viewSelector.value;
            const allNodes = fullGraphData.nodes.map(n => ({ data: { ...n } }));
            const allEdges = fullGraphData.edges.map(e => ({ data: { ...e } }));

            if (selectedView === 'import_graph') {
                const importEdges = allEdges.filter(e => e.data.label === 'imports');
                // SHOW ALL FILES even if disconnected
                const fileNodes = allNodes.filter(n => n.data.type === 'file');
                return [...fileNodes, ...importEdges];
            } else if (selectedView === 'class_diagram') {
                const classNodes = allNodes.filter(n => n.data.type === 'class' || n.data.type === 'interface');
                const classNodeIds = new Set(classNodes.map(n => n.data.id));

                const methodEdges = allEdges.filter(e => e.data.label === 'contains' && classNodeIds.has(e.data.source));
                const methodIds = new Set(methodEdges.map(e => e.data.target));
                const methodNodes = allNodes.filter(n => methodIds.has(n.data.id));

                const callEdges = allEdges.filter(e => e.data.label === 'calls' && (methodIds.has(e.data.source) || methodIds.has(e.data.target) || classNodeIds.has(e.data.source) || classNodeIds.has(e.data.target)));
                
                return [...classNodes, ...methodNodes, ...methodEdges, ...callEdges];
            } else { // default to call_graph (functions + calls + containing files)
                const relevantNodes = allNodes.filter(n => n.data.type === 'function' || n.data.type === 'file' || n.data.type === 'class'); 
                const relevantEdges = allEdges.filter(e => e.data.label === 'calls' || e.data.label === 'contains');
                return [...relevantNodes, ...relevantEdges];
            }
        }

        function initializeCytoscape() {
            const elements = applyViewFilter();

            if (elements.length === 0) {
                container.style.display = 'none';
                emptyState.style.display = 'block';
                if (cy) { cy.destroy(); cy = null; }
                return;
            }
            container.style.display = 'block';
            emptyState.style.display = 'none';
            
            if (cy) {
                cy.elements().remove();
                cy.add(elements);
            } else {
                cy = cytoscape({
                    container: container,
                    elements: elements,
                    minZoom: 0.1,
                    maxZoom: 3,
                    wheelSensitivity: 0.2,
                    style: [
                        { 
                            selector: 'node', 
                            style: {
                                'label': 'data(label)',
                                'color': 'var(--vscode-editor-foreground)',
                                'font-family': 'var(--vscode-font-family)',
                                'font-size': '11px',
                                'text-valign': 'center',
                                'text-halign': 'center',
                                'background-color': 'var(--node-bg)',
                                'border-width': 1,
                                'border-color': 'var(--node-border)',
                                'width': 'label',
                                'height': 'label',
                                'padding': '8px',
                                'shape': 'round-rectangle',
                                'text-wrap': 'wrap',
                                'text-max-width': '120px'
                            }
                        },
                        { 
                            selector: 'node[type = "file"]', 
                            style: {
                                'background-color': 'var(--node-file-bg)',
                                'border-color': 'var(--node-file-border)',
                                'shape': 'round-rectangle',
                                'font-weight': 'bold',
                                'border-width': 2,
                                'padding': '10px'
                            }
                        },
                        { 
                            selector: 'node[type = "class"]', 
                            style: {
                                'border-color': 'var(--vscode-charts-orange)',
                                'border-width': 2,
                                'shape': 'cut-rectangle'
                            }
                        },
                        { 
                            selector: 'node[type = "interface"]', 
                            style: {
                                'border-color': 'var(--vscode-charts-green)',
                                'border-style': 'dashed',
                                'border-width': 2,
                                'shape': 'cut-rectangle'
                            }
                        },
                        { 
                            selector: 'node[type = "function"]', 
                            style: {
                                'border-color': 'var(--vscode-charts-blue)',
                                'border-width': 1,
                                'shape': 'ellipse',
                                'padding': '10px'
                            }
                        },
                        { 
                            selector: 'edge', 
                            style: {
                                'width': 1.5,
                                'line-color': 'var(--vscode-scrollbarSlider-background)',
                                'target-arrow-color': 'var(--vscode-scrollbarSlider-background)',
                                'target-arrow-shape': 'triangle',
                                'curve-style': 'bezier',
                                'arrow-scale': 0.8
                            }
                        },
                        { 
                            selector: 'edge[label = "contains"]', 
                            style: {
                                'line-style': 'dashed',
                                'line-color': 'var(--vscode-descriptionForeground)',
                                'target-arrow-shape': 'none',
                                'width': 1,
                                'opacity': 0.7
                            }
                        },
                        { 
                            selector: 'edge[label = "calls"]', 
                            style: {
                                'line-color': 'var(--vscode-charts-blue)',
                                'target-arrow-color': 'var(--vscode-charts-blue)',
                                'opacity': 0.8
                            }
                        },
                        { 
                            selector: 'edge[label = "imports"]', 
                            style: {
                                'line-style': 'dotted',
                                'line-color': 'var(--vscode-charts-green)',
                                'target-arrow-color': 'var(--vscode-charts-green)',
                                'opacity': 0.6
                            }
                        },
                        { 
                            selector: '.highlighted', 
                            style: {
                                'background-color': 'var(--vscode-list-hoverBackground)',
                                'border-color': 'var(--vscode-focusBorder)',
                                'line-color': 'var(--vscode-focusBorder)',
                                'target-arrow-color': 'var(--vscode-focusBorder)',
                                'transition-property': 'background-color, line-color, target-arrow-color',
                                'transition-duration': '0.2s',
                                'z-index': 100
                            }
                        }
                    ]
                });

                cy.on('tap', 'node', function(evt){
                    const node = evt.target;
                    vscode.postMessage({ command: 'openFile', filePath: node.data('filePath'), line: node.data('startLine') });
                });

                cy.on('mouseover', 'node', function(e){
                    const node = e.target;
                    const nodeData = node.data();
                    let content = \`<h4>\${nodeData.label}</h4><p><strong>${l10n.tooltipType}</strong> \${nodeData.type}</p>\`;
                    if (nodeData.docstring) { content += \`<p>\${nodeData.docstring}</p>\`; }
                    tooltip.innerHTML = content;
                    tooltip.style.display = 'block';
                    const pos = e.renderedPosition;
                    const canvasBox = container.getBoundingClientRect();
                    tooltip.style.left = (canvasBox.left + pos.x + 20) + 'px';
                    tooltip.style.top = (canvasBox.top + pos.y + 20) + 'px';
                    
                    node.addClass('highlighted');
                    node.neighborhood().addClass('highlighted');
                });
                cy.on('mouseout', 'node', function(e){
                    tooltip.style.display = 'none';
                    const node = e.target;
                    node.removeClass('highlighted');
                    node.neighborhood().removeClass('highlighted');
                });
                cy.on('pan zoom', function(){ tooltip.style.display = 'none'; });
            }

            cy.layout({
                name: 'cose', 
                animate: true, 
                animationDuration: 800, 
                idealEdgeLength: 100, 
                nodeOverlap: 20,
                fit: true, 
                padding: 50, 
                componentSpacing: 80, 
                nodeRepulsion: 1000000, 
                edgeElasticity: 50, 
                nestingFactor: 5, 
                gravity: 90, 
                numIter: 1000, 
                initialTemp: 200, 
                coolingFactor: 0.95, 
                minTemp: 1.0,
                randomize: false
            }).run();
        }

        viewSelector.addEventListener('change', initializeCytoscape);

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'updateGraph') {
                fullGraphData = message.data;
                initializeCytoscape();
            }
        });
    </script>
</body>
</html>`;
    }
}
