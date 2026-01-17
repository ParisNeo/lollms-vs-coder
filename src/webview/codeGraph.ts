import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';
import mermaid from 'mermaid';

// Register extensions
cytoscape.use(dagre);

// Initialize Mermaid
mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    securityLevel: 'loose',
    fontFamily: 'var(--vscode-font-family)'
});

// VS Code API
declare const acquireVsCodeApi: any;
const vscode = acquireVsCodeApi();

// DOM Elements
const cyContainer = document.getElementById('cy') as HTMLDivElement;
const mermaidContainer = document.getElementById('mermaid-container') as HTMLDivElement;
const viewSelect = document.getElementById('view') as HTMLSelectElement;
const rebuildBtn = document.getElementById('rebuild') as HTMLButtonElement;
const addChatBtn = document.getElementById('add') as HTMLButtonElement;
const exportBtn = document.getElementById('export') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;
const statusLabel = document.getElementById('status') as HTMLSpanElement;
const loadingOverlay = document.getElementById('loading') as HTMLDivElement;

// State
let currentGraphData: any = null;
let currentClassDiagram: string = '';
let cyInstance: cytoscape.Core | null = null;

// Event Listeners
window.addEventListener('message', event => {
    const message = event.data;
    
    if (message.command === 'graph') {
        const { graph, state, lastError, classDiagram } = message;
        
        // Update Status UI
        if (state === 'building') {
            if (loadingOverlay) loadingOverlay.style.display = 'flex';
            if (rebuildBtn) rebuildBtn.style.display = 'none';
            if (stopBtn) stopBtn.style.display = 'inline-block';
            if (statusLabel) statusLabel.textContent = 'Building...';
        } else {
            if (loadingOverlay) loadingOverlay.style.display = 'none';
            if (rebuildBtn) rebuildBtn.style.display = 'inline-block';
            if (stopBtn) stopBtn.style.display = 'none';
            if (statusLabel) {
                statusLabel.textContent = state === 'error' ? `Error: ${lastError}` : (state === 'ready' ? 'Ready' : 'Idle');
                statusLabel.style.color = state === 'error' ? 'var(--vscode-errorForeground)' : 'inherit';
            }
        }

        // Store Data
        if (graph) currentGraphData = graph;
        if (classDiagram) currentClassDiagram = classDiagram;

        // Render if ready
        if (state === 'ready' || (graph && graph.nodes.length > 0)) {
            render();
        }
    } else if (message.command === 'triggerExport') {
        exportVisualGraph(message.format, message.view);
    }
});

if (rebuildBtn) {
    rebuildBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'rebuild' });
    });
}

if (stopBtn) {
    stopBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'stop' });
    });
}

if (addChatBtn) {
    addChatBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'addToChat', view: viewSelect.value });
    });
}

if (exportBtn) {
    exportBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'requestExport', view: viewSelect.value });
    });
}

if (viewSelect) {
    viewSelect.addEventListener('change', () => {
        render();
    });
}

// Initial Ready Signal
vscode.postMessage({ command: 'ready' });

function render() {
    const view = viewSelect.value;

    if (view === 'class_diagram') {
        renderMermaidView();
    } else {
        renderCytoscapeView(view);
    }
}

async function renderMermaidView() {
    if (cyContainer) cyContainer.style.display = 'none';
    if (mermaidContainer) {
        mermaidContainer.style.display = 'block';
        mermaidContainer.innerHTML = `<pre class="mermaid">${currentClassDiagram}</pre>`;
        try {
            await mermaid.run();
        } catch (e) {
            console.error("Mermaid render error", e);
            mermaidContainer.innerHTML += `<div style="color:red; padding:10px;">Error rendering diagram. Code structure might be too complex.</div>`;
        }
    }
}

function renderCytoscapeView(viewType: string) {
    if (mermaidContainer) mermaidContainer.style.display = 'none';
    if (cyContainer) cyContainer.style.display = 'block';

    if (!currentGraphData) return;

    // Filter elements based on view type
    const elements: any[] = [];
    
    // Add Nodes
    currentGraphData.nodes.forEach((n: any) => {
        let cssClass = n.type;
        if (n.type === 'file') cssClass = 'node-file';
        else if (n.type === 'class') cssClass = 'node-class';
        else if (n.type === 'function') cssClass = 'node-function';

        elements.push({
            group: 'nodes',
            data: { id: n.id, label: n.label, type: n.type, filePath: n.filePath, line: n.startLine },
            classes: cssClass
        });
    });

    // Add Edges
    currentGraphData.edges.forEach((e: any) => {
        let include = false;
        if (viewType === 'call_graph') {
            if (e.label === 'calls' || e.label === 'contains') include = true;
        } else if (viewType === 'import_graph') {
            if (e.label === 'imports') include = true;
        }

        if (include) {
            elements.push({
                group: 'edges',
                data: { id: e.id, source: e.source, target: e.target, label: e.label },
                classes: e.label
            });
        }
    });

    cyInstance = cytoscape({
        container: cyContainer,
        elements: elements,
        style: getCyStyle(),
        layout: {
            name: 'dagre',
            rankDir: 'LR',
            nodeSep: 50,
            rankSep: 100,
            animate: true,
            animationDuration: 500
        } as any,
        wheelSensitivity: 0.3
    });

    // Node Interaction
    cyInstance.on('tap', 'node', function(evt) {
        const node = evt.target;
        const data = node.data();
        if (data.filePath) {
            vscode.postMessage({ 
                command: 'open', 
                file: data.filePath, 
                line: data.line || 0 
            });
        }
    });
}

