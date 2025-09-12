import * as vscode from 'vscode';

export class InfoPanel {
    public static currentPanel: InfoPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _content: string;

    public static createOrShow(extensionUri: vscode.Uri, title: string, content: string) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (InfoPanel.currentPanel) {
            InfoPanel.currentPanel._panel.reveal(column);
            InfoPanel.currentPanel.updateContent(title, content);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'lollmsInfoPanel',
            title,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri]
            }
        );

        InfoPanel.currentPanel = new InfoPanel(panel, extensionUri, content);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, content: string) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._content = content;

        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview, this._panel.title, this._content);
        this._setWebviewMessageListener();

        this._panel.onDidDispose(() => this.dispose(), null, []);
    }
    
    public updateContent(title: string, content: string) {
        this._panel.title = title;
        this._content = content;
        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview, title, content);
    }

    public dispose() {
        InfoPanel.currentPanel = undefined;
        this._panel.dispose();
    }

    private _setWebviewMessageListener() {
        this._panel.webview.onDidReceiveMessage(message => {
            switch (message.command) {
                case 'saveInfoToFile':
                    vscode.commands.executeCommand('lollms-vs-coder.saveInfoToFile', this._content);
                    return;
            }
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview, title: string, content: string): string {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${title}</title>
            <script src="https://cdn.jsdelivr.net/npm/marked@5.1.1/marked.min.js"></script>
            <script src="https://cdn.jsdelivr.net/npm/dompurify@3.0.5/dist/purify.min.js"></script>
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
                .container {
                    padding: 1.5em;
                    flex: 1;
                    overflow-y: auto;
                }
                .footer {
                    padding: 0.8em 1.5em;
                    display: flex;
                    gap: 10px;
                    justify-content: flex-end;
                    background-color: var(--vscode-editorWidget-background);
                    border-top: 1px solid var(--vscode-panel-border);
                }
                button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: 1px solid var(--vscode-button-border);
                    padding: 8px 14px;
                    cursor: pointer;
                    border-radius: 4px;
                }
                button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                pre {
                    background-color: var(--vscode-textCodeBlock-background);
                    padding: 1em;
                    border-radius: 6px;
                    overflow-x: auto;
                }
            </style>
        </head>
        <body>
            <div class="container" id="content-container">
                <!-- Content will be rendered here -->
            </div>
            <div class="footer">
                <button id="copy-btn">Copy</button>
                <button id="save-btn">Save to File...</button>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                const contentContainer = document.getElementById('content-container');
                const copyBtn = document.getElementById('copy-btn');
                const saveBtn = document.getElementById('save-btn');
                
                const rawContent = ${JSON.stringify(content)};
                
                contentContainer.innerHTML = DOMPurify.sanitize(marked.parse(rawContent));

                copyBtn.addEventListener('click', () => {
                    navigator.clipboard.writeText(rawContent);
                    copyBtn.textContent = 'Copied!';
                    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
                });

                saveBtn.addEventListener('click', () => {
                    vscode.postMessage({ command: 'saveInfoToFile' });
                });
            </script>
        </body>
        </html>`;
    }
}