import * as vscode from 'vscode';

export interface CustomActionData {
    prompt: string;
    actionType: 'generation' | 'information';
    save: boolean;
    title: string;
    useContext: boolean;
}


export class CustomActionModal {
    public static currentPanel: CustomActionModal | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _resolve: (value: CustomActionData | null) => void;

    public static async createOrShow(extensionUri: vscode.Uri): Promise<CustomActionData | null> {
        // Open the modal "Beside" the current editor so the code remains visible
        const column = vscode.ViewColumn.Beside;

        if (CustomActionModal.currentPanel) {
            CustomActionModal.currentPanel._panel.reveal(column);
        } else {
            const panel = vscode.window.createWebviewPanel(
                'customActionModal', 
                'Lollms: Modify Selection', 
                column,
                { 
                    enableScripts: true, 
                    localResourceRoots: [extensionUri],
                    retainContextWhenHidden: true
                }
            );
            CustomActionModal.currentPanel = new CustomActionModal(panel, extensionUri);
        }

        return new Promise<CustomActionData | null>(resolve => {
            CustomActionModal.currentPanel!._resolve = resolve;
        });
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._resolve = () => {};

        this._panel.webview.html = this._getHtmlForWebview();
        this._setWebviewMessageListener();
        this._panel.onDidDispose(() => {
            this._resolve(null); 
            CustomActionModal.currentPanel = undefined;
        }, null, []);
    }
    
    private _setWebviewMessageListener() {
        this._panel.webview.onDidReceiveMessage(message => {
            switch (message.command) {
                case 'submit':
                    this._resolve(message.data);
                    this.dispose();
                    return;
                case 'cancel':
                    this._resolve(null);
                    this.dispose();
                    return;
            }
        });
    }

    public dispose() {
        this._panel.dispose();
    }

    private _getHtmlForWebview(): string {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Lollms: Selection Action</title>
            <style>
                body, html {
                    height: 100%; margin: 0; padding: 0;
                    font-family: var(--vscode-font-family);
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                }
                .container {
                    padding: 20px; 
                    height: 100vh; 
                    box-sizing: border-box;
                    display: flex; 
                    flex-direction: column; 
                    justify-content: flex-start; /* Align to top for easier multi-tasking */
                }
                .form-content { 
                    flex-grow: 0; 
                    background: var(--vscode-sideBar-background);
                    border: 1px solid var(--vscode-widget-border);
                    border-radius: 8px;
                    padding: 16px;
                    box-shadow: 0 4px 15px rgba(0,0,0,0.3);
                }
                
                h2 { font-weight: 400; font-size: 14px; margin: 0 0 16px 0; color: var(--vscode-foreground); display: flex; align-items: center; gap: 8px; }
                
                textarea {
                    width: 100%; height: 120px; padding: 10px; border: 1px solid var(--vscode-input-border);
                    border-radius: 4px; background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground); font-size: 13px; box-sizing: border-box;
                    font-family: var(--vscode-editor-font-family); resize: none;
                    outline: none; transition: border-color 0.2s;
                }
                textarea:focus { border-color: var(--vscode-focusBorder); }
                
                label { display: block; margin-top: 20px; margin-bottom: 8px; font-weight: 600; font-size: 11px; text-transform: uppercase; opacity: 0.8; letter-spacing: 0.5px; }
                
                .action-selector { display: flex; gap: 10px; margin-bottom: 20px; }
                .action-type-btn {
                    flex: 1; padding: 10px; border: 1px solid var(--vscode-widget-border);
                    border-radius: 6px; background: var(--vscode-editor-background);
                    color: var(--vscode-foreground); cursor: pointer; text-align: center;
                    display: flex; flex-direction: column; gap: 4px; transition: all 0.2s;
                }
                .action-type-btn.active { border-color: var(--vscode-focusBorder); background: var(--vscode-editor-inactiveSelectionBackground); }
                .action-type-btn strong { font-size: 12px; }
                .action-type-btn span { font-size: 10px; opacity: 0.7; }

