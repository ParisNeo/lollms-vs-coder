import { Network, DataSet } from 'vis-network/standalone';
import mermaid from 'mermaid';

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
const runBtn = document.getElementById('run') as HTMLButtonElement;
const aiTranslateBtn = document.getElementById('ai-translate-btn') as HTMLButtonElement;
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
let currentModuleDependencyGraph: string = '';
let currentExternalLibraryGraph: string = '';
let networkInstance: Network | null = null;
let currentConfig = { zoomSensitivity: 0.5, panningEnabled: true, zoomToCursor: true };

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
        if (aiTranslateBtn) {
            aiTranslateBtn.disabled = false;
            aiTranslateBtn.innerHTML = '<span class="codicon codicon-sparkle"></span> Translate';
        }
        if (message.error) {
            statusLabel.textContent = `AI Error: ${message.error}`;
            statusLabel.style.color = 'var(--vscode-errorForeground)';
        } else if (message.query) {
            symbolSearch.value = message.query;
            statusLabel.textContent = "AI translated query successfully!";
            statusLabel.style.color = 'var(--vscode-charts-green)';
            executeSparqlQuery(message.query);
        }
    }
});

if (runBtn) {
    runBtn.addEventListener('click', () => {
        const query = symbolSearch.value.trim();
        if (!query) return;

        if (query.toUpperCase().startsWith('SELECT')) {
            executeSparqlQuery(query);
        } else {
            vscode.postMessage({ command: 'runSymbol', symbol: query });
        }
    });
}

if (aiTranslateBtn) {
    aiTranslateBtn.addEventListener('click', () => {
        const query = symbolSearch.value.trim();
        if (!query) return;

        aiTranslateBtn.disabled = true;
        aiTranslateBtn.innerHTML = '<div class="spinner" style="width:12px; height:12px; border-width:2px;"></div> Translating...';
        vscode.postMessage({ command: 'translateNLQuery', text: query });
    });
}

if (symbolSearch) {
    symbolSearch.addEventListener('input', () => {
        const query = symbolSearch.value.trim().toLowerCase();
        if (!query || !networkInstance || !currentGraphData) {
            if (networkInstance) networkInstance.selectNodes([]);
            return;
        }

        if (query.toUpperCase().startsWith('SELECT')) return; // Ignore SPARQL on input

        const matchedNodes = currentGraphData.nodes.filter((n: any) => 
            n.label.toLowerCase().includes(query) || n.id.toLowerCase().includes(query)
        );

        if (matchedNodes.length > 0) {
            const ids = matchedNodes.map((n: any) => n.id);
            networkInstance.selectNodes(ids);
            
            const exactMatch = matchedNodes.find((n: any) => n.label.toLowerCase() === query);
            const nodeToFocus = exactMatch || matchedNodes[0];
            
            networkInstance.focus(nodeToFocus.id, {
                scale: 1.1,
                animation: {
                    duration: 400,
                    easingFunction: 'easeInOutQuad'
                }
            });
        }
    });
}

