import cytoscape from 'cytoscape';
import coseBilkent from 'cytoscape-cose-bilkent';
import cytoscapeDagre from 'cytoscape-dagre';
import mermaid from 'mermaid';

// Register layouts
cytoscape.use(coseBilkent);
cytoscape.use(cytoscapeDagre);

// Initialize Mermaid
mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    securityLevel: 'strict',
    fontFamily: 'var(--vscode-font-family)'
});

// VS Code API
declare const acquireVsCodeApi: any;
const vscode = acquireVsCodeApi();

// DOM Elements
const cyContainer = document.getElementById('cy') as HTMLDivElement;
const mermaidContainer = document.getElementById('mermaid-container') as HTMLDivElement;
const viewSelect = document.getElementById('view') as HTMLSelectElement;
const layoutStyleSelect = document.getElementById('layout-style') as HTMLSelectElement;
const groupingModeSelect = document.getElementById('grouping-mode') as HTMLSelectElement;
const hideOrphansCheckbox = document.getElementById('hide-orphans') as HTMLInputElement;
const symbolSearch = document.getElementById('symbol-search') as HTMLInputElement;
const symbolList = document.getElementById('symbols-list') as HTMLDataListElement;
const runQuerySelect = document.getElementById('run-query-select') as HTMLSelectElement;
const exampleSelect = document.getElementById('sparql-examples') as HTMLSelectElement;
const rebuildBtn = document.getElementById('rebuild') as HTMLButtonElement;
const actionSelect = document.getElementById('action-select') as HTMLSelectElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;
const statusLabel = document.getElementById('status') as HTMLSpanElement;
const loadingOverlay = document.getElementById('loading') as HTMLDivElement;
const clearHighlightsBtn = document.getElementById('clear-highlights') as HTMLButtonElement;
const queryModeSelect = document.getElementById('query-mode-select') as HTMLSelectElement | null;
const aiTranslateBtn = document.getElementById('ai-translate-btn') as HTMLButtonElement | null;
const sparqlQueryInput = document.getElementById('sparql-query-input') as HTMLInputElement | null;
const aiQueryInput = document.getElementById('ai-query-input') as HTMLInputElement | null;
const runSparqlBtn = document.getElementById('run-sparql-btn') as HTMLButtonElement | null;
const runAiBtn = document.getElementById('run-ai-btn') as HTMLButtonElement | null;
const aiExamplesSelect = document.getElementById('ai-examples') as HTMLSelectElement | null;

// State
let currentGraphData: any = null;
let currentClassDiagram: string = '';
let currentFunctionSignatures: string = '';
let currentModuleDependencyGraph: string = '';
let currentExternalLibraryGraph: string = '';
let cyInstance: any = null;
let currentConfig = { zoomSensitivity: 0.5, panningEnabled: true, zoomToCursor: true };

// Interactive Pathfinder State
let pathSourceNode: any = null;
let pathTargetNode: any = null;

// Ontological Tooltip Element (Drawn dynamically)
let tooltipElement = document.getElementById('ontological-tooltip');
if (!tooltipElement) {
    tooltipElement = document.createElement('div');
    tooltipElement.id = 'ontological-tooltip';
    tooltipElement.style.cssText = `
        position: absolute;
        z-index: 10000;
        background: var(--vscode-editorWidget-background);
        color: var(--vscode-editorWidget-foreground);
        border: 1px solid var(--vscode-widget-border);
        border-radius: 6px;
        padding: 10px 14px;
        font-size: 11px;
        font-family: var(--vscode-font-family);
        pointer-events: none;
        box-shadow: 0 10px 25px rgba(0,0,0,0.5);
        display: none;
        max-width: 280px;
        line-height: 1.4;
    `;
    document.body.appendChild(tooltipElement);
}

// Event Listeners
window.addEventListener('message', event => {
    const message = event.data;
    
    if (message.command === 'graph') {
        const { graph, state, lastError, classDiagram, functionSignatures, moduleDependencyGraph, externalLibraryGraph, config } = message;
        if (config) currentConfig = config;
        
        if (state === 'building') {
            if (loadingOverlay) {
                loadingOverlay.style.display = 'flex';
                if (cyContainer) cyContainer.style.opacity = '0.3';
                if (mermaidContainer) mermaidContainer.style.opacity = '0.3';
            }
            if (rebuildBtn) rebuildBtn.style.display = 'none';
            if (actionSelect) actionSelect.style.display = 'none';
            if (runQuerySelect) runQuerySelect.style.display = 'none';
            if (stopBtn) stopBtn.style.display = 'inline-block';
            if (statusLabel) statusLabel.textContent = 'Building...';
        } else {
            if (loadingOverlay) {
                loadingOverlay.style.display = 'none';
                if (cyContainer) cyContainer.style.opacity = '1';
                if (mermaidContainer) mermaidContainer.style.opacity = '1';
            }
            if (rebuildBtn) rebuildBtn.style.display = 'inline-block';
            if (actionSelect) actionSelect.style.display = 'inline-block';
            if (runQuerySelect) runQuerySelect.style.display = 'inline-block';
            if (stopBtn) stopBtn.style.display = 'none';
            if (statusLabel) {
                statusLabel.textContent = state === 'error' ? `Error: ${lastError}` : (state === 'ready' ? 'Ready' : 'Idle');
                statusLabel.style.color = state === 'error' ? 'var(--vscode-errorForeground)' : 'inherit';
            }
        }

        if (graph) {
            currentGraphData = graph;
            if (symbolList) {
                symbolList.innerHTML = graph.nodes
                    .filter((n: any) => n.type !== 'file')
                    .map((n: any) => `<option value="${n.label}">${n.type}</option>`)
                    .join('');
            }
        }
        if (classDiagram) currentClassDiagram = classDiagram;
        if (functionSignatures) currentFunctionSignatures = functionSignatures;
        if (moduleDependencyGraph) currentModuleDependencyGraph = moduleDependencyGraph;
        if (externalLibraryGraph) currentExternalLibraryGraph = externalLibraryGraph;

        if (state === 'ready' || (graph && graph.nodes.length > 0)) {
            render();
        }
    } else if (message.command === 'focusNode') {
        handleFocusNode(message.label, message.type);
    } else if (message.command === 'triggerExport') {
        exportVisualGraph(message.format, message.view);
    } else if (message.command === 'nlTranslationResult') {
        if (runAiBtn) {
            runAiBtn.disabled = false;
        }
        if (message.error) {
            statusLabel.textContent = `AI Error: ${message.error}`;
            statusLabel.style.color = 'var(--vscode-errorForeground)';
        } else if (message.query) {
            if (sparqlQueryInput) {
                sparqlQueryInput.value = message.query;
            }
            statusLabel.textContent = `Translated: ${message.query}`;
            statusLabel.style.color = 'var(--vscode-charts-green)';
            executeSparqlQuery(message.query);
        }
    }
});

