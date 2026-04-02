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
                        await this.manager.updateMemory('update', msg.id, msg.title, msg.content);
                        vscode.window.showInformationMessage(`Lollms: Memory "${msg.title}" updated.`);
                        break;
                    case 'delete':
                        await this.manager.updateMemory('delete', msg.id);
                        break;
                    case 'add_direct':
                        const id = 'mem_' + Date.now();
                        // CRITICAL: Await the update so _update() is triggered by onDidChange AFTER save
                        await this.manager.updateMemory('add', id, msg.title, msg.content);
                        vscode.window.showInformationMessage(`Lollms: New memory "${msg.title}" created.`);
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
        this._panel.webview.html = this._getHtml(memories);
    }

    private _getHtml(memories: MemoryEntry[]) {
        const escape = (str: string) => str.replace(/[&<>"']/g, (m) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[m] || m));

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); padding: 20px; background: var(--vscode-editor-background); }
                .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 10px; margin-bottom: 20px; }
                .memory-card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); padding: 15px; border-radius: 8px; margin-bottom: 15px; box-shadow: 0 2px 5px rgba(0,0,0,0.2); }
                .new-card { border: 2px dashed var(--vscode-focusBorder); display: none; margin-bottom: 25px; animation: slideDown 0.2s ease-out; }
                @keyframes slideDown { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
                label { display: block; font-size: 11px; font-weight: bold; opacity: 0.7; margin-bottom: 4px; text-transform: uppercase; }
                input, textarea { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 8px; margin-bottom: 12px; border-radius: 4px; font-family: inherit; box-sizing: border-box; }
                input:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); border-color: transparent; }
                .actions { display: flex; gap: 10px; justify-content: flex-end; }
                button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 14px; cursor: pointer; border-radius: 4px; font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
                button:hover { background: var(--vscode-button-hoverBackground); }
                button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
                button.delete-btn { background: transparent; border: 1px solid var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
                button.delete-btn:hover { background: var(--vscode-errorForeground); color: white; }
                .empty-state { text-align: center; opacity: 0.5; padding: 40px; }
            </style>
        </head>
        <body>
            <div class="header">
                <h2 style="margin:0;">🧠 Project Memories</h2>
                <button id="show-add-btn"><span style="font-size:16px;">+</span> Add New Fact</button>
            </div>

            <!-- THE NEW INLINE FORM -->
            <div id="new-memory-form" class="memory-card new-card">
                <div style="margin-bottom:10px; font-weight:bold; color:var(--vscode-focusBorder);">🆕 Create New Project Fact</div>
                <label>Title / Identifier</label>
                <input type="text" id="new-title" placeholder="e.g., Coding Standards">
                <label>Knowledge Content</label>
                <textarea id="new-content" rows="4" placeholder="Enter details the AI should always remember for this project..."></textarea>
                <div class="actions">
                    <button class="secondary" id="cancel-add-btn">Cancel</button>
                    <button id="confirm-add-btn">Create Memory</button>
                </div>
            </div>
            
            <div id="list">
                ${memories.length === 0 ? '<div class="empty-state">No memories saved yet. The AI will add facts here as you work.</div>' : ''}
                ${memories.map(m => `
                    <div class="memory-card" data-id="${m.id}">
                        <label>Title / Identifier</label>
                        <input type="text" class="title-input" value="${escape(m.title)}">
                        <label>Knowledge Content</label>
                        <textarea class="content-input" rows="4">${escape(m.content)}</textarea>
                        <div class="actions">
                            <button class="delete-btn" data-id="${m.id}">Delete</button>
                            <button class="save-btn" data-id="${m.id}">Save Changes</button>
                        </div>
                    </div>
                `).join('')}
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                const newForm = document.getElementById('new-memory-form');

                // Toggle visibility
                document.getElementById('show-add-btn').addEventListener('click', () => {
                    newForm.style.display = 'block';
                    document.getElementById('new-title').focus();
                });

                document.getElementById('cancel-add-btn').addEventListener('click', () => {
                    newForm.style.display = 'none';
                });

                // Create Logic
                document.getElementById('confirm-add-btn').addEventListener('click', () => {
                    const title = document.getElementById('new-title').value;
                    const content = document.getElementById('new-content').value;
                    if (!title.trim()) return;
                    
                    vscode.postMessage({ command: 'add_direct', title, content });
                    
                    // Reset and hide
                    document.getElementById('new-title').value = '';
                    document.getElementById('new-content').value = '';
                    newForm.style.display = 'none';
                });

                // Delegation for existing items
                document.getElementById('list').addEventListener('click', (e) => {
                    const target = e.target;
                    const id = target.getAttribute('data-id');
                    if (!id) return;

                    if (target.classList.contains('save-btn')) {
                        const card = target.closest('.memory-card');
                        const title = card.querySelector('.title-input').value;
                        const content = card.querySelector('.content-input').value;
                        vscode.postMessage({ command: 'save', id, title, content });
                    } else if (target.classList.contains('delete-btn')) {
                        vscode.postMessage({ command: 'delete', id });
                    }
                });
            </script>
        </body>
        </html>`;
    }
}