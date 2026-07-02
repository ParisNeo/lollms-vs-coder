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
    /**
     * Handles pulling a remote skill from the Git Zoo cache folder
     * directly into the active library (Format A).
     */
    private async handlePullSkill(skillData: any) {
        try {
            const added = await this.manager.addSkill(skillData);
            vscode.window.showInformationMessage(`Successfully pulled "${added.name}" into your local skills library.`);
            this._update();
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to pull skill: ${e.message}`);
        }
    }

    /**
     * Executes the git sync stream for a target Zoo registry
     */
    private async handleSyncZooRepo(repoId: string) {
        const repo = (this.manager as any).getZooRepos().find((r: any) => r.id === repoId);
        if (!repo) return;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Syncing: ${repo.name}`,
            cancellable: false
        }, async (progress) => {
            try {
                await (this.manager as any).syncZooRepo(repo, (status: string) => {
                    progress.report({ message: status });
                });
                vscode.window.showInformationMessage(`Successfully synchronized ${repo.name}.`);
                // Explore and render immediately
                await this.handleExploreZooRepo(repoId);
            } catch (e: any) {
                vscode.window.showErrorMessage(`Git Sync Failed for ${repo.name}: ${e.message}`);
            }
        });
    }

    /**
     * Explores local clone cache and sends structured tree back to Webview
     */
    private async handleExploreZooRepo(repoId: string) {
        const repo = (this.manager as any).getZooRepos().find((r: any) => r.id === repoId);
        if (!repo) return;

        try {
            const tree = await (this.manager as any).exploreZooRepo(repo);
            this._panel.webview.postMessage({
                command: 'zooExplored',
                tree: tree
            });
        } catch (e: any) {
            this._panel.webview.postMessage({
                command: 'zooExplored',
                tree: null
            });
        }
    }

    /**
     * Launches file/document selectors for multi-format ingestion pipelines
     */
    private async handleIngestionAction(type: 'claude' | 'document') {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: `Select File to Ingest`,
            filters: type === 'claude' 
                ? { 'Claude Markdown': ['md'] }
                : { 'Documents': ['pdf', 'docx', 'txt', 'md'] }
        });

        if (!uris || !uris[0]) return;

        const scopeChoice = await vscode.window.showQuickPick(
            [{ label: 'Global Library', value: 'global' }, { label: 'Project Library', value: 'local' }],
            { placeHolder: 'Select target library scope' }
        );
        const scope = (scopeChoice?.value as 'global' | 'local') || 'global';

        const fileUri = uris[0];
        const fileName = path.basename(fileUri.fsPath);

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Ingesting ${fileName}...`,
            cancellable: false
        }, async () => {
            try {
                const bytes = await vscode.workspace.fs.readFile(fileUri);
                const fileContent = Buffer.from(bytes).toString('utf8');

                if (type === 'claude') {
                    // Claude Style Frontmatter markdown parsing
                    const parsed = this.manager.claudeMarkdownToSkill(fileContent, scope);
                    await this.manager.addSkill(parsed);
                    vscode.window.showInformationMessage(`Claude Skill "${parsed.name}" successfully imported.`);
                } else {
                    // Extract text locally from PDF/DOCX/TXT
                    let text = "";
                    const ext = path.extname(fileName).toLowerCase();

                    if (ext === '.pdf') {
                        const { pdfParse } = require('pdf-parse');
                        text = (await pdfParse(bytes)).text;
                    } else if (ext === '.docx') {
                        const mammoth = require('mammoth');
                        text = (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
                    } else {
                        text = fileContent;
                    }

                    // Prompt LLM to structure extracted text into standard Lollms frontmatter skill format
                    const activeChat = ChatPanel.currentPanel;
                    const lollms = activeChat ? activeChat._lollmsAPI : null;

                    const added = await (this.manager as any).ingestDocumentAsSkill(fileName, text, scope, lollms);
                    if (added) {
                        vscode.window.showInformationMessage(`Document "${fileName}" successfully processed and saved as skill "${added.name}".`);
                    } else {
                        throw new Error("AI extraction yielded invalid format.");
                    }
                }
                this._update();
            } catch (e: any) {
                vscode.window.showErrorMessage(`Ingestion failed: ${e.message}`);
            }
        });
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
                        `Are you sure you want to delete skill "${msg.name}"?`,
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
                case 'ingestSkill':
                    await this.handleIngestionAction(msg.type);
                    break;
                case 'syncZooRepo':
                    await this.handleSyncZooRepo(msg.repoId);
                    break;
                case 'exploreZooRepo':
                    await this.handleExploreZooRepo(msg.repoId);
                    break;
                case 'pullSkillDirect':
                    await this.handlePullSkill(msg.skill);
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
        const safeId = s.id.replace(/'/g, "\\'");
        return `
            <div class="card ${isLoaded ? 'loaded' : ''}" data-id="${s.id}" data-search="${(s.name + (s.description || '')).toLowerCase().replace(/"/g, '&quot;')}" onclick="inspectSkill('${safeId}')">
                <div style="display:flex; justify-content:space-between; align-items:start; pointer-events:none;">
                    <div class="name" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:220px;">${s.name}</div>
                    <span class="scope-badge">${s.scope}</span>
                </div>
                <div class="desc" style="pointer-events:none;">${(s.description || 'No description.').substring(0, 300)}</div>
                <div class="actions">
                    <div style="display:flex; gap:6px;">
                        <button onclick="event.stopPropagation(); vscode.postMessage({command:'edit', id:'${s.id}'})">Edit</button>
                        <button class="danger" onclick="event.stopPropagation(); vscode.postMessage({command:'delete', id:'${s.id}', scope:'${s.scope}', name:'${s.name.replace(/'/g, "\\'")}'})">Delete</button>
                    </div>
                    <div style="display:flex; align-items:center; gap:6px;" onclick="event.stopPropagation()">
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
        const zooRepos = (this.manager as any).getZooRepos() || [];

        return `<!DOCTYPE html>
        <html>
        <head>
            <link href="https://cdn.jsdelivr.net/npm/@vscode/codicons/dist/codicon.css" rel="stylesheet" />
            <style>
                body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); margin: 0; padding: 0; background: var(--vscode-editor-background); overflow: hidden; height: 100vh; }

                .layout { display: flex; height: 100vh; width: 100vw; position: relative; }

                /* Sidebar Navigation */
                .sidebar { width: 280px; background: var(--vscode-sideBar-background); border-right: 1px solid var(--vscode-panel-border); display: flex; flex-direction: column; flex-shrink: 0; }
                .sidebar-header { padding: 12px 15px; font-size: 11px; font-weight: bold; text-transform: uppercase; opacity: 0.6; border-bottom: 1px solid var(--vscode-panel-border); display:flex; justify-content:space-between; align-items:center; }
                .category-list { flex: 1; overflow-y: auto; padding: 10px 0; }
                .category-item { padding: 8px 15px; cursor: pointer; font-size: 12px; display: flex; justify-content: space-between; align-items: center; transition: background 0.1s; }
                .category-item:hover { background: var(--vscode-list-hoverBackground); }
                .category-item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); font-weight: bold; }
                .cat-count { font-size: 10px; opacity: 0.6; background: var(--vscode-badge-background); padding: 2px 6px; border-radius: 10px; }

                /* Main Content Area */
                .main { flex: 1; display: flex; flex-direction: column; min-width: 0; position: relative; }
                .header { display: flex; justify-content: space-between; align-items: center; padding: 12px 20px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); z-index: 100; }

                .search-ribbon { padding: 10px 20px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); display:flex; gap:10px; align-items:center; }
                input#search { flex:1; padding: 8px 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; outline: none; }

                .ingest-toolbar { display:flex; gap:8px; margin-top:5px; padding:0 20px; }

                .content-scroll { flex: 1; overflow-y: auto; padding: 20px; }
                .category-section { margin-bottom: 40px; }
                .category-title { font-size: 13px; font-weight: bold; text-transform: uppercase; color: var(--vscode-textLink-foreground); margin-bottom: 20px; padding-bottom: 8px; border-bottom: 1px solid var(--vscode-widget-border); display: flex; align-items: center; gap: 8px; }

                .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 15px; }
                .card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); padding: 15px; border-radius: 8px; display: flex; flex-direction: column; transition: transform 0.1s; position:relative; }
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

                button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; cursor: pointer; border-radius: 4px; font-size: 12px; display:inline-flex; align-items:center; gap:6px; }
                button:hover { filter: brightness(1.2); }
                button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
                button.danger { background: transparent; border: 1px solid var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
                button.danger:hover { background: var(--vscode-errorForeground); color: white; }
                .scope-badge { font-size: 9px; padding: 2px 6px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); text-transform: uppercase; font-weight: bold; }

                /* RIGHT DRAWER PANEL (On-Demand) */
                .drawer-right { width: 380px; background: var(--vscode-sideBar-background); border-left: 1px solid var(--vscode-panel-border); display: none; flex-direction: column; padding: 20px; box-sizing: border-box; overflow-y: auto; flex-shrink: 0; box-shadow: -5px 0 15px rgba(0,0,0,0.2); }
                .drawer-right.visible { display: flex; }
                .drawer-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 8px; margin-bottom: 15px; }
                .drawer-title { font-weight: bold; font-size: 13px; text-transform: uppercase; color: var(--vscode-textLink-foreground); }

                .drawer-log-item { font-family: monospace; font-size: 10px; padding: 4px 6px; background: rgba(0,0,0,0.2); margin-bottom: 4px; border-radius: 4px; }
            </style>
        </head>
        <body>
            <div class="layout">
                <!-- SIDEBAR NAV -->
                <div class="sidebar">
                    <div class="sidebar-header">
                        <span>Browse Library</span>
                        <button class="secondary" onclick="vscode.postMessage({command:'refresh'})">↻</button>
                    </div>
                    <div class="category-list">
                        <div class="category-item active" onclick="selectCategory(this, 'all')">
                            <span>All Active Skills</span>
                            <span class="cat-count">${skills.length}</span>
                        </div>
                        <div class="category-item" onclick="selectCategory(this, 'loaded')">
                            <span>Loaded in Chat</span>
                            <span class="cat-count" style="background:var(--vscode-charts-blue)">${loadedIds.length}</span>
                        </div>

                        <div style="margin: 10px 15px; height: 1px; background: var(--vscode-panel-border);"></div>
                        <div style="padding: 4px 15px; font-size: 10px; font-weight: bold; opacity: 0.5;">ZOO REGISTRIES (GIT)</div>
                        ${zooRepos.map((repo: any) => `
                            <div class="category-item" onclick="selectCategory(this, 'zoo_${repo.id}')">
                                <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:180px;">${repo.name}</span>
                                <button class="secondary" style="padding: 2px 6px; font-size: 9px;" onclick="syncZoo(event, '${repo.id}')"><i class="codicon codicon-sync"></i></button>
                            </div>
                        `).join('')}

                        <div style="margin: 10px 15px; height: 1px; background: var(--vscode-panel-border);"></div>
                        <div style="padding: 4px 15px; font-size: 10px; font-weight: bold; opacity: 0.5;">CATEGORIES</div>
                        ${categories.map(cat => `
                            <div class="category-item" onclick="selectCategory(this, '${cat}')">
                                <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:180px;">${cat}</span>
                                <span class="cat-count">${skills.filter(s => (s.category || 'Uncategorized') === cat).length}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>

                <!-- MAIN CONTENT -->
                <div class="main">
                    <div class="header">
                        <h2 style="margin:0; font-size:18px;">💡 Skills Library Manager</h2>
                        <div style="display:flex; gap:10px;">
                            <button onclick="vscode.postMessage({command:'add'})">+ New Skill</button>
                        </div>
                    </div>

                    <div class="search-ribbon">
                        <input type="text" id="search" placeholder="Search across names, descriptions, or file contents (Grep)..." oninput="filter()">
                        <button class="secondary" id="search-mode-btn" onclick="toggleSearchMode()"><i class="codicon codicon-search"></i> <span id="search-mode-label">Simple</span></button>
                    </div>

                    <div class="ingest-toolbar">
                        <button class="secondary" onclick="ingest('claude')" title="Import Claude Code style YAML-Frontmatter Markdown"><i class="codicon codicon-markdown"></i> Ingest Claude Skill</button>
                        <button class="secondary" onclick="ingest('document')" title="Extract and format skill from PDF, DOCX, TXT"><i class="codicon codicon-file-pdf"></i> Ingest Document</button>
                    </div>

                    <div class="content-scroll" id="content-root">
                        <!-- LOADED SKILLS (Filtered View) -->
                        <div class="category-section" id="section-loaded" style="display:none;">
                            <div class="category-title" style="color: var(--vscode-charts-blue); border-color: var(--vscode-charts-blue);">
                                <span class="codicon codicon-cloud-download"></span> LOADED IN CURRENT CHAT
                            </div>
                            <div class="grid" id="loaded-grid">
                                ${skills.filter(s => loadedIds.includes(s.id)).map(s => this.renderSkillCard(s, true)).join('')}
                            </div>
                        </div>

                        <!-- ZOO REPOS (Dynamic placeholder view) -->
                        <div id="zoo-explorer-area" style="display:none;">
                            <!-- Injected dynamically on tab switch -->
                        </div>

                        <!-- ALL CATEGORIES -->
                        <div id="all-categories-area">
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

                <!-- RIGHT DRAWER PANEL (On-Demand Inspection) -->
                <div class="drawer-right" id="drawer">
                    <div class="drawer-header">
                        <span class="drawer-title" id="drawer-title-lbl">Symbol Inspect</span>
                        <span style="font-size:24px; cursor:pointer;" onclick="closeDrawer()">&times;</span>
                    </div>
                    <div class="form-group" style="margin-bottom:15px;">
                        <label>Description</label>
                        <div id="drawer-desc" style="font-size:12px; opacity:0.8; line-height:1.4;"></div>
                    </div>
                    <div class="form-group" style="margin-bottom:15px;" id="drawer-license-group">
                        <label><i class="codicon codicon-shield"></i> LICENSE</label>
                        <pre id="drawer-license" style="font-family:monospace; font-size:10px; background:rgba(0,0,0,0.15); padding:8px; border-radius:4px; max-height:100px; overflow-y:auto; margin:4px 0; border:1px solid var(--border); white-space:pre-wrap;"></pre>
                    </div>
                    <div class="form-group" style="flex:1; display:flex; flex-direction:column; margin-bottom:15px;">
                        <label>Content (Rules / Prompts)</label>
                        <pre id="drawer-content" style="flex:1; font-family:monospace; font-size:11px; background:rgba(0,0,0,0.25); padding:10px; border-radius:6px; overflow:auto; margin:4px 0; border:1px solid var(--border); white-space:pre-wrap;"></pre>
                    </div>
                    <div class="form-group" id="drawer-logs-group">
                        <label>Episodic Activity Logs</label>
                        <div id="drawer-logs" style="max-height:120px; overflow-y:auto; margin-top:4px;"></div>
                    </div>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                let activeCategory = 'all';
                let searchMode = 'simple'; // 'simple' or 'grep'
                let allSkillsData = ${JSON.stringify(skills)};

                function selectCategory(el, cat) {
                    document.querySelectorAll('.category-item').forEach(i => i.classList.remove('active'));
                    el.classList.add('active');
                    activeCategory = cat;

                    const allArea = document.getElementById('all-categories-area');
                    const zooArea = document.getElementById('zoo-explorer-area');

                    if (cat.startsWith('zoo_')) {
                        allArea.style.display = 'none';
                        zooArea.style.display = 'block';
                        exploreZoo(cat.replace('zoo_', ''));
                    } else {
                        allArea.style.display = 'block';
                        zooArea.style.display = 'none';
                        filter();
                    }
                }

                function toggleSearchMode() {
                    searchMode = searchMode === 'simple' ? 'grep' : 'simple';
                    document.getElementById('search-mode-label').textContent = searchMode === 'simple' ? 'Simple' : 'Deep (Grep)';
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
                            const name = card.dataset.search || '';
                            let match = name.includes(query);

                            if (searchMode === 'grep' && query.length > 2) {
                                // Grep matching through in-memory cache
                                const skillObj = allSkillsData.find(s => s.id === card.dataset.id);
                                if (skillObj && skillObj.content.toLowerCase().includes(query)) {
                                    match = true;
                                }
                            }

                            card.style.display = match ? 'flex' : 'none';
                            if (match) hasVisibleCards = true;
                        });

                        section.style.display = hasVisibleCards ? 'block' : 'none';
                    });
                }

                function inspectSkill(id) {
                    const skill = allSkillsData.find(s => s.id === id);
                    if (!skill) return;

                    document.getElementById('drawer-title-lbl').textContent = skill.name;
                    document.getElementById('drawer-desc').textContent = skill.description || "No description provided.";
                    document.getElementById('drawer-content').textContent = skill.content;

                    // Display License and Logs if available (Format A attributes)
                    const licenseBox = document.getElementById('drawer-license-group');
                    if (skill.license) {
                        licenseBox.style.display = 'block';
                        document.getElementById('drawer-license').textContent = skill.license;
                    } else {
                        licenseBox.style.display = 'none';
                    }

                    const logsBox = document.getElementById('drawer-logs-group');
                    const logsList = document.getElementById('drawer-logs');
                    if (skill.historicalLog && skill.historicalLog.length > 0) {
                        logsBox.style.display = 'block';
                        logsList.innerHTML = skill.historicalLog.map(l => \`<div class="drawer-log-item">\${l}</div>\`).join('');
                    } else {
                        logsBox.style.display = 'none';
                    }

                    document.getElementById('drawer').classList.add('visible');
                }

                function closeDrawer() {
                    document.getElementById('drawer').classList.remove('visible');
                }

                function ingest(type) {
                    vscode.postMessage({ command: 'ingestSkill', type });
                }

                function syncZoo(e, repoId) {
                    e.stopPropagation();
                    vscode.postMessage({ command: 'syncZooRepo', repoId });
                }

                function exploreZoo(repoId) {
                    const zooArea = document.getElementById('zoo-explorer-area');
                    zooArea.innerHTML = '<div style="padding:30px; text-align:center;"><div class="spinner"></div> Exploring cache...</div>';
                    vscode.postMessage({ command: 'exploreZooRepo', repoId });
                }

                window.addEventListener('message', event => {
                    const m = event.data;
                    if (m.command === 'zooExplored') {
                        const zooArea = document.getElementById('zoo-explorer-area');
                        if (!m.tree || !m.tree.children || m.tree.children.length === 0) {
                            zooArea.innerHTML = '<div style="padding:20px; text-align:center; opacity:0.5;">No pulled skills found. Press ↻ to pull from remote Zoo.</div>';
                            return;
                        }

                        // Render categories & cards for Zoo Repo
                        let html = \`<h3>🔍 Remote Zoo: \${m.tree.label}</h3>\`;

                        const renderZooNode = (node) => {
                            if (node.isSkill) return '';
                            const subSkills = [];

                            const collectSkills = (n) => {
                                if (n.isSkill) subSkills.push(n);
                                else if (n.children) n.children.forEach(collectSkills);
                            };
                            collectSkills(node);

                            if (subSkills.length === 0) return '';

                            return \`
                            <div class="category-section">
                                <div class="category-title"><span class="codicon codicon-folder"></span> \${node.label} (\${subSkills.length} available)</div>
                                <div class="grid">
                                    \${subSkills.map(s => \`
                                        <div class="card" onclick="inspectSkill('\\'Zoo: ' + s.id + '\\'")">
                                            <div class="name">\${s.label}</div>
                                            <div class="desc">\${s.description || 'No description provided.'}</div>
                                            <div class="actions">
                                                <button class="primary" onclick="pullSkill(event, \${JSON.stringify(s.skill).replace(/'/g, "&apos;")})"><i class="codicon codicon-cloud-download"></i> Pull Skill</button>
                                                \${s.license ? '<span class="scope-badge">Licensed</span>' : ''}
                                            </div>
                                        </div>
                                    \`).join('')}
                                </div>
                            </div>\`;
                        };

                        html += m.tree.children.map(renderZooNode).join('');
                        zooArea.innerHTML = html;
                    }
                });

                function pullSkill(e, skillObj) {
                    e.stopPropagation();
                    vscode.postMessage({ command: 'pullSkillDirect', skill: skillObj });
                }
            </script>
        </body>
    </html>`;
    }
}