if (exampleSelect) {
    exampleSelect.addEventListener('change', () => {
        if (exampleSelect.value) {
            symbolSearch.value = exampleSelect.value;
            exampleSelect.value = "";
            executeSparqlQuery(symbolSearch.value);
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
    if (!networkInstance || !currentGraphData) return;

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

    networkInstance.selectNodes(Array.from(matchedNodeIds));

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
    } else if (networkInstance) {
        const nodes = currentGraphData.nodes;
        const targetNode = nodes.find((n: any) => n.label === label || n.id === label);
        if (targetNode) {
            networkInstance.selectNodes([targetNode.id]);
            networkInstance.focus(targetNode.id, {
                scale: 1.2,
                animation: {
                    duration: 800,
                    easingFunction: 'easeInOutQuad'
                }
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

    if (view === 'class_diagram' || view === 'function_signatures' || view === 'module_dependency_graph' || view === 'external_library_graph') {
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

function renderCytoscapeView(viewType: string) {
    if (mermaidContainer) mermaidContainer.style.display = 'none';
    if (cyContainer) cyContainer.style.display = 'block';

    if (!currentGraphData) return;

    const visNodes: any[] = [];
    const visEdges: any[] = [];

    const hideOrphans = hideOrphansCheckbox ? hideOrphansCheckbox.checked : false;
    const groupingMode = groupingModeSelect ? groupingModeSelect.value : 'none';
    const layoutStyle = layoutStyleSelect ? layoutStyleSelect.value : 'organic';

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
                        shape: 'box',
                        color: { background: '#1572b6', border: '#ffffff' }
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
                            visEdges.push({
                                id: edgeId,
                                from: `folder_${srcFolder}`,
                                to: `folder_${trgFolder}`,
                                arrows: 'to',
                                color: { color: '#888888', highlight: '#ff9d00' }
                            });
                        }
                    }
                }
            }
        });

        folderNodesMap.forEach(node => {
            visNodes.push({
                ...node,
                font: { color: '#ffffff', face: 'monospace', size: 12 },
                customData: { type: 'folder', label: node.label }
            });
        });

    } else if (viewType === 'external_library_graph') {
        const libraryNodes = currentGraphData.nodes.filter((n: any) => n.type === 'library');
        const importedFileIds = new Set<string>();

        currentGraphData.edges.forEach((e: any) => {
            const trg = currentGraphData.nodes.find((n: any) => n.id === e.target);
            if (trg && trg.type === 'library') {
                importedFileIds.add(e.source);
                visEdges.push({
                    id: e.id,
                    from: e.source,
                    to: e.target,
                    label: 'imports',
                    arrows: 'to',
                    color: { color: '#d19a66', highlight: '#ff9d00' }
                });
            }
        });

        currentGraphData.nodes.forEach((n: any) => {
            if (n.type === 'library' || importedFileIds.has(n.id)) {
                let shape = n.type === 'library' ? 'hexagon' : 'box';
                let color = n.type === 'library' ? '#d19a66' : '#569cd6';

                visNodes.push({
                    id: n.id,
                    label: n.label,
                    shape: shape,
                    color: {
                        background: color,
                        border: '#ffffff'
                    },
                    font: { color: '#ffffff', face: 'monospace', size: 12 },
                    customData: n
                });
            }
        });

    } else if (viewType === 'hotspot_complexity_graph') {
        const fileNodes = currentGraphData.nodes.filter((n: any) => n.type === 'file');
        
        fileNodes.forEach((n: any) => {
            const lines = n.linesCount || 50; 
            const nodeSize = Math.max(15, Math.min(60, 15 + (lines / 10)));
            
            let color = '#569cd6'; 
            if (lines > 1000) color = '#e74c3c'; 
            else if (lines > 300) color = '#e67e22'; 

            visNodes.push({
                id: n.id,
                label: `${n.label}\n(${lines} LOC)`,
                shape: 'box',
                size: nodeSize,
                color: {
                    background: color,
                    border: '#ffffff'
                },
                font: { color: '#ffffff', face: 'monospace', size: 12, multi: 'html' },
                customData: n
            });
        });

        currentGraphData.edges.forEach((e: any) => {
            if (e.label === 'imports') {
                const src = fileNodes.find((n: any) => n.id === e.source);
                const trg = fileNodes.find((n: any) => n.id === e.target);
                if (src && trg) {
                    visEdges.push({
                        id: e.id,
                        from: e.source,
                        to: e.target,
                        arrows: 'to',
                        color: { color: '#888888', highlight: '#ff9d00' }
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
                visEdges.push({
                    id: e.id,
                    from: e.source,
                    to: e.target,
                    label: e.label,
                    arrows: 'to',
                    color: { color: '#888888', highlight: '#ff9d00' },
                    font: { color: '#888888', size: 10, align: 'top' }
                });
            }
        });

        currentGraphData.nodes.forEach((n: any) => {
            let shape = 'ellipse';
            let color = '#3c3c3c'; 

            if (n.type === 'file') {
                shape = 'box';
                color = '#569cd6';
            } else if (n.type === 'class') {
                shape = 'database';
                color = '#4ec9b0';
            } else if (n.type === 'function') {
                shape = 'ellipse';
                color = '#dcdcaa';
            } else if (n.type === 'library') {
                shape = 'hexagon';
                color = '#d19a66';
            }

            let nodeGroup: string | undefined = undefined;
            if (groupingMode === 'file') {
                nodeGroup = n.filePath || 'External / Global';
            } else if (groupingMode === 'type') {
                nodeGroup = n.type;
            }

            visNodes.push({
                id: n.id,
                label: n.label,
                shape: shape,
                group: nodeGroup,
                color: nodeGroup ? undefined : {
                    background: color,
                    border: '#ffffff',
                    highlight: {
                        background: '#ff9d00',
                        border: '#ffffff'
                    }
                },
                font: { color: '#ffffff', face: 'monospace', size: 12 },
                title: `Type: s:${n.type.charAt(0).toUpperCase() + n.type.slice(1)}\nPath: ${n.filePath || ''}\nID: ${n.id}`,
                customData: n
            });
        });
    }

    // 2. Filter unconnected nodes (Orphans) if requested
    let finalVisNodes = visNodes;
    if (hideOrphans) {
        const connectedNodeIds = new Set<string>();
        visEdges.forEach((e: any) => {
            connectedNodeIds.add(e.from);
            connectedNodeIds.add(e.to);
        });
        finalVisNodes = visNodes.filter((n: any) => connectedNodeIds.has(n.id));
    }

    // 3. Configure layout and physics dynamically
    let layoutOptions: any = { improvedLayout: true };
    let physicsOptions: any = { enabled: true };

    if (layoutStyle === 'hierarchical_ud' || layoutStyle === 'hierarchical_lr') {
        const dir = layoutStyle === 'hierarchical_ud' ? 'UD' : 'LR';
        layoutOptions = {
            hierarchical: {
                enabled: true,
                direction: dir,
                sortMethod: 'hubsize',
                nodeSpacing: 150,
                treeSpacing: 250,
                blockShifting: true,
                edgeMinimization: true,
                parentCentralization: true
            }
        };
        physicsOptions = { enabled: false };
    } else if (layoutStyle === 'organic') {
        layoutOptions = { hierarchical: { Directory: false } };
        physicsOptions = {
            enabled: true,
            solver: 'barnesHut',
            barnesHut: {
                theta: 0.5,
                gravitationalConstant: -2000,
                centralGravity: 0.3,
                springLength: 95,
                springConstant: 0.04,
                damping: 0.09,
                avoidOverlap: 1
            },
            stabilization: {
                enabled: true,
                iterations: 1000,
                updateInterval: 100,
                onlyDynamicEdges: false,
                fit: true
            }
        };
    } else if (layoutStyle === 'circular') {
        layoutOptions = { hierarchical: { enabled: false } };
        physicsOptions = { enabled: false };
        
        const radius = Math.max(200, finalVisNodes.length * 15);
        finalVisNodes.forEach((n: any, idx: number) => {
            const angle = (idx / finalVisNodes.length) * 2 * Math.PI;
            n.x = radius * Math.cos(angle);
            n.y = radius * Math.sin(angle);
        });
    } else if (layoutStyle === 'grid') {
        layoutOptions = { hierarchical: { enabled: false } };
        physicsOptions = { enabled: false };
        
        const cols = Math.ceil(Math.sqrt(finalVisNodes.length));
        const spacing = 180;
        finalVisNodes.forEach((n: any, idx: number) => {
            const col = idx % cols;
            const row = Math.floor(idx / cols);
            n.x = col * spacing;
            n.y = row * spacing;
        });
    }

    const isLarge = finalVisNodes.length > 100;

    const data = {
        nodes: new DataSet(finalVisNodes),
        edges: new DataSet(visEdges)
    };

    const options = {
        physics: physicsOptions,
        interaction: {
            hover: true,
            zoomView: currentConfig.panningEnabled,
            dragView: currentConfig.panningEnabled
        },
        layout: layoutOptions
    };

    networkInstance = new Network(cyContainer, data, options);

    if (isLarge && statusLabel) {
        statusLabel.textContent += ' (Performance Mode Active)';
        statusLabel.style.color = 'var(--vscode-charts-orange)';
    }

    networkInstance.on('doubleClick', function(properties) {
        if (!properties.nodes || properties.nodes.length === 0) return;
        const nodeId = properties.nodes[0];
        const matchedNode = visNodes.find(n => n.id === nodeId);
        const data = matchedNode?.customData;

        if (data && data.filePath) {
            vscode.postMessage({ 
                command: 'open', 
                file: data.filePath, 
                line: data.line || 0 
            });
        }
    });

    networkInstance.on('hoverNode', function(properties) {
        const nodeId = properties.node;
        const matchedNode = visNodes.find(n => n.id === nodeId);
        const data = matchedNode?.customData;
        if (!tooltipElement || !data) return;

        const screenPos = networkInstance.canvasToDOM(networkInstance.getPositions([nodeId])[nodeId]);
        const rect = cyContainer.getBoundingClientRect();
        const nodeTypeLabel = `s:${data.type.charAt(0).toUpperCase() + data.type.slice(1)}`;

        tooltipElement.innerHTML = `
            <div style="font-weight: bold; font-size: 12px; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 4px; margin-bottom: 6px;">
                <span class="codicon codicon-symbol-class" style="color:var(--vscode-charts-purple)"></span> 
                ${data.label}
            </div>
            <div><strong>RDF Class:</strong> <code style="color:var(--vscode-charts-blue);">${nodeTypeLabel}</code></div>
            ${data.filePath ? `<div><strong>s:path:</strong> <code style="font-size:10px;">${data.filePath}</code></div>` : ''}
            <div><strong>s:id:</strong> <code>${nodeId}</code></div>
        `;
        tooltipElement.style.display = 'block';
        tooltipElement.style.left = `${rect.left + screenPos.x + 15}px`;
        tooltipElement.style.top = `${rect.top + screenPos.y - 15}px`;
    });

    networkInstance.on('blurNode', function() {
        if (tooltipElement) tooltipElement.style.display = 'none';
    });
}

async function exportVisualGraph(format: 'png' | 'svg', viewType: string) {
    if (viewType === 'class_diagram' || viewType === 'function_signatures' || viewType === 'module_dependency_graph' || viewType === 'external_library_graph') {
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
        if (!networkInstance) return;

        if (format === 'svg') {
            vscode.postMessage({ command: 'showError', message: 'Vector (SVG) export not supported for network view. Use PNG instead.' });
        } else {
            const canvas = cyContainer.querySelector('canvas');
            if (canvas) {
                const pngContent = canvas.toDataURL('image/png');
                vscode.postMessage({ command: 'saveContent', name: `${viewType}.png`, content: pngContent, format: 'png' });
            }
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