if (runSparqlBtn) {
    runSparqlBtn.addEventListener('click', () => {
        const query = sparqlQueryInput ? sparqlQueryInput.value.trim() : "";
        if (!query) return;
        executeSparqlQuery(query);
    });
}

if (runAiBtn) {
    runAiBtn.addEventListener('click', () => {
        const query = aiQueryInput ? aiQueryInput.value.trim() : "";
        if (!query) return;

        if (runAiBtn) runAiBtn.disabled = true;
        statusLabel.textContent = "Asking AI to translate and execute...";
        statusLabel.style.color = 'var(--vscode-charts-blue)';
        vscode.postMessage({ command: 'translateNLQuery', text: query });
    });
}

if (symbolSearch) {
    symbolSearch.addEventListener('input', () => {
        const query = symbolSearch.value.trim().toLowerCase();
        if (!query || !cyInstance || !currentGraphData) {
            if (cyInstance) cyInstance.elements().unselect();
            return;
        }

        if (query.toUpperCase().startsWith('SELECT')) return; // Ignore SPARQL on input

        const matchedElements = cyInstance.nodes().filter((ele: any) => {
            const data = ele.data();
            return data && !data.isParent && (data.label.toLowerCase().includes(query) || data.id.toLowerCase().includes(query));
        });

        if (matchedElements.length > 0) {
            cyInstance.elements().unselect();
            matchedElements.select();

            const exactMatch = matchedElements.filter((ele: any) => {
                const d = ele.data();
                return d && d.label && d.label.toLowerCase() === query;
            });
            const eleToFocus = exactMatch.length > 0 ? exactMatch[0] : matchedElements[0];

            cyInstance.animate({
                center: { eles: eleToFocus },
                zoom: 1.1,
                duration: 400
            });
        }
    });
}

if (exampleSelect) {
    exampleSelect.addEventListener('change', () => {
        if (exampleSelect.value) {
            if (sparqlQueryInput) {
                sparqlQueryInput.value = exampleSelect.value;
            }
            exampleSelect.value = "";
            executeSparqlQuery(sparqlQueryInput ? sparqlQueryInput.value : "");
        }
    });
}

if (aiExamplesSelect) {
    aiExamplesSelect.addEventListener('change', () => {
        if (aiExamplesSelect.value) {
            if (aiQueryInput) {
                aiQueryInput.value = aiExamplesSelect.value;
            }
            aiExamplesSelect.value = "";
        }
    });
}

if (layoutStyleSelect) {
    layoutStyleSelect.addEventListener('change', () => {
        render();
    });
}

if (groupingModeSelect) {
    groupingModeSelect.addEventListener('change', () => {
        render();
    });
}

if (hideOrphansCheckbox) {
    hideOrphansCheckbox.addEventListener('change', () => {
        render();
    });
}

/**
 * Executes a SPARQL-lite query locally and animates the resulting subgraph.
 * Custom Matcher: Normalizes namespace syntax and handles case-insensitivity.
 */
