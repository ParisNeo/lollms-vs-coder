import * as vscode from 'vscode';

export class CompanionPanel {
    public static currentPanel: CompanionPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _content: string = "";
    private _originalSelection: string = "";

    public static createOrShow(extensionUri: vscode.Uri, title: string) {
        const column = vscode.window.activeTextEditor
            ? vscode.ViewColumn.Beside
            : undefined;

        if (CompanionPanel.currentPanel) {
            CompanionPanel.currentPanel._panel.reveal(column);
            CompanionPanel.currentPanel.updateTitle(title);
            return CompanionPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            'lollmsCompanion',
            title,
            column || vscode.ViewColumn.Two,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
                retainContextWhenHidden: true
            }
        );

        CompanionPanel.currentPanel = new CompanionPanel(panel, extensionUri);
        return CompanionPanel.currentPanel;
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._panel.onDidDispose(() => this.dispose(), null, []);
        this._panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'copyToClipboard':
                        vscode.env.clipboard.writeText(message.text);
                        vscode.window.showInformationMessage('Copied to clipboard');
                        return;
                    case 'insertAtCursor':
                        this.insertAtCursor(message.text);
                        return;
                    case 'replaceSelection':
                        this.replaceSelection(message.text);
                        return;
                }
            },
            null,
            []
        );
        this.updateView();
    }

    public updateContent(content: string, originalSelection: string = "") {
        this._content = content;
        this._originalSelection = originalSelection;
        this.updateView();
    }

    public updateTitle(title: string) {
        this._panel.title = title;
    }

    private updateView() {
        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
    }

    public dispose() {
        CompanionPanel.currentPanel = undefined;
        this._panel.dispose();
    }

    private async insertAtCursor(text: string) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            await editor.edit(editBuilder => {
                editBuilder.insert(editor.selection.active, text);
            });
        } else {
            vscode.window.showWarningMessage('No active editor to insert text.');
        }
    }

    private async replaceSelection(text: string) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            await editor.edit(editBuilder => {
                editBuilder.replace(editor.selection, text);
            });
        } else {
            vscode.window.showWarningMessage('No active editor to replace text.');
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const markedUri = "https://cdn.jsdelivr.net/npm/marked@5.1.1/marked.min.js";
        const domPurifyUri = "https://cdn.jsdelivr.net/npm/dompurify@3.0.5/dist/purify.min.js";
        const prismJsUri = "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js";
        const prismCssUri = "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css";
        const prismAutoloaderUri = "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/plugins/autoloader/prism-autoloader.min.js";

        // Embed the content safely
        const jsonContent = JSON.stringify(this._content);

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Lollms Companion</title>
            <script src="${markedUri}"></script>
            <script src="${domPurifyUri}"></script>
            <link href="${prismCssUri}" rel="stylesheet" />
            <script src="${prismJsUri}"></script>
            <script src="${prismAutoloaderUri}"></script>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    padding: 0;
                    margin: 0;
                    display: flex;
                    flex-direction: column;
                    height: 100vh;
                }
                .header {
                    padding: 10px 20px;
                    background-color: var(--vscode-editorWidget-background);
                    border-bottom: 1px solid var(--vscode-widget-border);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                .title {
                    font-weight: bold;
                    font-size: 1.1em;
                }
                .content {
                    flex: 1;
                    padding: 20px;
                    overflow-y: auto;
                    line-height: 1.6;
                }
                .actions {
                    display: flex;
                    gap: 10px;
                }
                button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 6px 12px;
                    border-radius: 2px;
                    cursor: pointer;
                    font-family: var(--vscode-font-family);
                }
                button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                button.secondary {
                    background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                }
                button.secondary:hover {
                    background-color: var(--vscode-button-secondaryHoverBackground);
                }
                
                /* Markdown Styles */
                code {
                    font-family: var(--vscode-editor-font-family);
                    background-color: var(--vscode-textCodeBlock-background);
                    padding: 2px 4px;
                    border-radius: 3px;
                }
                pre {
                    background-color: var(--vscode-textCodeBlock-background);
                    padding: 16px;
                    border-radius: 5px;
                    overflow-x: auto;
                    position: relative;
                }
                pre button.copy-code {
                    position: absolute;
                    top: 5px;
                    right: 5px;
                    padding: 4px 8px;
                    font-size: 0.8em;
                    opacity: 0.7;
                }
                pre button.copy-code:hover {
                    opacity: 1;
                }
                blockquote {
                    border-left: 4px solid var(--vscode-textBlockQuote-border);
                    margin: 0;
                    padding-left: 10px;
                    color: var(--vscode-descriptionForeground);
                }
            </style>
        </head>
        <body>
            <div class="header">
                <span class="title">Lollms Companion</span>
                <div class="actions">
                    <button class="secondary" onclick="copyFullResponse()">Copy Response</button>
                </div>
            </div>
            <div class="content" id="markdown-content"></div>

            <script>
                const vscode = acquireVsCodeApi();
                const content = ${jsonContent};
                const container = document.getElementById('markdown-content');

                // Markdown Configuration
                marked.setOptions({
                    highlight: function(code, lang) {
                        if (Prism.languages[lang]) {
                            return Prism.highlight(code, Prism.languages[lang], lang);
                        } else {
                            return code;
                        }
                    }
                });

                // Render
                container.innerHTML = DOMPurify.sanitize(marked.parse(content));

                // Add actions to code blocks
                document.querySelectorAll('pre code').forEach((block) => {
                    const pre = block.parentElement;
                    const code = block.textContent;
                    
                    // Copy Code Button
                    const copyBtn = document.createElement('button');
                    copyBtn.className = 'copy-code secondary';
                    copyBtn.textContent = 'Copy';
                    copyBtn.onclick = () => {
                        vscode.postMessage({ command: 'copyToClipboard', text: code });
                        copyBtn.textContent = 'Copied!';
                        setTimeout(() => copyBtn.textContent = 'Copy', 2000);
                    };
                    pre.appendChild(copyBtn);

                    // If it looks like code, add Insert/Replace buttons below
                    const actionsDiv = document.createElement('div');
                    actionsDiv.style.marginTop = '8px';
                    actionsDiv.style.display = 'flex';
                    actionsDiv.style.gap = '8px';

                    const insertBtn = document.createElement('button');
                    insertBtn.textContent = 'Insert at Cursor';
                    insertBtn.onclick = () => vscode.postMessage({ command: 'insertAtCursor', text: code });

                    const replaceBtn = document.createElement('button');
                    replaceBtn.textContent = 'Replace Selection';
                    replaceBtn.onclick = () => vscode.postMessage({ command: 'replaceSelection', text: code });

                    actionsDiv.appendChild(insertBtn);
                    actionsDiv.appendChild(replaceBtn);
                    pre.insertAdjacentElement('afterend', actionsDiv);
                });

                function copyFullResponse() {
                    vscode.postMessage({ command: 'copyToClipboard', text: content });
                }
            </script>
        </body>
        </html>`;
    }
}