                .settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-top: 20px; }
                .checkbox-container { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 4px; background: var(--vscode-editor-inactiveSelectionBackground); }
                .checkbox-container label { margin: 0; text-transform: none; font-size: 12px; cursor: pointer; opacity: 1; font-weight: normal; }

                .button-group {
                    display: flex; gap: 12px; margin-top: 24px;
                    border-top: 1px solid var(--vscode-panel-border);
                    padding-top: 20px;
                }
                button.main-btn {
                    flex: 2; background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground); border: none; padding: 10px;
                    font-size: 13px; font-weight: 600; border-radius: 4px; cursor: pointer;
                }
                button.secondary {
                    flex: 1; background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground); border: none; padding: 10px;
                    border-radius: 4px; cursor: pointer;
                }
                button:hover { filter: brightness(1.2); }
                
                #save-title-group { display: none; margin-top: 15px; animation: slideDown 0.2s ease-out; }
                @keyframes slideDown { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }

                .switch { position: relative; display: inline-block; width: 28px; height: 16px; }
                .switch input { opacity: 0; width: 0; height: 0; }
                .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #777; transition: .4s; border-radius: 16px; }
                .slider:before { position: absolute; content: ""; height: 12px; width: 12px; left: 2px; bottom: 2px; background-color: white; transition: .4s; border-radius: 50%; }
                input:checked + .slider { background-color: var(--vscode-button-background); }
                input:checked + .slider:before { transform: translateX(12px); }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="form-content">
                    <h2>📝 Modify Selection</h2>
                    
                    <textarea id="prompt" placeholder="Describe the changes you want (e.g., 'Refactor this to use async/await', 'Add error handling', 'Document this class')"></textarea>

                    <label>Action Goal</label>
                    <div class="action-selector">
                        <div class="action-type-btn active" id="btn-modify" onclick="setType('generation')">
                            <strong>Code Generation</strong>
                            <span>Applies changes as a diff</span>
                        </div>
                        <div class="action-type-btn" id="btn-ask" onclick="setType('information')">
                            <strong>Question / Info</strong>
                            <span>Answers in a new discussion</span>
                        </div>
                    </div>

                    <div class="settings-grid">
                        <div class="checkbox-container">
                            <label class="switch">
                                <input type="checkbox" id="use-context" checked>
                                <span class="slider"></span>
                            </label>
                            <label for="use-context">Include Project Context</label>
                        </div>

                        <div class="checkbox-container">
                            <label class="switch">
                                <input type="checkbox" id="save-prompt">
                                <span class="slider"></span>
                            </label>
                            <label for="save-prompt">Save as Library Prompt</label>
                        </div>
                    </div>
                    
                    <div id="save-title-group">
                        <label for="save-title">Prompt Name</label>
                        <input type="text" id="save-title" placeholder="e.g., 'Convert to Async'">
                    </div>
                </div>

                <div class="button-group">
                    <button id="cancel-btn" class="secondary">Cancel</button>
                    <button id="apply-btn" class="main-btn">Apply Action</button>
                </div>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                let currentType = 'generation';

                function setType(type) {
                    currentType = type;
                    document.getElementById('btn-modify').classList.toggle('active', type === 'generation');
                    document.getElementById('btn-ask').classList.toggle('active', type === 'information');
                }

                const promptInput = document.getElementById('prompt');
                const saveCheckbox = document.getElementById('save-prompt');
                const useContextCheckbox = document.getElementById('use-context');
                const saveTitleGroup = document.getElementById('save-title-group');
                const saveTitleInput = document.getElementById('save-title');
                const applyBtn = document.getElementById('apply-btn');

                // Focus the textarea immediately
                promptInput.focus();

                saveCheckbox.addEventListener('change', () => {
                    saveTitleGroup.style.display = saveCheckbox.checked ? 'block' : 'none';
                    if(saveCheckbox.checked) {
                        saveTitleInput.focus();
                    }
                });

                applyBtn.addEventListener('click', () => {
                    const prompt = promptInput.value.trim();
                    const save = saveCheckbox.checked;
                    const useContext = useContextCheckbox.checked;
                    const title = saveTitleInput.value.trim();

                    let hasError = false;

                    if (!prompt) {
                        promptInput.style.borderColor = 'var(--vscode-errorForeground)';
                        hasError = true;
                    } else {
                        promptInput.style.borderColor = '';
                    }

                    if (save && !title) {
                        saveTitleInput.style.borderColor = 'var(--vscode-errorForeground)';
                        hasError = true;
                    } else {
                        saveTitleInput.style.borderColor = '';
                    }

                    if (hasError) return;

                    vscode.postMessage({ 
                        command: 'submit', 
                        data: { prompt, actionType: currentType, save, title, useContext }
                    });
                });

                document.getElementById('cancel-btn').addEventListener('click', () => {
                    vscode.postMessage({ command: 'cancel' });
                });

                // Support Ctrl+Enter to submit
                promptInput.addEventListener('keydown', (e) => {
                    if (e.ctrlKey && e.key === 'Enter') {
                        applyBtn.click();
                    }
                });
            </script>
        </body>
        </html>`;
    }
}
