import cytoscape from 'cytoscape';
import mermaid from 'mermaid';
// @ts-ignore
import dagre from 'cytoscape-dagre';
// @ts-ignore
import coseBilkent from 'cytoscape-cose-bilkent';

// Register extensions
cytoscape.use(dagre);
cytoscape.use(coseBilkent);

// Initialize Mermaid
mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    securityLevel: 'loose'
});

// Define global VSCode API
declare const acquireVsCodeApi: any;
const vscode = acquireVsCodeApi();

// Define global interaction function for Mermaid clicks
(window as any).onMermaidClick = (nodeId: string) => {
    const node = graphData.nodes.find(n => n.id === nodeId);
    if (node && node.filePath) {
        vscode.postMessage({ 
            command: 'open', 
            file: node.filePath, 
            line: node.startLine || 0 
        });
    }
};

let cy: cytoscape.Core | undefined;
let graphData: { nodes: any[], edges: any[] } = { nodes: [], edges: [] };

const statusEl = document.getElementById('status');
const loadingEl = document.getElementById('loading');
const viewSelect = document.getElementById('view') as HTMLSelectElement;
const cyContainer = document.getElementById('cy');
const mermaidContainer = document.getElementById('mermaid-container');

// Zoom/Pan State for Mermaid
let zoomScale = 1;
let panX = 0;
let panY = 0;
let isDragging = false;
let startX = 0;
let startY = 0;

// Event Listeners
const rebuildBtn = document.getElementById('rebuild');
if (rebuildBtn) {
    rebuildBtn.onclick = () => {
        vscode.postMessage({ command: 'rebuild' });
        if (statusEl) statusEl.textContent = 'Requesting rebuild...';
        if (loadingEl) loadingEl.style.display = 'flex';
    };
}

const addBtn = document.getElementById('add');
if (addBtn) {
    addBtn.onclick = () => {
        vscode.postMessage({ command: 'addToChat', view: viewSelect.value });
    };
}

if (viewSelect) {
    viewSelect.onchange = () => render();
}

// Setup Mermaid Interactions
if (mermaidContainer) {
    mermaidContainer.addEventListener('wheel', (e) => {
        if (!mermaidContainer.querySelector('svg')) return;
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        zoomScale *= delta;
        updateMermaidTransform();
    });

    mermaidContainer.addEventListener('mousedown', (e) => {
        isDragging = true;
        startX = e.clientX - panX;
        startY = e.clientY - panY;
        mermaidContainer.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
        if (isDragging) {
            e.preventDefault();
            panX = e.clientX - startX;
            panY = e.clientY - startY;
            updateMermaidTransform();
        }
    });

    window.addEventListener('mouseup', () => {
        isDragging = false;
        mermaidContainer!.style.cursor = 'grab';
    });
}