function executeSparqlQuery(query: string) {
    if (!cyInstance || !currentGraphData) return;

    const cleanQuery = query.replace(/#.*/g, '').trim();
    const selectMatch = cleanQuery.match(/SELECT\s+([\?\w\s]+)\s+WHERE\s*\{([\s\S]+?)\}/i);

    if (!selectMatch) {
        statusLabel.textContent = "SPARQL-lite Error: Invalid query format.";
        statusLabel.style.color = 'var(--vscode-errorForeground)';
        return;
    }

    const selectVars = selectMatch[1].trim().split(/\s+/).map(v => v.trim());
    const body = selectMatch[2].trim();

    const triples: { s: string, p: string, o: string }[] = [];
    const lines = body.split(/\s*\.\s*(?=(?:[^"']*["'][^"']*["'])*[^"']*$)/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 3) {
            triples.push({
                s: parts[0],
                p: parts[1],
                o: parts.slice(2).join(' ')
            });
        }
    }

    if (triples.length === 0) return;

    const variables = new Set<string>();
    for (const t of triples) {
        if (t.s.startsWith('?')) variables.add(t.s);
        if (t.p.startsWith('?')) variables.add(t.p);
        if (t.o.startsWith('?')) variables.add(t.o);
    }

    const facts: { s: string, p: string, o: string }[] = [];
    currentGraphData.nodes.forEach((node: any) => {
        const typeUri = `s:${node.type.charAt(0).toUpperCase() + node.type.slice(1)}`;
        facts.push({ s: node.id, p: 's:type', o: typeUri });
        facts.push({ s: node.id, p: 's:name', o: `"${node.label}"` });
    });

    currentGraphData.edges.forEach((edge: any) => {
        facts.push({ s: edge.source, p: `s:${edge.label}`, o: edge.target });
    });

    const varList = Array.from(variables);
    const results: Record<string, string>[] = [];

    const matchValue = (factVal: string, queryVal: string): boolean => {
        if (!factVal || !queryVal) return false;
        const cleanFact = factVal.replace(/^s:/i, '').toLowerCase().replace(/['"]/g, '').trim();
        const cleanQuery = queryVal.replace(/^s:/i, '').toLowerCase().replace(/['"]/g, '').trim();
        return cleanFact === cleanQuery;
    };

    const solve = (varIdx: number, bindings: Record<string, string>) => {
        if (varIdx === varList.length) {
            let valid = true;
            for (const t of triples) {
                const sVal = t.s.startsWith('?') ? bindings[t.s] : t.s;
                const pVal = t.p.startsWith('?') ? bindings[t.p] : t.p;
                const oVal = t.o.startsWith('?') ? bindings[t.o] : t.o;

                const match = facts.some(f => 
                    matchValue(f.s, sVal) && matchValue(f.p, pVal) && matchValue(f.o, oVal)
                );
                if (!match) { valid = false; break; }
            }
            if (valid) {
                const isDup = results.some(r => varList.every(v => r[v] === bindings[v]));
                if (!isDup) results.push({ ...bindings });
            }
            return;
        }

        const currentVar = varList[varIdx];
        const domain = new Set<string>();
        for (const t of triples) {
            if (t.s === currentVar) facts.forEach(f => domain.add(f.s));
            if (t.p === currentVar) facts.forEach(f => domain.add(f.p));
            if (t.o === currentVar) facts.forEach(f => domain.add(f.o));
        }

        for (const val of domain) {
            bindings[currentVar] = val;
            solve(varIdx + 1, bindings);
            delete bindings[currentVar];
        }
    };

    solve(0, {});

    if (results.length === 0) {
        statusLabel.textContent = "SPARQL-lite: No matching subgraphs found.";
        statusLabel.style.color = 'var(--vscode-charts-orange)';
        return;
    }

    const matchedNodeIds = new Set<string>();
    results.forEach(row => {
        selectVars.forEach(v => {
            const val = row[v];
            if (val && !val.startsWith('s:')) {
                matchedNodeIds.add(val);
            }
        });
    });

    if (cyInstance) {
        cyInstance.elements().removeClass('dimmed matched path-node path-edge');

        const matchedSelector = Array.from(matchedNodeIds).map(id => `#${id}`).join(', ');
        if (matchedSelector) {
            const matchedNodes = cyInstance.$(matchedSelector);
            const matchedEdges = matchedNodes.edgesWith(matchedNodes);

            cyInstance.elements().addClass('dimmed');
            matchedNodes.removeClass('dimmed').addClass('matched');
            matchedEdges.removeClass('dimmed').addClass('matched');
            matchedNodes.ancestors().removeClass('dimmed');

            if (clearHighlightsBtn) {
                clearHighlightsBtn.style.display = 'inline-block';
            }
        }
    }

    statusLabel.textContent = `SPARQL-lite: Isolated ${matchedNodeIds.size} nodes`;
    statusLabel.style.color = 'var(--vscode-charts-green)';
}

async function handleFocusNode(label: string, type: string) {
    const isClass = (type || '').includes('class');
    const targetView = isClass ? 'class_diagram' : 'call_graph';

    if (viewSelect.value !== targetView) {
        viewSelect.value = targetView;
        render();
        await new Promise(resolve => setTimeout(resolve, 600));
    }

    if (viewSelect.value === 'class_diagram' || viewSelect.value === 'function_signatures' || viewSelect.value === 'module_dependency_graph' || viewSelect.value === 'external_library_graph') {
        const textNodes = Array.from(mermaidContainer.querySelectorAll('text, .nodeLabel'));
        const match = textNodes.find(n => n.textContent?.trim() === label || n.textContent?.includes(label));
        if (match) {
            match.scrollIntoView({ behavior: 'smooth', block: 'center' });
            (match as HTMLElement).style.filter = 'drop-shadow(0 0 10px #ff9d00)';
            setTimeout(() => { (match as HTMLElement).style.filter = ''; }, 3000);
        }
    } else if (cyInstance) {
        const nodes = currentGraphData.nodes;
        const targetNode = nodes.find((n: any) => n.label === label || n.id === label);
        if (targetNode) {
            const matched = cyInstance.$(`#${targetNode.id}`);
            if (matched.length > 0) {
                cyInstance.elements().unselect();
                matched.select();
                cyInstance.animate({
                    center: { eles: matched },
                    zoom: 1.2,
                    duration: 800
                });
                statusLabel.textContent = `Focused on ${label}`;
            }
        }
    }

    if (symbolSearch) symbolSearch.value = label;
}

if (rebuildBtn) {
    rebuildBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'rebuild' });
    });
}

if (actionSelect) {
    actionSelect.addEventListener('change', () => {
        const action = actionSelect.value;
        if (!action) return;

        // Reset selection to show placeholder again
        actionSelect.value = "";

        if (action === 'regenerate') {
            if (cyInstance) {
                cyInstance.elements().removeClass('dimmed matched path-node path-edge');
            }
            vscode.postMessage({ command: 'regenerate' });
        } else if (action === 'add') {
            vscode.postMessage({ command: 'addToChat', view: viewSelect.value });
        } else if (action === 'export') {
            vscode.postMessage({ command: 'requestExport', view: viewSelect.value });
        } else if (action === 'isolate-connected') {
            const selected = cyInstance?.$('node:selected').first();
            if (selected && selected.length > 0) {
                isolateConnectedComponent(selected);
            } else {
                vscode.postMessage({ command: 'showError', message: 'Please select a node first to isolate its connections.' });
            }
        } else if (action === 'isolate-neighbors') {
            const selected = cyInstance?.$('node:selected').first();
            if (selected && selected.length > 0) {
                isolateDirectNeighbors(selected);
            } else {
                vscode.postMessage({ command: 'showError', message: 'Please select a node first.' });
            }
        }
    });
}

if (stopBtn) {
    stopBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'stop' });
    });
}

function updateQueryModeUI() {
    if (!queryModeSelect) return;
    const mode = queryModeSelect.value;
    if (mode === 'simplified') {
        if (aiTranslateBtn) aiTranslateBtn.style.display = 'none';
        if (exampleSelect) exampleSelect.style.display = 'none';
        if (symbolSearch) symbolSearch.placeholder = "Search symbol or ask plain English... (Shift+Click nodes to find paths)";
    } else {
        if (aiTranslateBtn) aiTranslateBtn.style.display = 'inline-block';
        if (exampleSelect) exampleSelect.style.display = 'inline-block';
        if (symbolSearch) symbolSearch.placeholder = "Enter SPARQL-lite query (SELECT ?x WHERE...)";
    }
}

if (queryModeSelect) {
    queryModeSelect.addEventListener('change', () => {
        updateQueryModeUI();
        if (symbolSearch) symbolSearch.value = "";
        if (cyInstance) {
            cyInstance.elements().removeClass('dimmed matched path-node path-edge');
        }
        pathSourceNode = null;
        pathTargetNode = null;
        if (clearHighlightsBtn) clearHighlightsBtn.style.display = 'none';
        statusLabel.textContent = 'Ready';
        statusLabel.style.color = 'inherit';
    });
}

