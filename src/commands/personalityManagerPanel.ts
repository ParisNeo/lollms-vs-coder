import * as vscode from 'vscode';
import { PersonalityManager, Personality } from '../personalityManager';

export class PersonalityManagerPanel {
    public static currentPanel: PersonalityManagerPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri, manager: PersonalityManager) {
        if (PersonalityManagerPanel.currentPanel) {
            PersonalityManagerPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'personalitiesManager',
            '🎭 Expert Persona Manager',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        PersonalityManagerPanel.currentPanel = new PersonalityManagerPanel(panel, extensionUri, manager);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, private manager: PersonalityManager) {
        this._panel = panel;
        this._update();
        
        this._panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case 'edit':
                    const persona = this.manager.getPersonality(msg.id);
                    if (persona) {
                        vscode.commands.executeCommand('lollms-vs-coder.editPersonality', persona);
                    } else {
                        vscode.window.showErrorMessage(`Lookup failed: Could not find persona with ID: ${msg.id}`);
                    }
                    break;
                case 'delete':
                    const confirmDelete = await vscode.window.showWarningMessage(
                        `Are you sure you want to delete expert persona "${msg.name}"?`,
                        { modal: true },
                        "Delete"
                    );
                    if (confirmDelete === "Delete") {
                        await this.manager.deletePersonality(msg.id);
                        this._update();
                        vscode.window.showInformationMessage(`Persona "${msg.name}" has been deleted.`);
                    }
                    break;
                case 'add':
                    vscode.commands.executeCommand('lollms-vs-coder.createPersonality');
                    break;
                case 'refresh':
                    this._update();
                    break;
            }
        }, null, this._disposables);

        this._panel.onDidDispose(() => {
            PersonalityManagerPanel.currentPanel = undefined;
            this._disposables.forEach(d => d.dispose());
        }, null, this._disposables);
    }

    private _update() {
        const personas = this.manager.getPersonalities();
        this._panel.webview.html = this._getHtml(personas);
    }

    private _getHtml(personas: Personality[]) {
        const categories = [...new Set(personas.map(p => p.category || 'General Experts'))].sort();

        return `<!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); padding: 20px; background: var(--vscode-editor-background); }
                .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 10px; position: sticky; top: 0; background: var(--vscode-editor-background); z-index: 100; }
                .search-container { margin-bottom: 20px; }
                input#search { width: 100%; padding: 8px 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; outline: none; }
                
                .category-section { margin-bottom: 30px; }
                .category-title { font-size: 12px; font-weight: bold; text-transform: uppercase; opacity: 0.6; margin-bottom: 15px; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 5px; }
                
                .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 15px; }
                .card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); padding: 15px; border-radius: 8px; display: flex; flex-direction: column; }
                .card:hover { border-color: var(--vscode-focusBorder); }
                .name { font-weight: bold; font-size: 1.1em; margin-bottom: 5px; color: var(--vscode-charts-purple); }
                .desc { font-size: 0.9em; opacity: 0.8; flex-grow: 1; margin-bottom: 15px; }
                .actions { display: flex; gap: 8px; }
                button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; cursor: pointer; border-radius: 4px; font-size: 12px; }
                button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
                button.danger { background: transparent; border: 1px solid var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
                .badge { font-size: 9px; padding: 2px 6px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); text-transform: uppercase; }
            </style>
        </head>
        <body>
            <div class="header">
                <h2 style="margin:0;">🎭 Expert Personas</h2>
                <div style="display:flex; gap:10px;">
                    <button class="secondary" onclick="vscode.postMessage({command:'refresh'})">Refresh</button>
                    <button onclick="vscode.postMessage({command:'add'})">+ New Persona</button>
                </div>
            </div>

            <div class="search-container">
                <input type="text" id="search" placeholder="Search personas by name or role..." oninput="filter()">
            </div>

            <div id="content">
                ${categories.map(cat => {
                    const catPersonas = personas.filter(p => (p.category || 'General Experts') === cat);
                    return `
                    <div class="category-section">
                        <div class="category-title">${cat} (${catPersonas.length})</div>
                        <div class="grid">
                            ${catPersonas.map(p => `
                                <div class="card" data-search="${(p.name + p.description).toLowerCase()}">
                                    <div style="display:flex; justify-content:space-between;">
                                        <div class="name">${p.name}</div>
                                        ${p.isDefault ? '<span class="badge">Default</span>' : ''}
                                    </div>
                                    <div class="desc">${p.description}</div>
                                    <div class="actions">
                                        <button onclick="vscode.postMessage({command:'edit', id:'${p.id}'})">Edit</button>
                                        ${!p.isDefault ? `<button class="danger" onclick="vscode.postMessage({command:'delete', id:'${p.id}', name:'${p.name.replace(/'/g, "\\'")}'})">Delete</button>` : ''}
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
                    const query = document.getElementById('search').value.toLowerCase();
                    const sections = document.querySelectorAll('.category-section');

                    sections.forEach(section => {
                        let hasVisible = false;
                        const cards = section.querySelectorAll('.card');
                        cards.forEach(card => {
                            const match = card.dataset.search.includes(query);
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