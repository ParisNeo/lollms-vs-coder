import * as vscode from 'vscode';
import { WorkflowEngine } from '../workflow/engine';
import { LollmsAPI } from '../lollmsAPI';

import { WorkflowManager } from '../workflow/workflowManager';

export class WorkflowStudioPanel {
    public static currentPanel: WorkflowStudioPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _engine: WorkflowEngine;
    private _workflowManager: WorkflowManager;

    public static createOrShow(extensionUri: vscode.Uri, lollms: LollmsAPI, workflowManager: WorkflowManager) {
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
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'media'),
                    vscode.Uri.joinPath(extensionUri, 'out')
                ],
                retainContextWhenHidden: true
            }
        );

        WorkflowStudioPanel.currentPanel = new WorkflowStudioPanel(panel, extensionUri, lollms, workflowManager);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, lollms: LollmsAPI, workflowManager: WorkflowManager) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._workflowManager = workflowManager;
        this._engine = new WorkflowEngine(lollms);

        this._panel.webview.html = this._getHtmlForWebview();
        this._panel.onDidDispose(() => this.dispose(), null, []);
        
        this._panel.webview.onDidReceiveMessage(async message => {
            switch (message.command) {
                case 'runWorkflow':
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders) {
                        // Reset all nodes to idle in webview before start
                        message.workflow.nodes.forEach((n: any) => {
                            this._panel.webview.postMessage({ command: 'updateNodeStatus', nodeId: n.id, status: 'idle' });
                        });

                        await this._engine.executeWorkflow(
                            message.workflow, 
                            workspaceFolders[0].uri.fsPath, 
                            (msg) => {
                                this._panel.webview.postMessage({ command: 'log', message: msg });
                            },
                            (nodeId, status) => {
                                this._panel.webview.postMessage({ command: 'updateNodeStatus', nodeId, status });
                            }
                        );
                    } else {
                        vscode.window.showErrorMessage("No workspace open.");
                    }
                    break;
                case 'saveWorkflow':
                    const mgr = (this as any)._workflowManager || services.workflowManager;
                    if (message.workflow) {
                        await mgr.saveWorkflow(message.workflow);
                        vscode.window.showInformationMessage(`Workflow "${message.workflow.name}" saved to your local library.`);
                    }
                    break;
            }
        });
    }

    public dispose() {
        WorkflowStudioPanel.currentPanel = undefined;
        this._panel.dispose();
    }

    private _getHtmlForWebview(): string {
        const codiconUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'));

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Lollms Flow Studio</title>
    <link href="${codiconUri}" rel="stylesheet" />
    <style>
        body { margin: 0; display: flex; flex-direction: column; height: 100vh; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); overflow: hidden; }
        .toolbar { padding: 10px 15px; background: var(--vscode-sideBarSectionHeader-background); border-bottom: 1px solid var(--vscode-widget-border); display: flex; gap: 10px; align-items: center; }
        .studio-container { display: flex; flex: 1; overflow: hidden; position: relative; }

        /* SIDEBAR PALETTE */
        .palette { width: 220px; background: var(--vscode-sideBar-background); border-right: 1px solid var(--vscode-widget-border); padding: 15px; box-sizing: border-box; display: flex; flex-direction: column; gap: 10px; }
        .palette h3 { margin: 0 0 5px 0; font-size: 11px; text-transform: uppercase; opacity: 0.6; }
        .block-template { padding: 8px 12px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 6px; cursor: grab; font-size: 12px; display: flex; align-items: center; gap: 8px; user-select: none; }
        .block-template:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }

        /* CANVAS AREA */
        .canvas-area { flex: 1; position: relative; overflow: hidden; outline: none; }
        #workflow-svg { width: 100%; height: 100%; display: block; background-size: 20px 20px; background-image: radial-gradient(circle, var(--vscode-widget-border) 1px, transparent 1px); }

        /* PROPERTY PANEL / DRAWER */
        .property-drawer { width: 320px; background: var(--vscode-sideBar-background); border-left: 1px solid var(--vscode-widget-border); padding: 20px; box-sizing: border-box; display: none; flex-direction: column; gap: 15px; overflow-y: auto; z-index: 100; box-shadow: -4px 0 15px rgba(0,0,0,0.2); }
        .property-drawer.visible { display: flex; }
        .drawer-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 8px; }
        .drawer-title { font-weight: bold; font-size: 13px; }

        /* FORMS */
        .form-group { display: flex; flex-direction: column; gap: 4px; }
        .form-group label { font-size: 9px; font-weight: bold; text-transform: uppercase; opacity: 0.7; }
        input, textarea, select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 6px 10px; border-radius: 4px; font-family: inherit; font-size: 12px; }
        input:focus, textarea:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); border-color: transparent; }
        textarea { resize: vertical; min-height: 80px; }

        /* BUTTONS */
        button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: bold; display: flex; align-items: center; gap: 6px; }
        button:hover { filter: brightness(1.1); }
        button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }

        /* CONSOLE OUTPUT */
        .console-panel { height: 120px; background: #000; border-top: 2px solid var(--vscode-widget-border); padding: 10px; font-family: monospace; font-size: 11px; color: #0f0; overflow-y: auto; box-sizing: border-box; }

        /* SVG ELEMENTS */
        .svg-node { cursor: pointer; }
        .svg-node rect { fill: var(--vscode-editorWidget-background); stroke: var(--vscode-widget-border); stroke-width: 1.5px; rx: 6px; }
        .svg-node:hover rect { stroke: var(--vscode-focusBorder); }
        .svg-node.selected rect { stroke: var(--vscode-focusBorder); stroke-width: 2.5px; }

        .svg-node.running rect { stroke: var(--vscode-charts-orange); stroke-width: 2.5px; }
        .svg-node.completed rect { stroke: var(--vscode-charts-green); stroke-width: 2.5px; }
        .svg-node.error rect { stroke: var(--vscode-charts-red); stroke-width: 2.5px; }

        .svg-node text { fill: var(--vscode-foreground); font-size: 11px; pointer-events: none; user-select: none; }
        .svg-node .node-type-label { font-size: 9px; opacity: 0.6; fill: var(--vscode-descriptionForeground); }

        .port { fill: var(--vscode-widget-border); stroke: var(--vscode-editor-background); stroke-width: 1.5px; cursor: crosshair; }
        .port:hover { fill: var(--vscode-focusBorder); }

        .svg-edge { fill: none; stroke: var(--vscode-widget-border); stroke-width: 2px; }
        .svg-edge.active { stroke: var(--vscode-focusBorder); }
    </style>
</head>
<body>
    <div class="toolbar">
        <button id="runBtn" class="apply-btn"><i class="codicon codicon-play"></i> Run Protocol</button>
        <button id="saveBtn"><i class="codicon codicon-save"></i> Save Workflow</button>
        <div style="flex:1"></div>
        <div style="font-size:11px; opacity:0.8; font-weight:bold;">
            <i class="codicon codicon-layout-sidebar-right"></i> Double-click node to configure
        </div>
    </div>

    <div class="studio-container">
        <!-- SIDEBAR PALETTE -->
        <div class="palette">
            <h3>Flow Nodes</h3>
            <div class="block-template" draggable="true" data-type="agent"><i class="codicon codicon-robot"></i> Specialist Agent</div>
            <div class="block-template" draggable="true" data-type="tool"><i class="codicon codicon-wrench"></i> Execution Tool</div>
            <div class="block-template" draggable="true" data-type="condition"><i class="codicon codicon-git-compare"></i> Logic Gate</div>
            <div class="block-template" draggable="true" data-type="loop"><i class="codicon codicon-sync"></i> Iterative Loop</div>
        </div>

        <!-- CANVAS -->
        <div class="canvas-area" id="canvas-container">
            <svg id="workflow-svg">
                <!-- Edges & Nodes generated dynamically -->
                <g id="edges-group"></g>
                <g id="nodes-group"></g>
                <line id="temp-edge" x1="0" y1="0" x2="0" y2="0" style="display:none; stroke: var(--vscode-focusBorder); stroke-width:2px; stroke-dasharray: 4;" />
            </svg>
        </div>

        <!-- PROPERTY DRAWER -->
        <div class="property-drawer" id="property-drawer">
            <div class="drawer-header">
                <span class="drawer-title" id="drawer-node-id">Configure Node</span>
                <span style="font-size:20px; cursor:pointer;" onclick="closeDrawer()">&times;</span>
            </div>

            <div class="form-group">
                <label>Display Name</label>
                <input type="text" id="prop-label">
            </div>

            <!-- Agent specific fields -->
            <div class="form-group node-specific-field" id="field-agent" style="display:none;">
                <label>Specialist Persona (Instructions)</label>
                <textarea id="prop-persona" placeholder="e.g. You are an expert python debugger..."></textarea>
                <label>Assigned Model</label>
                <input type="text" id="prop-model" placeholder="Default model">
            </div>

            <!-- Tool specific fields -->
            <div class="form-group node-specific-field" id="field-tool" style="display:none;">
                <label>Target Tool Name</label>
                <input type="text" id="prop-tool-name" placeholder="e.g. edit_code">
                <label>Default Parameters (JSON)</label>
                <textarea id="prop-tool-params" placeholder="{}"></textarea>
            </div>

            <!-- Condition specific fields -->
            <div class="form-group node-specific-field" id="field-condition" style="display:none;">
                <label>Decision Criteria (NL Statement)</label>
                <textarea id="prop-criteria" placeholder="e.g. Output contains errors"></textarea>
            </div>

            <div style="display:flex; gap:10px; margin-top:20px; border-top:1px solid var(--vscode-widget-border); padding-top:15px;">
                <button class="secondary danger" id="delete-node-btn" style="flex:1; justify-content:center;"><i class="codicon codicon-trash"></i> Delete Node</button>
                <button id="save-node-props-btn" style="flex:1; justify-content:center;"><i class="codicon codicon-check"></i> Apply</button>
            </div>
        </div>
    </div>

    <!-- CONSOLE LOG -->
    <div class="console-panel" id="console">
        <div style="opacity:0.6; border-bottom:1px solid #222; margin-bottom:5px; padding-bottom:2px; font-weight:bold;">
            <i class="codicon codicon-terminal"></i> AUTOMATION ENGINE OUTPUT
        </div>
        <div id="console-logs"></div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        // --- FLOW DATA STATE ---
        let workflow = {
            id: "custom-flow-" + Date.now(),
            name: "Sovereign Workflow",
            nodes: [],
            edges: []
        };

        let selectedNodeId = null;
        let draggingNodeId = null;
        let dragOffset = { x: 0, y: 0 };

        // Edge creation state
        let activePortSource = null; // { nodeId, portType }

        const svg = document.getElementById('workflow-svg');
        const nodesGroup = document.getElementById('nodes-group');
        const edgesGroup = document.getElementById('edges-group');
        const tempEdge = document.getElementById('temp-edge');

        // --- PALETTE DRAG & DROP ---
        document.querySelectorAll('.block-template').forEach(block => {
            block.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', block.dataset.type);
            });
        });

        const canvasContainer = document.getElementById('canvas-container');
        canvasContainer.addEventListener('dragover', (e) => {
            e.preventDefault();
        });

        canvasContainer.addEventListener('drop', (e) => {
            e.preventDefault();
            const type = e.dataTransfer.getData('text/plain');
            const rect = svg.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            addNode(type, x, y);
        });

        function addNode(type, x, y) {
            const id = 'node_' + Date.now() + Math.random().toString(36).substring(2, 5);
            const newNode = {
                id,
                type,
                position: { x, y },
                data: {
                    label: type.charAt(0).toUpperCase() + type.slice(1) + " Node",
                },
                status: 'idle'
            };
            workflow.nodes.push(newNode);
            render();
        }

        // --- GRAPH RENDER ENGINE (PURE SVG) ---
        function render() {
            nodesGroup.innerHTML = '';
            edgesGroup.innerHTML = '';

            // 1. Render Edges
            workflow.edges.forEach(edge => {
                const srcNode = workflow.nodes.find(n => n.id === edge.source);
                const trgNode = workflow.nodes.find(n => n.id === edge.target);
                if (srcNode && trgNode) {
                    const line = document.createElementNS(svgNamespace, 'line');
                    const startX = srcNode.position.x + 180;
                    const startY = srcNode.position.y + 25;
                    const endX = trgNode.position.x;
                    const endY = trgNode.y + 25;

                    line.setAttribute('x1', startX.toString());
                    line.setAttribute('y1', startY.toString());
                    line.setAttribute('x2', endNodeX(trgNode).toString());
                    line.setAttribute('y2', endNodeY(trgNode).toString());
                    line.setAttribute('stroke', '#888');
                    line.setAttribute('stroke-width', '2');
                    line.setAttribute('marker-end', 'url(#arrow)');
                    hunkGroup.appendChild(line);
                }
            });

            // 2. Render Nodes
            workflow.nodes.forEach(node => {
                const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                g.setAttribute('transform', \`translate(\${node.position.x}, \${node.position.y})\`);
                g.setAttribute('class', \`node-group \${node.id === selectedNodeId ? 'selected' : ''}\`);

                const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                rect.setAttribute('width', '180');
                rect.setAttribute('height', '50');
                rect.setAttribute('rx', '6');
                rect.setAttribute('fill', 'var(--vscode-editorWidget-background)');
                rect.setAttribute('stroke', 'var(--vscode-widget-border)');
                rect.setAttribute('stroke-width', '1.5');

                if (node.status === 'running') {
                    rect.setAttribute('stroke', 'var(--vscode-charts-orange)');
                    rect.setAttribute('stroke-width', '2.5');
                } else if (node.status === 'completed') {
                    rect.setAttribute('stroke', 'var(--vscode-charts-green)');
                    rect.setAttribute('stroke-width', '2.5');
                } else if (node.status === 'error') {
                    rect.setAttribute('stroke', 'var(--vscode-charts-red)');
                    rect.setAttribute('stroke-width', '2.5');
                }

                const textLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                textLabel.setAttribute('x', '15');
                textLabel.setAttribute('y', '25');
                textLabel.setAttribute('fill', 'var(--vscode-foreground)');
                textLabel.setAttribute('font-size', '11');
                textLabel.setAttribute('font-weight', 'bold');
                textLabel.textContent = node.data.label;

                const textType = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                textType.setAttribute('x', '15');
                textType.setAttribute('y', '38');
                textType.setAttribute('fill', 'var(--vscode-descriptionForeground)');
                textType.setAttribute('font-size', '9');
                textType.textContent = node.type.toUpperCase();

                // Ports
                const inputPort = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                inputPort.setAttribute('cx', '0');
                inputPort.setAttribute('cy', '25');
                inputPort.setAttribute('r', '5');
                inputPort.setAttribute('class', 'port');
                inputPort.setAttribute('data-node-id', node.id);
                inputPort.setAttribute('data-port-type', 'input');

                const outputPort = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                outputPort.setAttribute('cx', '180');
                outputPort.setAttribute('cy', '25');
                outputPort.setAttribute('r', '5');
                outputPort.setAttribute('class', 'port');
                outputPort.setAttribute('data-node-id', node.id);
                outputPort.setAttribute('data-port-type', 'output');

                g.append(rect, textLabel, textType, inputPort, outputPort);
                nodesGroup.appendChild(g);

                // --- INTERACTIVE EVENT ATTACHMENTS ---
                rect.addEventListener('mousedown', (e) => {
                    if (e.button === 0) {
                        selectedNodeId = node.id;
                        draggingNodeId = node.id;
                        const rectBounds = svg.getBoundingClientRect();
                        dragOffset.x = e.clientX - rectBounds.left - node.position.x;
                        dragOffset.y = e.clientY - rectBounds.top - node.position.y;

                        document.querySelectorAll('.node-group').forEach(el => el.classList.remove('selected'));
                        g.classList.add('selected');
                        e.stopPropagation();
                    }
                });

                rect.addEventListener('dblclick', (e) => {
                    e.stopPropagation();
                    openDrawer(node);
                });

                // Port connection start
                outputPort.addEventListener('mousedown', (e) => {
                    e.stopPropagation();
                    activePortSource = { nodeId: node.id, portType: 'output' };
                    const startX = node.position.x + 180;
                    const startY = node.position.y + 25;
                    tempEdge.setAttribute('x1', startX.toString());
                    tempEdge.setAttribute('y1', startY.toString());
                    tempEdge.setAttribute('x2', startX.toString());
                    tempEdge.setAttribute('y2', startY.toString());
                    tempEdge.style.display = 'block';
                });

                inputPort.addEventListener('mouseup', (e) => {
                    e.stopPropagation();
                    if (activePortSource && activePortSource.portType === 'output' && activePortSource.nodeId !== node.id) {
                        // Create edge
                        const edgeId = \`edge_\${Date.now()}\`;
                        workflow.edges.push({
                            id: edgeId,
                            source: activePortSource.nodeId,
                            sourceHandle: 'output',
                            target: node.id,
                            targetHandle: 'input'
                        });
                        activePortSource = null;
                        tempEdge.style.display = 'none';
                        render();
                    }
                });
            });

            // Re-render explicit edges
            renderEdges();
        }

        function endNodeX(node) { return node.position.x; }
        function endNodeY(node) { return node.position.y + 25; }

        function renderEdges() {
            edgesGroup.innerHTML = '';
            workflow.edges.forEach(edge => {
                const src = workflow.nodes.find(n => n.id === edge.source);
                const trg = workflow.nodes.find(n => n.id === edge.target);
                if (src && trg) {
                    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    const startX = src.position.x + 180;
                    const startY = src.position.y + 25;
                    const endX = trg.position.x;
                    const endY = trg.position.y + 25;

                    // Curved cubic bezier paths for a premium aesthetic
                    const controlX1 = startX + 50;
                    const controlY1 = startY;
                    const controlX2 = endX - 50;
                    const controlY2 = endY;

                    path.setAttribute('d', \`M \${startX} \${startY} C \${controlX1} \${controlY1}, \${controlX2} \${controlY2}, \${endX} \${endY}\`);
                    path.setAttribute('class', 'svg-edge');
                    edgesGroup.appendChild(path);
                }
            });
        }

        // Global Mouse Events for drag-resize
        window.addEventListener('mousemove', (e) => {
            const rect = svg.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            if (draggingNodeId) {
                const node = workflow.nodes.find(n => n.id === draggingNodeId);
                if (node) {
                    node.position.x = x - dragOffset.x;
                    node.position.y = y - dragOffset.y;
                    render();
                }
            }

            if (activePortSource) {
                tempEdge.setAttribute('x2', x.toString());
                tempEdge.setAttribute('y2', y.toString());
            }
        });

        window.addEventListener('mouseup', () => {
            draggingNodeId = null;
            if (activePortSource) {
                activePortSource = null;
                tempEdge.style.display = 'none';
            }
        });

        // --- PROPERTY DRAWER ---
        const drawer = document.getElementById('property-drawer');

        function openDrawer(node) {
            selectedNodeId = node.id;
            document.getElementById('drawer-node-id').textContent = \`Configure: \${node.data.label}\`;
            document.getElementById('prop-label').value = node.data.label;

            // Hide all specific forms
            document.querySelectorAll('.node-specific-field').forEach(el => el.style.display = 'none');

            // Reveal and prefill corresponding section
            if (node.type === 'agent') {
                document.getElementById('field-agent').style.display = 'flex';
                document.getElementById('prop-persona').value = node.data.persona || '';
                document.getElementById('prop-model').value = node.data.model || '';
            } else if (node.type === 'tool') {
                document.getElementById('field-tool').style.display = 'flex';
                document.getElementById('prop-tool-name').value = node.data.toolName || '';
                document.getElementById('prop-tool-params').value = JSON.stringify(node.data.params || {}, null, 2);
            } else if (node.type === 'condition') {
                document.getElementById('field-condition').style.display = 'flex';
                document.getElementById('prop-criteria').value = node.data.criteria || '';
            }

            drawer.classList.add('visible');
        }

        function closeDrawer() {
            drawer.classList.remove('visible');
        }

        document.getElementById('save-node-props-btn').onclick = () => {
            const node = workflow.nodes.find(n => n.id === selectedNodeId);
            if (node) {
                node.data.label = document.getElementById('prop-label').value;

                if (node.type === 'agent') {
                    node.data.persona = document.getElementById('prop-persona').value;
                    node.data.model = document.getElementById('prop-model').value;
                } else if (node.type === 'tool') {
                    node.data.toolName = document.getElementById('prop-tool-name').value;
                    try {
                        node.data.params = JSON.parse(document.getElementById('prop-tool-params').value || '{}');
                    } catch {
                        vscode.postMessage({ command: 'showError', message: 'Invalid JSON parameters.' });
                        return;
                    }
                } else if (node.type === 'condition') {
                    node.data.criteria = document.getElementById('prop-criteria').value;
                }
                closeDrawer();
                render();
            }
        };

        document.getElementById('delete-node-btn').onclick = () => {
            workflow.nodes = workflow.nodes.filter(n => n.id !== selectedNodeId);
            workflow.edges = workflow.edges.filter(e => e.source !== selectedNodeId && e.target !== selectedNodeId);
            closeDrawer();
            render();
        };

        // --- BUTTONS ---
        document.getElementById('saveBtn').onclick = () => {
            vscode.postMessage({ command: 'saveWorkflow', workflow });
            vscode.postMessage({ command: 'showWarning', message: 'Workflow schema saved to your local library.' });
        };

        document.getElementById('runBtn').onclick = () => {
            log('Initializing workflow pipeline execution...');
            vscode.postMessage({ command: 'runWorkflow', workflow });
        };

        // --- CONSOLE LOGGER ---
        const consoleLogs = document.getElementById('console-logs');
        function log(msg) {
            const row = document.createElement('div');
            row.textContent = \`> \${msg}\`;
            consoleLogs.appendChild(row);
            consoleLogs.scrollTop = consoleLogs.scrollHeight;
        }

        // --- EVENT HANDLERS ---
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'log') {
                log(message.message);
            } else if (message.command === 'updateNodeStatus') {
                const node = workflow.nodes.find(n => n.id === message.nodeId);
                if (node) {
                    node.status = message.status;
                    render();
                }
            } else if (message.command === 'loadWorkflow') {
                if (message.workflow) {
                    workflow = message.workflow;
                    log(\`Loaded workflow: "\${workflow.name}"\`);
                    render();
                }
            }
        });

        // Add dummy start node on initialization
        addNode('agent', 100, 150);
        addNode('tool', 400, 150);
    </script>
</body>
</html>`;
    }
}
