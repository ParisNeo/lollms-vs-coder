import * as vscode from 'vscode';
import { CodeGraph } from '../codeGraphManager';

export class CodeExplorerPanel {
    public static currentPanel: CodeExplorerPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;

    public static createOrShow(extensionUri: vscode.Uri, graphData: CodeGraph) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (CodeExplorerPanel.currentPanel) {
            CodeExplorerPanel.currentPanel.updateGraph(graphData);
            CodeExplorerPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'lollmsCodeExplorer',
            'Code Structure Graph',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
            }
        );

        CodeExplorerPanel.currentPanel = new CodeExplorerPanel(panel, extensionUri, graphData);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, initialGraphData: CodeGraph) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._panel.webview.html = this._getHtmlForWebview(initialGraphData);
        this._panel.onDidDispose(() => this.dispose(), null, []);
        this._setWebviewMessageListener();
    }
    
    private _setWebviewMessageListener() {
        this._panel.webview.onDidReceiveMessage(async message => {
            if (message.command === 'openFile' && message.filePath) {
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
        });
    }

    public updateGraph(graphData: CodeGraph) {
        this._panel.webview.postMessage({ command: 'updateGraph', data: graphData });
    }

    public dispose() {
        CodeExplorerPanel.currentPanel = undefined;
        this._panel.dispose();
    }

    private _getHtmlForWebview(graphData: CodeGraph): string {
        
        // Pass translated strings to the webview
        const l10n = {
            viewLabel: vscode.l10n.t('view.codeGraph.viewLabel', "View:"),
            callGraph: vscode.l10n.t('view.codeGraph.callGraph', "Call Graph"),
            importGraph: vscode.l10n.t('view.codeGraph.importGraph', "Import Graph"),
            classDiagram: vscode.l10n.t('view.codeGraph.classDiagram', "Class Diagram"),
            emptyState: vscode.l10n.t('view.codeGraph.emptyState', "No code structure found or graph has not been built yet. Click the diagram icon in the 'Discussions' view sidebar to build the graph."),
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
        body, html {
            font-family: var(--vscode-font-family);
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            margin: 0;
            padding: 0;
            height: 100%;
            width: 100%;
            overflow: hidden;
        }
        #cy { width: 100%; height: 100%; display: block; }
        .empty-state { text-align: center; margin-top: 3em; color: var(--vscode-descriptionForeground); }
        #toolbar {
            position: absolute;
            top: 10px;
            left: 10px;
            z-index: 10;
            background-color: var(--vscode-editorWidget-background);
            padding: 8px;
            border-radius: 5px;
            border: 1px solid var(--vscode-panel-border);
        }
        #tooltip {
            position: absolute;
            display: none;
            padding: 10px;
            background-color: var(--vscode-menu-background);
            border: 1px solid var(--vscode-menu-border);
            border-radius: 5px;
            max-width: 400px;
            z-index: 100;
            pointer-events: none;
            font-size: 0.9em;
            white-space: pre-wrap;
            word-wrap: break-word;
            box-shadow: 0 4px 8px rgba(0,0,0,0.2);
        }
        #tooltip h4 { margin: 0 0 5px 0; }
        #tooltip p { margin: 0; color: var(--vscode-descriptionForeground); }
        #tooltip strong { color: var(--vscode-editor-foreground); }
    </style>
</head>
<body>
    <div id="toolbar">
        <label for="view-selector">${l10n.viewLabel} </label>
        <select id="view-selector">
            <option value="call_graph" selected>${l10n.callGraph}</option>
            <option value="import_graph">${l10n.importGraph}</option>
            <option value="class_diagram">${l10n.classDiagram}</option>
        </select>
    </div>
    <div id="cy"></div>
    <div id="tooltip"></div>
    <div id="empty-state-container" class="empty-state" style="display: none;">
        <p>${l10n.emptyState}</p>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let cy;
        let fullGraphData = ${JSON.stringify(graphData)};
        const tooltip = document.getElementById('tooltip');
        const viewSelector = document.getElementById('view-selector');

        function applyViewFilter() {
            if (!fullGraphData || !fullGraphData.nodes) return [];

            const selectedView = viewSelector.value;
            const allNodes = fullGraphData.nodes.map(n => ({ data: { ...n } }));
            const allEdges = fullGraphData.edges.map(e => ({ data: { ...e } }));

            if (selectedView === 'import_graph') {
                const importEdges = allEdges.filter(e => e.data.label === 'imports');
                const relevantNodeIds = new Set();
                importEdges.forEach(e => {
                    relevantNodeIds.add(e.data.source);
                    relevantNodeIds.add(e.data.target);
                });
                const fileNodes = allNodes.filter(n => relevantNodeIds.has(n.data.id));
                return [...fileNodes, ...importEdges];
            } else if (selectedView === 'class_diagram') {
                const classNodes = allNodes.filter(n => n.data.type === 'class');
                const classNodeIds = new Set(classNodes.map(n => n.data.id));

                const methodEdges = allEdges.filter(e => e.data.label === 'contains' && classNodeIds.has(e.data.source));
                const methodIds = new Set(methodEdges.map(e => e.data.target));
                const methodNodes = allNodes.filter(n => methodIds.has(n.data.id));

                const callEdges = allEdges.filter(e => e.data.label === 'calls' && (methodIds.has(e.data.source) || methodIds.has(e.data.target)));
                
                return [...classNodes, ...methodNodes, ...methodEdges, ...callEdges];
            } else { // default to call_graph
                return [...allNodes, ...allEdges.filter(e => e.data.label !== 'imports')];
            }
        }

        function initializeCytoscape() {
            const container = document.getElementById('cy');
            const emptyState = document.getElementById('empty-state-container');
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
                    style: [
                        { selector: 'node', style: { 'label': 'data(label)', 'color': 'var(--vscode-editor-foreground)', 'font-size': '14px', 'font-weight': 'bold', 'text-valign': 'center', 'text-halign': 'center', 'background-color': 'var(--vscode-input-background)', 'border-color': 'var(--vscode-panel-border)', 'border-width': 2, 'min-zoomed-font-size': 10 } },
                        { selector: 'node[type = "file"]', style: { 'shape': 'rectangle', 'width': 'label', 'height': 'label', 'padding': '15px', 'font-size': '16px' } },
                        { selector: 'node[type = "class"]', style: { 'shape': 'octagon', 'background-color': 'var(--vscode-gitDecoration-modifiedResourceForeground)', 'border-color': 'var(--vscode-charts-yellow)' } },
                        { selector: 'node[type = "function"]', style: { 'shape': 'ellipse', 'background-color': 'var(--vscode-gitDecoration-addedResourceForeground)', 'border-color': 'var(--vscode-charts-green)' } },
                        { selector: 'edge', style: { 'width': 1.5, 'line-color': 'var(--vscode-panel-border)', 'target-arrow-color': 'var(--vscode-panel-border)', 'target-arrow-shape': 'triangle', 'curve-style': 'bezier' } },
                        { selector: 'edge[label = "contains"]', style: { 'line-style': 'dashed', 'line-color': 'var(--vscode-descriptionForeground)' } },
                        { selector: 'edge[label = "calls"]', style: { 'line-color': 'var(--vscode-charts-blue)' } },
                        { selector: 'edge[label = "imports"]', style: { 'line-color': '#999', 'line-style': 'dotted' } },
                        { selector: '.highlighted', style: { 'background-color': 'var(--vscode-list-hoverBackground)', 'line-color': 'var(--vscode-focusBorder)', 'target-arrow-color': 'var(--vscode-focusBorder)', 'transition-property': 'background-color, line-color, target-arrow-color', 'transition-duration': '0.2s' } }
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
                    tooltip.style.left = pos.x + 15 + 'px';
                    tooltip.style.top = pos.y + 15 + 'px';
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
                name: 'cose', animate: 'end', animationDuration: 300, idealEdgeLength: 180, nodeOverlap: 40,
                fit: true, padding: 30, componentSpacing: 150, nodeRepulsion: 800000, edgeElasticity: 100, gravity: 60,
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

        initializeCytoscape();
    </script>
</body>
</html>`;
    }
}