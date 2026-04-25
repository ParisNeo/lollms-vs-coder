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
const symbolSearch = document.getElementById('symbol-search') as HTMLInputElement;
const symbolList = document.getElementById('symbols-list') as HTMLDataListElement;
const runBtn = document.getElementById('run') as HTMLButtonElement;
const exampleSelect = document.getElementById('sparql-examples') as HTMLSelectElement;
const rebuildBtn = document.getElementById('rebuild') as HTMLButtonElement;
const regenerateBtn = document.getElementById('regenerate') as HTMLButtonElement;
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
let currentConfig = { zoomSensitivity: 0.5, panningEnabled: true, zoomToCursor: true };

// SPARQL-lite Logic
function runGraphQuery(query: string) {
    if (!cyInstance) return;
    
    // Reset visibility
    cyInstance.elements().removeClass('highlighted hidden');
    
    const lowerQuery = query.toLowerCase().trim();
    if (!lowerQuery) return;

    // 1. Handle "Isolate" command
    if (lowerQuery.startsWith('isolate ')) {
        const target = lowerQuery.replace('isolate ', '');
        const roots = cyInstance.nodes().filter(n => n.data('label').toLowerCase().includes(target));
        const neighborhood = roots.neighborhood().add(roots);
        cyInstance.elements().not(neighborhood).addClass('hidden');
        return;
    }

    // 2. Handle SPARQL-lite: "SELECT ?x WHERE { ?x imports 'target' }"
    const sparqlMatch = lowerQuery.match(/select\s+\?(\w+)\s+where\s+\{\s*\?\w+\s+(\w+)\s+['"]([^'"]+)['"]\s*\}/i);
    if (sparqlMatch) {
        const [_, variable, relation, target] = sparqlMatch;
        const targetNodes = cyInstance.nodes().filter(n => n.data('label').toLowerCase().includes(target.toLowerCase()));
        
        if (relation === 'imports' || relation === 'depends') {
            const dependents = targetNodes.incomers('edge[label="imports"]').sources();
            dependents.addClass('highlighted');
            cyInstance.elements().not(dependents.add(targetNodes).add(dependents.edgesWith(targetNodes))).addClass('hidden');
        }
        return;
    }

    // 3. Default: Simple Search & Center
    const matches = cyInstance.nodes().filter(n => n.data('label').toLowerCase().includes(lowerQuery));
    if (matches.length > 0) {
        cyInstance.animate({ center: { eles: matches }, zoom: 1 });
        matches.addClass('highlighted');
    }
}

// Event Listeners
window.addEventListener('message', event => {
    const message = event.data;
    
    if (message.command === 'graph') {
        const { graph, state, lastError, classDiagram, functionSignatures, config } = message;
        if (config) currentConfig = config;
        
        // Update Status UI
        if (state === 'building') {
            if (loadingOverlay) {
                loadingOverlay.style.display = 'flex';
                // Also hide the graph area while building to prevent showing stale data
                if (cyContainer) cyContainer.style.opacity = '0.3';
                if (mermaidContainer) mermaidContainer.style.opacity = '0.3';
            }
            if (rebuildBtn) rebuildBtn.style.display = 'none';
            if (regenerateBtn) regenerateBtn.style.display = 'none';
            if (stopBtn) stopBtn.style.display = 'inline-block';
            if (statusLabel) statusLabel.textContent = 'Building...';
        } else {
            if (loadingOverlay) {
                loadingOverlay.style.display = 'none';
                if (cyContainer) cyContainer.style.opacity = '1';
                if (mermaidContainer) mermaidContainer.style.opacity = '1';
            }
            if (rebuildBtn) rebuildBtn.style.display = 'inline-block';
            if (regenerateBtn) regenerateBtn.style.display = 'inline-block';
            if (stopBtn) stopBtn.style.display = 'none';
            if (statusLabel) {
                statusLabel.textContent = state === 'error' ? `Error: ${lastError}` : (state === 'ready' ? 'Ready' : 'Idle');
                statusLabel.style.color = state === 'error' ? 'var(--vscode-errorForeground)' : 'inherit';
            }
        }

        // Store Data
        if (graph) {
            currentGraphData = graph;
            // Update Autocomplete
            if (symbolList) {
                symbolList.innerHTML = graph.nodes
                    .filter((n: any) => n.type !== 'file')
                    .map((n: any) => `<option value="${n.label}">${n.type}</option>`)
                    .join('');
            }
        }
        if (classDiagram) currentClassDiagram = classDiagram;
        if (functionSignatures) currentFunctionSignatures = functionSignatures;

        // Render if ready
        if (state === 'ready' || (graph && graph.nodes.length > 0)) {
            render();
        }
    } else if (message.command === 'focusNode') {
        handleFocusNode(message.label, message.type);
    } else if (message.command === 'triggerExport') {
        exportVisualGraph(message.format, message.view);
    }
});