if (viewSelect) {
    viewSelect.addEventListener('change', () => {
        render();
    });
}

if (clearHighlightsBtn) {
    clearHighlightsBtn.addEventListener('click', () => {
        if (cyInstance) {
            cyInstance.elements().removeClass('dimmed matched path-node path-edge');
            clearHighlightsBtn.style.display = 'none';
            statusLabel.textContent = 'Ready';
            statusLabel.style.color = 'inherit';
            if (symbolSearch) symbolSearch.value = '';
            pathSourceNode = null;
            pathTargetNode = null;
            closeContextMenu();
        }
    });
}

vscode.postMessage({ command: 'ready' });

// Initialize UI States
updateQueryModeUI();

vscode.postMessage({ command: 'ready' });

function render() {
    const view = viewSelect.value;

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

async function renderMermaidView(view: string) {
    if (cyContainer) cyContainer.style.display = 'none';
    if (mermaidContainer) {
        mermaidContainer.style.display = 'block';
        
        let rawDiagram = '';
        if (view === 'class_diagram') rawDiagram = currentClassDiagram;
        else if (view === 'function_signatures') rawDiagram = currentFunctionSignatures;
        else if (view === 'module_dependency_graph') rawDiagram = currentModuleDependencyGraph;
        else if (view === 'external_library_graph') rawDiagram = currentExternalLibraryGraph;

        const sanitizedDiagram = preprocessMermaid(rawDiagram);
        const id = `mermaid-render-${Date.now()}`;
        
        try {
            const { svg } = await mermaid.render(id, sanitizedDiagram);
            mermaidContainer.innerHTML = `<div class="mermaid">${svg}</div>`;
            const handlers = enablePanZoom(mermaidContainer);
            handlers.fitToScreen();
            
        } catch (e: any) {
            console.error("📊 Mermaid Syntax Error:", e);
            mermaidContainer.innerHTML = `
                <div style="color:var(--vscode-errorForeground); padding:20px; background:var(--vscode-inputValidation-errorBackground); border:1px solid var(--vscode-errorForeground); border-radius:4px;">
                    <div style="font-weight:bold; margin-bottom:8px;"><span class="codicon codicon-error"></span> Mermaid Render Failed</div>
                    <div style="font-family:monospace; font-size:11px; white-space:pre-wrap;">${e.message || e}</div>
                </div>
            `;
        }
    }
}

const cyStyle: any[] = [
    {
        selector: 'node',
        style: {
            'label': 'data(label)',
            'color': '#ffffff',
            'font-family': 'var(--vscode-font-family), monospace',
            'font-size': '11px',
            'text-valign': 'center',
            'text-halign': 'center',
            'background-color': '#2d2d2d',
            'border-width': '1.5px',
            'border-color': '#555555',
            'width': 'data(estWidth)',
            'height': 'data(estHeight)',
            'shape': 'round-rectangle',
            'text-wrap': 'wrap',
            'text-max-width': '180px'
        }
    },
    {
        selector: 'node[type="file"]',
        style: {
            'background-color': '#1f4e79',
            'border-color': '#569cd6',
            'shape': 'round-rectangle'
        }
    },
    {
        selector: 'node[type="class"]',
        style: {
            'background-color': '#2d6a4f',
            'border-color': '#4ec9b0',
            'shape': 'ellipse'
        }
    },
    {
        selector: 'node[type="function"]',
        style: {
            'background-color': '#8c7a1e',
            'border-color': '#dcdcaa',
            'shape': 'ellipse'
        }
    },
    {
        selector: 'node[type="library"]',
        style: {
            'background-color': '#8f5c2c',
            'border-color': '#d19a66',
            'shape': 'hexagon'
        }
    },
    {
        selector: 'node[type="folder"]',
        style: {
            'background-color': '#114b7a',
            'border-color': '#ffffff',
            'shape': 'round-rectangle'
        }
    },
    {
        selector: 'node:parent',
        style: {
            'background-color': '#000000',
            'background-opacity': 0.25,
            'border-color': '#555555',
            'border-width': '1px',
            'border-style': 'dashed',
            'label': 'data(label)',
            'text-valign': 'top',
            'text-halign': 'center',
            'color': '#aaaaaa',
            'font-size': '10px',
            'font-weight': 'bold',
            'padding': '15px'
        }
    },
    {
        selector: 'edge',
        style: {
            'width': 1.5,
            'line-color': '#555555',
            'target-arrow-color': '#555555',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            'arrow-scale': 0.8,
            'font-size': '8px',
            'color': '#888888',
            'text-background-opacity': 0.8,
            'text-background-color': '#1e1e1e',
            'text-background-padding': '2px',
            'text-background-shape': 'round-rectangle'
        }
    },
    {
        selector: 'edge[label]',
        style: {
            'label': 'data(label)'
        }
    },
    {
        selector: 'node:selected',
        style: {
            'border-color': '#ff9d00',
            'border-width': '3px',
            'background-color': '#ff9d00',
            'color': '#000000'
        }
    },
    {
        selector: 'edge:selected',
        style: {
            'line-color': '#ff9d00',
            'target-arrow-color': '#ff9d00',
            'width': 3
        }
    },
    {
        selector: '.dimmed',
        style: {
            'opacity': 0.15,
            'events': 'no'
        }
    },
    {
        selector: '.matched',
        style: {
            'border-color': '#ff9d00',
            'border-width': '4px',
            'z-index': 9999
        }
    },
    {
        selector: 'edge.matched',
        style: {
            'line-color': '#ff9d00',
            'target-arrow-color': '#ff9d00',
            'width': 3,
            'z-index': 9998
        }
    },
    {
        selector: '.path-node',
        style: {
            'border-color': '#00ffcc',
            'border-width': '4px',
            'z-index': 9999
        }
    },
    {
        selector: 'edge.path-edge',
        style: {
            'line-color': '#00ffcc',
            'target-arrow-color': '#00ffcc',
            'width': 4,
            'z-index': 9998
        }
    }
];

function renderCytoscapeView(viewType: string) {
    if (mermaidContainer) mermaidContainer.style.display = 'none';
    if (cyContainer) cyContainer.style.display = 'block';

    if (!currentGraphData) return;

    const elements: any[] = [];
    const hideOrphans = hideOrphansCheckbox ? hideOrphansCheckbox.checked : false;
    const groupingMode = groupingModeSelect ? groupingModeSelect.value : 'none';
    const layoutStyle = layoutStyleSelect ? layoutStyleSelect.value : 'organic';

    const parentIds = new Set<string>();

    const getEstDimensions = (label: string, type: string) => {
        const cleanLabel = label.replace(/📁\s*/, '').trim();
        const charCount = cleanLabel.length;

        let width = Math.max(65, Math.min(220, charCount * 7.5 + 24));
        let height = 35;

        if (type === 'class' || type === 'function') {
            width = Math.max(70, Math.min(240, charCount * 8 + 30));
            height = 45;
        }
        return { width, height };
    };

    // 1. Process specific Graph / Topology views
    if (viewType === 'module_dependency_graph') {
        const folderNodesMap = new Map<string, any>();
        const folderEdgesSet = new Set<string>();

        // Gather folders from file paths
        currentGraphData.nodes.forEach((n: any) => {
            if (n.type === 'file' && n.filePath) {
                const folder = n.filePath.includes('/') ? n.filePath.substring(0, n.filePath.lastIndexOf('/')) : '.';
                if (!folderNodesMap.has(folder)) {
                    folderNodesMap.set(folder, {
                        id: `folder_${folder}`,
                        label: `📁 ${folder}`,
                        type: 'folder'
                    });
                }
            }
        });

        // Gather cross-folder imports
        currentGraphData.edges.forEach((e: any) => {
            if (e.label === 'imports') {
                const src = currentGraphData.nodes.find((n: any) => n.id === e.source);
                const trg = currentGraphData.nodes.find((n: any) => n.id === e.target);
                if (src && trg && src.filePath && trg.filePath) {
                    const srcFolder = src.filePath.includes('/') ? src.filePath.substring(0, src.filePath.lastIndexOf('/')) : '.';
                    const trgFolder = trg.filePath.includes('/') ? trg.filePath.substring(0, trg.filePath.lastIndexOf('/')) : '.';
                    if (srcFolder !== trgFolder) {
                        const edgeId = `folder_${srcFolder}-->folder_${trgFolder}`;
                        if (!folderEdgesSet.has(edgeId)) {
                            folderEdgesSet.add(edgeId);
                            elements.push({
                                group: 'edges',
                                data: {
                                    id: edgeId,
                                    source: `folder_${srcFolder}`,
                                    target: `folder_${trgFolder}`,
                                    label: 'imports'
                                }
                            });
                        }
                    }
                }
            }
        });

        folderNodesMap.forEach(node => {
            const dims = getEstDimensions(node.label, 'folder');
            elements.push({
                group: 'nodes',
                data: {
                    id: node.id,
                    label: node.label,
                    type: 'folder',
                    filePath: node.filePath,
                    estWidth: dims.width,
                    estHeight: dims.height
                }
            });
        });

    } else if (viewType === 'external_library_graph') {
        const importedFileIds = new Set<string>();

        currentGraphData.edges.forEach((e: any) => {
            const trg = currentGraphData.nodes.find((n: any) => n.id === e.target);
            if (trg && trg.type === 'library') {
                importedFileIds.add(e.source);
                elements.push({
                    group: 'edges',
                    data: {
                        id: e.id,
                        source: e.source,
                        target: e.target,
                        label: 'imports'
                    }
                });
            }
        });

        currentGraphData.nodes.forEach((n: any) => {
            if (n.type === 'library' || importedFileIds.has(n.id)) {
                const dims = getEstDimensions(n.label, n.type);
                elements.push({
                    group: 'nodes',
                    data: {
                        id: n.id,
                        label: n.label,
                        type: n.type,
                        filePath: n.filePath,
                        estWidth: dims.width,
                        estHeight: dims.height
                    }
                });
            }
        });

    } else if (viewType === 'hotspot_complexity_graph') {
        const fileNodes = currentGraphData.nodes.filter((n: any) => n.type === 'file');

        fileNodes.forEach((n: any) => {
            const lines = n.linesCount || 50; 
            const dims = getEstDimensions(n.label, 'file');
            dims.width = Math.max(dims.width, 95);
            dims.height = 45;

            elements.push({
                group: 'nodes',
                data: {
                    id: n.id,
                    label: `${n.label}\n(${lines} LOC)`,
                    type: n.type,
                    filePath: n.filePath,
                    linesCount: lines,
                    estWidth: dims.width,
                    estHeight: dims.height
                }
            });
        });

        currentGraphData.edges.forEach((e: any) => {
            if (e.label === 'imports') {
                const src = fileNodes.find((n: any) => n.id === e.source);
                const trg = fileNodes.find((n: any) => n.id === e.target);
                if (src && trg) {
                    elements.push({
                        group: 'edges',
                        data: {
                            id: e.id,
                            source: e.source,
                            target: e.target,
                            label: 'imports'
                        }
                    });
                }
            }
        });

    } else {
        // Fallback for default views (Call/Import Graphs)
        currentGraphData.edges.forEach((e: any) => {
            let include = false;
            if (viewType === 'call_graph' && e.label === 'calls') include = true;
            if (viewType === 'import_graph' && e.label === 'imports') include = true;

            if (include) {
                elements.push({
                    group: 'edges',
                    data: {
                        id: e.id,
                        source: e.source,
                        target: e.target,
                        label: e.label
                    }
                });
            }
        });

        currentGraphData.nodes.forEach((n: any) => {
            let nodeGroup: string | undefined = undefined;
            if (groupingMode === 'file') {
                nodeGroup = n.filePath || 'External_Global';
            } else if (groupingMode === 'type') {
                nodeGroup = n.type;
            }

            if (nodeGroup) {
                const parentId = `parent_${nodeGroup.replace(/[^a-zA-Z0-9_]/g, '_')}`;
                if (!parentIds.has(parentId)) {
                    parentIds.add(parentId);
                    elements.push({
                        group: 'nodes',
                        data: {
                            id: parentId,
                            label: nodeGroup,
                            isParent: true
                        }
                    });
                }
                nodeGroup = parentId;
            }

            const dims = getEstDimensions(n.label, n.type);

            elements.push({
                group: 'nodes',
                data: {
                    id: n.id,
                    label: n.label,
                    type: n.type,
                    filePath: n.filePath,
                    parent: nodeGroup || undefined,
                    estWidth: dims.width,
                    estHeight: dims.height
                }
            });
        });
    }

    // 2. Filter unconnected nodes (Orphans) if requested
    let finalElements = elements;
    if (hideOrphans) {
        const connectedNodeIds = new Set<string>();
        elements.forEach((e: any) => {
            if (e.group === 'edges') {
                connectedNodeIds.add(e.data.source);
                connectedNodeIds.add(e.data.target);
            }
        });
        finalElements = elements.filter((n: any) => {
            if (n.group === 'edges') return true;
            if (n.data.isParent) return true; // Keep compound parents
            return connectedNodeIds.has(n.data.id);
        });
    }

    // 3. Configure layout dynamically
    let layoutConfig: any = { name: 'cose' };

    if (layoutStyle === 'hierarchical_ud') {
        layoutConfig = {
            name: 'dagre',
            nodeSep: 100,
            rankSep: 150,
            rankDir: 'TB',
            animate: true,
            animationDuration: 500
        };
    } else if (layoutStyle === 'hierarchical_lr') {
        layoutConfig = {
            name: 'dagre',
            nodeSep: 100,
            rankSep: 150,
            rankDir: 'LR',
            animate: true,
            animationDuration: 500
        };
    } else if (layoutStyle === 'organic') {
        layoutConfig = {
            name: 'cose-bilkent',
            animate: 'end',
            animationEasing: 'ease-out-quad',
            animationDuration: 1000,
            randomize: true,
            nodeDimensionsIncludeLabels: true, // Factor in text labels during overlap calculations
            nodeRepulsion: 15000,             // Significantly increased repulsion to aggressively push dense clusters apart
            idealEdgeLength: 160,             // Longer edges to allow clusters to breathe
            edgeElasticity: 0.1,              // Softer edges so they can stretch much further
            nestingFactor: 0.05,              // Reduced nesting constraint to let compounds expand
            gravity: 0.05,                    // Greatly reduced gravity (center pull) to let repulsion spread the nodes
            numIter: 5000,                    // More iterations to ensure a settled, overlap-free layout
            tile: true
        };
    } else if (layoutStyle === 'circular') {
        layoutConfig = {
            name: 'circle',
            animate: true,
            animationDuration: 500,
            radius: Math.max(300, finalElements.length * 10)
        };
    } else if (layoutStyle === 'grid') {
        layoutConfig = {
            name: 'grid',
            animate: true,
            animationDuration: 500,
            spacingFactor: 1.5
        };
    }

    const isLarge = finalElements.filter(e => e.group === 'nodes').length > 100;

    cyInstance = cytoscape({
        container: cyContainer,
        elements: finalElements,
        style: cyStyle,
        layout: layoutConfig,
        zoomingEnabled: currentConfig.panningEnabled,
        panningEnabled: currentConfig.panningEnabled,
        boxSelectionEnabled: true,
        autounselectify: false
    });

    if (isLarge && statusLabel) {
        if (!statusLabel.textContent.includes('LOD Optimization Active')) {
            statusLabel.textContent += ' (LOD Optimization Active)';
        }
        statusLabel.style.color = 'var(--vscode-charts-orange)';
    }

    // --- LEVEL OF DETAIL (LOD) OPTIMIZATION ---
    cyInstance.on('zoom', () => {
        const zoom = cyInstance.zoom();
        if (zoom < 0.45) {
            cyInstance.style().selector('node').style({ 'content': '' }).update();
        } else {
            cyInstance.style().selector('node').style({ 'content': 'data(label)' }).update();
        }
    });

    cyInstance.on('dblclick', 'node', function(evt: any) {
        const node = evt.target;
        const data = node.data();

        if (data && data.filePath) {
            vscode.postMessage({ 
                command: 'open', 
                file: data.filePath, 
                line: data.startLine || 0 
            });
        }
    });

    cyInstance.on('mouseover', 'node', function(evt: any) {
        const node = evt.target;
        const data = node.data();
        if (!tooltipElement || !data || data.isParent) return;

        const renderedPos = node.renderedPosition();
        const rect = cyContainer.getBoundingClientRect();
        const nodeTypeLabel = `s:${data.type.charAt(0).toUpperCase() + data.type.slice(1)}`;

        tooltipElement.innerHTML = `
            <div style="font-weight: bold; font-size: 12px; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 4px; margin-bottom: 6px;">
                <span class="codicon codicon-symbol-class" style="color:var(--vscode-charts-purple)"></span> 
                ${data.label}
            </div>
            <div><strong>RDF Class:</strong> <code style="color:var(--vscode-charts-blue);">${nodeTypeLabel}</code></div>
            ${data.filePath ? `<div><strong>s:path:</strong> <code style="font-size:10px;">${data.filePath}</code></div>` : ''}
            <div><strong>s:id:</strong> <code>${data.id}</code></div>
        `;
        tooltipElement.style.display = 'block';
        tooltipElement.style.left = `${rect.left + renderedPos.x + 15}px`;
        tooltipElement.style.top = `${rect.top + renderedPos.y - 15}px`;
    });

    cyInstance.on('mouseout', 'node', function() {
        if (tooltipElement) tooltipElement.style.display = 'none';
    });

    // --- INTERACTIVE SHIFT-CLICK PATHFINDER ---
    cyInstance.on('tap', 'node', function(evt: any) {
        const node = evt.target;
        if (node.data().isParent) return;

        const originalEvent = evt.originalEvent;
        if (originalEvent && originalEvent.shiftKey) {
            evt.preventDefault();
            evt.stopPropagation();

            if (!pathSourceNode) {
                // Set Source Node
                pathSourceNode = node;
                cyInstance.elements().removeClass('dimmed matched path-node path-edge');
                node.addClass('path-node');
                
                statusLabel.textContent = `Path: Source set to ${node.data().label}. Shift-click target node.`;
                statusLabel.style.color = 'var(--vscode-charts-blue)';
                if (clearHighlightsBtn) clearHighlightsBtn.style.display = 'inline-block';
            } else if (!pathTargetNode && node.id() !== pathSourceNode.id()) {
                // Set Target Node and Run Dijkstra / A-Star
                pathTargetNode = node;
                node.addClass('path-node');

                const aStarResult = cyInstance.elements().aStar({
                    root: pathSourceNode,
                    target: pathTargetNode,
                    directed: true
                });

                if (aStarResult.found) {
                    cyInstance.elements().addClass('dimmed');
                    aStarResult.path.removeClass('dimmed');
                    aStarResult.path.nodes().addClass('path-node');
                    aStarResult.path.edges().addClass('path-edge');
                    aStarResult.path.nodes().ancestors().removeClass('dimmed');

                    statusLabel.textContent = `Path Found (Directed): ${aStarResult.distance} steps. Shift-click to reset.`;
                    statusLabel.style.color = 'var(--vscode-charts-green)';
                } else {
                    // Fallback: Undirected path search
                    const undirectedResult = cyInstance.elements().aStar({
                        root: pathSourceNode,
                        target: pathTargetNode,
                        directed: false
                    });

                    if (undirectedResult.found) {
                        cyInstance.elements().addClass('dimmed');
                        undirectedResult.path.removeClass('dimmed');
                        undirectedResult.path.nodes().addClass('path-node');
                        undirectedResult.path.edges().addClass('path-edge');
                        undirectedResult.path.nodes().ancestors().removeClass('dimmed');

                        statusLabel.textContent = `Path Found (Undirected): ${undirectedResult.distance} steps. Shift-click to reset.`;
                        statusLabel.style.color = 'var(--vscode-charts-green)';
                    } else {
                        statusLabel.textContent = `No Path Found between ${pathSourceNode.data().label} and ${node.data().label}.`;
                        statusLabel.style.color = 'var(--vscode-charts-red)';
                        
                        // Reset selection
                        pathSourceNode.removeClass('path-node');
                        node.removeClass('path-node');
                        pathSourceNode = null;
                        pathTargetNode = null;
                    }
                }
            } else {
                // Reset Pathfinder on third click or clicking itself
                cyInstance.elements().removeClass('dimmed matched path-node path-edge');
                pathSourceNode = null;
                pathTargetNode = null;
                statusLabel.textContent = 'Paths reset. Shift-click a node to set path source.';
                statusLabel.style.color = 'inherit';
                if (clearHighlightsBtn) clearHighlightsBtn.style.display = 'none';
            }
        }
    });

    // --- SOVEREIGN RIGHT-CLICK CONTEXT MENU ---
    cyInstance.on('cxttap', 'node', function(evt: any) {
        const node = evt.target;
        if (node.data().isParent) return;

        cyInstance.elements().unselect();
        node.select();

        showContextMenu(evt);
    });

    cyInstance.on('drag zoom tapstart', () => {
        closeContextMenu();
    });
}

// --- CONTEXT MENU DOM & GESTURE DRIVERS ---
let contextMenuElement = document.getElementById('graph-context-menu');
if (!contextMenuElement) {
    contextMenuElement = document.createElement('div');
    contextMenuElement.id = 'graph-context-menu';
    contextMenuElement.style.cssText = `
        position: absolute;
        z-index: 20000;
        background: var(--vscode-menu-background);
        color: var(--vscode-menu-foreground);
        border: 1px solid var(--vscode-menu-border);
        border-radius: 6px;
        box-shadow: 0 10px 25px rgba(0,0,0,0.5);
        display: none;
        padding: 4px 0;
        min-width: 180px;
        font-size: 11px;
        font-family: var(--vscode-font-family);
    `;
    document.body.appendChild(contextMenuElement);
}

function showContextMenu(evt: any) {
    if (!contextMenuElement) return;
    const node = evt.target;
    const data = node.data();
    const renderedPos = node.renderedPosition();
    const rect = cyContainer.getBoundingClientRect();

    contextMenuElement.innerHTML = `
        <div class="context-menu-item" id="ctx-isolate-component" style="padding: 6px 12px; cursor: pointer; display: flex; align-items: center; gap: 8px;">
            <span class="codicon codicon-link"></span> Isolate Connected Component
        </div>
        <div class="context-menu-item" id="ctx-isolate-neighbors" style="padding: 6px 12px; cursor: pointer; display: flex; align-items: center; gap: 8px;">
            <span class="codicon codicon-references"></span> Isolate Direct Neighbors
        </div>
        <div style="height: 1px; background: var(--vscode-widget-border); margin: 4px 0;"></div>
        <div class="context-menu-item" id="ctx-open-file" style="padding: 6px 12px; cursor: pointer; display: flex; align-items: center; gap: 8px;">
            <span class="codicon codicon-go-to-file"></span> Open File/Code
        </div>
    `;

    contextMenuElement.style.display = 'block';
    contextMenuElement.style.left = `${rect.left + renderedPos.x + 5}px`;
    contextMenuElement.style.top = `${rect.top + renderedPos.y - 5}px`;

    // Bind Event Listeners
    const isolateComp = document.getElementById('ctx-isolate-component');
    if (isolateComp) {
        isolateComp.onclick = (e) => {
            e.stopPropagation();
            isolateConnectedComponent(node);
            closeContextMenu();
        };
    }

    const isolateNeigh = document.getElementById('ctx-isolate-neighbors');
    if (isolateNeigh) {
        isolateNeigh.onclick = (e) => {
            e.stopPropagation();
            isolateDirectNeighbors(node);
            closeContextMenu();
        };
    }

    const openFile = document.getElementById('ctx-open-file');
    if (openFile) {
        openFile.onclick = (e) => {
            e.stopPropagation();
            if (data.filePath) {
                vscode.postMessage({ 
                    command: 'open', 
                    file: data.filePath, 
                    line: data.startLine || 0 
                });
            }
            closeContextMenu();
        };
    }
}

function closeContextMenu() {
    if (contextMenuElement) {
        contextMenuElement.style.display = 'none';
    }
}

window.addEventListener('click', closeContextMenu);

// --- SUBGRAPH ISOLATION DRIVERS ---
function isolateConnectedComponent(node: any) {
    if (!cyInstance || !node) return;
    cyInstance.elements().removeClass('dimmed matched path-node path-edge');

    const bfs = cyInstance.elements().bfs({
        root: node,
        directed: false,
        visit: () => {}
    });
    const component = bfs.path;

    cyInstance.elements().addClass('dimmed');
    component.removeClass('dimmed');
    component.nodes().ancestors().removeClass('dimmed');

    statusLabel.textContent = `Isolated connected component for ${node.data().label} (${component.nodes().length} nodes)`;
    statusLabel.style.color = 'var(--vscode-charts-green)';
    if (clearHighlightsBtn) clearHighlightsBtn.style.display = 'inline-block';
}

function isolateDirectNeighbors(node: any) {
    if (!cyInstance || !node) return;
    cyInstance.elements().removeClass('dimmed matched path-node path-edge');

    const neighborhood = node.closedNeighborhood();

    cyInstance.elements().addClass('dimmed');
    neighborhood.removeClass('dimmed');
    neighborhood.nodes().ancestors().removeClass('dimmed');

    statusLabel.textContent = `Isolated direct neighbors of ${node.data().label} (${neighborhood.nodes().length - 1} neighbors)`;
    statusLabel.style.color = 'var(--vscode-charts-green)';
    if (clearHighlightsBtn) clearHighlightsBtn.style.display = 'inline-block';
}
async function exportVisualGraph(format: 'png' | 'svg', viewType: string) {
    if (viewType === 'class_diagram' || viewType === 'function_signatures') {
        const svgElement = mermaidContainer.querySelector('svg');
        if (!svgElement) {
            vscode.postMessage({ command: 'showError', message: 'No diagram to export.' });
            return;
        }

        if (format === 'svg') {
            const svgData = getSvgData(svgElement);
            vscode.postMessage({ command: 'saveContent', name: `${viewType}.svg`, content: svgData, format: 'svg' });
        } else {
            const svgData = getSvgData(svgElement);
            const img = new Image();
            const scale = 3;
            
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const rect = svgElement.getBoundingClientRect();
                const width = rect.width;
                const height = rect.height;

                canvas.width = width * scale;
                canvas.height = height * scale;
                
                const ctx = canvas.getContext('2d');
                if (ctx) {
                    ctx.fillStyle = '#1e1e1e';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    
                    ctx.scale(scale, scale);
                    ctx.drawImage(img, 0, 0);
                    
                    const pngData = canvas.toDataURL('image/png');
                    vscode.postMessage({ command: 'saveContent', name: `${viewType}.png`, content: pngData, format: 'png' });
                }
            };
            img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
        }
    } else {
        if (!cyInstance) return;

        if (format === 'svg') {
            vscode.postMessage({ command: 'showError', message: 'Vector (SVG) export not supported for network view. Use PNG instead.' });
        } else {
            const pngContent = cyInstance.png({ bg: '#1e1e1e', full: true });
            vscode.postMessage({ command: 'saveContent', name: `${viewType}.png`, content: pngContent, format: 'png' });
        }
    }
}

