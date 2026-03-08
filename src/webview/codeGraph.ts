import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';
import coseBilkent from 'cytoscape-cose-bilkent';
import mermaid from 'mermaid';

// Register extensions
cytoscape.use(dagre);
cytoscape.use(coseBilkent);

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
let currentFunctionSignatures: string = '';
let cyInstance: cytoscape.Core | null = null;

// Event Listeners
window.addEventListener('message', event => {
    const message = event.data;
    
    if (message.command === 'graph') {
        const { graph, state, lastError, classDiagram, functionSignatures } = message;
        
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
        if (functionSignatures) currentFunctionSignatures = functionSignatures;

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

    // Reset containers to ensure clean render
    if (cyContainer) cyContainer.style.display = 'none';
    if (mermaidContainer) {
        mermaidContainer.style.display = 'none';
        mermaidContainer.innerHTML = '';
        mermaidContainer.style.transform = '';
        mermaidContainer.style.cursor = 'default';
    }

    if (view === 'class_diagram' || view === 'function_signatures') {
        renderMermaidView(view);
    } else {
        renderCytoscapeView(view);
    }
}

/**
 * Cleans up Mermaid code to prevent rendering errors.
 * Ensures node labels are properly quoted and special characters are handled.
 */
function preprocessMermaid(code: string): string {
    if (code.includes('classDiagram')) {
        return code; // Do NOT run the node bracket replacement on class diagrams!
    }
    return code.split('\n').map(line => {
        const trimmed = line.trim();
        // Skip header definitions and keywords
        if (trimmed.match(/^(subgraph|end|class|state|note|participant|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|gitGraph|flowchart|graph|class)/i)) {
            return line;
        }
        // Identify node definitions like ID[Label] and wrap label in quotes
        return line.replace(/([a-zA-Z0-9_-]+)\s*([\[\(\{]{1,2})\s*([^"'\n\r\t]+?)\s*([\]\)\}]{1,2})/g, (match, id, open, label, close) => {
            const safeLabel = label.replace(/"/g, "'");
            return `${id}${open}"${safeLabel.trim()}"${close}`;
        });
    }).join('\n');
}

async function renderMermaidView(view: string) {
    if (cyContainer) cyContainer.style.display = 'none';
    if (mermaidContainer) {
        mermaidContainer.style.display = 'block';
        
        const rawDiagram = view === 'class_diagram' ? currentClassDiagram : currentFunctionSignatures;
        const sanitizedDiagram = preprocessMermaid(rawDiagram);
        const id = `mermaid-render-${Date.now()}`;
        
        mermaidContainer.innerHTML = `<div id="${id}" class="mermaid">${sanitizedDiagram}</div>`;
        
        try {
            await mermaid.run({
                nodes: [document.getElementById(id)]
            });
            
            // Enable Pan/Zoom AND Auto-Fit
            const handlers = enablePanZoom(mermaidContainer);
            
            // Allow DOM and SVG geometry to fully stabilize
            setTimeout(() => {
                handlers.fitToScreen();
            }, 500);

        } catch (e: any) {
            console.error("📊 Mermaid Syntax Error:", e);
            
            console.group("❌ Faulty Mermaid Source");
            console.log(sanitizedDiagram);
            console.groupEnd();

            mermaidContainer.innerHTML = `
                <div style="color:var(--vscode-errorForeground); padding:20px; background:var(--vscode-inputValidation-errorBackground); border:1px solid var(--vscode-errorForeground); border-radius:4px;">
                    <div style="font-weight:bold; margin-bottom:8px;"><span class="codicon codicon-error"></span> Mermaid Render Failed</div>
                    <div style="font-family:monospace; font-size:11px; white-space:pre-wrap;">${e.message || e}</div>
                    <div style="margin-top:10px; font-size:10px; opacity:0.8;">The error and source have been logged to the Developer Tools console (Help > Toggle Developer Tools).</div>
                </div>
            `;
        }
    }
}

function enablePanZoom(container: HTMLElement) {
    let zoomScale = 1;
    let panX = 0;
    let panY = 0;
    let isDragging = false;
    let startX = 0;
    let startY = 0;

    const innerDiv = container.querySelector('.mermaid') as HTMLElement;
    
    // Return empty handlers if init fails
    if (!innerDiv) return { fitToScreen: () => {} };

    container.style.overflow = 'hidden';
    container.style.cursor = 'grab';
    container.style.position = 'relative';

    innerDiv.style.transformOrigin = '0 0';
    innerDiv.style.transition = 'transform 0.05s ease-out';
    innerDiv.style.width = 'fit-content'; 
    innerDiv.style.minWidth = '100px'; 
    innerDiv.style.minHeight = '100px';

    const updateTransform = () => {
        innerDiv.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomScale})`;
    };

    // Logic to auto-fit the content to the screen
    const fitToScreen = () => {
        const svg = innerDiv.querySelector('svg') as SVGSVGElement;
        if (!svg) return;
        
        svg.removeAttribute('width');
        svg.removeAttribute('height');
        svg.style.width = '';
        svg.style.height = '';
        svg.style.maxWidth = 'none';

        const containerRect = container.getBoundingClientRect();
        const bbox = svg.getBBox();
        
        if (bbox.width <= 0 || bbox.height <= 0) return;

        const padding = 20;
        const scaleX = (containerRect.width - padding) / bbox.width;
        const scaleY = (containerRect.height - padding) / bbox.height;
        
        // Fit content but don't blow up tiny diagrams beyond 1.0
        // Use 0.95 to ensure a small visible border
        zoomScale = Math.min(scaleX, scaleY, 1.0) * 0.95;
        
        // Centering calculation using the Bounding Box offset
        panX = (containerRect.width / 2) - (zoomScale * (bbox.x + bbox.width / 2));
        panY = (containerRect.height / 2) - (zoomScale * (bbox.y + bbox.height / 2));
        
        updateTransform();
    };

    container.onwheel = (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        zoomScale = Math.min(Math.max(0.05, zoomScale * delta), 10); 
        updateTransform();
    };

    container.onmousedown = (e) => {
        isDragging = true;
        startX = e.clientX - panX;
        startY = e.clientY - panY;
        container.style.cursor = 'grabbing';
        innerDiv.style.transition = 'none'; 
    };

    window.onmousemove = (e) => {
        if (!isDragging) return;
        e.preventDefault();
        panX = e.clientX - startX;
        panY = e.clientY - startY;
        updateTransform();
    };

    window.onmouseup = () => {
        if(isDragging) {
            isDragging = false;
            container.style.cursor = 'grab';
            innerDiv.style.transition = 'transform 0.1s ease-out';
        }
    };

    return { fitToScreen };
}

function renderCytoscapeView(viewType: string) {
    if (mermaidContainer) mermaidContainer.style.display = 'none';
    if (cyContainer) cyContainer.style.display = 'block';

    if (!currentGraphData) return;

    const elements: any[] = [];
    const parentMap = new Map<string, string>();

    // 1. Identify containment for Compound Nodes
    currentGraphData.edges.forEach((e: any) => {
        if (e.label === 'contains') {
            parentMap.set(e.target, e.source);
        }
    });
    
    // 2. Add Nodes with nesting
    currentGraphData.nodes.forEach((n: any) => {
        let cssClass = n.type;
        if (n.type === 'file') cssClass = 'node-file';
        else if (n.type === 'class') cssClass = 'node-class';
        else if (n.type === 'function') cssClass = 'node-function';
        else if (n.type === 'library') cssClass = 'node-library';

        elements.push({
            group: 'nodes',
            data: { 
                id: n.id, 
                label: n.label, 
                type: n.type, 
                filePath: n.filePath, 
                line: n.startLine,
                parent: parentMap.get(n.id) // This triggers the "box-inside-box" rendering
            },
            classes: cssClass
        });
    });

    // 3. Add Interaction Edges (filtering out "contains" since it's now a nesting relation)
    currentGraphData.edges.forEach((e: any) => {
        let include = false;
        if (viewType === 'call_graph' && e.label === 'calls') include = true;
        if (viewType === 'import_graph' && e.label === 'imports') include = true;

        if (include) {
            elements.push({
                group: 'edges',
                data: { id: e.id, source: e.source, target: e.target, label: e.label },
                classes: e.label
            });
        }
    });

    // Use 'cose' (physics) for everything to avoid flat, overlapping graphs
    // FCose would be better but requires an extension; cose is built-in.
    
    cyInstance = cytoscape({
        container: cyContainer,
        elements: elements,
        style: getCyStyle(),
        layout: {
            name: 'cose-bilkent',
            // CoSE-Bilkent options for better compound layout
            quality: 'proof',
            nodeDimensionsIncludeLabels: true,
            randomize: false,        // Keep deterministic
            fit: true,
            padding: 30,
            
            // "Pack elements of same file together"
            // Tiling puts disconnected nodes in a grid, keeping them tidy
            tilingPaddingVertical: 20,
            tilingPaddingHorizontal: 20,
            
            // "Unpack files to avoid intersections"
            nodeRepulsion: 8500,     // Repulsion between nodes
            idealEdgeLength: 120,    // Longer edges between files
            edgeElasticity: 0.45,
            nestingFactor: 0.1,      // Tighter nesting for children inside parents
            gravity: 0.25,           // Weak gravity to allow spreading
            numIter: 2500,           // More iterations for a cleaner result
            tile: true,              // Enable tiling for disconnected components
            animate: false
        } as any,
        minZoom: 0.05,
        maxZoom: 4.0,
        wheelSensitivity: 0.2
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
                'color': '#ffffff',
                'font-size': '10px',
                'text-valign': 'bottom',
                'text-halign': 'center',
                'text-margin-y': '4px',
                'background-color': '#3c3c3c',
                'border-width': 2,
                'border-color': '#555',
                'width': '15px',
                'height': '15px',
                'shape': 'ellipse',
                'overlay-opacity': 0,
                'transition-property': 'background-color, line-color, target-arrow-color',
                'transition-duration': '0.2s'
            }
        },
        {
            selector: ':parent', 
            style: {
                'text-valign': 'top',
                'text-halign': 'center',
                'background-color': '#ffffff',
                'background-opacity': 0.03,
                'border-color': '#ffffff',
                'border-opacity': 0.1,
                'border-width': 1,
                'border-style': 'dashed',
                'padding': '5px'  // Reduced padding significantly for tighter boxes
            }
        },
        {
            selector: '.node-class',
            style: {
                'background-color': '#1e4e3c',
                'border-color': '#4ec9b0',
                'shape': 'cut-rectangle'
            }
        },
        {
            selector: '.node-function',
            style: {
                'background-color': '#4d3b1e',
                'border-color': '#dcdcaa',
                'shape': 'ellipse'
            }
        },
        {
            selector: '.node-library',
            style: {
                'background-color': '#6e3e1e',
                'border-color': '#f96',
                'shape': 'hexagon',
                'color': '#ffffff'
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
