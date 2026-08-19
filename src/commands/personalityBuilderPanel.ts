import * as vscode from 'vscode';
import { Personality, PersonalityManager } from '../personalityManager';
import { LollmsAPI } from '../lollmsAPI';
import { stripThinkingTags } from '../utils';
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
        const isDefault = this._personalityManager.isDefaultPersonality(p.id);
        const all = this._personalityManager.getPersonalities().map(item => ({
            id: item.id,
            name: item.name,
            isDefault: this._personalityManager.isDefaultPersonality(item.id)
        }));
        this._panel.webview.postMessage({ 
            command: 'loadPersonality', 
            personality: p, 
            isDefault, 
            allPersonalities: all 
        });
    }

    public dispose() {
        PersonalityBuilderPanel.currentPanel = undefined;
        this._panel.dispose();
    }

    private _setWebviewMessageListener(webview: vscode.Webview) {
        webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'save':
                    await this.handleSave(message.data, message.createAsNew);
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
                case 'selectPersonality':
                    await this.handleSelectPersonality(message.id);
                    break;
                case 'resetToDefault':
                    await this.handleResetToDefault(message.id);
                    break;
                case 'newPersonality':
                    this.handleNewPersonality();
                    break;
            }
        });
    }

    private handleNewPersonality() {
        this._editingId = null;
        const all = this._personalityManager.getPersonalities().map(item => ({
            id: item.id,
            name: item.name,
            isDefault: this._personalityManager.isDefaultPersonality(item.id)
        }));
        this._panel.webview.postMessage({
            command: 'createNew',
            allPersonalities: all
        });
    }

    private async handleSelectPersonality(id: string) {
        if (!id) {
            this.handleNewPersonality();
            return;
        }

        const personality = this._personalityManager.getPersonality(id);
        if (personality) {
            this.setPersonality(personality);
        }
    }

    private async handleResetToDefault(id: string) {
        const targetId = id || this._editingId;
        if (!targetId) return;

        const defaultPersona = this._personalityManager.getDefaultPersonality(targetId);
        if (!defaultPersona) {
            vscode.window.showWarningMessage(`'${targetId}' is not a built-in default personality.`);
            return;
        }

        this._panel.webview.postMessage({
            command: 'fillSystemPrompt',
            content: defaultPersona.systemPrompt,
            description: defaultPersona.description,
            name: defaultPersona.name
        });

        vscode.window.showInformationMessage(`System prompt reset to default for '${defaultPersona.name}'.`);
    }

    private async handleSave(data: any, createAsNew: boolean = false) {
        const { name, description, systemPrompt } = data;
        
        if (!name || !name.trim()) {
            vscode.window.showErrorMessage("Personality name is required.");
            return;
        }

        const shouldCreateNew = createAsNew || !this._editingId;
        const targetId = shouldCreateNew ? `custom_${Date.now()}` : this._editingId!;
        const isDefault = !shouldCreateNew && this._personalityManager.isDefaultPersonality(targetId);

        const personality: Personality = {
            id: targetId,
            name: name.trim(),
            description: description?.trim() || '',
            systemPrompt: systemPrompt || '',
            isDefault
        };

        if (shouldCreateNew) {
            await this._personalityManager.addPersonality(personality);
            this._editingId = personality.id;
            vscode.window.showInformationMessage(`Personality '${personality.name}' created successfully.`);
        } else {
            await this._personalityManager.updatePersonality(personality);
            vscode.window.showInformationMessage(`Changes applied to '${personality.name}'.`);
        }

        const all = this._personalityManager.getPersonalities().map(item => ({
            id: item.id,
            name: item.name,
            isDefault: this._personalityManager.isDefaultPersonality(item.id)
        }));

        this._panel.webview.postMessage({
            command: 'loadPersonality',
            personality,
            isDefault: this._personalityManager.isDefaultPersonality(personality.id),
            allPersonalities: all
        });

        vscode.commands.executeCommand('lollms-vs-coder.refreshPersonalities');
    }

    private async handleGenerate(userDescription: string) {
        if (!userDescription || !userDescription.trim()) {
            vscode.window.showErrorMessage("Please provide a description for generation.");
            return;
        }

        this._panel.webview.postMessage({ command: 'setLoading', loading: true });

        try {
            const systemPrompt = `You are an expert prompt engineer. Your task is to create a detailed, highly effective system prompt for an LLM based on a user's description of a persona.

**INSTRUCTIONS:**
1. Analyze the persona description carefully.
2. Define the persona's tone, style, technical expertise, and operational constraints.
3. Write a comprehensive, production-grade system prompt that embodies this persona.
4. Output ONLY the system prompt text. Do not add preamble, conversational fillers, or markdown code fences around the prompt.`;

            const userPrompt = `Create a system prompt for the following persona:\n"${userDescription.trim()}"`;

            const generated = await this._lollmsAPI.sendChat([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ]);

            const cleanPrompt = stripThinkingTags(generated)
                .replace(/^```(?:\w+)?\n?/, '')
                .replace(/\n?```$/, '')
                .trim();

            this._panel.webview.postMessage({ command: 'fillSystemPrompt', content: cleanPrompt });

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
                    const all = this._personalityManager.getPersonalities().map(item => ({
                        id: item.id,
                        name: item.name,
                        isDefault: this._personalityManager.isDefaultPersonality(item.id)
                    }));
                    this._editingId = null; // New import is treated as a new draft
                    this._panel.webview.postMessage({ 
                        command: 'loadPersonality', 
                        personality: {
                            id: '',
                            name: parsed.name || '',
                            description: parsed.description || '',
                            systemPrompt: parsed.systemPrompt || ''
                        },
                        isDefault: false,
                        allPersonalities: all
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
        
        const all = this._personalityManager.getPersonalities().map(item => ({
            id: item.id,
            name: item.name,
            isDefault: this._personalityManager.isDefaultPersonality(item.id)
        }));

        const isDefault = personality ? this._personalityManager.isDefaultPersonality(personality.id) : false;

        const initialData = personality ? 
            JSON.stringify(personality)
                .replace(/</g, '\\u003c')
                .replace(/\//g, '\\/') : 
            'null';

        const initialAll = JSON.stringify(all)
            .replace(/</g, '\\u003c')
            .replace(/\//g, '\\/');

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Personality Builder</title>
            <link href="${codiconUri}" rel="stylesheet" />
            <style>
                :root {
                    --bg-color: var(--vscode-editor-background);
                    --fg-color: var(--vscode-editor-foreground);
                    --border-color: var(--vscode-widget-border);
                    --input-bg: var(--vscode-input-background);
                    --input-fg: var(--vscode-input-foreground);
                    --btn-bg: var(--vscode-button-background);
                    --btn-fg: var(--vscode-button-foreground);
                    --btn-hover: var(--vscode-button-hoverBackground);
                    --btn-sec-bg: var(--vscode-button-secondaryBackground);
                    --btn-sec-fg: var(--vscode-button-secondaryForeground);
                    --btn-sec-hover: var(--vscode-button-secondaryHoverBackground);
                }

                body {
                    font-family: var(--vscode-font-family);
                    background-color: var(--bg-color);
                    color: var(--fg-color);
                    padding: 20px;
                    display: flex;
                    flex-direction: column;
                    height: 100vh;
                    box-sizing: border-box;
                    margin: 0;
                }

                .container { 
                    max-width: 900px; 
                    margin: 0 auto; 
                    width: 100%; 
                    display: flex; 
                    flex-direction: column; 
                    gap: 14px; 
                    flex: 1; 
                    min-height: 0;
                }

                .header-bar {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    border-bottom: 1px solid var(--border-color);
                    padding-bottom: 12px;
                    gap: 12px;
                    flex-wrap: wrap;
                }

                .header-title {
                    font-size: 16px;
                    font-weight: 600;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .mode-badge {
                    font-size: 11px;
                    padding: 2px 8px;
                    border-radius: 12px;
                    background-color: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    font-weight: normal;
                }

                .mode-badge.default {
                    background-color: var(--vscode-charts-orange);
                    color: #fff;
                }

                .mode-badge.custom {
                    background-color: var(--vscode-charts-blue);
                    color: #fff;
                }

                .mode-badge.new {
                    background-color: var(--vscode-charts-green);
                    color: #fff;
                }

                .selector-row {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    background: var(--vscode-editorWidget-background);
                    padding: 10px 14px;
                    border-radius: 6px;
                    border: 1px solid var(--border-color);
                }

                .selector-row label {
                    font-size: 12px;
                    font-weight: 600;
                    white-space: nowrap;
                    opacity: 0.8;
                }

                select {
                    flex: 1;
                    background-color: var(--input-bg);
                    color: var(--input-fg);
                    border: 1px solid var(--vscode-input-border);
                    padding: 6px 10px;
                    border-radius: 4px;
                    font-family: inherit;
                    font-size: 12px;
                    outline: none;
                }
                select:focus { border-color: var(--vscode-focusBorder); }

                .form-group { display: flex; flex-direction: column; gap: 5px; }
                .form-group.grow { flex: 1; min-height: 0; }
                
                label { 
                    font-size: 12px;
                    font-weight: 600; 
                    color: var(--vscode-descriptionForeground); 
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                
                input, textarea {
                    background-color: var(--input-bg);
                    color: var(--input-fg);
                    border: 1px solid var(--vscode-input-border);
                    padding: 8px 10px;
                    border-radius: 4px;
                    font-family: var(--vscode-editor-font-family);
                    font-size: 12px;
                    box-sizing: border-box;
                }
                input:focus, textarea:focus { border-color: var(--vscode-focusBorder); outline: none; }
                
                textarea { resize: vertical; min-height: 80px; }
                #systemPrompt { 
                    flex: 1; 
                    min-height: 180px; 
                    font-family: var(--vscode-editor-font-family);
                    line-height: 1.5;
                }

                .toolbar { display: flex; gap: 8px; align-items: center; }
                
                button {
                    background-color: var(--btn-bg);
                    color: var(--btn-fg);
                    border: none; 
                    padding: 6px 12px; 
                    border-radius: 4px; 
                    cursor: pointer;
                    display: flex; 
                    align-items: center; 
                    gap: 6px;
                    font-size: 12px;
                    font-weight: 500;
                    transition: background-color 0.15s ease;
                }
                button:hover { background-color: var(--btn-hover); }
                
                button.secondary {
                    background-color: var(--btn-sec-bg);
                    color: var(--btn-sec-fg);
                }
                button.secondary:hover { background-color: var(--btn-sec-hover); }

                button.warning {
                    background-color: transparent;
                    color: var(--vscode-charts-orange);
                    border: 1px solid var(--vscode-charts-orange);
                }
                button.warning:hover {
                    background-color: var(--vscode-charts-orange);
                    color: #fff;
                }

                button.success {
                    background-color: var(--vscode-charts-green);
                    color: #fff;
                }
                button.success:hover {
                    filter: brightness(1.1);
                }

                .ai-gen-box {
                    display: flex; 
                    gap: 8px; 
                    align-items: center;
                    background-color: var(--vscode-editorWidget-background);
                    padding: 8px 12px; 
                    border-radius: 6px; 
                    border: 1px solid var(--border-color);
                    margin-bottom: 6px;
                }
                .ai-gen-box input { flex: 1; }

                .action-footer {
                    display: flex;
                    gap: 10px;
                    border-top: 1px solid var(--border-color);
                    padding-top: 12px;
                    margin-top: auto;
                    flex-wrap: wrap;
                }

                .action-footer button {
                    padding: 8px 16px;
                    font-size: 13px;
                }

                #spinner {
                    display: none !important;
                    animation: spin 1s linear infinite;
                }
                #spinner.visible {
                    display: inline-block !important;
                }
                @keyframes spin { 100% { transform: rotate(360deg); } }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header-bar">
                    <div class="header-title">
                        <i class="codicon codicon-person"></i>
                        <span>Personality Builder</span>
                        <span id="modeBadge" class="mode-badge new">New Personality</span>
                    </div>
                    <div class="toolbar">
                        <button class="secondary" id="importBtn" title="Import personality from YAML file"><i class="codicon codicon-cloud-upload"></i> Import</button>
                        <button class="secondary" id="exportBtn" title="Export current personality to YAML file"><i class="codicon codicon-cloud-download"></i> Export</button>
                    </div>
                </div>

                <div class="selector-row">
                    <label for="personaSelect"><i class="codicon codicon-list-selection"></i> Persona:</label>
                    <select id="personaSelect">
                        <option value="">✨ [Create New from Scratch]</option>
                    </select>
                    <button class="secondary" id="newPersonaBtn" title="Clear form and create from scratch">
                        <i class="codicon codicon-add"></i> Create New
                    </button>
                </div>

                <div class="form-group">
                    <label for="name">Name</label>
                    <input type="text" id="name" placeholder="e.g., Python Expert">
                </div>

                <div class="form-group">
                    <label for="description">Description</label>
                    <input type="text" id="description" placeholder="Brief summary of skills, tone, and focus">
                </div>

                <div class="form-group grow">
                    <label for="systemPrompt">
                        <span>System Prompt</span>
                        <button type="button" class="warning" id="resetPromptBtn" style="display:none; padding:2px 8px; font-size:11px;" title="Reset this default persona back to its factory prompt">
                            <i class="codicon codicon-discard"></i> Reset Default Prompt
                        </button>
                    </label>
                    
                    <div class="ai-gen-box">
                        <i class="codicon codicon-sparkle" style="color:var(--vscode-charts-purple);"></i>
                        <input type="text" id="genDesc" placeholder="Describe the persona to auto-generate prompt (e.g., 'An expert Linux kernel and C programmer who enforces strict memory safety')">
                        <button id="genBtn" class="secondary"><i class="codicon codicon-wand"></i> Generate with AI</button>
                        <i class="codicon codicon-loading spinner" id="spinner"></i>
                    </div>

                    <textarea id="systemPrompt" placeholder="You are an expert software engineer..."></textarea>
                </div>

                <div class="action-footer">
                    <button id="saveBtn" class="success" style="flex:1; justify-content:center;">
                        <i class="codicon codicon-save"></i> <span id="saveBtnLabel">Create Personality</span>
                    </button>
                    <button id="saveCopyBtn" class="secondary" style="display:none; justify-content:center;">
                        <i class="codicon codicon-copy"></i> Save as New Copy
                    </button>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                let currentPersonality = ${initialData};
                let allPersonalities = ${initialAll};
                let isCurrentDefault = ${isDefault ? 'true' : 'false'};

                const personaSelect = document.getElementById('personaSelect');
                const newPersonaBtn = document.getElementById('newPersonaBtn');
                const nameInput = document.getElementById('name');
                const descInput = document.getElementById('description');
                const promptInput = document.getElementById('systemPrompt');
                const genDescInput = document.getElementById('genDesc');
                const spinner = document.getElementById('spinner');
                const genBtn = document.getElementById('genBtn');
                const saveBtn = document.getElementById('saveBtn');
                const saveBtnLabel = document.getElementById('saveBtnLabel');
                const saveCopyBtn = document.getElementById('saveCopyBtn');
                const resetPromptBtn = document.getElementById('resetPromptBtn');
                const modeBadge = document.getElementById('modeBadge');

                function populateSelector() {
                    const currentId = currentPersonality ? currentPersonality.id : '';
                    personaSelect.innerHTML = '<option value="">✨ [Create New from Scratch]</option>';
                    
                    allPersonalities.forEach(p => {
                        const opt = document.createElement('option');
                        opt.value = p.id;
                        opt.textContent = (p.isDefault ? '⭐ ' : '👤 ') + p.name;
                        if (p.id === currentId) {
                            opt.selected = true;
                        }
                        personaSelect.appendChild(opt);
                    });
                }

                function updateUIState() {
                    populateSelector();
                    
                    if (currentPersonality && currentPersonality.id) {
                        nameInput.value = currentPersonality.name || '';
                        descInput.value = currentPersonality.description || '';
                        promptInput.value = currentPersonality.systemPrompt || '';
                        
                        saveBtnLabel.textContent = 'Apply Changes';
                        saveCopyBtn.style.display = 'inline-flex';

                        if (isCurrentDefault) {
                            modeBadge.textContent = 'Default Persona';
                            modeBadge.className = 'mode-badge default';
                            resetPromptBtn.style.display = 'inline-flex';
                        } else {
                            modeBadge.textContent = 'Custom Persona';
                            modeBadge.className = 'mode-badge custom';
                            resetPromptBtn.style.display = 'none';
                        }
                    } else {
                        nameInput.value = currentPersonality ? (currentPersonality.name || '') : '';
                        descInput.value = currentPersonality ? (currentPersonality.description || '') : '';
                        promptInput.value = currentPersonality ? (currentPersonality.systemPrompt || '') : '';

                        saveBtnLabel.textContent = 'Create Personality';
                        saveCopyBtn.style.display = 'none';
                        resetPromptBtn.style.display = 'none';
                        modeBadge.textContent = 'New Personality';
                        modeBadge.className = 'mode-badge new';
                    }
                }

                personaSelect.addEventListener('change', (e) => {
                    const selectedId = e.target.value;
                    if (selectedId) {
                        vscode.postMessage({ command: 'selectPersonality', id: selectedId });
                    } else {
                        vscode.postMessage({ command: 'newPersonality' });
                    }
                });

                newPersonaBtn.addEventListener('click', () => {
                    vscode.postMessage({ command: 'newPersonality' });
                });

                resetPromptBtn.addEventListener('click', () => {
                    if (currentPersonality && currentPersonality.id) {
                        vscode.postMessage({ command: 'resetToDefault', id: currentPersonality.id });
                    }
                });

                saveBtn.addEventListener('click', () => {
                    vscode.postMessage({
                        command: 'save',
                        createAsNew: !currentPersonality || !currentPersonality.id,
                        data: {
                            name: nameInput.value,
                            description: descInput.value,
                            systemPrompt: promptInput.value
                        }
                    });
                });

                saveCopyBtn.addEventListener('click', () => {
                    vscode.postMessage({
                        command: 'save',
                        createAsNew: true,
                        data: {
                            name: nameInput.value ? (nameInput.value + ' (Copy)') : 'Custom Personality',
                            description: descInput.value,
                            systemPrompt: promptInput.value
                        }
                    });
                });

                genBtn.addEventListener('click', () => {
                    const desc = genDescInput.value;
                    if (desc) {
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
                            currentPersonality = message.personality;
                            isCurrentDefault = !!message.isDefault;
                            if (message.allPersonalities) {
                                allPersonalities = message.allPersonalities;
                            }
                            updateUIState();
                            break;
                        case 'createNew':
                            currentPersonality = null;
                            isCurrentDefault = false;
                            if (message.allPersonalities) {
                                allPersonalities = message.allPersonalities;
                            }
                            updateUIState();
                            nameInput.focus();
                            break;
                        case 'fillSystemPrompt':
                            promptInput.value = message.content;
                            if (message.description) descInput.value = message.description;
                            if (message.name && (!nameInput.value || nameInput.value === '')) nameInput.value = message.name;
                            break;
                        case 'setLoading':
                            if (message.loading) {
                                spinner.classList.add('visible');
                            } else {
                                spinner.classList.remove('visible');
                            }
                            document.getElementById('genBtn').disabled = !!message.loading;
                            break;
                    }
                });

                updateUIState();
            </script>
        </body>
        </html>`;
    }
}