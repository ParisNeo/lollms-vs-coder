import * as vscode from 'vscode';
import { ProjectMemoryManager, MemoryEntry } from '../projectMemoryManager';
import { Logger } from '../logger';

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
                        await this.manager.updateMemory('update', msg.id, msg.title, msg.content, undefined, msg.importance, msg.predicates, msg.scope);
                        vscode.window.showInformationMessage(`Lollms: Memory "${msg.title}" updated.`);
                        break;
                    case 'delete':
                        await this.manager.updateMemory('delete', msg.id);
                        break;
                    case 'add_direct':
                        await this.manager.updateMemory('add', msg.id, msg.title, msg.content, msg.category || "general", msg.importance, undefined, msg.scope);
                        vscode.window.showInformationMessage(`Lollms: New memory "${msg.title}" created.`);
                        break;
                    case 'force_dream':
                        await this.manager.performDreamCycle((event) => {
                            this._panel.webview.postMessage({ command: 'dream_event', event });
                        });
                        this._update();
                        break;
                    case 'export_ontology':
                        await this.handleExportOntology();
                        break;
                    case 'import_ontology':
                        await this.handleImportOntology();
                        break;
                    case 'reset_default_ontology':
                        await this.handleResetDefaultOntology();
                        break;
                    case 'wipe_all':
                        const confirmWipe = await vscode.window.showWarningMessage(
                            "Are you sure you want to permanently clear all memories? This will delete all custom engrams and restore only the default Lollms Code Ontology.",
                            { modal: true },
                            "Wipe All Memories"
                        );
                        if (confirmWipe === "Wipe All Memories") {
                            await this.manager.resetToDefaultOntology();
                            vscode.window.showInformationMessage("Memory vault successfully cleared.");
                            this._update();
                        }
                        break;
                    case 'delete_multiple':
                        if (msg.ids && Array.isArray(msg.ids)) {
                            const confirmDelete = await vscode.window.showWarningMessage(
                                `Are you sure you want to permanently delete the ${msg.ids.length} selected memories?`,
                                { modal: true },
                                "Delete Selected"
                            );
                            if (confirmDelete === "Delete Selected") {
                                for (const id of msg.ids) {
                                    await this.manager.updateMemory('delete', id);
                                }
                                vscode.window.showInformationMessage(`Successfully deleted ${msg.ids.length} memories.`);
                                this._update();
                            }
                        }
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
        const discussion = activeChat?.getCurrentDiscussion();
        const activeSkillIds = discussion?.importedSkills || [];

        const memories = await this.manager.getProjectedGraph(activeChat?.agentManager?.['skillsManager'], activeSkillIds);
        this._panel.webview.html = this._getHtml(this._panel.webview, memories, false);
    }

    private async handleExportOntology() {
        const memories = await this.manager.getMemories();
        const uri = await vscode.window.showSaveDialog({
            filters: { 'JSON': ['json'] },
            saveLabel: 'Export Ontology Graph',
            defaultUri: vscode.Uri.file('ontology_export.json')
        });

        if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(memories, null, 2), 'utf8'));
            vscode.window.showInformationMessage(`Ontology exported to ${path.basename(uri.fsPath)}`);
        }
    }

    private async handleImportOntology() {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'JSON': ['json'] },
            openLabel: 'Import Ontology Graph'
        });

        if (uris && uris[0]) {
            try {
                const bytes = await vscode.workspace.fs.readFile(uris[0]);
                const imported = JSON.parse(Buffer.from(bytes).toString('utf8'));

                if (Array.isArray(imported)) {
                    // Update all memories
                    for (const entry of imported) {
                        if (entry.id) {
                            await this.manager.updateMemory('update', entry.id, entry.title, entry.content, entry.category, entry.importance, entry.predicates, entry.scope);
                        }
                    }
                    vscode.window.showInformationMessage(`Successfully imported ${imported.length} ontology nodes.`);
                    this._update();
                } else {
                    vscode.window.showErrorMessage("Invalid ontology file format. Expected a JSON array of engram nodes.");
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(`Import failed: ${e.message}`);
            }
        }
    }

    private async handleResetDefaultOntology() {
        const confirm = await vscode.window.showWarningMessage(
            "Are you sure you want to reset the project memory ontology? This will permanently delete all custom engrams and restore only the default Lollms Code Ontology.",
            { modal: true },
            "Reset Ontology"
        );

        if (confirm === "Reset Ontology") {
            try {
                await this.manager.resetToDefaultOntology();
                vscode.window.showInformationMessage("Project memory ontology has been reset to default.");
                this._update();
            } catch (e: any) {
                vscode.window.showErrorMessage(`Reset failed: ${e.message}`);
            }
        }
    }

    private _getHtml(webview: vscode.Webview, memories: any[], isLoading: boolean = false) {
        const escape = (str: string) => (str || '').replace(/[&<>"']/g, (m) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[m] || m));

        const T1_THRESHOLD = 25;

        // TBox Schema Nodes
        const tboxConcepts = memories.filter(m => {
            const id = String(m.id || '');
            return id.startsWith('concept_template_') || m.category === 'concept';
        });

        // ABox Instance Nodes
        const physicalMemories = memories.filter(m => {
            const id = String(m.id || '');
            return !id.startsWith('concept_template_') && m.category !== 'concept' && !id.startsWith('skill_') && !id.startsWith('tag_') && !id.startsWith('cat_');
        });

        const workingMemory = physicalMemories.filter(m => (m.importance || 0) >= T1_THRESHOLD);
        const deepMemory = physicalMemories.filter(m => (m.importance || 0) < T1_THRESHOLD);

        // Pre-build target memory option elements once to avoid O(N^2 * P) string allocation limits in nested loops!
        const targetOptionsCache = physicalMemories.map(x => ({
            id: x.id,
            html: `<option value="${x.id}">` + escape(x.title) + `</option>`
        }));

        const renderTBoxCard = (m: any) => {
            return `
            <div class="memory-card tbox-card" style="border-left: 5px solid var(--dream-color); margin-bottom:12px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <span class="badge" style="background: var(--dream-color); color: white; font-size:9px; border-radius:4px; padding:2px 6px; font-weight:bold;">TBox Class</span>
                    <span style="font-size:9px; opacity:0.6; font-family:monospace;">ID: ${m.id}</span>
                </div>
                <div style="font-weight:bold; font-size:13px; margin-bottom:6px;">${escape(m.title)}</div>
                <div style="font-size:11px; opacity:0.85; line-height:1.4;">${escape(m.content)}</div>
            </div>`;
        };

        const renderMemoryCard = (m: any) => {
            const predicateRows = (m.predicates || []).map((p: any, idx: number) => {
                const targetNode = memories.find(x => x.id === p.targetId);
                const isCustomTag = p.verb === 'has_tag' && !targetNode;

                // Fast pre-built selection options
                const optionsHtml = targetOptionsCache
                    .filter(opt => opt.id !== m.id)
                    .map(opt => opt.id === p.targetId ? opt.html.replace('option value', 'option selected value') : opt.html)
                    .join('');

                return `
                <div class="predicate-row" style="display:flex; flex-direction:column; gap:4px; margin-bottom:8px; border-bottom:1px solid rgba(255,255,255,0.05); padding-bottom:6px;">
                    <div style="display:flex; gap:6px;">
                        <input type="text" class="pred-verb" value="${escape(p.verb)}" placeholder="verb" style="flex:1;">
                        <select class="pred-target-select" onchange="toggleTargetInput(this)" style="flex:1;">
                            <option value="__custom__" ${isCustomTag ? 'selected' : ''}>✍️ Custom Tag/ID...</option>
                            ${optionsHtml}
                        </select>
                        <button class="icon-btn remove-btn remove-pred-btn" style="padding:2px 6px;"><i class="codicon codicon-trash"></i></button>
                    </div>
                    <input type="text" class="pred-target-custom" value="${escape(p.targetId)}" placeholder="Enter custom #tag or ID..." style="margin-top:2px; display:${isCustomTag ? 'block' : 'none'};" />
                </div>`;
            }).join('');

            const scopeLabel = m.scope === 'global' ? 'GLOBAL' : 'PROJECT';
            const scopeColor = m.scope === 'global' ? 'var(--vscode-charts-purple)' : 'var(--vscode-charts-blue)';

            return `
            <div class="memory-card" data-id="${m.id}" style="border-left: 5px solid ${m.importance >= T1_THRESHOLD ? 'var(--vscode-charts-blue)' : 'var(--vscode-descriptionForeground)'}">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                    <div style="display:flex; gap:6px; align-items:center;">
                        <span class="badge" style="background: var(--vscode-badge-background); font-size:9px; border-radius:4px; padding:2px 6px;">${m.category || 'general'}</span>
                        <span class="badge" style="background: ${scopeColor}; color: white; font-size:9px; border-radius:4px; padding:2px 6px; font-weight:bold;">${scopeLabel}</span>
                    </div>
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
                    <label>Scope Settings</label>
                    <select class="scope-input" style="padding:4px; font-size:11px;">
                        <option value="local" ${m.scope !== 'global' ? 'selected' : ''}>Local (This Project Only)</option>
                        <option value="global" ${m.scope === 'global' ? 'selected' : ''}>Global (Cross-Project Developer DNA)</option>
                    </select>
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

        // Helper to estimate node dimensions based on label length to prevent label overflow
        const getEstDimensions = (label: string, category: string) => {
            const charCount = label.length;
            const words = label.split(/\s+/);
            const longestWord = words.reduce((max, w) => Math.max(max, w.length), 0);

            // Concepts/Tags can be rounder, standard engrams are wide rectangles
            if (category === 'tag' || category === 'concept') {
                // Expanded size boundary to prevent text overflow from clipped shapes (e.g. Hexagon)
                const size = Math.max(100, Math.min(180, longestWord * 10 + 36));
                return { width: size, height: size };
            }

            const charsPerLine = 22;
            const approxLines = Math.ceil(charCount / charsPerLine);
            const width = Math.max(140, Math.min(280, longestWord * 8 + 30, charCount * 6 + 24));
            const height = Math.max(42, approxLines * 14 + 20);
            return { width, height };
        };

        // Serialize Cytoscape data safely for injection
        const nodes: any[] = [];
        const edges: any[] = [];
        const nodeIds = new Set<string>();

        memories.forEach(m => {
            nodeIds.add(m.id);
            const dims = getEstDimensions(m.title, m.category || 'general');
            nodes.push({
                data: {
                    id: m.id,
                    label: m.title,
                    importance: m.importance,
                    category: m.category || 'general',
                    estWidth: dims.width,
                    estHeight: dims.height
                }
            });
        });

        // 🛡️ SOVEREIGN SAFETY SIEVE: Filter out any edges pointing to unrendered/missing nodes
        memories.forEach(m => {
            if (m.predicates && Array.isArray(m.predicates)) {
                m.predicates.forEach((p: any) => {
                    if (nodeIds.has(m.id) && nodeIds.has(p.targetId)) {
                        edges.push({
                            data: {
                                id: `${m.id}-${p.verb}-${p.targetId}`,
                                source: m.id,
                                target: p.targetId,
                                label: p.verb
                            }
                        });
                    } else {
                        Logger.warn(`[Memory Sieve] Stripped orphaned edge: ${m.id} -> ${p.targetId}`);
                    }
                });
            }
        });

        // Use the constructor-assigned property
        const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'));
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="
                default-src 'self' ${webview.cspSource} https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com;
                style-src 'unsafe-inline' ${webview.cspSource} https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com;
                script-src 'unsafe-inline' 'unsafe-eval' ${webview.cspSource} https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com;
                img-src 'self' data: ${webview.cspSource} https:;
                font-src 'self' ${webview.cspSource} https://cdn.jsdelivr.net;
                connect-src 'self' https:;
            ">
            <link href="https://cdn.jsdelivr.net/npm/@vscode/codicons/dist/codicon.css" rel="stylesheet" />
            
            <script src="https://cdn.jsdelivr.net/npm/cytoscape@3.28.1/dist/cytoscape.min.js"></script>
            <script src="https://cdn.jsdelivr.net/npm/layout-base@2.0.1/layout-base.js"></script>
            <script src="https://cdn.jsdelivr.net/npm/cose-base@2.2.0/cose-base.js"></script>
            <script src="https://cdn.jsdelivr.net/npm/cytoscape-cose-bilkent@4.1.0/cytoscape-cose-bilkent.js"></script>
            
            <style>
                :root {
                    --card-bg: var(--vscode-editorWidget-background);
                    --input-bg: var(--vscode-input-background);
                    --border: var(--vscode-widget-border);
                    --dream-color: #9b59b6;
                    --accent: var(--vscode-textLink-foreground);
                }
                body, html { height: 100vh; width: 100vw; margin: 0; padding: 0; font-family: var(--vscode-font-family); background-color: #1e1e1e; background: var(--vscode-editor-background, #1e1e1e); color: var(--vscode-editor-foreground); overflow: hidden; }

                /* 🌟 FULL SCREEN GRAPH WITH FLOATING CONTROL OVERLAY */
                .workspace-layout { position: relative; width: 100%; height: 100%; }
                #cy-canvas { width: 100%; height: 100%; background-color: #1e1e1e; background: var(--vscode-editor-background, #1e1e1e); z-index: 1; }

                /* 🧬 FLOATING MEMORY PANEL */
                .cards-pane { 
                    position: absolute;
                    top: 15px;
                    left: 15px;
                    bottom: 15px;
                    width: 420px;
                    background: rgba(30, 30, 30, 0.82); /* Semi-transparent glassy look */
                    backdrop-filter: blur(14px);
                    -webkit-backdrop-filter: blur(14px);
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
                .tier-badge { font-size: 8px; padding: 1px 5px; border-radius: 4px; font-weight: bold; float: right; margin-top: 3px; }
                .tier-live { background: #2ecc71; color: #1e1e1e; }
                .tier-deep { background: var(--vscode-descriptionForeground); color: var(--vscode-editor-background); }
            </style>
        </head>
        <body>
            <div class="workspace-layout">
                <!-- OVERLAPPING CONTROLS -->
                <div class="graph-controls">
                    <button class="secondary" id="toggle-view-mode-btn" title="Toggle between Instance Graph and Abstract Ontology Schema"><i class="codicon codicon-git-compare"></i> <span id="view-mode-text">Ontology View</span></button>
                    <button class="secondary" id="export-ontology-btn" title="Export current ontology to JSON"><i class="codicon codicon-cloud-download"></i> Export</button>
                    <button class="secondary" id="import-ontology-btn" title="Import ontology from JSON"><i class="codicon codicon-cloud-upload"></i> Import</button>
                    <button class="secondary" onclick="toggleSidebar()" title="Toggle Sidebar"><i class="codicon codicon-layout-sidebar-left"></i> Toggle Panel</button>
                    <button class="secondary" onclick="fitGraph()"><i class="codicon codicon-screen-full"></i> Fit View</button>
                    <button class="secondary" onclick="zoomIn()"><i class="codicon codicon-zoom-in"></i> Zoom In</button>
                    <button class="secondary" onclick="zoomOut()"><i class="codicon codicon-zoom-out"></i> Zoom Out</button>
                </div>

                <!-- FULL SCREEN GRAPH -->
                <div id="cy-canvas"></div>

                <!-- FLOATING PANEL -->
                <div class="cards-pane" id="sidebar-panel">
                    <div class="header-sticky" style="flex-wrap: wrap; gap: 8px;">
                        <h2 id="sidebar-title"><i class="codicon codicon-chip"></i> Memory Vault (ABox)</h2>
                        <div style="display:flex; gap:6px; flex-wrap: wrap;">
                            <button id="delete-selected-btn" class="secondary danger" style="display:none; padding: 4px 8px;" title="Delete selected nodes from the graph"><i class="codicon codicon-trash"></i> Delete (<span id="selected-count">0</span>)</button>
                            <button id="wipe-all-btn" class="secondary danger" style="padding: 4px 8px;" title="Permanently delete all custom memories"><i class="codicon codicon-trash"></i> Wipe All</button>
                            <button id="dream-btn" class="secondary" title="Reorganize and consolidate memories now."><i class="codicon codicon-cloud"></i> Dream</button>
                            <button id="show-add-btn"><i class="codicon codicon-add"></i> Add</button>
                        </div>
                    </div>

                    <div class="scrollable-cards-area">
                        <!-- ONTOLOGY SCHEMA EDITOR (Visible in Ontology Mode) -->
                        <div id="ontology-editor-form" class="memory-card" style="display: none; border-color: var(--dream-color);">
                            <h3 style="margin-top:0; color:var(--dream-color); border:none; padding:0; display:flex; align-items:center; gap:6px;"><i class="codicon codicon-beaker"></i> Schema Editor</h3>

                            <div class="form-group" style="margin-top:10px;">
                                <label>Add New Concept (Category)</label>
                                <div style="display:flex; gap:6px;">
                                    <input type="text" id="new-concept-name" placeholder="e.g. security_standards" style="flex:1;">
                                    <button id="add-concept-btn" style="padding:4px 10px;"><i class="codicon codicon-add"></i></button>
                                </div>
                            </div>

                            <div class="form-group" style="margin-top:15px;">
                                <label>Add Relationship Triplet</label>
                                <div style="display:flex; flex-direction:column; gap:6px;">
                                    <select id="triplet-source" style="width:100%;"></select>
                                    <input type="text" id="triplet-verb" value="depends_on" placeholder="Relationship verb..." style="width:100%;">
                                    <select id="triplet-target" style="width:100%;"></select>
                                    <button id="add-triplet-btn" class="primary" style="width:100%; justify-content:center; margin:0;"><i class="codicon codicon-add"></i> Establish Rule</button>
                                </div>
                            </div>

                            <div style="margin-top: 20px; border-top: 1px solid var(--border); padding-top: 15px;">
                                <button id="reset-default-ontology-btn" class="secondary-button remove-btn" style="width:100%; justify-content:center; margin:0; border-color:var(--vscode-errorForeground); color:var(--vscode-errorForeground);">
                                    <i class="codicon codicon-history"></i> Reset to Default Ontology
                                </button>
                            </div>
                        </div>

                        <div id="new-memory-form" class="memory-card new-card">
                            <label>Identifier (e.g. <code>api_rule</code>)</label>
                            <input type="text" id="new-id" placeholder="e.g. api_security_rule">
                            <label style="margin-top:10px;">Title / Label</label>
                            <input type="text" id="new-title" placeholder="e.g. Secure API Handshake">
                            <label style="margin-top:10px;">Category / Concept</label>
                            <select id="new-category" style="width:100%;"></select>
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

                            <!-- ABox Instance List -->
                            <div id="abox-list-area">
                                <h3>Live Working Memory (Tier 1) <span class="tier-badge tier-live">LIVE</span></h3>
                                ${workingMemory.length === 0 ? '<div class="empty-hint">No memories hydrated. Use "Make Live" or run a relevant chat.</div>' : workingMemory.map(renderMemoryCard).join('')}

                                <h3>Deep Memory Archive (Tier 2) <span class="tier-badge tier-deep">LATENT</span></h3>
                                ${deepMemory.length === 0 ? '<div class="empty-hint">No deep memories archived.</div>' : deepMemory.map(renderMemoryCard).join('')}
                            </div>

                            <!-- TBox Concept List -->
                            <div id="tbox-list-area" style="display:none;">
                                <h3>Active Schema Classes</h3>
                                ${tboxConcepts.map(renderTBoxCard).join('')}
                            </div>
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

                function debounce(func, wait) {
                    let timeout;
                    return function(...args) {
                        const context = this;
                        clearTimeout(timeout);
                        timeout = setTimeout(() => func.apply(context, args), wait);
                    };
                }

                // --- ONTOLOGY SCHEMA GRAPH GENERATOR ---
                let viewMode = 'full'; // 'full' or 'ontology'

                function getOntologyElements() {
                    return STATIC_ONTOLOGY_ELEMENTS;
                }

                function getActiveElements() {
                    return viewMode === 'ontology' ? getOntologyElements() : [...graphNodes, ...graphEdges];
                }

                function syncOntologyEditorDropdowns() {
                    const srcSelect = document.getElementById('triplet-source');
                    const trgSelect = document.getElementById('triplet-target');
                    const catSelect = document.getElementById('new-category');
                    if (!srcSelect || !trgSelect) return;

                    // Extract categories
                    const categories = new Set();
                    graphNodes.forEach(n => {
                        const cat = n.data.category;
                        if (cat && cat !== 'tag' && cat !== 'concept' && cat !== 'chunk' && cat !== 'document') {
                            categories.add(cat);
                        }
                    });

                    const optionsHtml = Array.from(categories).map(cat => 
                        \`<option value="\${cat}">\${cat.toUpperCase()}</option>\`
                    ).join('');

                    srcSelect.innerHTML = optionsHtml;
                    trgSelect.innerHTML = optionsHtml + '<option value="__tag__"># Tag Hub</option>';
                    if (catSelect) catSelect.innerHTML = optionsHtml;
                }
                const overlay = document.getElementById('dream-overlay');
                const log = document.getElementById('dream-progress-log');
                const status = document.getElementById('dream-status');

                // Graph Data Injection (ABox Instances)
                // Strictly filter out TBox schema templates so they only appear in the Ontology View
                const graphNodes = ${JSON.stringify(nodes)}.filter(n => !n.data.id.startsWith('concept_template_'));
                const graphEdges = ${JSON.stringify(edges)}.filter(e => !e.data.source.startsWith('concept_template_') && !e.data.target.startsWith('concept_template_'));

                // Static Schema Definition (TBox Ontology)
                const STATIC_ONTOLOGY_ELEMENTS = [
                    { group: 'nodes', data: { id: 'concept_template_engram', label: 'Engram', category: 'concept', estWidth: 100, estHeight: 100 } },
                    { group: 'nodes', data: { id: 'concept_template_tag', label: 'Tag', category: 'concept', estWidth: 100, estHeight: 100 } },
                    { group: 'nodes', data: { id: 'concept_template_document', label: 'Document', category: 'concept', estWidth: 110, estHeight: 110 } },
                    { group: 'nodes', data: { id: 'concept_template_rule', label: 'Rule', category: 'concept', estWidth: 100, estHeight: 100 } },
                    { group: 'nodes', data: { id: 'concept_template_skill', label: 'Skill', category: 'concept', estWidth: 100, estHeight: 100 } },
                    { group: 'edges', data: { id: 'e_engram_tag', source: 'concept_template_engram', target: 'concept_template_tag', label: 'has_tag' } },
                    { group: 'edges', data: { id: 'e_engram_doc', source: 'concept_template_engram', target: 'concept_template_document', label: 'part_of' } },
                    { group: 'edges', data: { id: 'e_engram_rule', source: 'concept_template_engram', target: 'concept_template_rule', label: 'enforces' } },
                    { group: 'edges', data: { id: 'e_skill_rule', source: 'concept_template_skill', target: 'concept_template_rule', label: 'enforces' } },
                    { group: 'edges', data: { id: 'e_rule_rule', source: 'concept_template_rule', target: 'concept_template_rule', label: 'supersedes' } },
                    { group: 'edges', data: { id: 'e_doc_engram', source: 'concept_template_document', target: 'concept_template_engram', label: 'contains' } }
                ];

                let cy = null;

                function initGraph() {
                    const accentColor = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#007acc';
                    const fgColor = getComputedStyle(document.body).getPropertyValue('--vscode-editor-foreground').trim() || '#ffffff';
                    const cardBg = getComputedStyle(document.body).getPropertyValue('--card-bg').trim() || '#252526';
                    const borderColor = getComputedStyle(document.body).getPropertyValue('--vscode-widget-border').trim() || '#555555';
                    const fontFamily = getComputedStyle(document.body).getPropertyValue('--vscode-font-family').trim() || 'sans-serif';

                    cy = cytoscape({
                        container: document.getElementById('cy-canvas'),
                        elements: getActiveElements(),
                        zoomingEnabled: true,
                        panningEnabled: true,
                        boxSelectionEnabled: false,
                        minZoom: 0.1,
                        maxZoom: 3.0,
                        style: [
                            {
                                selector: 'node',
                                style: {
                                    'label': 'data(label)',
                                    'color': fgColor,
                                    'background-color': '#2d2d2d',
                                    'border-width': '2px',
                                    'border-color': borderColor,
                                    'opacity': 0.7, 
                                    'text-valign': 'center',
                                    'text-halign': 'center',
                                    'font-family': fontFamily,
                                    'font-size': '10px',
                                    'width': 'data(estWidth)',
                                    'height': 'data(estHeight)',
                                    'shape': 'round-rectangle',
                                    'text-wrap': 'wrap',
                                    'text-max-width': 'data(estWidth)' // Dynamically bound to node width to prevent text overflow
                                }
                            },
                            {
                                selector: 'node[category = "concept"]',
                                style: {
                                    'background-color': '#3498db', // Vibrant blue for abstract concepts
                                    'border-color': '#2980b9',
                                    'color': '#ffffff',
                                    'shape': 'hexagon',
                                    'width': 'data(estWidth)',
                                    'height': 'data(estHeight)',
                                    'font-weight': 'bold',
                                    'opacity': 1.0
                                }
                            },
                            {
                                selector: 'node[category = "tag"]',
                                style: {
                                    'background-color': '#9b59b6', // Glowing purple for Shared Semantic Tags
                                    'border-color': '#9b59b6',
                                    'color': '#ffffff',
                                    'shape': 'ellipse',
                                    'width': 'data(estWidth)',
                                    'height': 'data(estHeight)',
                                    'font-weight': 'bold',
                                    'opacity': 1.0, // Tags are always visible
                                    'shadow-blur': '12px',
                                    'shadow-color': '#9b59b6',
                                    'shadow-opacity': 0.5
                                }
                            },
                            {
                                selector: 'node[importance >= 25][category != "tag"]',
                                style: {
                                    'background-color': '#2ecc71', // Glowing vibrant green for Live Working Memory (Tier 1)
                                    'border-color': '#2ecc71',
                                    'color': '#1e1e1e',
                                    'font-weight': 'bold',
                                    'opacity': 1.0, // Fully opaque
                                    'border-width': '3px',
                                    'shadow-blur': '15px',
                                    'shadow-color': '#2ecc71',
                                    'shadow-opacity': 0.6
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
                                    'line-style': 'dashed',
                                    'width': 1.5
                                }
                            }
                        ],
                        layout: {
                            name: 'cose-bilkent',
                            animate: true,
                            randomize: true,
                            nodeDimensionsIncludeLabels: true,
                            nodeRepulsion: 45000,
                            idealEdgeLength: 120,
                            numIter: 2500,
                            tile: true
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

                    // Background double tap to fit graph
                    cy.on('dbltap', function(evt) {
                        if (evt.target === cy) {
                            fitGraph();
                        }
                    });

                    // Listen to selection events for multiselect and delete
                    const deleteSelectedBtn = document.getElementById('delete-selected-btn');
                    const selectedCountSpan = document.getElementById('selected-count');

                    function updateSelectionState() {
                        if (!cy) return;
                        const selectedNodes = cy.$('node:selected').filter(n => !n.data().isParent);
                        const count = selectedNodes.length;
                        if (count > 0) {
                            deleteSelectedBtn.style.display = 'inline-flex';
                            selectedCountSpan.textContent = count;
                        } else {
                            deleteSelectedBtn.style.display = 'none';
                        }
                    }

                    cy.on('select unselect', 'node', function() {
                        updateSelectionState();
                    });

                    if (deleteSelectedBtn) {
                        deleteSelectedBtn.onclick = () => {
                            const selectedNodes = cy.$('node:selected').filter(n => !n.data().isParent);
                            const ids = selectedNodes.map(n => n.id());
                            if (ids.length > 0) {
                                vscode.postMessage({ command: 'delete_multiple', ids });
                            }
                        };
                    }

                    const wipeAllBtn = document.getElementById('wipe-all-btn');
                    if (wipeAllBtn) {
                        wipeAllBtn.onclick = () => {
                            vscode.postMessage({ command: 'wipe_all' });
                        };
                    }
                }

                function fitGraph() {
                    if (cy) {
                        cy.resize();
                        cy.fit();
                    }
                }

                function zoomIn() {
                    if (cy) {
                        cy.zoom({
                            level: cy.zoom() * 1.2,
                            renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 }
                        });
                    }
                }

                function zoomOut() {
                    if (cy) {
                        cy.zoom({
                            level: cy.zoom() * 0.8,
                            renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 }
                        });
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
                                addLog(\"Decayed: \\"\" + ev.title + \"\\" to \" + Math.round(ev.value) + \"%\");
                                break;
                            case 'archive':
                                addLog(\"Archived: \\"\" + ev.title + \"\\" moved to deep storage.\");
                                break;
                            case 'forget':
                                addLog(\"Pruned: \\"\" + ev.title + \"\\" forgotten.\");
                                break;
                            case 'fuse':
                                addLog(\"🧬 Fusion: \" + ev.title);
                                break;
                            case 'summary':
                                status.textContent = "Cognitive maintenance complete.";
                                setTimeout(() => {
                                    overlay.style.display = 'none';
                                    location.reload(); // Hard refresh to update list & graph cleanly
                                }, 2000);
                                break;
                        }
                    }
                });

                // --- TOOLBAR COMMAND BINDERS (IMPORT/EXPORT/TOGGLE) ---
                function updateSidebarViewMode() {
                    const titleEl = document.getElementById('sidebar-title');
                    const schemaEditor = document.getElementById('ontology-editor-form');
                    const aboxList = document.getElementById('abox-list-area');
                    const tboxList = document.getElementById('tbox-list-area');
                    const addBtn = document.getElementById('show-add-btn');
                    const dreamBtn = document.getElementById('dream-btn');

                    if (viewMode === 'ontology') {
                        if (titleEl) titleEl.innerHTML = '<i class="codicon codicon-symbol-class"></i> Sovereign Schema (TBox)';
                        if (schemaEditor) {
                            schemaEditor.style.display = 'block';
                            syncOntologyEditorDropdowns();
                        }
                        if (aboxList) aboxList.style.display = 'none';
                        if (tboxList) tboxList.style.display = 'block';
                        if (addBtn) addBtn.style.display = 'none';
                        if (dreamBtn) dreamBtn.style.display = 'none';
                    } else {
                        if (titleEl) titleEl.innerHTML = '<i class="codicon codicon-chip"></i> Memory Vault (ABox)';
                        if (schemaEditor) schemaEditor.style.display = 'none';
                        if (aboxList) aboxList.style.display = 'block';
                        if (tboxList) tboxList.style.display = 'none';
                        if (addBtn) addBtn.style.display = 'inline-flex';
                        if (dreamBtn) dreamBtn.style.display = 'inline-flex';
                    }
                }

                document.getElementById('toggle-view-mode-btn').onclick = () => {
                    viewMode = viewMode === 'full' ? 'ontology' : 'full';

                    const text = document.getElementById('view-mode-text');
                    if (text) text.textContent = viewMode === 'ontology' ? 'Instance Graph' : 'Ontology View';

                    // Toggle Sidebar Panel Views
                    updateSidebarViewMode();

                    // Re-render Graph View
                    if (cy) {
                        cy.elements().remove();
                        cy.add(getActiveElements());
                        cy.layout({
                            name: 'cose-bilkent',
                            animate: true,
                            nodeDimensionsIncludeLabels: true,
                            numIter: 1000
                        }).run();
                    } else {
                        renderSvgFallbackGraph();
                    }
                };

                document.getElementById('export-ontology-btn').onclick = () => {
                    vscode.postMessage({ command: 'export_ontology' });
                };

                document.getElementById('import-ontology-btn').onclick = () => {
                    vscode.postMessage({ command: 'import_ontology' });
                };

                // Schema Editor Actions
                const addConceptBtn = document.getElementById('add-concept-btn');
                if (addConceptBtn) {
                    addConceptBtn.onclick = () => {
                        const name = document.getElementById('new-concept-name').value.trim().toLowerCase();
                        if (name) {
                            // Write a template concept node to the storage to register the category
                            vscode.postMessage({
                                command: 'add_direct',
                                id: \`concept_template\${name}_\${Date.now()}\`,
                                title: \`Template node for concept: \${name}\`,
                                content: \`System-generated schema placeholder for \${name} category.\`,
                                category: name,
                                importance: 10,
                                scope: 'local'
                            });
                            document.getElementById('new-concept-name').value = '';
                            setTimeout(() => location.reload(), 1500); // Reload to pull new category
                        }
                    };
                }

                const addTripletBtn = document.getElementById('add-triplet-btn');
                if (addTripletBtn) {
                    addTripletBtn.onclick = () => {
                        const srcCat = document.getElementById('triplet-source').value;
                        const verb = document.getElementById('triplet-verb').value.trim();
                        const trgCat = document.getElementById('triplet-target').value;

                        if (srcCat && verb && trgCat) {
                            const isTag = trgCat === '__tag__';
                            
                            // Link a template concept relation to register the edge in the ontology
                            vscode.postMessage({
                                command: 'add_direct',
                                id: \`schema_triplet_\${srcCat}_\${verb}_\${Date.now()}\`,
                                title: \`Schema Relation: \${srcCat} -> \${verb} -> \${trgCat}\`,
                                content: \`System-generated relationship rule linking category '\${srcCat}' to '\${trgCat}' via '\${verb}'.\`,
                                category: srcCat,
                                importance: 10,
                                scope: 'local',
                                predicates: [
                                    { verb: verb, targetId: isTag ? 'tag_schema_placeholder' : \`concept_template_\${trgCat}\` }
                                ]
                            });
                            setTimeout(() => location.reload(), 1500);
                        }
                    };
                }

                const resetOntologyBtn = document.getElementById('reset-default-ontology-btn');
                if (resetOntologyBtn) {
                    resetOntologyBtn.onclick = () => {
                        vscode.postMessage({ command: 'reset_default_ontology' });
                    };
                }

                document.getElementById('show-add-btn').onclick = () => {
                    newForm.style.display = 'block';
                    syncOntologyEditorDropdowns();
                    document.getElementById('new-id').focus();
                };

                document.getElementById('cancel-add-btn').onclick = () => newForm.style.display = 'none';

                document.getElementById('confirm-add-btn').onclick = () => {
                    const id = document.getElementById('new-id').value.trim();
                    const title = document.getElementById('new-title').value.trim();
                    const category = document.getElementById('new-category').value;
                    const content = document.getElementById('new-content').value.trim();
                    const importance = parseInt(document.getElementById('new-importance').value, 10);
                    if (!id || !title) return;
                    vscode.postMessage({ command: 'add_direct', id, title, content, importance, category });
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
                        const scope = card.querySelector('.scope-input').value;
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

                        vscode.postMessage({ command: 'save', id, title, content, importance, predicates: preds, scope: scope });
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

                // Initialize Cytoscape with automatic SVG failover
                try {
                    if (typeof cytoscape !== 'undefined' && graphNodes.length > 0) {
                        initGraph();
                    } else if (graphNodes.length > 0) {
                        Logger.warn("Cytoscape offline. Loading Sovereign SVG Graph engine fallback.");
                        renderSvgFallbackGraph();
                        window.onresize = debounce(renderSvgFallbackGraph, 150);
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
                    window.onresize = debounce(renderSvgFallbackGraph, 150);
                }
            </script>
        </body>
        </html>`;
    }
}