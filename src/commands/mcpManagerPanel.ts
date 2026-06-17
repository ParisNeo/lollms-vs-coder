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

    private _getHtml(servers: Record<string, any>) {
        return `<!DOCTYPE html>
        <html>
        <head>
            <link href="https://cdn.jsdelivr.net/npm/@vscode/codicons/dist/codicon.css" rel="stylesheet" />
            <style>
                body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); padding: 20px; background: var(--vscode-editor-background); }
                .server-card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); padding: 15px; border-radius: 8px; margin-bottom: 10px; }
                input { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 6px; margin-bottom: 8px; border-radius: 4px; box-sizing: border-box; }
                .actions { display: flex; gap: 10px; margin-top: 20px; }
                button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 16px; cursor: pointer; border-radius: 4px; }
                button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
                .remove-btn { color: var(--vscode-errorForeground); background: transparent; border: 1px solid var(--vscode-errorForeground); padding: 4px 8px; }
                .badge { font-size: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 2px 6px; border-radius: 10px; font-weight: bold; }
            </style>
        </head>
        <body>
            <h3>🔌 Configured MCP Servers</h3>
            <div id="list"></div>
            <button onclick="add()">+ Add Server</button>
            
            <div id="quick-add" style="margin-top: 20px; border-top: 1px solid var(--vscode-widget-border); padding-top: 15px;"></div>

            <div class="actions">
                <button onclick="save()">Save Changes</button>
                <button class="secondary" onclick="vscode.postMessage({command:'restart'})">Reload Agent</button>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                let servers = ${JSON.stringify(servers)};

                const KNOWN_SERVERS = [
                    { name: 'google-maps', type: 'stdio', cmd: 'npx -y @modelcontextprotocol/server-google-maps', desc: 'Local search & navigation' },
                    { name: 'brave-search', type: 'stdio', cmd: 'npx -y @modelcontextprotocol/server-brave-search', desc: 'Live web search results' },
                    { name: 'github', type: 'stdio', cmd: 'npx -y @modelcontextprotocol/server-github', desc: 'Manage issues/PRs/code' },
                    { name: 'memory', type: 'stdio', cmd: 'npx -y @modelcontextprotocol/server-memory', desc: 'Persistent Knowledge Graph' }
                ];
                
                function render() {
                    const container = document.getElementById('list');
                    let html = '';
                    
                    for (const [name, cfg] of Object.entries(servers)) {
                        const cmdVal = cfg.command || cfg.url || '';
                        const envVal = JSON.stringify(cfg.env || {});
                        const typeVal = cfg.type || 'stdio';

                        html += '<div class="server-card">';
                        html += '  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">';
                        html += '    <input style="font-weight:bold; border:none; background:transparent; width:auto;" value="' + name + '" onchange="updateName(\\'' + name + '\\', this.value)" />';
                        html += '    <span class="badge">' + typeVal + '</span>';
                        html += '  </div>';
                        html += '  <label>COMMAND / URL</label>';
                        html += '  <input value="' + cmdVal + '" onchange="updateVal(\\'' + name + '\\', this.value)" />';
                        html += '  <label>ENV (JSON format)</label>';
                        html += '  <input value=\\'' + envVal + '\\' onchange="updateEnv(\\'' + name + '\\', this.value)" placeholder=\\'{"API_KEY": "..."}\\' />';
                        html += '  <button class="remove-btn" onclick="remove(\\'' + name + '\\')">Delete</button>';
                        html += '</div>';
                    }
                    container.innerHTML = html;
                    
                    const quick = document.getElementById('quick-add');
                    let quickHtml = '<h4>Quick Install Popular Servers</h4>';
                    for (const s of KNOWN_SERVERS) {
                        quickHtml += '<div class="server-card" style="border-style:dashed; opacity:0.8; cursor:pointer;" onclick=\\'addKnown(' + JSON.stringify(s) + ')\\'>';
                        quickHtml += '  <strong>' + s.name + '</strong><br><small>' + s.desc + '</small>';
                        quickHtml += '</div>';
                    }
                    quick.innerHTML = quickHtml;
                }

                function addKnown(s) { 
                    servers[s.name] = { type: s.type, command: s.cmd, env: {} }; 
                    render(); 
                }

                function updateName(oldName, newName) {
                    const cmd = servers[oldName];
                    delete servers[oldName];
                    servers[newName] = cmd;
                    render();
                }
                function updateVal(name, val) { 
                    if (servers[name]) {
                        if (servers[name].type === 'sse') {
                            servers[name].url = val;
                        } else {
                            servers[name].command = val;
                        }
                    }
                    render();
                }
                function updateEnv(name, val) {
                    try {
                        if (servers[name]) {
                            servers[name].env = JSON.parse(val);
                        }
                    } catch(e) {
                        vscode.postMessage({command: 'showError', message: 'Invalid JSON for environment variables.'});
                    }
                }
                function add() { 
                    const n = 'new-server-' + Date.now(); 
                    servers[n] = { type: 'stdio', command: '', env: {} }; 
                    render(); 
                }
                function remove(name) { delete servers[name]; render(); }
                function save() { vscode.postMessage({command: 'save', servers}); }
                render();
            </script>
        </body></html>`;
    }
}