function getCyStyle() {
    return [
        {
            selector: 'node',
            style: {
                'label': 'data(label)',
                'color': '#cccccc',
                'font-size': '12px',
                'text-valign': 'center',
                'text-halign': 'center',
                'background-color': '#333',
                'border-width': 1,
                'border-color': '#555',
                'width': 'label',
                'height': 'label',
                'padding': '10px',
                'shape': 'round-rectangle'
            }
        },
        {
            selector: '.node-file',
            style: {
                'background-color': '#2a2d3e',
                'border-color': '#007acc',
                'color': '#ffffff',
                'font-weight': 'bold'
            }
        },
        {
            selector: '.node-class',
            style: {
                'background-color': '#1e4e3c', // darker green
                'border-color': '#4ec9b0',
                'shape': 'cut-rectangle'
            }
        },
        {
            selector: '.node-function',
            style: {
                'background-color': '#4d3b1e', // darker yellow/orange
                'border-color': '#dcdcaa',
                'shape': 'ellipse'
            }
        },
        {
            selector: 'edge',
            style: {
                'width': 1.5,
                'line-color': '#666',
                'target-arrow-color': '#666',
                'target-arrow-shape': 'triangle',
                'curve-style': 'bezier',
                'arrow-scale': 0.8
            }
        },
        {
            selector: 'edge.contains',
            style: {
                'width': 1,
                'line-style': 'dashed',
                'line-color': '#444',
                'target-arrow-shape': 'none'
            }
        },
        {
            selector: 'edge.imports',
            style: {
                'line-color': '#569cd6',
                'target-arrow-color': '#569cd6'
            }
        }
    ];
}

async function exportVisualGraph(format: 'png' | 'svg', viewType: string) {
    if (viewType === 'class_diagram') {
        const svgElement = mermaidContainer.querySelector('svg');
        if (!svgElement) {
            vscode.postMessage({ command: 'showError', message: 'No diagram to export.' });
            return;
        }

        if (format === 'svg') {
            const svgData = getSvgData(svgElement);
            vscode.postMessage({ command: 'saveContent', name: 'class_diagram.svg', content: svgData, format: 'svg' });
        } else {
            // PNG Export for Mermaid (SVG -> Canvas -> PNG)
            const svgData = getSvgData(svgElement);
            const img = new Image();
            
            // High resolution scale
            const scale = 3;
            
            img.onload = () => {
                const canvas = document.createElement('canvas');
                // Use getBBox to ensure we capture the whole visual area, or clientWidth/Height
                // Mermaid SVGs often set width/height to 100% or maxWidth, so we rely on viewBox or bounding client rect
                const rect = svgElement.getBoundingClientRect();
                const width = rect.width;
                const height = rect.height;

                canvas.width = width * scale;
                canvas.height = height * scale;
                
                const ctx = canvas.getContext('2d');
                if (ctx) {
                    // Fill background (transparent by default, let's make it dark theme bg or white? 
                    // Usually PNGs for diagrams are better with transparent or matching bg. 
                    // Let's use the editor background color for consistency)
                    ctx.fillStyle = '#1e1e1e'; // Default dark theme bg
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    
                    ctx.scale(scale, scale);
                    ctx.drawImage(img, 0, 0);
                    
                    const pngData = canvas.toDataURL('image/png');
                    vscode.postMessage({ command: 'saveContent', name: 'class_diagram.png', content: pngData, format: 'png' });
                }
            };
            
            // Handle loading SVG data into image
            img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
        }
    } else {
        // Cytoscape Export
        if (!cyInstance) return;

        if (format === 'svg') {
            const svgContent = cyInstance.svg({ scale: 1, full: true });
            vscode.postMessage({ command: 'saveContent', name: `${viewType}.svg`, content: svgContent, format: 'svg' });
        } else {
            const pngContent = cyInstance.png({ scale: 3, full: true, output: 'base64uri' });
            vscode.postMessage({ command: 'saveContent', name: `${viewType}.png`, content: pngContent, format: 'png' });
        }
    }
}

function getSvgData(svg: SVGSVGElement): string {
    const serializer = new XMLSerializer();
    let source = serializer.serializeToString(svg);
    // Add namespaces if missing
    if(!source.match(/^<svg[^>]+xmlns="http\:\/\/www\.w3\.org\/2000\/svg"/)){
        source = source.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    if(!source.match(/^<svg[^>]+xmlns:xlink/)){
        source = source.replace(/^<svg/, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
    }
    return '<?xml version="1.0" standalone="no"?>\r\n' + source;
}