if (runBtn) {
    runBtn.addEventListener('click', () => {
        const query = symbolSearch.value.trim();
        if (!query) return;

        if (query.toUpperCase().startsWith('SELECT')) {
            executeSparql(query);
        } else {
            vscode.postMessage({ command: 'runSymbol', symbol: query });
        }
    });
}

if (exampleSelect) {
    exampleSelect.addEventListener('change', () => {
        if (exampleSelect.value) {
            symbolSearch.value = exampleSelect.value;
            exampleSelect.value = "";
        }
    });
}

function executeSparql(query: string) {
    if (!cyInstance || !currentGraphData) return;
    
    console.log("[Graph] Executing SPARQL:", query);

    // 1. Reset current state
    cyInstance.elements().removeClass('highlight');

    // 2. Improved Regex: Supports variables (?x) or literals ('file.py', "MyClass")
    const match = query.match(/SELECT\s+(\?\w+)\s+WHERE\s*\{\s*(\S+)\s+(\S+)\s+(\S+)\s*\}/i);
    
    if (!match) {
        statusLabel.textContent = "Query syntax error. Use: SELECT ?x WHERE { ?x type 'class' }";
        statusLabel.style.color = 'var(--vscode-errorForeground)';
        return;
    }

    const [,, subject, predicate, object] = match;
    const selectVar = match[1];
    const clean = (s: string) => s.replace(/['"]/g, '');

    // 3. Triple Matching logic
    const matchingElements = cyInstance.collection();

    cyInstance.edges().forEach(edge => {
        const source = edge.source();
        const target = edge.target();
        const edgeLabel = edge.data('label');

        if (edgeLabel === clean(predicate)) {
            // Check if Subject or Object match (either literal match or variable)
            const subjectMatches = subject.startsWith('?') || source.data('label') === clean(subject);
            const objectMatches = object.startsWith('?') || target.data('label') === clean(object);

            if (subjectMatches && objectMatches) {
                matchingElements.merge(edge);
                
                // Map the SELECT variable back to the correct part of the triple
                if (subject === selectVar) matchingElements.merge(source);
                if (object === selectVar) matchingElements.merge(target);
                
                // Also highlight literals for context
                if (!subject.startsWith('?')) matchingElements.merge(source);
                if (!object.startsWith('?')) matchingElements.merge(target);
            }
        }
    });

    // Special case for node-only metadata (e.g. type)
    if (clean(predicate) === 'type') {
        cyInstance.nodes().forEach(node => {
            if (node.data('type') === clean(object)) {
                matchingElements.merge(node);
            }
        });
    }

    // 4. Update UI and Zoom
    if (matchingElements.length > 0) {
        matchingElements.addClass('highlight');
        statusLabel.textContent = `Found ${matchingElements.nodes().length} matches`;
        statusLabel.style.color = 'inherit';
        
        cyInstance.animate({
            fit: { eles: matchingElements, padding: 80 },
            duration: 500
        });
    } else {
        statusLabel.textContent = "No matches found.";
        statusLabel.style.color = 'var(--vscode-charts-orange)';
    }
}

async function handleFocusNode(label: string, type: string) {
    // 1. Auto-switch view based on symbol type
    const isClass = (type || '').includes('class');
    const targetView = isClass ? 'class_diagram' : 'call_graph';
    
    if (viewSelect.value !== targetView) {
        viewSelect.value = targetView;
        render();
        await new Promise(resolve => setTimeout(resolve, 600));
    }

    // 2. Perform search/focus
    if (viewSelect.value === 'class_diagram' || viewSelect.value === 'function_signatures') {
        const textNodes = Array.from(mermaidContainer.querySelectorAll('text, .nodeLabel'));
        const match = textNodes.find(n => n.textContent?.trim() === label || n.textContent?.includes(label));
        if (match) {
            match.scrollIntoView({ behavior: 'smooth', block: 'center' });
            (match as HTMLElement).style.filter = 'drop-shadow(0 0 10px #ff9d00)';
            setTimeout(() => { (match as HTMLElement).style.filter = ''; }, 3000);
        }
    } else if (cyInstance) {
        const node = cyInstance.nodes().filter(n => n.data('label') === label || n.data('id') === label);
        
        if (node.length > 0) {
            cyInstance.elements().removeClass('highlight');
            
            // HIGHLIGHT NODE + NEIGHBORHOOD (Connections)
            const neighborhood = node.closedNeighborhood();
            neighborhood.addClass('highlight');
            
            // Ensure parents (file boxes) are visible but not blocking
            node.parents().style('background-opacity', 0.05);

            cyInstance.animate({
                zoom: 1.2, // Slightly out to see connections
                center: { eles: node },
                duration: 800,
                easing: 'ease-in-out-quint'
            });
            
            statusLabel.textContent = `Focused on ${label}`;
        }
    }
    
    if (symbolSearch) symbolSearch.value = label;
}

if (rebuildBtn) {
    rebuildBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'rebuild' });
    });
}