function updateMermaidTransform() {
    const svg = mermaidContainer?.querySelector('svg') as HTMLElement;
    if (svg) {
        svg.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomScale})`;
        svg.style.transformOrigin = '0 0';
        svg.style.transition = isDragging ? 'none' : 'transform 0.1s ease-out';
    }
}

// Layout Configuration
function getLayout(view: string): cytoscape.LayoutOptions {
    if (view === 'import_graph') {
        return { name: 'breadthfirst', directed: true, spacingFactor: 1.5, animate: true } as any;
    }
    // Default to cose-bilkent for clusters/compound or just standard
    return {
        name: 'cose-bilkent',
        animate: true,
        idealEdgeLength: 120,
        nodeRepulsion: 15000
    } as any;
}

// Data Filtering for Cytoscape
function filterData(view: string) {
    const nodes: any[] = [];
    const edges: any[] = [];
    const nodeIds = new Set();

    const addNode = (n: any) => {
        if(!nodeIds.has(n.id)) {
            nodes.push({ data: n });
            nodeIds.add(n.id);
        }
    };

    const addEdge = (e: any) => {
        edges.push({ data: e });
    };

    if (view === 'import_graph') {
        graphData.nodes.forEach(n => {
            if (n.type === 'file') addNode(n);
        });
        graphData.edges.forEach(e => {
            if (e.label === 'imports') addEdge(e);
        });
    } else {
        // Call Graph / Default
        graphData.nodes.forEach(n => addNode(n));
        graphData.edges.forEach(e => {
            if (e.label === 'calls' || e.label === 'contains') addEdge(e);
        });
    }

    return [...nodes, ...edges];
}

async function renderMermaid() {
    if (!mermaidContainer) return;
    mermaidContainer.innerHTML = '';
    
    // Reset Zoom
    zoomScale = 1;
    panX = 0;
    panY = 0;
    
    let definition = 'classDiagram\n';
    
    const classes = graphData.nodes.filter(n => n.type === 'class');
    if (classes.length === 0) {
        mermaidContainer.innerHTML = '<div style="padding:20px; color:#aaa;">No classes found.</div>';
        return;
    }

    // Add Classes with Members
    classes.forEach(n => {
        // Sanitize label for Mermaid
        const label = n.label.replace(/[^a-zA-Z0-9_]/g, '_');
        definition += `class ${label} {\n`;
        
        if (n.attributes) {
            n.attributes.slice(0, 8).forEach((a: string) => definition += `  +${a}\n`);
        }
        if (n.methods) {
            n.methods.slice(0, 10).forEach((m: string) => definition += `  +${m}()\n`);
        }
        definition += `}\n`;
        
        // Add interactivity: Calls global function onMermaidClick
        definition += `click ${label} call onMermaidClick("${n.id}")\n`;
    });

    // Add Inheritance
    graphData.edges.filter(e => e.label === 'inherits').forEach(e => {
        const src = graphData.nodes.find(n => n.id === e.source);
        const trg = graphData.nodes.find(n => n.id === e.target);
        if (src && trg) {
            const srcLabel = src.label.replace(/[^a-zA-Z0-9_]/g, '_');
            const trgLabel = trg.label.replace(/[^a-zA-Z0-9_]/g, '_');
            definition += `${trgLabel} <|-- ${srcLabel}\n`;
        }
    });

    try {
        const { svg } = await mermaid.render('mermaid-svg', definition);
        mermaidContainer.innerHTML = svg;
        
        // Apply initial style for interactivity
        const svgEl = mermaidContainer.querySelector('svg');
        if (svgEl) {
            svgEl.style.cursor = 'grab';
            svgEl.style.height = '100%';
            svgEl.style.width = '100%';
        }
    } catch (e) {
        console.error('Mermaid render error:', e);
        mermaidContainer.innerText = 'Error rendering diagram. Check console for details.';
    }
}

// Rendering Logic
function render() {
    const view = viewSelect.value;

    if (view === 'class_diagram') {
        if (cyContainer) cyContainer.style.display = 'none';
        if (mermaidContainer) {
            mermaidContainer.style.display = 'block';
            renderMermaid();
        }
        if (statusEl) statusEl.textContent = 'Class Diagram Rendered (Scroll to Zoom, Drag to Pan)';
        return;
    }

    // Cytoscape Rendering
    if (mermaidContainer) mermaidContainer.style.display = 'none';
    if (cyContainer) cyContainer.style.display = 'block';

    const elements = filterData(view);

    if (cy) {
        cy.destroy();
    }

    if (elements.length === 0) {
        if (statusEl) statusEl.textContent = 'No data for this view';
        return;
    }

    if (statusEl) statusEl.textContent = `Rendering ${elements.length} elements...`;

    cy = cytoscape({
        container: document.getElementById('cy'),
        elements: elements,
        layout: getLayout(view),
        style: [
            {
                selector: 'node',
                style: {
                    'label': 'data(label)',
                    'color': '#cccccc',
                    'text-valign': 'center',
                    'text-halign': 'center',
                    'background-color': '#555',
                    'shape': 'round-rectangle',
                    'width': 'label',
                    'height': 'label',
                    'padding': '10px',
                    'font-size': '12px'
                }
            },
            {
                selector: 'node[type="file"]',
                style: {
                    'background-color': '#007acc', // VS Code Blue
                    'color': '#ffffff'
                }
            },
            {
                selector: 'node[type="class"]',
                style: {
                    'background-color': '#d16d04', // Orange
                    'shape': 'rectangle'
                }
            },
            {
                selector: 'node[type="function"]',
                style: {
                    'background-color': '#6a1b9a', // Purple
                    'shape': 'ellipse'
                }
            },
            {
                selector: 'edge',
                style: {
                    'width': 4, // Increased width
                    'line-color': '#777',
                    'target-arrow-color': '#777',
                    'target-arrow-shape': 'triangle',
                    'curve-style': 'bezier',
                    'arrow-scale': 1.5
                }
            },
            {
                selector: 'edge[label="inherits"]',
                style: {
                    'target-arrow-shape': 'triangle',
                    'target-arrow-fill': 'hollow',
                    'line-style': 'solid',
                    'width': 5, // Extra thick
                    'line-color': '#d16d04',
                    'target-arrow-color': '#d16d04'
                }
            },
            {
                selector: 'edge[label="imports"]',
                style: {
                    'target-arrow-shape': 'triangle',
                    'line-style': 'solid',
                    'width': 3,
                    'line-color': '#3498db',
                    'target-arrow-color': '#3498db'
                }
            },
            {
                selector: ':selected',
                style: {
                    'border-width': 3,
                    'border-color': '#fff',
                    'background-color': '#333'
                }
            }
        ]
    });

    cy.on('tap', 'node', function(evt){
        const node = evt.target;
        const data = node.data();
        if (data.filePath) {
            vscode.postMessage({ 
                command: 'open', 
                file: data.filePath, 
                line: data.startLine || 0 
            });
        }
    });
    
    if (statusEl) statusEl.textContent = 'Graph Rendered';
}

// Message Handling
window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.command === 'graph') {
        graphData = msg.graph;
        
        if (msg.state === 'building') {
            if (loadingEl) loadingEl.style.display = 'flex';
            if (statusEl) statusEl.textContent = 'Building...';
        } else if (msg.state === 'error') {
            if (loadingEl) loadingEl.style.display = 'none';
            if (statusEl) statusEl.textContent = 'Error: ' + (msg.lastError || 'Unknown');
        } else {
            if (loadingEl) loadingEl.style.display = 'none';
            if (statusEl) statusEl.textContent = 'Ready';
            render();
        }
    }
});

// Notify extension we are ready to receive data
vscode.postMessage({ command: 'ready' });
