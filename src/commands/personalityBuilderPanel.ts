import * as vscode from 'vscode';
import { Personality, PersonalityManager } from '../personalityManager';
import { LollmsAPI } from '../lollmsAPI';
import * as yaml from 'js-yaml';

export class PersonalityBuilderPanel {
    public static currentPanel: PersonalityBuilderPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _personalityManager: PersonalityManager;
    private readonly _lollmsAPI: LollmsAPI;
    private _editingId: string | null = null;

    public static createOrShow(
        extensionUri: vscode.Uri, 
        personalityManager: PersonalityManager, 
        lollmsAPI: LollmsAPI,
        personalityToEdit?: Personality
    ) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (PersonalityBuilderPanel.currentPanel) {
            PersonalityBuilderPanel.currentPanel._panel.reveal(column);
            if (personalityToEdit) {
                PersonalityBuilderPanel.currentPanel.setPersonality(personalityToEdit);
            }
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'lollmsPersonalityBuilder',
            'Personality Builder',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out', 'styles')]
            }
        );

        PersonalityBuilderPanel.currentPanel = new PersonalityBuilderPanel(panel, extensionUri, personalityManager, lollmsAPI, personalityToEdit);
    }

    private constructor(
        panel: vscode.WebviewPanel, 
        extensionUri: vscode.Uri, 
        personalityManager: PersonalityManager, 
        lollmsAPI: LollmsAPI,
        personalityToEdit?: Personality
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._personalityManager = personalityManager;
        this._lollmsAPI = lollmsAPI;

        if (personalityToEdit) {
            this._editingId = personalityToEdit.id;
        }

        this._panel.webview.html = this._getHtmlForWebview(personalityToEdit);
        
        this._panel.onDidDispose(() => this.dispose(), null, []);
        this._setWebviewMessageListener(this._panel.webview);
    }

    public setPersonality(p: Personality) {
        this._editingId = p.id;
        this._panel.webview.postMessage({ command: 'loadPersonality', personality: p });
    }

    public dispose() {
        PersonalityBuilderPanel.currentPanel = undefined;
        this._panel.dispose();
    }

    private _setWebviewMessageListener(webview: vscode.Webview) {
        webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'save':
                    await this.handleSave(message.data);
                    break;
                case 'generate':
                    await this.handleGenerate(message.description);
                    break;
                case 'export':
                    await this.handleExport(message.data);
                    break;
                case 'import':
                    await this.handleImport();
                    break;
            }
        });
    }

    private async handleSave(data: any) {
        const { name, description, systemPrompt } = data;
        
        if (!name) {
            vscode.window.showErrorMessage("Personality name is required.");
            return;
        }

        const personality: Personality = {
            id: this._editingId || Date.now().toString(),
            name,
            description,
            systemPrompt
        };

        if (this._editingId) {
            await this._personalityManager.updatePersonality(personality);
            vscode.window.showInformationMessage(`Personality '${name}' updated.`);
        } else {
            await this._personalityManager.addPersonality(personality);
            vscode.window.showInformationMessage(`Personality '${name}' created.`);
            this._editingId = personality.id; // Switch to edit mode
        }
    }

    private async handleGenerate(userDescription: string) {
        if (!userDescription) {
            vscode.window.showErrorMessage("Please provide a description for generation.");
            return;
        }

        this._panel.webview.postMessage({ command: 'setLoading', loading: true });

        try {
            const systemPrompt = `You are an expert prompt engineer. Your task is to create a detailed, highly effective system prompt for an LLM based on a user's description of a persona.
            
**INSTRUCTIONS:**
1. Analyze the user's description carefully.
2. Define the persona's tone, style, expertise, and constraints.
3. Write a comprehensive system prompt that embodies this persona.
4. Output ONLY the system prompt text. Do not add conversational fillers.

**User Description:** "${userDescription}"`;

            const generated = await this._lollmsAPI.sendChat([{ role: 'system', content: systemPrompt }]);
            this._panel.webview.postMessage({ command: 'fillSystemPrompt', content: generated });

        } catch (error: any) {
            vscode.window.showErrorMessage(`Generation failed: ${error.message}`);
        } finally {
            this._panel.webview.postMessage({ command: 'setLoading', loading: false });
        }
    }

    private async handleExport(data: any) {
        const { name, description, systemPrompt } = data;
        const personality = { name, description, systemPrompt };
        
        try {
            const yamlStr = yaml.dump(personality);
            const uri = await vscode.window.showSaveDialog({
                filters: { 'YAML': ['yaml', 'yml'] },
                saveLabel: 'Export Personality'
            });

            if (uri) {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(yamlStr, 'utf8'));
                vscode.window.showInformationMessage("Personality exported successfully.");
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Export failed: ${e.message}`);
        }
    }

    private async handleImport() {
        try {
            const uris = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: { 'YAML': ['yaml', 'yml'] },
                openLabel: 'Import Personality'
            });

            if (uris && uris[0]) {
                const content = await vscode.workspace.fs.readFile(uris[0]);
                const str = Buffer.from(content).toString('utf8');
                const parsed = yaml.load(str) as any;

                if (parsed && typeof parsed === 'object') {
                    this._panel.webview.postMessage({ 
                        command: 'loadPersonality', 
                        personality: {
                            name: parsed.name || '',
                            description: parsed.description || '',
                            systemPrompt: parsed.systemPrompt || ''
                        }
                    });
                    vscode.window.showInformationMessage("Personality imported.");
                } else {
                    throw new Error("Invalid YAML format.");
                }
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Import failed: ${e.message}`);
        }
    }

    private _getHtmlForWebview(personality?: Personality): string {
        const codiconUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'));
        
        // FIX: Do NOT use .replace(/"/g, '&quot;') for script injection. 
        // Use standard JSON stringify which is valid JS object syntax.
        // We replace < to \u003c to prevent script injection attacks.
        const initialData = personality ? JSON.stringify(personality).replace(/</g, '\\u003c') : 'null';

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Personality Builder</title>
            <link href="${codiconUri}" rel="stylesheet" />
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    padding: 20px;
                    display: flex;
                    flex-direction: column;
                    height: 100vh;
                    box-sizing: border-box;
                }
                .container { max-width: 800px; margin: 0 auto; width: 100%; display: flex; flex-direction: column; gap: 15px; flex: 1; }
                h1 { font-weight: 300; margin-bottom: 20px; text-align: center; }
                
                .form-group { display: flex; flex-direction: column; gap: 5px; }
                label { font-weight: 600; color: var(--vscode-descriptionForeground); }
                
                input, textarea {
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    padding: 8px;
                    border-radius: 4px;
                    font-family: var(--vscode-editor-font-family);
                }
                input:focus, textarea:focus { border-color: var(--vscode-focusBorder); outline: none; }
                
                textarea { resize: vertical; min-height: 100px; }
                #systemPrompt { flex: 1; min-height: 200px; }

                .toolbar { display: flex; gap: 10px; margin-bottom: 10px; justify-content: flex-end; }
                
                button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none; padding: 8px 14px; border-radius: 4px; cursor: pointer;
                    display: flex; align-items: center; gap: 6px;
                    font-size: 13px;
                }
                button:hover { background-color: var(--vscode-button-hoverBackground); }
                button.secondary {
                    background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                }
                button.secondary:hover { background-color: var(--vscode-button-secondaryHoverBackground); }

                .ai-gen-box {
                    display: flex; gap: 10px; align-items: center;
                    background-color: var(--vscode-editorWidget-background);
                    padding: 10px; border-radius: 6px; border: 1px solid var(--vscode-widget-border);
                    margin-bottom: 10px;
                }
                .ai-gen-box input { flex: 1; }

                .spinner {
                    animation: spin 1s linear infinite;
                    display: none;
                }
                @keyframes spin { 100% { transform: rotate(360deg); } }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Personality Builder</h1>
                
                <div class="toolbar">
                    <button class="secondary" id="importBtn"><i class="codicon codicon-cloud-upload"></i> Import YAML</button>
                    <button class="secondary" id="exportBtn"><i class="codicon codicon-cloud-download"></i> Export YAML</button>
                </div>

                <div class="form-group">
                    <label for="name">Name</label>
                    <input type="text" id="name" placeholder="e.g., Python Expert">
                </div>

                <div class="form-group">
                    <label for="description">Description</label>
                    <input type="text" id="description" placeholder="Short description of capabilities">
                </div>

                <div class="form-group" style="flex: 1; display: flex; flex-direction: column;">
                    <label for="systemPrompt">System Prompt</label>
                    
                    <div class="ai-gen-box">
                        <i class="codicon codicon-sparkle"></i>
                        <input type="text" id="genDesc" placeholder="Describe the persona to generate prompt with AI (e.g., 'A grumpy sysadmin who loves bash')">
                        <button id="genBtn" class="secondary">Generate</button>
                        <i class="codicon codicon-loading spinner" id="spinner"></i>
                    </div>

                    <textarea id="systemPrompt" placeholder="You are..."></textarea>
                </div>

                <button id="saveBtn" style="width: 100%; justify-content: center; margin-top: 10px;"><i class="codicon codicon-save"></i> Save Personality</button>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                const initialData = ${initialData};

                const nameInput = document.getElementById('name');
                const descInput = document.getElementById('description');
                const promptInput = document.getElementById('systemPrompt');
                const genDescInput = document.getElementById('genDesc');
                const spinner = document.getElementById('spinner');

                if (initialData) {
                    nameInput.value = initialData.name || '';
                    descInput.value = initialData.description || '';
                    promptInput.value = initialData.systemPrompt || '';
                }

                document.getElementById('saveBtn').addEventListener('click', () => {
                    vscode.postMessage({
                        command: 'save',
                        data: {
                            name: nameInput.value,
                            description: descInput.value,
                            systemPrompt: promptInput.value
                        }
                    });
                });

                document.getElementById('genBtn').addEventListener('click', () => {
                    const desc = genDescInput.value;
                    if(desc) {
                        vscode.postMessage({ command: 'generate', description: desc });
                    }
                });

                document.getElementById('exportBtn').addEventListener('click', () => {
                    vscode.postMessage({
                        command: 'export',
                        data: {
                            name: nameInput.value,
                            description: descInput.value,
                            systemPrompt: promptInput.value
                        }
                    });
                });

                document.getElementById('importBtn').addEventListener('click', () => {
                    vscode.postMessage({ command: 'import' });
                });

                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.command) {
                        case 'loadPersonality':
                            const p = message.personality;
                            nameInput.value = p.name || '';
                            descInput.value = p.description || '';
                            promptInput.value = p.systemPrompt || '';
                            break;
                        case 'fillSystemPrompt':
                            promptInput.value = message.content;
                            break;
                        case 'setLoading':
                            spinner.style.display = message.loading ? 'block' : 'none';
                            document.getElementById('genBtn').disabled = message.loading;
                            break;
                    }
                });
            </script>
        </body>
        </html>`;
    }
}
