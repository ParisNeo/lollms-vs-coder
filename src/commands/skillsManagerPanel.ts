import * as vscode from 'vscode';
import { SkillsManager, Skill } from '../skillsManager';

export class SkillsManagerPanel {
    public static currentPanel: SkillsManagerPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri, manager: SkillsManager) {
        if (SkillsManagerPanel.currentPanel) {
            SkillsManagerPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
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
            switch (msg.command) {
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
        const skills = await this.manager.getSkills();
        this._panel.webview.html = this._getHtml(skills);
    }

    private _getHtml(skills: Skill[]) {
        const categories = [...new Set(skills.map(s => s.category || 'Uncategorized'))].sort();

        return `<!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); padding: 20px; background: var(--vscode-editor-background); }
                .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 10px; position: sticky; top: 0; background: var(--vscode-editor-background); z-index: 100; }
                .search-container { margin-bottom: 20px; }
                input#search { width: 100%; padding: 8px 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; outline: none; }
                input#search:focus { border-color: var(--vscode-focusBorder); }
                
                .category-section { margin-bottom: 30px; }
                .category-title { font-size: 12px; font-weight: bold; text-transform: uppercase; opacity: 0.6; margin-bottom: 15px; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 5px; display: flex; align-items: center; gap: 8px; }
                
                .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 15px; }
                .card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); padding: 15px; border-radius: 8px; display: flex; flex-direction: column; transition: transform 0.1s; }
                .card:hover { border-color: var(--vscode-focusBorder); transform: translateY(-2px); }
                .name { font-weight: bold; font-size: 1.1em; margin-bottom: 5px; color: var(--vscode-textLink-foreground); }
                .desc { font-size: 0.9em; opacity: 0.8; flex-grow: 1; margin-bottom: 15px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
                .actions { display: flex; gap: 8px; }
                button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; cursor: pointer; border-radius: 4px; font-size: 12px; }
                button:hover { filter: brightness(1.2); }
                button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
                button.danger { background: transparent; border: 1px solid var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
                button.danger:hover { background: var(--vscode-errorForeground); color: white; }
                .scope-badge { font-size: 9px; padding: 2px 6px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); text-transform: uppercase; font-weight: bold; }
            </style>
        </head>
        <body>
            <div class="header">
                <h2 style="margin:0;">💡 Skills Library</h2>
                <div style="display:flex; gap:10px;">
                    <button class="secondary" onclick="vscode.postMessage({command:'refresh'})">Refresh</button>
                    <button onclick="vscode.postMessage({command:'add'})">+ New Skill</button>
                </div>
            </div>

            <div class="search-container">
                <input type="text" id="search" placeholder="Search skills by name, description or content..." oninput="filter()">
            </div>

            <div id="content">
                ${categories.map(cat => {
                    const catSkills = skills.filter(s => (s.category || 'Uncategorized') === cat);
                    return `
                    <div class="category-section" data-category="${cat}">
                        <div class="category-title"><span class="codicon codicon-folder"></span> ${cat} (${catSkills.length})</div>
                        <div class="grid">
                            ${catSkills.map(s => `
                                <div class="card" data-search="${(s.name + (s.description || '')).toLowerCase().replace(/"/g, '&quot;')}">
                                    <div style="display:flex; justify-content:space-between; align-items:start;">
                                        <div class="name">${s.name}</div>
                                        <span class="scope-badge">${s.scope}</span>
                                    </div>
                                    <div class="desc">${(s.description || 'No description provided.').substring(0, 500)}</div>
                                    <div class="actions">
                                        <button onclick="vscode.postMessage({command:'edit', id:'${s.id}'})">Edit</button>
                                        <button class="danger" onclick="vscode.postMessage({command:'delete', id:'${s.id}', scope:'${s.scope}', name:'${s.name.replace(/'/g, "\\'")}'})">Delete</button>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>`;
                }).join('')}
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                function filter() {
                    const searchInput = document.getElementById('search');
                    if (!searchInput) return;
                    const query = searchInput.value.toLowerCase();
                    const sections = document.querySelectorAll('.category-section');

                    sections.forEach(section => {
                        let hasVisible = false;
                        const sectionCards = section.querySelectorAll('.card');
                        sectionCards.forEach(card => {
                            const searchData = card.dataset.search || '';
                            const match = searchData.includes(query);
                            card.style.display = match ? 'flex' : 'none';
                            if (match) hasVisible = true;
                        });
                        section.style.display = hasVisible ? 'block' : 'none';
                    });
                }
            </script>
        </body></html>`;
    }
}