function getSvgData(svg: SVGSVGElement): string {
    const serializer = new XMLSerializer();
    let source = serializer.serializeToString(svg);
    if(!source.match(/^<svg[^>]+xmlns="http\:\/\/www\.w3\.org\/2000\/svg"/)){
        source = source.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    if(!source.match(/^<svg[^>]+xmlns:xlink/)){
        source = source.replace(/^<svg/, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
    }
    return '<?xml version="1.0" standalone="no"?>\r\n' + source;
}

function preprocessMermaid(code: string): string {
    if (code.includes('classDiagram')) {
        return code;
    }
    return code.split('\n').map(line => {
        const trimmed = line.trim();
        if (trimmed.match(/^(subgraph|end|class|state|note|participant|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|gitGraph|flowchart|graph)/i)) {
            return line;
        }

        return line.replace(/([a-zA-Z0-9_-]+)\s*([\[\(\{]{1,2})\s*([^"'\n\r\t]+?)\s*([\]\)\}]{1,2})/g, (match, id, open, label, close) => {
            const safeLabel = label.replace(/"/g, "'");
            return `${id}${open}"${safeLabel.trim()}"${close}`;
        });
    }).join('\n');
}

function enablePanZoom(container: HTMLElement) {
    let zoomScale = 1;
    let panX = 0;
    let panY = 0;
    let isDragging = false;
    let startX = 0;
    let startY = 0;

    const svg = container.querySelector('svg') as unknown as SVGSVGElement;
    if (!svg) return { fitToScreen: () => {} };

    container.style.overflow = 'hidden';
    container.style.cursor = 'grab';
    container.style.border = '1px solid var(--vscode-widget-border)';
    container.style.borderRadius = '4px';
    container.style.background = 'var(--vscode-editor-background)';
    container.style.minHeight = '400px'; 
    container.style.position = 'relative';

    svg.style.transformOrigin = '0 0';
    svg.style.transition = 'transform 0.1s ease-out';
    svg.style.width = '100%'; 
    svg.style.height = '100%';
    
    svg.style.display = 'block';

    const updateTransform = () => {
        svg.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomScale})`;
    };

    container.addEventListener('wheel', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        zoomScale *= delta;
        updateTransform();
    }, { passive: false });

    container.addEventListener('mousedown', (e) => {
        isDragging = true;
        startX = e.clientX - panX;
        startY = e.clientY - panY;
        container.style.cursor = 'grabbing';
        svg.style.transition = 'none';
    });

    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        e.preventDefault();
        panX = e.clientX - startX;
        panY = e.clientY - startY;
        updateTransform();
    });

    const stopDrag = () => {
        if(isDragging) {
            isDragging = false;
            container.style.cursor = 'grab';
            svg.style.transition = 'transform 0.1s ease-out';
        }
    };

    window.addEventListener('mouseup', stopDrag);

    const fitToScreen = () => {
        const containerRect = container.getBoundingClientRect();
        const svgRect = svg.getBoundingClientRect();
        if (svgRect.width === 0 || svgRect.height === 0) return;
        const scaleX = containerRect.width / svgRect.width;
        const scaleY = containerRect.height / svgRect.height;
        zoomScale = Math.min(scaleX, scaleY, 1) * 0.95;
        panX = (containerRect.width - svgRect.width * zoomScale) / 2;
        panY = (containerRect.height - svgRect.height * zoomScale) / 2;
        updateTransform();
    };

    return { fitToScreen };
}
