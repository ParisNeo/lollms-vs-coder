import * as vscode from 'vscode';
import { ProjectMemoryManager, MemoryEntry } from '../projectMemoryManager';

export class ProjectMemoryPanel {
    public static currentPanel: ProjectMemoryPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri, manager: ProjectMemoryManager) {
        if (ProjectMemoryPanel.currentPanel) {
            ProjectMemoryPanel.currentPanel._panel.reveal(vscode.ViewColumn.Two);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'projectMemoryManager',
            '🧠 Project Memory Manager',
            vscode.ViewColumn.Two,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        ProjectMemoryPanel.currentPanel = new ProjectMemoryPanel(panel, extensionUri, manager);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, private manager: ProjectMemoryManager) {
        this._panel = panel;
        this._update();
        
        this.manager.onDidChange(() => this._update(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(async (msg) => {
            try {
                switch (msg.command) {
                    case 'save':
                        await this.manager.updateMemory('update', msg.id, msg.title, msg.content, undefined, msg.importance);
                        vscode.window.showInformationMessage(`Lollms: Memory "${msg.title}" updated.`);
                        break;
                    case 'delete':
                        await this.manager.updateMemory('delete', msg.id);
                        break;
                    case 'add_direct':
                        const id = 'mem_' + Date.now();
                        // CRITICAL: Await the update so _update() is triggered by onDidChange AFTER save
                        await this.manager.updateMemory('add', id, msg.title, msg.content, "general", msg.importance);
                        vscode.window.showInformationMessage(`Lollms: New memory "${msg.title}" created.`);
                        break;
                    case 'force_dream':
                        await this.manager.performDreamCycle((event) => {
                            this._panel.webview.postMessage({ command: 'dream_event', event });
                        });
                        // Final refresh of the static list
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
        const memories = await this.manager.getMemories();
        // Skip the intermediate loading state to prevent flickering during rapid AI updates
        this._panel.webview.html = this._getHtml(memories, false);
    }

    private _getHtml(memories: any[], isLoading: boolean = false) {
        const escape = (str: string) => (str || '').replace(/[&<>"']/g, (m) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[m] || m));

        // Threshold for T1 (Working Memory) defined in projectMemoryManager
        const T1_THRESHOLD = 25;
        const workingMemory = memories.filter(m => (m.importance || 0) >= T1_THRESHOLD);
        const deepMemory = memories.filter(m => (m.importance || 0) < T1_THRESHOLD);

        const renderMemoryCard = (m: any) => `
            <div class="memory-card" data-id="${m.id}" style="border-left: 5px solid ${m.importance >= T1_THRESHOLD ? 'var(--vscode-charts-blue)' : 'var(--vscode-descriptionForeground)'}">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                    <span class="badge" style="background: var(--vscode-badge-background); font-size:9px; border-radius:4px; padding:2px 6px;">${m.category || 'general'}</span>
                    <span style="font-size:10px; opacity:0.6; font-weight:bold;">Importance: ${Math.round(m.importance)}%</span>
                </div>
                
                <div class="form-group">
                    <label>Identifier</label>
                    <input type="text" class="title-input" value="${escape(m.title)}">
                </div>
                
                <div class="form-group">
                    <label>Context Body</label>
                    <textarea class="content-input" rows="3">${escape(m.content)}</textarea>
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

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <link href="https://cdn.jsdelivr.net/npm/@vscode/codicons/dist/codicon.css" rel="stylesheet" />
            <style>
                :root {
                    --card-bg: var(--vscode-editorWidget-background);
                    --input-bg: var(--vscode-input-background);
                    --border: var(--vscode-widget-border);
                    --dream-color: #9b59b6;
                }
                body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); padding: 25px; background: var(--vscode-editor-background); margin: 0; overflow-x: hidden; }

                /* 🌪️ THE NEURAL ARENA (DREAM OVERLAY) */
                #dream-overlay {
                    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                    background: rgba(0, 0, 0, 0.7);
                    backdrop-filter: blur(8px);
                    z-index: 500;
                    display: none;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    color: white;
                    text-align: center;
                }

                .dream-brain {
                    width: 200px; height: 200px;
                    background: radial-gradient(circle, var(--dream-color) 0%, transparent 70%);
                    border-radius: 50%;
                    filter: blur(20px);
                    animation: brain-throb 3s infinite ease-in-out;
                    margin-bottom: 30px;
                    display: flex; align-items: center; justify-content: center;
                }

                @keyframes brain-throb {
                    0%, 100% { transform: scale(1); opacity: 0.5; }
                    50% { transform: scale(1.3); opacity: 0.8; }
                }

                .dream-log {
                    max-width: 400px;
                    height: 100px;
                    overflow: hidden;
                    font-family: 'Courier New', monospace;
                    font-size: 12px;
                    opacity: 0.8;
                }

                /* 🧬 ANIMATED MEMORY STATES */
                .memory-card { 
                    transition: all 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275); 
                }

                .memory-card.decaying {
                    transform: scale(0.98);
                    opacity: 0.7;
                    border-color: var(--dream-color) !important;
                }

                .memory-card.forgetting {
                    transform: translateX(100px) rotate(15deg);
                    opacity: 0;
                    filter: blur(10px);
                }

                .memory-card.archiving {
                    transform: translateY(200px) scale(0.5);
                    opacity: 0;
                }

                .memory-card.reinforcing {
                    animation: reinforce-pulse 0.5s ease-out;
                    box-shadow: 0 0 20px var(--vscode-charts-green);
                }

                .memory-card.fusing {
                    transform: scale(1.2);
                    filter: brightness(2) blur(5px);
                    box-shadow: 0 0 50px var(--dream-color);
                    z-index: 1000;
                }

                @keyframes reinforce-pulse {
                    0% { transform: scale(1); }
                    50% { transform: scale(1.05); }
                    100% { transform: scale(1); }
                }

                .header-sticky { position: sticky; top: 0; background: var(--vscode-editor-background); padding-bottom: 15px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 25px; z-index: 100; display: flex; justify-content: space-between; align-items: center; }
                h2 { margin: 0; font-size: 18px; font-weight: 400; display: flex; align-items: center; gap: 10px; }
                h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.5; margin: 30px 0 15px 0; border-bottom: 1px dashed var(--border); padding-bottom: 5px; }

                .memory-card { background: var(--card-bg); border: 1px solid var(--border); padding: 16px; border-radius: 8px; margin-bottom: 15px; box-shadow: 0 4px 10px rgba(0,0,0,0.2); transition: transform 0.1s; }
                .memory-card:hover { border-color: var(--vscode-focusBorder); }
                
                .new-card { border: 2px dashed var(--vscode-focusBorder); display: none; margin-bottom: 30px; background: rgba(0, 122, 204, 0.05); }
                
                .form-group { margin-bottom: 12px; }
                label { display: block; font-size: 10px; font-weight: 700; opacity: 0.6; margin-bottom: 4px; text-transform: uppercase; }
                input, textarea { width: 100%; background: var(--input-bg); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 8px; border-radius: 4px; font-family: inherit; box-sizing: border-box; }
                input:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); border-color: transparent; }
                
                .actions { display: flex; gap: 8px; margin-top: 15px; }
                button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 14px; cursor: pointer; border-radius: 4px; font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
                button:hover { filter: brightness(1.2); }
                button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
                button.delete-btn { background: transparent; color: var(--vscode-errorForeground); border: 1px solid var(--vscode-errorForeground); padding: 6px 10px; }
                button.delete-btn:hover { background: var(--vscode-errorForeground); color: white; }
                
                .loading-overlay { text-align: center; padding: 100px 0; opacity: 0.5; }
                .spinner { width: 30px; height: 30px; border: 3px solid var(--vscode-button-secondaryBackground); border-top: 3px solid var(--vscode-button-background); border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 15px auto; }
                @keyframes spin { 100% { transform: rotate(360deg); } }
                
                .empty-hint { padding: 40px; text-align: center; opacity: 0.4; font-style: italic; border: 1px dashed var(--border); border-radius: 8px; }
                
                .tier-badge { font-size: 9px; padding: 2px 6px; border-radius: 4px; font-weight: bold; margin-left: 10px; }
                .tier-live { background: var(--vscode-charts-blue); color: white; }
                .tier-deep { background: var(--vscode-descriptionForeground); color: white; opacity: 0.6; }
            </style>
        </head>
        <body>
            <div class="header-sticky">
                <h2><i class="codicon codicon-chip"></i> Neural Memory Manager</h2>
                <div style="display:flex; gap:10px;">
                    <button id="dream-btn" class="secondary" title="Reorganize and consolidate memories now."><i class="codicon codicon-cloud"></i> Dream Session</button>
                    <button id="show-add-btn"><i class="codicon codicon-add"></i> Add New Fact</button>
                </div>
            </div>

            <div id="new-memory-form" class="memory-card new-card">
                <label>Identifier / Title</label>
                <input type="text" id="new-title" placeholder="e.g., Coding Standards (v2)">
                <label style="margin-top:10px;">Context Content</label>
                <textarea id="new-content" rows="4" placeholder="Technical facts the AI must remember for this project..."></textarea>
                
                <div style="margin: 15px 0;">
                    <div style="display:flex; justify-content: space-between;">
                        <label style="margin:0;">Initial Power (0-100%)</label>
                        <span id="new-weight-val" style="font-size: 11px; opacity: 0.8; font-family:monospace;">80</span>
                    </div>
                    <input type="range" id="new-importance" min="0" max="100" step="1" value="80" style="width:100%;" oninput="document.getElementById('new-weight-val').textContent = this.value">
                </div>

                <div class="actions">
                    <button class="secondary" id="cancel-add-btn">Cancel</button>
                    <button id="confirm-add-btn"><i class="codicon codicon-check"></i> Create Memory</button>
                </div>
            </div>

            <div id="main-list">
                ${isLoading ? '<div class="loading-overlay"><div class="spinner"></div>Scanning project brain...</div>' : ''}
                
                <h3>Live Working Memory (Tier 1) <span class="tier-badge tier-live">AUTO-INJECTED</span></h3>
                ${workingMemory.length === 0 ? '<div class="empty-hint">No facts currently in the active working context.</div>' : workingMemory.map(renderMemoryCard).join('')}

                <h3>Deep Memory handles (Tier 2) <span class="tier-badge tier-deep">HIDDEN</span></h3>
                ${deepMemory.length === 0 ? '<div class="empty-hint">No facts archived in deep memory.</div>' : deepMemory.map(renderMemoryCard).join('')}
            </div>

            <div id="dream-overlay">
                <div class="dream-brain">
                    <i class="codicon codicon-circuit-board" style="font-size: 60px; color: white;"></i>
                </div>
                <h1 style="margin: 0; letter-spacing: 4px;">REORGANIZING SYNAPSES</h1>
                <p id="dream-status">Consolidating neural engrams...</p>
                <div id="dream-progress-log" class="dream-log"></div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                const newForm = document.getElementById('new-memory-form');
                const overlay = document.getElementById('dream-overlay');
                const log = document.getElementById('dream-progress-log');
                const status = document.getElementById('dream-status');

                function addLog(text) {
                    const div = document.createElement('div');
                    div.textContent = "> " + text;
                    log.prepend(div);
                }

                document.getElementById('dream-btn').onclick = () => {
                    overlay.style.display = 'flex';
                    log.innerHTML = '';
                    addLog("Dream sequence initiated...");
                    vscode.postMessage({ command: 'force_dream' });
                };

                window.addEventListener('message', event => {
                    const m = event.data;
                    if (m.command === 'dream_event') {
                        const ev = m.event;
                        const card = document.querySelector(\`.memory-card[data-id="\${ev.id}"]\`);

                        switch (ev.type) {
                            case 'decay':
                                addLog(\`Decaying importance of "\${ev.title}" to \${Math.round(ev.value)}%\`);
                                if (card) card.classList.add('decaying');
                                break;
                            case 'archive':
                                addLog(\`ARCHIVING: "\${ev.title}" moved to deep storage.\`);
                                if (card) card.classList.add('archiving');
                                break;
                            case 'forget':
                                const isNoise = ev.title.toLowerCase().includes('lesson') || ev.title.toLowerCase().includes('attempt');
                                addLog(isNoise ? \`PURGING POISON: Redundant loop "\${ev.title}" destroyed.\` : \`PRUNING: "\${ev.title}" erased from memory.\`);
                                if (card) card.classList.add('forgetting');
                                break;
                            case 'fuse':
                                addLog(\`🧬 FUSION: \${ev.title}\`);
                                status.textContent = "Synthesizing High-Density Rules...";
                                document.querySelectorAll('.memory-card').forEach(c => {
                                    if(c.textContent.toLowerCase().includes('lesson')) c.classList.add('fusing');
                                });
                                break;
                            case 'summary':
                                status.textContent = "Cognitive Maintenance Complete.";
                                addLog(\`Finished: Decayed \${ev.data.decayed}, Archived \${ev.data.consolidated}, Pruned \${ev.data.forgotten}.\`);
                                setTimeout(() => {
                                    overlay.style.display = 'none';
                                    document.getElementById('dream-btn').disabled = false;
                                    document.getElementById('dream-btn').innerHTML = '<i class="codicon codicon-cloud"></i> Dream Session';
                                }, 2500);
                                break;
                        }
                    }
                });

                document.getElementById('show-add-btn').onclick = () => {
                    newForm.style.display = 'block';
                    document.getElementById('new-title').focus();
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                };

                document.getElementById('cancel-add-btn').onclick = () => newForm.style.display = 'none';

                document.getElementById('confirm-add-btn').onclick = () => {
                    const title = document.getElementById('new-title').value;
                    const content = document.getElementById('new-content').value;
                    const importance = parseInt(document.getElementById('new-importance').value, 10);
                    if (!title.trim()) return;
                    vscode.postMessage({ command: 'add_direct', title, content, importance });
                    newForm.style.display = 'none';
                };

                document.getElementById('main-list').onclick = (e) => {
                    const btn = e.target.closest('button');
                    if (!btn) return;
                    const id = btn.dataset.id;
                    const card = btn.closest('.memory-card');

                    if (btn.classList.contains('save-btn')) {
                        const title = card.querySelector('.title-input').value;
                        const content = card.querySelector('.content-input').value;
                        const importance = parseInt(card.querySelector('.importance-input').value, 10);
                        vscode.postMessage({ command: 'save', id, title, content, importance });
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
            </script>
        </body>
        </html>`;
    }
}