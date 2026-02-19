import * as vscode from 'vscode';
import { Skill, SkillsManager } from '../skillsManager';

export class SkillEditorPanel {
    public static currentPanel: SkillEditorPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _skillsManager: SkillsManager;
    private _skill: Skill | null = null;

    public static createOrShow(extensionUri: vscode.Uri, skillsManager: SkillsManager, skillToEdit?: Skill) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (SkillEditorPanel.currentPanel) {
            SkillEditorPanel.currentPanel._panel.reveal(column);
            if (skillToEdit) {
                SkillEditorPanel.currentPanel.loadSkill(skillToEdit);
            }
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'lollmsSkillEditor',
            'Skill Editor',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true, // Keep state when switching tabs
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out', 'styles')]
            }
        );

        SkillEditorPanel.currentPanel = new SkillEditorPanel(panel, extensionUri, skillsManager, skillToEdit);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, skillsManager: SkillsManager, skillToEdit?: Skill) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._skillsManager = skillsManager;
        this._skill = skillToEdit || null;

        this._panel.webview.html = this._getHtmlForWebview();
        this._setWebviewMessageListener();
        
        if (this._skill) {
            this.loadSkill(this._skill);
        }

        this._panel.onDidDispose(() => {
            SkillEditorPanel.currentPanel = undefined;
        }, null, []);
    }

    private loadSkill(skill: Skill) {
        this._skill = skill;
        this._panel.webview.postMessage({ command: 'load', skill });
    }

    private _setWebviewMessageListener() {
        this._panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'save':
                    await this.handleSave(message.data);
                    break;
                case 'cancel':
                    this._panel.dispose();
                    break;
            }
        });
    }

    private async handleSave(data: any) {
        if (!data.name || !data.content) {
            vscode.window.showErrorMessage("Name and Content are required.");
            return;
        }

        const id = this._skill ? this._skill.id : ('skill-' + Date.now());
        
        const skill: Omit<Skill, 'timestamp'> = {
            id,
            name: data.name,
            description: data.description || '',
            category: data.category || '',
            language: data.language || 'markdown',
            content: data.content
        };

        await this._skillsManager.addOrUpdateSkill(skill);
        vscode.window.showInformationMessage(`Skill '${data.name}' saved.`);
        vscode.commands.executeCommand('lollms-vs-coder.refreshSkills');
        this._panel.dispose();
    }

    private _getHtmlForWebview(): string {
        const codiconUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'));

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <link href="${codiconUri}" rel="stylesheet" />
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    padding: 20px;
                    display: flex; flex-direction: column; height: 100vh; box-sizing: border-box;
                }
                .form-group { display: flex; flex-direction: column; gap: 5px; margin-bottom: 15px; }
                label { font-weight: 600; font-size: 12px; color: var(--vscode-descriptionForeground); text-transform: uppercase; }
                input, textarea, select {
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    padding: 8px; border-radius: 4px;
                    font-family: var(--vscode-editor-font-family);
                }
                textarea { flex: 1; min-height: 200px; resize: none; font-family: 'Consolas', 'Courier New', monospace; }
                .row { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
                .footer { display: flex; justify-content: flex-end; gap: 10px; padding-top: 15px; border-top: 1px solid var(--vscode-widget-border); }
                button {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;
                    display: flex; align-items: center; gap: 6px;
                }
                button:hover { background: var(--vscode-button-hoverBackground); }
                button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
            </style>
        </head>
        <body>
            <div class="form-group">
                <label>Skill Name</label>
                <input type="text" id="name" placeholder="e.g., Python Data Cleaning">
            </div>

            <div class="form-group">
                <label>Description</label>
                <input type="text" id="description" placeholder="What does this skill teach the AI?">
            </div>

            <div class="row">
                <div class="form-group">
                    <label>Folder / Category</label>
                    <input type="text" id="category" placeholder="e.g., programming/python">
                </div>
                <div class="form-group">
                    <label>Language</label>
                    <select id="language">
                        <option value="markdown">Markdown / Text</option>
                        <option value="python">Python</option>
                        <option value="javascript">JavaScript</option>
                        <option value="typescript">TypeScript</option>
                        <option value="json">JSON / Skill</option>
                    </select>
                </div>
            </div>

            <div class="form-group" style="flex: 1;">
                <label>Content</label>
                <textarea id="content" placeholder="Paste documentation, code snippets, or rules here..."></textarea>
            </div>

            <div class="footer">
                <button class="secondary" id="cancelBtn">Cancel</button>
                <button id="saveBtn"><i class="codicon codicon-save"></i> Save Skill</button>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                const fields = ['name', 'description', 'category', 'language', 'content'];

                window.addEventListener('message', event => {
                    if (event.data.command === 'load') {
                        const skill = event.data.skill;
                        fields.forEach(f => {
                            document.getElementById(f).value = skill[f] || '';
                        });
                    }
                });

                document.getElementById('saveBtn').onclick = () => {
                    const data = {};
                    fields.forEach(f => data[f] = document.getElementById(f).value);
                    vscode.postMessage({ command: 'save', data });
                };

                document.getElementById('cancelBtn').onclick = () => {
                    vscode.postMessage({ command: 'cancel' });
                };
            </script>
        </body>
        </html>`;
    }
}
