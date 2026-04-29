import * as vscode from 'vscode';
import { SkillsManager, Skill } from '../skillsManager';

export class SkillsManagerPanel {
    public static currentPanel: SkillsManagerPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri, manager: SkillsManager) {
        if (SkillsManagerPanel.currentPanel) {
            SkillsManagerPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
            SkillsManagerPanel.currentPanel._update(); // Refresh on reveal
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'skillsManager',
            '💡 Skills Library Manager',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        SkillsManagerPanel.currentPanel = new SkillsManagerPanel(panel, extensionUri, manager);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, private manager: SkillsManager) {
        this._panel = panel;
        this._update();

        this._panel.webview.onDidReceiveMessage(async (msg) => {
            const { ChatPanel } = require('./chatPanel/chatPanel');
            const activeChat = ChatPanel.currentPanel;

            switch (msg.command) {
                case 'toggleLoad':
                    if (activeChat && activeChat.getCurrentDiscussion()) {
                        const discussion = activeChat.getCurrentDiscussion()!;
                        if (!discussion.importedSkills) discussion.importedSkills = [];

                        if (msg.load) {
                            if (!discussion.importedSkills.includes(msg.id)) {
                                discussion.importedSkills.push(msg.id);
                            }
                        } else {
                            discussion.importedSkills = discussion.importedSkills.filter((id: string) => id !== msg.id);
                        }

                        // Sync with Disk and HUD
                        await activeChat._discussionManager.saveDiscussion(discussion);
                        activeChat.updateContextAndTokens();
                        this._update(); // Refresh library view
                    } else {
                        vscode.window.showWarningMessage("Open a chat discussion first to load/unload skills.");
                        this._update(); // Reset switch in UI
                    }
                    break;
                case 'edit':
                    const allSkills = await this.manager.getSkills();
                    const skill = allSkills.find(s => s.id === msg.id);
                    if (skill) {
                        vscode.commands.executeCommand('lollms-vs-coder.editSkill', skill);
                    } else {
                        vscode.window.showErrorMessage(`Lookup failed: Could not find skill with ID: ${msg.id}`);
                    }
                    break;
                case 'delete':
                    const confirmDelete = await vscode.window.showWarningMessage(
                        `Are you sure you want to delete skill "${msg.name}"? This action cannot be undone.`,
                        { modal: true },
                        "Delete"
                    );
                    if (confirmDelete === "Delete") {
                        await this.manager.deleteSkill(msg.id, msg.scope);
                        this._update();
                        vscode.window.showInformationMessage(`Skill "${msg.name}" has been deleted.`);
                    }
                    break;
                case 'add':
                    vscode.commands.executeCommand('lollms-vs-coder.addSkill');
                    break;
                case 'refresh':
                    this._update();
                    break;
            }
        }, null, this._disposables);

        this._panel.onDidDispose(() => {
            SkillsManagerPanel.currentPanel = undefined;
            this._disposables.forEach(d => d.dispose());
        }, null, this._disposables);
    }

    private async _update() {
        const { ChatPanel } = require('./chatPanel/chatPanel');
        const activeChat = ChatPanel.currentPanel;
        const loadedIds = activeChat?.getCurrentDiscussion()?.importedSkills || [];

        const skills = await this.manager.getSkills();
        this._panel.webview.html = this._getHtml(skills, loadedIds);
    }

    // Helper to generate a single skill card HTML
    private renderSkillCard(s: Skill, isLoaded: boolean): string {
        return `
            <div class="card ${isLoaded ? 'loaded' : ''}" data-search="${(s.name + (s.description || '')).toLowerCase().replace(/"/g, '&quot;')}">
                <div style="display:flex; justify-content:space-between; align-items:start;">
                    <div class="name" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:250px;">${s.name}</div>
                    <span class="scope-badge">${s.scope}</span>
                </div>
                <div class="desc">${(s.description || 'No description.').substring(0, 300)}</div>
                <div class="actions">
                    <div style="display:flex; gap:6px;">
                        <button onclick="vscode.postMessage({command:'edit', id:'${s.id}'})">Edit</button>
                        <button class="danger" onclick="vscode.postMessage({command:'delete', id:'${s.id}', scope:'${s.scope}', name:'${s.name.replace(/'/g, "\\'")}'})">Delete</button>
                    </div>
                    <div style="display:flex; align-items:center; gap:6px;">
                        <span style="font-size:9px; font-weight:bold; opacity:0.6;">${isLoaded ? 'LOADED' : 'OFF'}</span>
                        <label class="switch">
                            <input type="checkbox" ${isLoaded ? 'checked' : ''} onchange="vscode.postMessage({command:'toggleLoad', id:'${s.id}', load: this.checked})">
                            <span class="slider"></span>
                        </label>
                    </div>
                </div>
            </div>`;
    }

    private _getHtml(skills: Skill[], loadedIds: string[]) {
        const categories = [...new Set(skills.map(s => s.category || 'Uncategorized'))].sort();

        return `<!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); margin: 0; padding: 0; background: var(--vscode-editor-background); overflow: hidden; height: 100vh; }
                
                .layout { display: flex; height: 100vh; width: 100vw; }
                
                /* Sidebar Navigation */
                .sidebar { width: 260px; background: var(--vscode-sideBar-background); border-right: 1px solid var(--vscode-panel-border); display: flex; flex-direction: column; flex-shrink: 0; }
                .sidebar-header { padding: 15px; font-size: 11px; font-weight: bold; text-transform: uppercase; opacity: 0.6; border-bottom: 1px solid var(--vscode-panel-border); }
                .category-list { flex: 1; overflow-y: auto; padding: 10px 0; }
                .category-item { padding: 8px 15px; cursor: pointer; font-size: 12px; display: flex; justify-content: space-between; align-items: center; transition: background 0.1s; }
                .category-item:hover { background: var(--vscode-list-hoverBackground); }
                .category-item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); font-weight: bold; }
                .cat-count { font-size: 10px; opacity: 0.6; background: var(--vscode-badge-background); padding: 2px 6px; border-radius: 10px; }

                /* Main Content Area */
                .main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
                .header { display: flex; justify-content: space-between; align-items: center; padding: 15px 20px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); z-index: 100; }
                .search-container { padding: 10px 20px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); }
                input#search { width: 100%; padding: 8px 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; outline: none; }
                
                .content-scroll { flex: 1; overflow-y: auto; padding: 20px; }
                .category-section { margin-bottom: 40px; }
                .category-title { font-size: 14px; font-weight: bold; text-transform: uppercase; color: var(--vscode-textLink-foreground); margin-bottom: 20px; padding-bottom: 8px; border-bottom: 1px solid var(--vscode-widget-border); display: flex; align-items: center; gap: 8px; }
                
                .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 20px; }
                .card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); padding: 15px; border-radius: 8px; display: flex; flex-direction: column; transition: transform 0.1s; }
                .card:hover { border-color: var(--vscode-focusBorder); transform: translateY(-2px); }
                .card.loaded { border-left: 4px solid var(--vscode-charts-blue); background: rgba(0, 122, 204, 0.05); }
                .name { font-weight: bold; font-size: 1.1em; margin-bottom: 5px; color: var(--vscode-textLink-foreground); }
                .desc { font-size: 0.9em; opacity: 0.8; flex-grow: 1; margin-bottom: 15px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
                .actions { display: flex; gap: 8px; align-items: center; justify-content: space-between; }

                /* Switch styles */
                .switch { position: relative; display: inline-block; width: 34px; height: 20px; }
                .switch input { opacity: 0; width: 0; height: 0; }
                .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: var(--vscode-input-background); border: 1px solid var(--vscode-widget-border); transition: .4s; border-radius: 20px; }
                .slider:before { position: absolute; content: ""; height: 14px; width: 14px; left: 2px; bottom: 2px; background-color: var(--vscode-foreground); transition: .4s; border-radius: 50%; }
                input:checked + .slider { background-color: var(--vscode-button-background); }
                input:checked + .slider:before { transform: translateX(14px); background-color: var(--vscode-button-foreground); }
                button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; cursor: pointer; border-radius: 4px; font-size: 12px; }
                button:hover { filter: brightness(1.2); }
                button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
                button.danger { background: transparent; border: 1px solid var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
                button.danger:hover { background: var(--vscode-errorForeground); color: white; }
                .scope-badge { font-size: 9px; padding: 2px 6px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); text-transform: uppercase; font-weight: bold; }
            </style>
        </head>
        <body>
            <div class="layout">
                <!-- SIDEBAR NAV -->
                <div class="sidebar">
                    <div class="sidebar-header">Browse Library</div>
                    <div class="category-list">
                        <div class="category-item active" onclick="selectCategory(this, 'all')">
                            <span>All Skills</span>
                            <span class="cat-count">${skills.length}</span>
                        </div>
                        <div class="category-item" onclick="selectCategory(this, 'loaded')">
                            <span>Loaded in Chat</span>
                            <span class="cat-count" style="background:var(--vscode-charts-blue)">${loadedIds.length}</span>
                        </div>
                        <div style="margin: 10px 15px; height: 1px; background: var(--vscode-panel-border);"></div>
                        ${categories.map(cat => `
                            <div class="category-item" onclick="selectCategory(this, '${cat}')">
                                <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${cat}</span>
                                <span class="cat-count">${skills.filter(s => (s.category || 'Uncategorized') === cat).length}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>

                <!-- MAIN CONTENT -->
                <div class="main">
                    <div class="header">
                        <h2 style="margin:0; font-size:18px;">💡 Skills Library</h2>
                        <div style="display:flex; gap:10px;">
                            <button class="secondary" onclick="vscode.postMessage({command:'refresh'})">Refresh</button>
                            <button onclick="vscode.postMessage({command:'add'})">+ New Skill</button>
                        </div>
                    </div>

                    <div class="search-container">
                        <input type="text" id="search" placeholder="Search by name, description or content..." oninput="filter()">
                    </div>

                    <div class="content-scroll" id="content-root">
                        <!-- LOADED SKILLS (Filtered View) -->
                        <div class="category-section" id="section-loaded" style="display:none;">
                            <div class="category-title" style="color: var(--vscode-charts-blue); border-color: var(--vscode-charts-blue);">
                                <span class="codicon codicon-cloud-download"></span> LOADED IN CURRENT CHAT
                            </div>
                            <div class="grid">
                                ${skills.filter(s => loadedIds.includes(s.id)).map(s => this.renderSkillCard(s, true)).join('')}
                            </div>
                        </div>

                        <!-- ALL CATEGORIES -->
                        ${categories.map(cat => `
                            <div class="category-section" data-category="${cat}">
                                <div class="category-title"><span class="codicon codicon-folder"></span> ${cat}</div>
                                <div class="grid">
                                    ${skills.filter(s => (s.category || 'Uncategorized') === cat).map(s => this.renderSkillCard(s, loadedIds.includes(s.id))).join('')}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                let activeCategory = 'all';

                function selectCategory(el, cat) {
                    document.querySelectorAll('.category-item').forEach(i => i.classList.remove('active'));
                    el.classList.add('active');
                    activeCategory = cat;
                    filter();
                }

                function filter() {
                    const query = document.getElementById('search').value.toLowerCase();
                    const sections = document.querySelectorAll('.category-section');

                    sections.forEach(section => {
                        const isLoadedSection = section.id === 'section-loaded';
                        const categoryMatch = activeCategory === 'all' 
                            || (activeCategory === 'loaded' && isLoadedSection)
                            || (section.dataset.category === activeCategory);

                        if (!categoryMatch) {
                            section.style.display = 'none';
                            return;
                        }

                        let hasVisibleCards = false;
                        const cards = section.querySelectorAll('.card');
                        cards.forEach(card => {
                            const searchData = card.dataset.search || '';
                            const match = searchData.includes(query);
                            card.style.display = match ? 'flex' : 'none';
                            if (match) hasVisibleCards = true;
                        });

                        section.style.display = hasVisibleCards ? 'block' : 'none';
                    });
                }

                function renderSkillCard(s, isLoaded) {
                    // Logic moved to a function for re-use if we used a more dynamic JS framework, 
                    // but since this is injected via template literal, it's just here for structural reference.
                }
            </script>
        </body>
    </html>`;
    }
}