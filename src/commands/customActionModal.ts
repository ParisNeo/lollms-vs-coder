import * as vscode from 'vscode';

export interface CustomActionData {
    prompt: string;
    actionType: 'generation' | 'information';
    save: boolean;
    title: string;
}


export class CustomActionModal {
    public static currentPanel: CustomActionModal | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _resolve: (value: CustomActionData | null) => void;

    public static async createOrShow(extensionUri: vscode.Uri): Promise<CustomActionData | null> {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (CustomActionModal.currentPanel) {
            CustomActionModal.currentPanel._panel.reveal(column);
        } else {
            const panel = vscode.window.createWebviewPanel(
                'customActionModal', 'Custom Lollms Action', column || vscode.ViewColumn.One,
                { enableScripts: true, localResourceRoots: [extensionUri] }
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
            <title>Custom Lollms Action</title>
            <style>
                body, html {
                    height: 100%; margin: 0; padding: 0;
                    font-family: var(--vscode-font-family);
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                }
                .container {
                    padding: 2em; height: 100%; box-sizing: border-box;
                    display: flex; flex-direction: column; max-width: 600px; margin: 0 auto;
                }
                .form-content { flex-grow: 1; overflow-y: auto; }
                h1 { font-weight: 300; text-align: center; margin-bottom: 2em; }
                textarea, input[type="text"] {
                    width: 100%; padding: 8px; border: 1px solid var(--vscode-input-border);
                    border-radius: 4px; background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground); font-size: 0.9em; box-sizing: border-box;
                    font-family: var(--vscode-font-family);
                }
                textarea { height: 150px; resize: vertical; }
                label { display: block; margin-top: 14px; margin-bottom: 5px; font-weight: 600; color: var(--vscode-description-foreground); }
                .radio-group label { display: inline-block; margin-right: 15px; font-weight: normal; }
                .checkbox-container { display: flex; align-items: center; margin-top: 1em; }
                .checkbox-container input { margin-right: 0.5em; }
                .button-group {
                    display: flex; gap: 10px; margin-top: 2em;
                    border-top: 1px solid var(--vscode-panel-border);
                    padding-top: 1em;
                }
                button {
                    flex-grow: 1; background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground); border: none; padding: 10px;
                    font-size: 1em; font-weight: 600; border-radius: 4px; cursor: pointer;
                    transition: background-color 0.2s ease;
                }
                button.secondary {
                    background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                }
                button:hover { background-color: var(--vscode-button-hoverBackground); }
                button.secondary:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
                #save-title-group { display: none; margin-top: 1em; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="form-content">
                    <h1>Custom Action</h1>
                    
                    <label for="prompt">Prompt for selected code</label>
                    <textarea id="prompt" placeholder="e.g., 'Add comments to this function'"></textarea>

                    <label>Action Type</label>
                    <div class="radio-group">
                        <input type="radio" id="type-modify" name="actionType" value="generation" checked>
                        <label for="type-modify">Modify Code (Show diff)</label>
                        <br>
                        <input type="radio" id="type-ask" name="actionType" value="information">
                        <label for="type-ask">Ask Question (Show in panel)</label>
                    </div>

                    <div class="checkbox-container">
                        <input type="checkbox" id="save-prompt">
                        <label for="save-prompt">Save as a new reusable prompt</label>
                    </div>
                    
                    <div id="save-title-group">
                        <label for="save-title">New Prompt Title</label>
                        <input type="text" id="save-title" placeholder="e.g., 'Add Code Comments'">
                    </div>
                </div>

                <div class="button-group">
                    <button id="cancel-btn" class="secondary">Cancel</button>
                    <button id="apply-btn">Apply</button>
                </div>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                
                const promptInput = document.getElementById('prompt');
                const saveCheckbox = document.getElementById('save-prompt');
                const saveTitleGroup = document.getElementById('save-title-group');
                const saveTitleInput = document.getElementById('save-title');
                
                saveCheckbox.addEventListener('change', () => {
                    saveTitleGroup.style.display = saveCheckbox.checked ? 'block' : 'none';
                });

                document.getElementById('apply-btn').addEventListener('click', () => {
                    const prompt = promptInput.value;
                    const actionType = document.querySelector('input[name="actionType"]:checked').value;
                    const save = saveCheckbox.checked;
                    const title = saveTitleInput.value;

                    if (!prompt) {
                        vscode.postMessage({ command: 'error', message: 'Prompt cannot be empty.' });
                        return;
                    }
                    if (save && !title) {
                        vscode.postMessage({ command: 'error', message: 'Title cannot be empty when saving.' });
                        return;
                    }

                    vscode.postMessage({ 
                        command: 'submit', 
                        data: { prompt, actionType, save, title }
                    });
                });

                document.getElementById('cancel-btn').addEventListener('click', () => {
                    vscode.postMessage({ command: 'cancel' });
                });
            </script>
        </body>
        </html>`;
    }
}