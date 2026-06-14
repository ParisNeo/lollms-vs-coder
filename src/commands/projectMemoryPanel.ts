import * as vscode from 'vscode';
import { ProjectMemoryManager, MemoryEntry } from '../projectMemoryManager';

export class ProjectMemoryPanel {
    public static currentPanel: ProjectMemoryPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri, manager: ProjectMemoryManager) {
        if (ProjectMemoryPanel.currentPanel) {
            ProjectMemoryPanel.currentPanel._panel.reveal(vscode.ViewColumn.Active);
            return;
        }

        // Force open in the Active Column to occupy the entire editor area without splitting
        const panel = vscode.window.createWebviewPanel(
            'projectMemoryManager',
            '🧠 Project Memory Manager',
            vscode.ViewColumn.Active,
            { 
                enableScripts: true, 
                retainContextWhenHidden: true 
            }
        );

        ProjectMemoryPanel.currentPanel = new ProjectMemoryPanel(panel, extensionUri, manager);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, private manager: ProjectMemoryManager) {
        this._panel = panel;
        this._extensionUri = extensionUri; // Assigned immediately to prevent race conditions during _update()
        this._update();

        this.manager.onDidChange(() => this._update(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(async (msg) => {
            try {
                switch (msg.command) {
                    case 'save':
                        await this.manager.updateMemory('update', msg.id, msg.title, msg.content, undefined, msg.importance, msg.predicates);
                        vscode.window.showInformationMessage(`Lollms: Memory "${msg.title}" updated.`);
                        break;
                    case 'delete':
                        await this.manager.updateMemory('delete', msg.id);
                        break;
                    case 'add_direct':
                        await this.manager.updateMemory('add', msg.id, msg.title, msg.content, "general", msg.importance);
                        vscode.window.showInformationMessage(`Lollms: New memory "${msg.title}" created.`);
                        break;
                    case 'force_dream':
                        await this.manager.performDreamCycle((event) => {
                            this._panel.webview.postMessage({ command: 'dream_event', event });
                        });
                        this._update();
                        break;
                    }
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to manage memory: ${e.message}`);
            }
        }, null, this._disposables);

        this._panel.onDidDispose(() => {
            ProjectMemoryPanel.currentPanel = undefined;
            this._disposables.forEach(d => d.dispose());
        }, null, this._disposables);
    }

    private async _update() {
        const { ChatPanel } = require('./chatPanel/chatPanel');
        const activeChat = ChatPanel.currentPanel;

        const memories = await this.manager.getMemories();
        this._panel.webview.html = this._getHtml(this._panel.webview, memories, false);
    }

    private _getHtml(webview: vscode.Webview, memories: any[], isLoading: boolean = false) {
        const escape = (str: string) => (str || '').replace(/[&<>"']/g, (m) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[m] || m));

        const T1_THRESHOLD = 25;
        const workingMemory = memories.filter(m => (m.importance || 0) >= T1_THRESHOLD);
        const deepMemory = memories.filter(m => (m.importance || 0) < T1_THRESHOLD);

        // Declare the helper at the very top of the method so it is in-scope for all mappings
        const renderMemoryCard = (m: any) => {
            const predicateRows = (m.predicates || []).map((p: any, idx: number) => {
                const targetNode = memories.find(x => x.id === p.targetId);
                const isCustomTag = p.verb === 'has_tag' && !targetNode;

                return `
                <div class="predicate-row" style="display:flex; flex-direction:column; gap:4px; margin-bottom:8px; border-bottom:1px solid rgba(255,255,255,0.05); padding-bottom:6px;">
                    <div style="display:flex; gap:6px;">
                        <input type="text" class="pred-verb" value="${escape(p.verb)}" placeholder="verb" style="flex:1;">
                        <select class="pred-target-select" onchange="toggleTargetInput(this)" style="flex:1;">
                            <option value="__custom__" ${isCustomTag ? 'selected' : ''}>✍️ Custom Tag/ID...</option>
                            ${memories.filter(x => x.id !== m.id).map(x => `<option value="${x.id}" ${x.id === p.targetId ? 'selected' : ''}>${escape(x.title)}</option>`).join('')}
                        </select>
                        <button class="icon-btn remove-btn remove-pred-btn" style="padding:2px 6px;"><i class="codicon codicon-trash"></i></button>
                    </div>
                    <input type="text" class="pred-target-custom" value="${escape(p.targetId)}" placeholder="Enter custom #tag or ID..." style="margin-top:2px; display:${isCustomTag ? 'block' : 'none'};" />
                </div>`;
            }).join('');

            return `
            <div class="memory-card" data-id="${m.id}" style="border-left: 5px solid ${m.importance >= T1_THRESHOLD ? 'var(--vscode-charts-blue)' : 'var(--vscode-descriptionForeground)'}">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                    <span class="badge" style="background: var(--vscode-badge-background); font-size:9px; border-radius:4px; padding:2px 6px;">${m.category || 'general'}</span>
                    <span style="font-size:10px; opacity:0.6; font-weight:bold;">Importance: ${Math.round(m.importance)}%</span>
                </div>
                
                <div class="form-group">
                    <label>Identifier (ID: <code>${m.id}</code>)</label>
                    <input type="text" class="title-input" value="${escape(m.title)}">
                </div>
                
                <div class="form-group">
                    <label>Context Body</label>
                    <textarea class="content-input" rows="3">${escape(m.content)}</textarea>
                </div>

                <div class="form-group">
                    <label>Graph Relationships (Predicates)</label>
                    <div class="predicates-list" style="margin-top:4px;">
                        ${predicateRows}
                    </div>
                    <button class="secondary-button add-pred-btn" style="margin-top:6px; padding:2px 8px; font-size:10px;"><i class="codicon codicon-add"></i> Add Relationship</button>
                </div>
                
                <div style="margin: 10px 0;">
                    <div style="display:flex; justify-content: space-between;">
                        <label style="margin:0; font-size:10px;">Retentiveness Weight</label>
                        <span class="weight-val" style="font-size: 11px; opacity: 0.8; font-family:monospace;">${Math.round(m.importance)}</span>
                    </div>
                    <input type="range" class="importance-input" min="0" max="100" step="1" value="${m.importance}" style="width:100%;" oninput="this.previousElementSibling.querySelector('.weight-val').textContent = this.value">
                </div>

                <div class="actions">
                    <button class="delete-btn" data-id="${m.id}" title="Delete fact permanently"><i class="codicon codicon-trash"></i></button>
                    <div style="flex:1"></div>
                    ${m.importance >= T1_THRESHOLD 
                        ? `<button class="secondary move-deep-btn" data-id="${m.id}" title="Archive to Deep Memory (Stops auto-injection)"><i class="codicon codicon-archive"></i> Archive</button>`
                        : `<button class="secondary move-live-btn" data-id="${m.id}" title="Bring to Live Context (Always in prompt)"><i class="codicon codicon-zap"></i> Make Live</button>`
                    }
                    <button class="save-btn" data-id="${m.id}" title="Commit changes"><i class="codicon codicon-save"></i> Save</button>
                </div>
            </div>`;
        };

        // Serialize Cytoscape data safely for injection
        const nodes: any[] = [];
        const edges: any[] = [];

        memories.forEach(m => {
            nodes.push({
                data: {
                    id: m.id,
                    label: m.title,
                    importance: m.importance,
                    category: m.category || 'general'
                }
            });

            if (m.predicates && Array.isArray(m.predicates)) {
                m.predicates.forEach((p: any) => {
                    edges.push({
                        data: {
                            id: `${m.id}-${p.verb}-${p.targetId}`,
                            source: m.id,
                            target: p.targetId,
                            label: p.verb
                        }
                    });
                });
            }
        });

        // Use the constructor-assigned property
        const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'));

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <!-- Bulletproof CSP: Allow cdnjs, unpkg, and cdn.jsdelivr.net specifically to guarantee loading -->
            <meta http-equiv="Content-Security-Policy" content="
                default-src 'self' ${webview.cspSource} https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com;
                style-src 'unsafe-inline' ${webview.cspSource} https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com;
                script-src 'unsafe-inline' 'unsafe-eval' ${webview.cspSource} https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com;
                img-src 'self' data: ${webview.cspSource} https:;
                font-src 'self' ${webview.cspSource} https://cdn.jsdelivr.net;
                connect-src 'self' https:;
            ">
            <link href="https://cdn.jsdelivr.net/npm/@vscode/codicons/dist/codicon.css" rel="stylesheet" />
            
            <!-- Bulletproof Failover Script Loader for Cytoscape -->
            <script src="https://cdn.jsdelivr.net/npm/cytoscape@3.28.1/dist/cytoscape.min.js"></script>
            <script>
                if (typeof cytoscape === 'undefined') {
                    document.write('<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.28.1/cytoscape.min.js"><\\/script>');
                }
            </script>
            <script>
                if (typeof cytoscape === 'undefined') {
                    document.write('<script src="https://unpkg.com/cytoscape@3.28.1/dist/cytoscape.min.js"><\\/script>');
                }
            </script>
            <style>
                :root {
                    --card-bg: var(--vscode-editorWidget-background);
                    --input-bg: var(--vscode-input-background);
                    --border: var(--vscode-widget-border);
                    --dream-color: #9b59b6;
                    --accent: var(--vscode-textLink-foreground);
                }
                body, html { height: 100vh; width: 100vw; margin: 0; padding: 0; font-family: var(--vscode-font-family); background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); overflow: hidden; }

                /* 🌟 FULL SCREEN GRAPH WITH FLOATING CONTROL OVERLAY */
                .workspace-layout { position: relative; width: 100%; height: 100%; }
                #cy-canvas { width: 100%; height: 100%; background: var(--vscode-editor-background); z-index: 1; }

                /* 🧬 FLOATING MEMORY PANEL */
                .cards-pane { 
                    position: absolute;
                    top: 15px;
                    left: 15px;
                    bottom: 15px;
                    width: 420px;
                    background: rgba(30, 30, 30, 0.85); /* Semi-transparent glassy look */
                    backdrop-filter: blur(12px);
                    -webkit-backdrop-filter: blur(12px);
                    border: 1px solid var(--border);
                    border-radius: 12px;
                    display: flex;
                    flex-direction: column;
                    padding: 20px;
                    box-sizing: border-box;
                    z-index: 100; /* Stays above graph canvas */
                    box-shadow: 0 10px 30px rgba(0,0,0,0.5);
                    transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.3s;
                }

                .cards-pane.collapsed {
                    transform: translateX(-450px);
                    opacity: 0;
                }

                /* 🛠️ CONTROLS BAR ABOVE GRAPH */
                .graph-controls {
                    position: absolute;
                    top: 15px;
                    right: 15px;
                    z-index: 101;
                    display: flex;
                    gap: 8px;
                }

                /* 🌪️ THE NEURAL ARENA (DREAM OVERLAY) */
                #dream-overlay {
                    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                    background: rgba(0, 0, 0, 0.85);
                    backdrop-filter: blur(8px);
                    z-index: 10000;
                    display: none;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    color: white;
                    text-align: center;
                }

                .dream-brain {
                    width: 150px; height: 150px;
                    background: radial-gradient(circle, var(--dream-color) 0%, transparent 70%);
                    border-radius: 50%;
                    filter: blur(15px);
                    animation: brain-throb 2.5s infinite ease-in-out;
                    margin-bottom: 25px;
                    display: flex; align-items: center; justify-content: center;
                }

                @keyframes brain-throb {
                    0%, 100% { transform: scale(1); opacity: 0.5; }
                    50% { transform: scale(1.2) rotate(15deg); opacity: 0.8; }
                }

                .dream-log {
                    max-width: 400px;
                    height: 100px;
                    overflow: hidden;
                    font-family: 'Courier New', monospace;
                    font-size: 11px;
                    opacity: 0.8;
                    text-align: left;
                    margin-top: 15px;
                    border: 1px solid #444;
                    background: #111;
                    padding: 8px;
                    border-radius: 4px;
                }

                .header-sticky { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-shrink: 0; }
                h2 { margin: 0; font-size: 16px; font-weight: 500; display: flex; align-items: center; gap: 8px; }
                h3 { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.5; margin: 25px 0 10px 0; border-bottom: 1px dashed var(--border); padding-bottom: 4px; }

                .scrollable-cards-area { flex: 1; overflow-y: auto; padding-right: 4px; }
                .scrollable-cards-area::-webkit-scrollbar { width: 4px; }
                .scrollable-cards-area::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 2px; }

                .memory-card { background: var(--card-bg); border: 1px solid var(--border); padding: 14px; border-radius: 6px; margin-bottom: 12px; box-shadow: 0 4px 10px rgba(0,0,0,0.2); }
                .memory-card:hover { border-color: var(--vscode-focusBorder); }
                .memory-card.highlighted { border-color: var(--dream-color) !important; box-shadow: 0 0 15px rgba(155, 89, 182, 0.4) !important; }
                
                .new-card { border: 2px dashed var(--vscode-focusBorder); display: none; margin-bottom: 20px; background: rgba(0, 122, 204, 0.05); }
                
                .form-group { margin-bottom: 10px; }
                label { display: block; font-size: 9px; font-weight: 700; opacity: 0.6; margin-bottom: 4px; text-transform: uppercase; }
                input, textarea, select { width: 100%; background: var(--input-bg); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 6px 10px; border-radius: 4px; font-family: inherit; box-sizing: border-box; font-size: 12px; }
                input:focus, textarea:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); border-color: transparent; }
                
                .actions { display: flex; gap: 6px; margin-top: 12px; }
                button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; cursor: pointer; border-radius: 4px; font-size: 11px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
                button:hover { filter: brightness(1.2); }
                button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
                button.danger { background: transparent; border: 1px solid var(--vscode-errorForeground); color: var(--vscode-errorForeground); padding: 4px 8px; }
                button.danger:hover { background: var(--vscode-errorForeground); color: white; }
                .scope-badge { font-size: 9px; padding: 2px 6px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); text-transform: uppercase; font-weight: bold; }
            </style>
        </head>
        <body>
            <div class="workspace-layout">
                <!-- OVERLAPPING CONTROLS -->
                <div class="graph-controls">
                    <button class="secondary" onclick="toggleSidebar()" title="Toggle Sidebar"><i class="codicon codicon-layout-sidebar-left"></i> Toggle Panel</button>
                    <button class="secondary" onclick="fitGraph()"><i class="codicon codicon-screen-full"></i> Fit View</button>
                </div>

                <!-- FULL SCREEN GRAPH -->
                <div id="cy-canvas"></div>

                <!-- FLOATING PANEL -->
                <div class="cards-pane" id="sidebar-panel">
                    <div class="header-sticky">
                        <h2><i class="codicon codicon-chip"></i> Memory Vault</h2>
                        <div style="display:flex; gap:6px;">
                            <button id="dream-btn" class="secondary" title="Reorganize and consolidate memories now."><i class="codicon codicon-cloud"></i> Dream</button>
                            <button id="show-add-btn"><i class="codicon codicon-add"></i> Add</button>
                        </div>
                    </div>

                    <div class="scrollable-cards-area">
                        <div id="new-memory-form" class="memory-card new-card">
                            <label>Identifier (e.g. <code>api_rule</code>)</label>
                            <input type="text" id="new-id" placeholder="e.g. api_security_rule">
                            <label style="margin-top:10px;">Title / Label</label>
                            <input type="text" id="new-title" placeholder="e.g. Secure API Handshake">
                            <label style="margin-top:10px;">Context Content</label>
                            <textarea id="new-content" rows="4" placeholder="Sovereign facts for the AI to possess..."></textarea>

                            <div style="margin: 15px 0;">
                                <div style="display:flex; justify-content: space-between;">
                                    <label style="margin:0;">Initial Retentiveness</label>
                                    <span id="new-weight-val" style="font-size: 11px; opacity: 0.8; font-family:monospace;">80</span>
                                </div>
                                <input type="range" id="new-importance" min="0" max="100" step="1" value="80" style="width:100%;" oninput="document.getElementById('new-weight-val').textContent = this.value">
                            </div>

                            <div class="actions">
                                <button class="secondary" id="cancel-add-btn">Cancel</button>
                                <button id="confirm-add-btn"><i class="codicon codicon-check"></i> Save</button>
                            </div>
                        </div>

                        <div id="main-list">
                            ${isLoading ? '<div class="loading-overlay"><div class="spinner"></div>Hydrating synapses...</div>' : ''}

                            <h3>Live Working Memory (Tier 1) <span class="tier-badge tier-live">LIVE</span></h3>
                            ${workingMemory.length === 0 ? '<div class="empty-hint">No memories hydrated. Use "Make Live" or run a relevant chat.</div>' : workingMemory.map(renderMemoryCard).join('')}

                            <h3>Deep Memory Archive (Tier 2) <span class="tier-badge tier-deep">LATENT</span></h3>
                            ${deepMemory.length === 0 ? '<div class="empty-hint">No deep memories archived.</div>' : deepMemory.map(renderMemoryCard).join('')}
                        </div>
                    </div>
                </div>
            </div>

            <!-- THE DREAM SEQUENCER -->
            <div id="dream-overlay">
                <div class="dream-brain">
                    <i class="codicon codicon-circuit-board" style="font-size: 45px; color: white;"></i>
                </div>
                <h2 style="margin: 0; letter-spacing: 3px; font-weight:800;">CONSOLIDATING ENGRAMS</h2>
                <p id="dream-status" style="font-size:12px; opacity:0.7; margin-top:5px;">Analyzing semantic overlaps...</p>
                <div id="dream-progress-log" class="dream-log"></div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                const newForm = document.getElementById('new-memory-form');
                const overlay = document.getElementById('dream-overlay');
                const log = document.getElementById('dream-progress-log');
                const status = document.getElementById('dream-status');

                // Graph Data Injection
                const graphNodes = ${JSON.stringify(nodes)};
                const graphEdges = ${JSON.stringify(edges)};

                let cy = null;

                function initGraph() {
                    const accentColor = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#007acc';
                    const fgColor = getComputedStyle(document.body).getPropertyValue('--vscode-editor-foreground').trim() || '#ffffff';
                    const cardBg = getComputedStyle(document.body).getPropertyValue('--card-bg').trim() || '#252526';

                    cy = cytoscape({
                        container: document.getElementById('cy-canvas'),
                        elements: [...graphNodes, ...graphEdges],
                        style: [
                            {
                                selector: 'node',
                                style: {
                                    'label': 'data(label)',
                                    'color': fgColor,
                                    'background-color': '#202020',
                                    'border-width': '2px',
                                    'border-color': '#444444',
                                    'opacity': 0.5, 
                                    'text-valign': 'center',
                                    'text-halign': 'center',
                                    'font-family': 'sans-serif', // CSS Variable fallback
                                    'font-size': '10px',
                                    'width': '130px',
                                    'height': '38px',
                                    'shape': 'round-rectangle',
                                    'text-wrap': 'wrap',
                                    'text-max-width': '110px'
                                }
                            },
                            {
                                selector: 'node[category = "tag"]',
                                style: {
                                    'background-color': '#9b59b6', // Glowing purple for Shared Semantic Tags
                                    'border-color': '#9b59b6',
                                    'color': '#ffffff',
                                    'shape': 'ellipse',
                                    'width': '55px',
                                    'height': '55px',
                                    'font-weight': 'bold',
                                    'opacity': 1.0 // Tags are always visible
                                }
                            },
                            {
                                selector: 'node[importance >= 25][category != "tag"]',
                                style: {
                                    'background-color': '#2ecc71', // Glowing vibrant green for Live Working Memory (Tier 1)
                                    'border-color': '#2ecc71',
                                    'color': '#ffffff',
                                    'font-weight': 'bold',
                                    'opacity': 1.0, // Fully opaque
                                    'border-width': '3px'
                                }
                            },
                            {
                                selector: 'node[importance < 25][category != "tag"]',
                                style: {
                                    'background-color': '#2d2d2d',
                                    'border-color': '#555555',
                                    'color': fgColor,
                                    'opacity': 0.65 // Dim Tier 2 deep memory
                                }
                            },
                            {
                                selector: 'edge',
                                style: {
                                    'label': 'data(label)',
                                    'width': 1.5,
                                    'line-color': '#555',
                                    'target-arrow-color': '#555',
                                    'target-arrow-shape': 'triangle',
                                    'curve-style': 'bezier',
                                    'arrow-scale': 0.8,
                                    'font-size': '8px',
                                    'color': '#888',
                                    'text-background-opacity': 0.8,
                                    'text-background-color': '#111111', // Hex fallback for CSS Variable
                                    'text-background-padding': '2px',
                                    'text-background-shape': 'round-rectangle'
                                }
                            },
                            {
                                selector: 'edge[label = "has_tag"]',
                                style: {
                                    'line-color': '#9b59b6',
                                    'target-arrow-color': '#9b59b6',
                                    'line-style': 'dashed'
                                }
                            }
                        ],
                        layout: {
                            name: 'cose',
                            animate: true,
                            idealEdgeLength: 140,
                            nodeRepulsion: 12000
                        }
                    });

                    cy.on('tap', 'node', function(evt) {
                        const node = evt.target;
                        const card = document.querySelector(\`.memory-card[data-id="\${node.id()}"]\`);
                        
                        document.querySelectorAll('.memory-card').forEach(c => c.classList.remove('highlighted'));
                        
                        if (card) {
                            card.classList.add('highlighted');
                            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }
                    });
                }

                function fitGraph() {
                    if (cy) {
                        cy.resize();
                        cy.fit();
                    }
                }

                function toggleSidebar() {
                    const panel = document.getElementById('sidebar-panel');
                    panel.classList.toggle('collapsed');
                    setTimeout(fitGraph, 310);
                }

                function addLog(text) {
                    const div = document.createElement('div');
                    div.textContent = "> " + text;
                    log.prepend(div);
                }

                document.getElementById('dream-btn').onclick = () => {
                    overlay.style.display = 'flex';
                    log.innerHTML = '';
                    addLog("Synapse consolidation starting...");
                    vscode.postMessage({ command: 'force_dream' });
                };

                window.addEventListener('message', event => {
                    const m = event.data;
                    if (m.command === 'dream_event') {
                        const ev = m.event;
                        const card = document.querySelector(\`.memory-card[data-id="\${ev.id}"]\`);

                        switch (ev.type) {
                            case 'decay':
                                addLog(\`Decayed: "\${ev.title}" to \${Math.round(ev.value)}%\`);
                                break;
                            case 'archive':
                                addLog(\`Archived: "\${ev.title}" moved to deep storage.\`);
                                break;
                            case 'forget':
                                addLog(\`Pruned: "\${ev.title}" forgotten.\`);
                                break;
                            case 'fuse':
                                addLog(\`🧬 Fusion: \${ev.title}\`);
                                break;
                            case 'summary':
                                status.textContent = "Cognitive maintenance complete.";
                                setTimeout(() => {
                                    overlay.style.display = 'none';
                                }, 2000);
                                break;
                        }
                    }
                });

                document.getElementById('show-add-btn').onclick = () => {
                    newForm.style.display = 'block';
                    document.getElementById('new-id').focus();
                };

                document.getElementById('cancel-add-btn').onclick = () => newForm.style.display = 'none';

                document.getElementById('confirm-add-btn').onclick = () => {
                    const id = document.getElementById('new-id').value.trim();
                    const title = document.getElementById('new-title').value.trim();
                    const content = document.getElementById('new-content').value.trim();
                    const importance = parseInt(document.getElementById('new-importance').value, 10);
                    if (!id || !title) return;
                    vscode.postMessage({ command: 'add_direct', id, title, content, importance });
                    newForm.style.display = 'none';
                };

                // Delegate clicks inside Cards list
                document.getElementById('main-list').onclick = (e) => {
                    const btn = e.target.closest('button');
                    if (!btn) return;
                    
                    const card = btn.closest('.memory-card');
                    const id = card.dataset.id;

                    if (btn.classList.contains('add-pred-btn')) {
                        const container = card.querySelector('.predicates-list');
                        const row = document.createElement('div');
                        row.className = 'predicate-row';
                        row.style.cssText = "display:flex; flex-direction:column; gap:4px; margin-bottom:8px; border-bottom:1px solid rgba(255,255,255,0.05); padding-bottom:6px;";
                        row.innerHTML = \`
                            <div style="display:flex; gap:6px;">
                                <input type="text" class="pred-verb" value="has_tag" placeholder="verb" style="flex:1;">
                                <select class="pred-target-select" onchange="toggleTargetInput(this)" style="flex:1;">
                                    <option value="__custom__" selected>✍️ Custom Tag/ID...</option>
                                    \${graphNodes.filter(n => n.data.id !== id).map(n => \`<option value="\${n.data.id}">\${n.data.label}</option>\`).join('')}
                                </select>
                                <button class="icon-btn remove-btn remove-pred-btn" style="padding:2px 6px;"><i class="codicon codicon-trash"></i></button>
                            </div>
                            <input type="text" class="pred-target-custom" value="" placeholder="Enter custom #tag or ID..." style="margin-top:2px; display:block;" />
                        \`;
                        container.appendChild(row);
                        return;
                    }

                    if (btn.classList.contains('remove-pred-btn')) {
                        btn.closest('.predicate-row').remove();
                        return;
                    }

                    if (btn.classList.contains('save-btn')) {
                        const title = card.querySelector('.title-input').value;
                        const content = card.querySelector('.content-input').value;
                        const importance = parseInt(card.querySelector('.importance-input').value, 10);
                        
                        // Serialize predicates
                        const preds = [];
                        card.querySelectorAll('.predicate-row').forEach(row => {
                            const verb = row.querySelector('.pred-verb').value.trim();
                            const select = row.querySelector('.pred-target-select');
                            const customInput = row.querySelector('.pred-target-custom');
                            
                            let targetId = select.value;
                            if (targetId === '__custom__' && customInput) {
                                let rawVal = customInput.value.trim().toLowerCase();
                                if (rawVal.startsWith('#')) rawVal = rawVal.substring(1);
                                if (rawVal) {
                                    targetId = \`tag_\${rawVal}\`;
                                }
                            }

                            if (verb && targetId && targetId !== '__custom__') {
                                preds.push({ verb, targetId });
                            }
                        });

                        // Automatically extract typed hashtags and merge them into the predicate links on save
                        const tagRegex = /#([\\w_]+)/g;
                        let match;
                        while ((match = tagRegex.exec(content)) !== null) {
                            const tagId = \`tag_\${match[1].toLowerCase()}\`;
                            const exists = preds.some(p => p.verb === 'has_tag' && p.targetId === tagId);
                            if (!exists) {
                                preds.push({ verb: 'has_tag', targetId: tagId });
                            }
                        }

                        vscode.postMessage({ command: 'save', id, title, content, importance, predicates: preds });
                    } else if (btn.classList.contains('delete-btn')) {
                        vscode.postMessage({ command: 'delete', id });
                    } else if (btn.classList.contains('move-deep-btn')) {
                        const title = card.querySelector('.title-input').value;
                        const content = card.querySelector('.content-input').value;
                        vscode.postMessage({ command: 'save', id, title, content, importance: 20 });
                    } else if (btn.classList.contains('move-live-btn')) {
                        const title = card.querySelector('.title-input').value;
                        const content = card.querySelector('.content-input').value;
                        vscode.postMessage({ command: 'save', id, title, content, importance: 80 });
                    }
                };

                function toggleTargetInput(select) {
                    const row = select.closest('.predicate-row');
                    const customInp = row.querySelector('.pred-target-custom');
                    if (customInp) {
                        customInp.style.display = select.value === '__custom__' ? 'block' : 'none';
                    }
                }

                // --- SOVEREIGN SVG GRAPH FALLBACK ENGINE ---
                // If Cytoscape fails to load due to strict CSP or offline isolation,
                // this high-performance SVG layout engine automatically activates to render nodes and links.
                function renderSvgFallbackGraph() {
                    const canvas = document.getElementById('cy-canvas');
                    if (!canvas) return;

                    const width = canvas.clientWidth || 600;
                    const height = canvas.clientHeight || 500;

                    // Arrange nodes using a simple circle layout
                    const radius = Math.min(width, height) * 0.35;
                    const centerX = width / 2;
                    const centerY = height / 2;

                    const nodesWithCoords = graphNodes.map((n, idx) => {
                        const angle = (idx / graphNodes.length) * 2 * Math.PI;
                        return {
                            ...n,
                            x: centerX + radius * Math.cos(angle),
                            y: centerY + radius * Math.sin(angle)
                        };
                    });

                    // Render lines and nodes
                    let svgContent = \`<svg width="100%" height="100%" viewBox="0 0 \${width} \${height}" style="cursor: grab;">\`;

                    // 1. Draw Edges
                    graphEdges.forEach(e => {
                        const srcNode = nodesWithCoords.find(n => n.data.id === e.data.source);
                        const trgNode = nodesWithCoords.find(n => n.data.id === e.data.target);
                        if (srcNode && trgNode) {
                            const isTagLink = e.data.label === 'has_tag';
                            const color = isTagLink ? '#9b59b6' : '#555555';
                            const dash = isTagLink ? 'stroke-dasharray="4"' : '';

                            svgContent += \`
                                <line x1="\${srcNode.x}" y1="\${srcNode.y}" x2="\${trgNode.x}" y2="\${trgNode.y}" 
                                      stroke="\${color}" stroke-width="2" \${dash} />
                                <text x="\${(srcNode.x + trgNode.x)/2}" y="\${(srcNode.y + trgNode.y)/2 - 4}" 
                                      fill="#888888" font-size="8px" text-anchor="middle" font-family="sans-serif">\${e.data.label}</text>
                            \`;
                        }
                    });

                    // 2. Draw Nodes
                    nodesWithCoords.forEach(n => {
                        const isTag = n.data.category === 'tag';
                        const isLive = n.data.importance >= 25;

                        const fillColor = isTag ? '#9b59b6' : (isLive ? '#2ecc71' : '#2d2d2d');
                        const borderColor = isTag ? '#9b59b6' : (isLive ? '#2ecc71' : '#555555');
                        const fgColor = '#ffffff';

                        if (isTag) {
                            svgContent += \`
                                <g class="svg-node" data-id="\${n.data.id}" style="cursor:pointer;">
                                    <circle cx="\${n.x}" cy="\${n.y}" r="22" fill="\${fillColor}" stroke="\${borderColor}" stroke-width="2" />
                                    <text x="\${n.x}" y="\${n.y + 4}" fill="\${fgColor}" font-size="9px" font-weight="bold" text-anchor="middle" font-family="sans-serif">\${n.data.label}</text>
                                </g>\`;
                        } else {
                            svgContent += \`
                                <g class="svg-node" data-id="\${n.data.id}" style="cursor:pointer;">
                                    <rect x="\${n.x - 55}" y="\${n.y - 16}" width="110" height="32" rx="6" fill="\${fillColor}" stroke="\${borderColor}" stroke-width="2" />
                                    <text x="\${n.x}" y="\${n.y + 4}" fill="\${fgColor}" font-size="9px" text-anchor="middle" font-family="sans-serif">\${n.data.label}</text>
                                </g>\`;
                        }
                    });

                    svgContent += \`</svg>\`;
                    canvas.innerHTML = svgContent;

                    // Attach selection events to SVG nodes
                    canvas.querySelectorAll('.svg-node').forEach(el => {
                        el.onclick = (e) => {
                            const id = el.getAttribute('data-id');
                            const card = document.querySelector(\`.memory-card[data-id="\${id}"]\`);

                            document.querySelectorAll('.memory-card').forEach(c => c.classList.remove('highlighted'));
                            if (card) {
                                card.classList.add('highlighted');
                                card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }

                            // Highlight selected node in SVG
                            canvas.querySelectorAll('circle, rect').forEach(shape => {
                                shape.style.filter = '';
                            });
                            const shape = el.querySelector('circle, rect');
                            if (shape) shape.style.filter = 'drop-shadow(0 0 8px #ff9d00)';
                        };
                    });
                }

                // --- SOVEREIGN SVG GRAPH FALLBACK ENGINE ---
                // If Cytoscape fails to load due to strict CSP or offline isolation,
                // this high-performance SVG layout engine automatically activates to render nodes and links.
                function renderSvgFallbackGraph() {
                    const canvas = document.getElementById('cy-canvas');
                    if (!canvas) return;

                    const width = canvas.clientWidth || 600;
                    const height = canvas.clientHeight || 500;

                    // Arrange nodes using a simple circle layout
                    const radius = Math.min(width, height) * 0.35;
                    const centerX = width / 2;
                    const centerY = height / 2;

                    const nodesWithCoords = graphNodes.map((n, idx) => {
                        const angle = (idx / graphNodes.length) * 2 * Math.PI;
                        return {
                            ...n,
                            x: centerX + radius * Math.cos(angle),
                            y: centerY + radius * Math.sin(angle)
                        };
                    });

                    // Render lines and nodes
                    let svgContent = \`<svg width="100%" height="100%" viewBox="0 0 \${width} \${height}" style="cursor: grab;">\`;
                    
                    // 1. Draw Edges
                    graphEdges.forEach(e => {
                        const srcNode = nodesWithCoords.find(n => n.data.id === e.data.source);
                        const trgNode = nodesWithCoords.find(n => n.data.id === e.data.target);
                        if (srcNode && trgNode) {
                            const isTagLink = e.data.label === 'has_tag';
                            const color = isTagLink ? '#9b59b6' : '#555555';
                            const dash = isTagLink ? 'stroke-dasharray="4"' : '';
                            
                            svgContent += \`
                                <line x1="\${srcNode.x}" y1="\${srcNode.y}" x2="\${trgNode.x}" y2="\${trgNode.y}" 
                                      stroke="\${color}" stroke-width="2" \${dash} />
                                <text x="\${(srcNode.x + trgNode.x)/2}" y="\${(srcNode.y + trgNode.y)/2 - 4}" 
                                      fill="#888888" font-size="8px" text-anchor="middle" font-family="sans-serif">\${e.data.label}</text>
                            \`;
                        }
                    });

                    // 2. Draw Nodes
                    nodesWithCoords.forEach(n => {
                        const isTag = n.data.category === 'tag';
                        const isLive = n.data.importance >= 25;
                        
                        const fillColor = isTag ? '#9b59b6' : (isLive ? '#2ecc71' : '#2d2d2d');
                        const borderColor = isTag ? '#9b59b6' : (isLive ? '#2ecc71' : '#555555');
                        const fgColor = '#ffffff';

                        if (isTag) {
                            svgContent += \`
                                <g class="svg-node" data-id="\${n.data.id}" style="cursor:pointer;">
                                    <circle cx="\${n.x}" cy="\${n.y}" r="22" fill="\${fillColor}" stroke="\${borderColor}" stroke-width="2" />
                                    <text x="\${n.x}" y="\${n.y + 4}" fill="\${fgColor}" font-size="9px" font-weight="bold" text-anchor="middle" font-family="sans-serif">\${n.data.label}</text>
                                </g>\`;
                        } else {
                            svgContent += \`
                                <g class="svg-node" data-id="\${n.data.id}" style="cursor:pointer;">
                                    <rect x="\${n.x - 55}" y="\${n.y - 16}" width="110" height="32" rx="6" fill="\${fillColor}" stroke="\${borderColor}" stroke-width="2" />
                                    <text x="\${n.x}" y="\${n.y + 4}" fill="\${fgColor}" font-size="9px" text-anchor="middle" font-family="sans-serif">\${n.data.label}</text>
                                </g>\`;
                        }
                    });

                    svgContent += \`</svg>\`;
                    canvas.innerHTML = svgContent;

                    // Attach selection events to SVG nodes
                    canvas.querySelectorAll('.svg-node').forEach(el => {
                        el.onclick = (e) => {
                            const id = el.getAttribute('data-id');
                            const card = document.querySelector(\`.memory-card[data-id="\${id}"]\`);
                            
                            document.querySelectorAll('.memory-card').forEach(c => c.classList.remove('highlighted'));
                            if (card) {
                                card.classList.add('highlighted');
                                card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }

                            // Highlight selected node in SVG
                            canvas.querySelectorAll('circle, rect').forEach(shape => {
                                shape.style.filter = '';
                            });
                            const shape = el.querySelector('circle, rect');
                            if (shape) shape.style.filter = 'drop-shadow(0 0 8px #ff9d00)';
                        };
                    });
                }

                // Initialize Cytoscape with automatic SVG failover
                try {
                    if (typeof cytoscape !== 'undefined' && graphNodes.length > 0) {
                        initGraph();
                    } else if (graphNodes.length > 0) {
                        Logger.warn("Cytoscape offline. Loading Sovereign SVG Graph engine fallback.");
                        renderSvgFallbackGraph();
                        window.onresize = renderSvgFallbackGraph;
                    } else {
                        document.getElementById('cy-canvas').innerHTML = \`
                            <div style="padding: 40px; text-align: center; opacity:0.5;">
                                <i class="codicon codicon-info" style="font-size: 30px; display:block; margin-bottom:10px;"></i>
                                <p>Memory Vault is currently empty.</p>
                                <p style="font-size: 10px;">Click '+ Add' above to begin building your project engrams.</p>
                            </div>\`;
                    }
                } catch (err) {
                    console.error("Failed to render graph:", err);
                    renderSvgFallbackGraph();
                }
            </script>
        </body>
        </html>`;
    }
}