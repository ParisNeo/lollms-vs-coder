import * as vscode from 'vscode';

export class McpManagerPanel {
    public static currentPanel: McpManagerPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri) {
        if (McpManagerPanel.currentPanel) {
            McpManagerPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'mcpManager',
            '🔌 MCP Server Management',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        McpManagerPanel.currentPanel = new McpManagerPanel(panel, extensionUri);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._update();

        this._panel.webview.onDidReceiveMessage(async (msg) => {
            const config = vscode.workspace.getConfiguration('lollmsVsCoder');
            let mcpServers = config.get<Record<string, string>>('mcpServers') || {};

            switch (msg.command) {
                case 'save':
                    await config.update('mcpServers', msg.servers, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage("Lollms: MCP Servers updated.");
                    break;
                case 'restart':
                    await vscode.commands.executeCommand('lollmsApi.recreateClient');
                    break;
            }
        }, null, this._disposables);

        this._panel.onDidDispose(() => {
            McpManagerPanel.currentPanel = undefined;
            this._disposables.forEach(d => d.dispose());
        }, null, this._disposables);
    }

    private _update() {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const servers = config.get<Record<string, string>>('mcpServers') || {};
        this._panel.webview.html = this._getHtml(servers);
    }

    private _getHtml(servers: Record<string, string>) {
        return `<!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); padding: 20px; background: var(--vscode-editor-background); }
                .server-card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); padding: 15px; border-radius: 8px; margin-bottom: 10px; }
                input { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 6px; margin-bottom: 8px; border-radius: 4px; box-sizing: border-box; }
                .actions { display: flex; gap: 10px; margin-top: 20px; }
                button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 16px; cursor: pointer; border-radius: 4px; }
                button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
                .remove-btn { color: var(--vscode-errorForeground); background: transparent; border: 1px solid var(--vscode-errorForeground); padding: 4px 8px; }
            </style>
        </head>
        <body>
            <h3>🔌 Configured MCP Servers</h3>
            <div id="list"></div>
            <button onclick="add()">+ Add Server</button>
            <div class="actions">
                <button onclick="save()">Save Changes</button>
                <button class="secondary" onclick="vscode.postMessage({command:'restart'})">Reload Agent</button>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                let servers = ${JSON.stringify(servers)};
                
                function render() {
                    const container = document.getElementById('list');
                    container.innerHTML = Object.entries(servers).map(([name, cmd], i) => \`
                        <div class="server-card">
                            <label style="font-size:10px; font-weight:bold; opacity:0.7;">SERVER NAME</label>
                            <input value="\${name}" onchange="updateName('\${name}', this.value)" placeholder="e.g. filesystem" />
                            <label style="font-size:10px; font-weight:bold; opacity:0.7;">COMMAND</label>
                            <input value="\${cmd}" onchange="updateCmd('\${name}', this.value)" placeholder="npx -y ..." />
                            <button class="remove-btn" onclick="remove('\${name}')">Remove</button>
                        </div>
                    \`).join('');
                }

                function updateName(oldName, newName) {
                    const cmd = servers[oldName];
                    delete servers[oldName];
                    servers[newName] = cmd;
                    render();
                }
                function updateCmd(name, val) { servers[name] = val; }
                function add() { const n = 'new-server-' + Date.now(); servers[n] = ''; render(); }
                function remove(name) { delete servers[name]; render(); }
                function save() { vscode.postMessage({command: 'save', servers}); }
                render();
            </script>
        </body></html>`;
    }
}