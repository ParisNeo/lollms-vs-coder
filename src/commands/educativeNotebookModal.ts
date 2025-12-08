import * as vscode from 'vscode';

export interface EducativeNotebookData {
    topic: string;
    includeTree: boolean;
    selectedTools: string[];
}

export class EducativeNotebookModal {
    public static currentPanel: EducativeNotebookModal | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _resolve: (value: EducativeNotebookData | null) => void;

    public static async createOrShow(extensionUri: vscode.Uri): Promise<EducativeNotebookData | null> {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (EducativeNotebookModal.currentPanel) {
            EducativeNotebookModal.currentPanel._panel.reveal(column);
        } else {
            const panel = vscode.window.createWebviewPanel(
                'educativeNotebookModal', 'Generate Educative Notebook', column || vscode.ViewColumn.One,
                { enableScripts: true, localResourceRoots: [extensionUri] }
            );
            EducativeNotebookModal.currentPanel = new EducativeNotebookModal(panel, extensionUri);
        }

        return new Promise<EducativeNotebookData | null>(resolve => {
            EducativeNotebookModal.currentPanel!._resolve = resolve;
        });
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._resolve = () => {};

        this._panel.webview.html = this._getHtmlForWebview();
        this._setWebviewMessageListener();
        this._panel.onDidDispose(() => {
            this._resolve(null); 
            EducativeNotebookModal.currentPanel = undefined;
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
            <title>Generate Educative Notebook</title>
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
                textarea { height: 100px; resize: vertical; }
                label { display: block; margin-top: 14px; margin-bottom: 5px; font-weight: 600; color: var(--vscode-description-foreground); }
                .checkbox-container { display: flex; align-items: center; margin-top: 1em; }
                .checkbox-container label:not(.switch) { margin-top: 0; margin-bottom: 0; font-weight: normal; cursor: pointer; }
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
                
                /* Switch Toggle */
                .switch {
                    position: relative;
                    display: inline-block;
                    width: 32px;
                    height: 18px;
                    margin-right: 8px;
                }
                .switch input { opacity: 0; width: 0; height: 0; }
                .slider {
                    position: absolute;
                    cursor: pointer;
                    top: 0; left: 0; right: 0; bottom: 0;
                    background-color: var(--vscode-input-background);
                    border: 1px solid var(--vscode-widget-border);
                    transition: .4s;
                    border-radius: 18px;
                }
                .slider:before {
                    position: absolute;
                    content: "";
                    height: 12px;
                    width: 12px;
                    left: 2px;
                    bottom: 2px;
                    background-color: var(--vscode-foreground);
                    transition: .4s;
                    border-radius: 50%;
                }
                input:checked + .slider {
                    background-color: var(--vscode-button-background);
                    border-color: var(--vscode-button-background);
                }
                input:checked + .slider:before {
                    transform: translateX(14px);
                    background-color: var(--vscode-button-foreground);
                }
                input:focus + .slider { outline: 1px solid var(--vscode-focusBorder); }

                .tools-grid {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 10px;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="form-content">
                    <h1>Generate Educative Notebook</h1>
                    
                    <label for="topic">Topic / Prompt</label>
                    <textarea id="topic" placeholder="e.g., 'Explain Support Vector Machines with examples'"></textarea>

                    <label>Enable Tools</label>
                    <div class="tools-grid">
                        <div class="checkbox-container">
                            <label class="switch"><input type="checkbox" class="tool-check" value="search_web"><span class="slider"></span></label>
                            <label>Web Search</label>
                        </div>
                        <div class="checkbox-container">
                            <label class="switch"><input type="checkbox" class="tool-check" value="search_arxiv"><span class="slider"></span></label>
                            <label>ArXiv Search</label>
                        </div>
                        <div class="checkbox-container">
                            <label class="switch"><input type="checkbox" class="tool-check" value="generate_image"><span class="slider"></span></label>
                            <label>Image Generation</label>
                        </div>
                         <div class="checkbox-container">
                            <label class="switch"><input type="checkbox" class="tool-check" value="read_file" checked><span class="slider"></span></label>
                            <label>Read File (Agent)</label>
                        </div>
                    </div>

                    <div class="checkbox-container">
                        <label class="switch">
                            <input type="checkbox" id="include-tree" checked>
                            <span class="slider"></span>
                        </label>
                        <label for="include-tree">Include Project File Tree in Context</label>
                    </div>
                </div>

                <div class="button-group">
                    <button id="cancel-btn" class="secondary">Cancel</button>
                    <button id="generate-btn">Generate</button>
                </div>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                
                const topicInput = document.getElementById('topic');
                const includeTreeCheckbox = document.getElementById('include-tree');
                
                document.getElementById('generate-btn').addEventListener('click', () => {
                    const topic = topicInput.value;
                    const includeTree = includeTreeCheckbox.checked;
                    const selectedTools = Array.from(document.querySelectorAll('.tool-check:checked')).map(cb => cb.value);

                    if (!topic) {
                        vscode.postMessage({ command: 'error', message: 'Topic cannot be empty.' });
                        return;
                    }

                    vscode.postMessage({ 
                        command: 'submit', 
                        data: { topic, includeTree, selectedTools }
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
