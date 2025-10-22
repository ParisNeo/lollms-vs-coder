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

        this._setPanelIcon();
        this._panel.webview.html = this._getHtmlForWebview(initialGraphData);
        this._panel.onDidDispose(() => this.dispose(), null, []);
        this._setWebviewMessageListener();
    }
    
    private _setPanelIcon() {
        const iconPath = vscode.Uri.joinPath(this._extensionUri, 'media', 'lollms-icon.svg');
        this._panel.iconPath = iconPath;
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
        const cytoscapeUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'cytoscape.min.js'));
        
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
        #cy {
            width: 100%;
            height: 100%;
            display: block;
        }
        .empty-state { text-align: center; margin-top: 3em; color: var(--vscode-descriptionForeground); }
    </style>
</head>
<body>
    <div id="cy"></div>
    <div id="empty-state-container" class="empty-state" style="display: none;">
        <p>No code structure found or graph has not been built yet.</p>
        <p>Click the diagram icon in the 'Discussions' view sidebar to build the graph.</p>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let cy;

        function renderGraph(graphData) {
            const container = document.getElementById('cy');
            const emptyState = document.getElementById('empty-state-container');

            if (!graphData || !graphData.nodes || graphData.nodes.length === 0) {
                container.style.display = 'none';
                emptyState.style.display = 'block';
                return;
            }
            container.style.display = 'block';
            emptyState.style.display = 'none';

            const elements = [
                ...graphData.nodes.map(n => ({ data: { ...n, ext: n.filePath.split('.').pop() } })),
                ...graphData.edges.map(e => ({ data: { ...e } }))
            ];

            cy = cytoscape({
                container: container,
                elements: elements,
                style: [
                    {
                        selector: 'node',
                        style: {
                            'label': 'data(label)',
                            'color': 'var(--vscode-editor-foreground)',
                            'font-size': '14px',
                            'font-weight': 'bold',
                            'text-valign': 'center',
                            'text-halign': 'center',
                            'background-color': 'var(--vscode-input-background)',
                            'border-color': 'var(--vscode-panel-border)',
                            'border-width': 2,
                            'min-zoomed-font-size': 10
                        }
                    },
                    {
                        selector: 'node[type = "file"]',
                        style: { 'shape': 'rectangle', 'width': 'label', 'height': 'label', 'padding': '15px', 'font-size': '16px' }
                    },
                    // File Type Colors
                    { selector: 'node[ext = "py"]', style: { 'background-color': '#306998', 'border-color':'#FFD43B' } }, // Python
                    { selector: 'node[ext = "js"]', style: { 'background-color': '#f0db4f', 'border-color':'#323330' } }, // JavaScript
                    { selector: 'node[ext = "ts"]', style: { 'background-color': '#007acc', 'border-color':'#ffffff' } }, // TypeScript
                    { selector: 'node[ext = "json"]', style: { 'background-color': '#8c8c8c' } }, // JSON
                    { selector: 'node[ext = "md"]', style: { 'background-color': '#000000', 'border-color':'#ffffff' } }, // Markdown

                    {
                        selector: 'node[type = "class"]',
                        style: { 'shape': 'octagon', 'background-color': 'var(--vscode-gitDecoration-modifiedResourceForeground)', 'border-color': 'var(--vscode-charts-yellow)' }
                    },
                    {
                        selector: 'node[type = "function"]',
                        style: { 'shape': 'ellipse', 'background-color': 'var(--vscode-gitDecoration-addedResourceForeground)', 'border-color': 'var(--vscode-charts-green)' }
                    },
                    {
                        selector: 'edge',
                        style: { 'width': 1.5, 'line-color': 'var(--vscode-panel-border)', 'target-arrow-color': 'var(--vscode-panel-border)', 'target-arrow-shape': 'triangle', 'curve-style': 'bezier' }
                    },
                    {
                        selector: 'edge[label = "contains"]',
                        style: { 'line-style': 'dashed', 'line-color': 'var(--vscode-descriptionForeground)' }
                    },
                    {
                        selector: 'edge[label = "calls"]',
                        style: { 'line-color': 'var(--vscode-charts-blue)' }
                    },
                    {
                        selector: '.highlighted',
                        style: {
                            'background-color': 'var(--vscode-list-hoverBackground)', 'line-color': 'var(--vscode-focusBorder)', 'target-arrow-color': 'var(--vscode-focusBorder)',
                            'transition-property': 'background-color, line-color, target-arrow-color', 'transition-duration': '0.2s'
                        }
                    }
                ],
                layout: {
                    name: 'cose',
                    animate: 'end',
                    animationDuration: 300,
                    idealEdgeLength: 180,
                    nodeOverlap: 40,
                    fit: true,
                    padding: 30,
                    componentSpacing: 150,
                    nodeRepulsion: 800000,
                    edgeElasticity: 100,
                    gravity: 60,
                }
            });

            cy.on('tap', 'node', function(evt){
                const node = evt.target;
                vscode.postMessage({
                    command: 'openFile',
                    filePath: node.data('filePath'),
                    line: node.data('startLine')
                });
            });

            cy.on('mouseover', 'node', function(e){
                const node = e.target;
                node.addClass('highlighted');
                node.neighborhood().addClass('highlighted');
            });
            cy.on('mouseout', 'node', function(e){
                const node = e.target;
                node.removeClass('highlighted');
                node.neighborhood().removeClass('highlighted');
            });
        }

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'updateGraph') {
                if (cy) { cy.destroy(); }
                renderGraph(message.data);
            }
        });

        renderGraph(${JSON.stringify(graphData)});
    </script>
</body>
</html>`;
    }
}