if (regenerateBtn) {
    regenerateBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'regenerate' });
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
        
        // Render to a temporary string first to let mermaid generate the SVG
        try {
            const { svg } = await mermaid.render(id, sanitizedDiagram);
            mermaidContainer.innerHTML = `<div class="mermaid">${svg}</div>`;
            
            // Enable Pan/Zoom
            const handlers = enablePanZoom(mermaidContainer);
            
            // Initial fit
            handlers.fitToScreen();
            
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
    if (!innerDiv) return { fitToScreen: () => {} };

    const svg = innerDiv.querySelector('svg') as SVGSVGElement;
    if (!svg) return { fitToScreen: () => {} };

    container.style.overflow = 'hidden';
    container.style.cursor = 'grab';
    container.style.position = 'relative';

    svg.style.transformOrigin = '0 0';
    svg.style.transition = 'transform 0.1s ease-out';
    
    // Remove static sizing
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.maxWidth = 'none';

    const updateTransform = () => {
        svg.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomScale})`;
    };

    const fitToScreen = () => {
        const containerRect = container.getBoundingClientRect();
        const bbox = svg.getBBox();
        
        if (bbox.width <= 0 || bbox.height <= 0) return;

        const padding = 40;
        const availableWidth = containerRect.width - padding;
        const availableHeight = containerRect.height - padding;

        const scaleX = availableWidth / bbox.width;
        const scaleY = availableHeight / bbox.height;
        
        zoomScale = Math.min(scaleX, scaleY, 1.5); // Limit max auto-zoom to 1.5x
        
        panX = (containerRect.width / 2) - (zoomScale * (bbox.x + bbox.width / 2));
        panY = (containerRect.height / 2) - (zoomScale * (bbox.y + bbox.height / 2));
        
        updateTransform();
    };

    container.onwheel = (e) => {
        e.preventDefault();
        const intensity = currentConfig.zoomSensitivity * 0.2;
        const delta = e.deltaY > 0 ? -intensity : intensity;
        const factor = Math.exp(delta);
        
        const newScale = Math.min(Math.max(0.01, zoomScale * factor), 20);
        
        if (currentConfig.zoomToCursor) {
            const rect = container.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            panX = mouseX - (mouseX - panX) * (newScale / zoomScale);
            panY = mouseY - (mouseY - panY) * (newScale / zoomScale);
        }
        
        zoomScale = newScale;
        updateTransform();
    };

    if (!currentConfig.panningEnabled) {
        container.onmousedown = null;
    }

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
    
    const isLarge = elements.length > 500;

    cyInstance = cytoscape({
        container: cyContainer,
        elements: elements,
        style: getCyStyle(),
        layout: isLarge ? {
            name: 'dagre',
            rankDir: 'LR',
            nodeSep: 120, // Increased spacing
            rankSep: 200, // Increased spacing
            animate: false
        } : {
            name: 'cose-bilkent',
            quality: 'proof',           // Highest quality for best packing
            nodeDimensionsIncludeLabels: true,
            randomize: false,           // Deterministic layout is less messy
            fit: true,
            padding: 30,
            // --- ULTRA-COMPACT PACKING ---
            nodeRepulsion: 2500,        // Drastically lower to let nodes huddle
            idealEdgeLength: 30,        // Very short connections
            edgeElasticity: 0.55,       // Very strong pull on edges
            nestingFactor: 0.05,        // Tighten the bounds around children
            gravity: 2.5,               // Strong pull to center
            numIter: 5000,
            tile: true,                 // Aggressively tile orphans
            tilingPaddingVertical: 20,
            tilingPaddingHorizontal: 20,
            animate: false
        } as any,
        minZoom: 0.005,
        maxZoom: 10.0,
        wheelSensitivity: currentConfig.zoomSensitivity,
        userPanningEnabled: currentConfig.panningEnabled
    });

    if (isLarge) {
        statusLabel.textContent += ' (Performance Mode Active)';
        statusLabel.style.color = 'var(--vscode-charts-orange)';
    }

    // CRITICAL FIX: Ensure container is ready and force a spread-out layout
    setTimeout(() => {
        if (!cyInstance) return;
        cyInstance.resize();
        cyInstance.layout(isLarge ? {
            name: 'dagre',
            rankDir: 'LR',
            nodeSep: 200, // Even wider
            rankSep: 350, // Even deeper
            animate: true,
            animationDuration: 400
        } : {
            name: 'cose-bilkent',
            animate: true,
            nodeRepulsion: 25000, // Massive repulsion to prevent packing
            idealEdgeLength: 200,   // Longer connections
            nodeDimensionsIncludeLabels: true
        } as any).run();
        cyInstance.fit(undefined, 60);
    }, 150);

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
                'text-valign': 'center', // Labels moved inside
                'text-halign': 'center',
                'text-wrap': 'wrap',
                'text-max-width': '80px',
                'background-color': '#3c3c3c',
                'border-width': 1.5,
                'border-color': '#ffffff',
                'width': '60px', // Larger nodes to fit text
                'height': '60px',
                'shape': 'ellipse',
                'text-outline-color': '#1e1e1e', // Contrast for readability
                'text-outline-width': 2,
                'overlay-opacity': 0,
                'transition-property': 'background-color, line-color, target-arrow-color',
                'transition-duration': '0.2s'
            }
        },
        {
            selector: ':parent', // This represents FILES
            style: {
                'text-valign': 'top',
                'text-halign': 'center',
                'background-color': '#569cd6',
                'background-opacity': 0.03,
                'border-color': '#569cd6',
                'border-opacity': 0.4,
                'border-width': 2,
                'border-style': 'solid',
                'padding': '40px', // More space inside files
                'shape': 'roundrectangle',
                'font-size': '14px',
                'font-weight': 'bold',
                'text-margin-y': '-15px'
            }
        },
        {
            selector: '.node-class',
            style: {
                'background-color': '#4ec9b0', // Teal
                'border-color': '#ffffff',
                'shape': 'rectangle',
                'width': '80px'
            }
        },
        {
            selector: '.node-function',
            style: {
                'background-color': '#dcdcaa', // Yellow
                'border-color': '#ffffff',
                'shape': 'ellipse'
            }
        },
        {
            selector: 'node[type="method"]',
            style: {
                'background-color': '#ce9178', // Orange/Brown
                'border-color': '#ffffff',
                'shape': 'round-rectangle'
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
                'target-arrow-color': '#569cd6',
                'target-arrow-shape': 'triangle'
            }
        },
        {
            selector: 'node.highlight',
            style: {
                'background-color': '#ff9d00',
                'transition-property': 'background-color, width, height',
                'transition-duration': '0.3s',
                'width': '35px',
                'height': '35px',
                'border-width': 4,
                'border-color': '#ffffff',
                'font-size': '14px',
                'font-weight': 'bold',
                'z-index': 9999
            }
        },
        {
            selector: 'edge.highlight',
            style: {
                'line-color': '#ff9d00',
                'target-arrow-color': '#ff9d00',
                'width': '4px',
                'arrow-scale': 1.5,
                'z-index': 9998,
                'opacity': 1
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
