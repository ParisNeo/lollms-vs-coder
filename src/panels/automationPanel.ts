import * as vscode from 'vscode';

export class AutomationPanel {
    public static currentPanel: AutomationPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _onDidCancel = new vscode.EventEmitter<void>();
    public readonly onDidCancel = this._onDidCancel.event;

    public static createOrShow(extensionUri: vscode.Uri): AutomationPanel {
        if (AutomationPanel.currentPanel) {
            AutomationPanel.currentPanel._panel.reveal(vscode.ViewColumn.Two);
            return AutomationPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            'lollmsAutomation',
            'Lollms: Workspace Repair',
            vscode.ViewColumn.Two,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
            }
        );

        AutomationPanel.currentPanel = new AutomationPanel(panel, extensionUri);
        return AutomationPanel.currentPanel;
    }

    private constructor(panel: vscode.WebviewPanel, private _extensionUri: vscode.Uri) {
        this._panel = panel;
        this._panel.webview.html = this._getHtmlForWebview();
        
        this._panel.webview.onDidReceiveMessage(msg => {
            if (msg.command === 'cancel') {
                this._onDidCancel.fire();
            }
        }, null, this._disposables);

        this._panel.onDidDispose(() => {
            AutomationPanel.currentPanel = undefined;
        }, null, this._disposables);
    }

    public updateFileProgress(filePath: string, status: string, details: string, data?: any) {
        this._panel.webview.postMessage({ command: 'updateFile', filePath, status, details, ...data });
    }

    public updateOverallProgress(percentage: number, label: string) {
        this._panel.webview.postMessage({ command: 'updateProgress', percentage, label });
    }

    public log(message: string) {
        if (this._panel && this._panel.visible) {
            this._panel.webview.postMessage({ command: 'log', message });
        }
    }

    public dispose() {
        this._panel.dispose();
    }

    private _getHtmlForWebview() {
        return `<!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); padding: 20px; background: var(--vscode-editor-background); line-height: 1.4; }
                .sticky-header { position: sticky; top: 0; background: var(--vscode-editor-background); z-index: 100; padding-bottom: 10px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 20px; }
                .header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
                .progress-container { width: 100%; height: 8px; background: var(--vscode-editorWidget-background); border-radius: 4px; overflow: hidden; border: 1px solid var(--vscode-widget-border); }
                .progress-bar { height: 100%; background: var(--vscode-charts-blue); width: 0%; transition: width 0.3s ease; }
                .progress-label { font-size: 11px; opacity: 0.8; margin-top: 5px; display: block; }
                .file-card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 8px; margin-bottom: 15px; overflow: hidden; }
                .file-header { padding: 8px 15px; background: var(--vscode-sideBarSectionHeader-background); display: flex; justify-content: space-between; align-items: center; }
                .file-path { font-weight: bold; font-size: 13px; color: var(--vscode-textLink-foreground); }
                .error-badge { background: var(--vscode-charts-red); color: white; padding: 1px 6px; border-radius: 10px; font-size: 10px; }
                .timeline { padding: 10px 15px; display: flex; flex-direction: column; gap: 8px; }
                .step { font-size: 12px; border-left: 2px solid var(--vscode-widget-border); padding-left: 15px; margin-left: 5px; position: relative; padding-bottom: 10px; }
                .step.success { border-left-color: var(--vscode-charts-green); }
                .step.error { border-left-color: var(--vscode-charts-red); }
                .step::before { content: ''; position: absolute; left: -6px; top: 4px; width: 10px; height: 10px; border-radius: 50%; background: var(--vscode-widget-border); border: 2px solid var(--vscode-editorWidget-background); }
                .step.active::before { background: var(--vscode-textLink-foreground); }
                .step.done::before { background: var(--vscode-charts-green); }
                details { background: var(--vscode-editor-background); border: 1px solid var(--vscode-widget-border); border-radius: 4px; margin-top: 5px; }
                summary { padding: 5px 10px; cursor: pointer; font-size: 11px; font-weight: bold; outline: none; }
                .detail-content { padding: 10px; font-family: var(--vscode-editor-font-family); font-size: 11px; white-space: pre-wrap; max-height: 200px; overflow-y: auto; color: var(--vscode-descriptionForeground); }
                .spinner { width: 10px; height: 10px; border: 2px solid currentColor; border-bottom-color: transparent; border-radius: 50%; animation: spin 1s linear infinite; display: inline-block; }
                @keyframes spin { 100% { transform: rotate(360deg); } }
                .stop-btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 12px; border-radius: 2px; cursor: pointer; font-size: 12px; }
            </style>
        </head>
        <body>
            <div class="sticky-header">
                <div class="header-row">
                    <h3>🛠️ Workspace Repair Engine</h3>
                    <button class="stop-btn" onclick="vscode.postMessage({command:'cancel'})">Stop All</button>
                </div>
                <div class="progress-container"><div id="main-progress" class="progress-bar"></div></div>
                <span id="progress-label" class="progress-label">Initializing...</span>
            </div>
            
            <div id="file-container" style="flex: 1; overflow-y: auto; padding-bottom: 200px;"></div>

            <div id="console-output" style="position: fixed; bottom: 0; left: 0; right: 0; height: 180px; background: #000; border-top: 2px solid var(--vscode-widget-border); padding: 10px; font-family: 'Consolas', monospace; font-size: 10px; overflow-y: auto; color: #0f0; z-index: 200;">
                <div style="color: #aaa; border-bottom: 1px solid #333; margin-bottom: 5px; padding-bottom: 2px;">LIVE SYSTEM LOGS</div>
                <div id="log-entries"></div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                const container = document.getElementById('file-container');
                const logEntries = document.getElementById('log-entries');
                const fileMap = new Map();

                window.addEventListener('message', event => {
                    const msg = event.data;
                    if (msg.command === 'log') {
                        const entry = document.createElement('div');
                        entry.style.marginBottom = '2px';
                        // On échappe le $ pour que TypeScript ne cherche pas la variable 'msg' ici
                        entry.textContent = \`[\${new Date().toLocaleTimeString()}] \${msg.message}\`;
                        logEntries.appendChild(entry);
                        logEntries.scrollTop = logEntries.scrollHeight;
                    }
                    if (msg.command === 'updateProgress') {
                        document.getElementById('main-progress').style.width = msg.percentage + '%';
                        document.getElementById('progress-label').textContent = msg.label;
                    }
                    if (msg.command === 'log') {
                        const entry = document.createElement('div');
                        entry.style.marginBottom = '2px';
                        entry.textContent = \`[\${new Date().toLocaleTimeString()}] \${msg.message}\`;
                        logEntries.appendChild(entry);
                        logEntries.scrollTop = logEntries.scrollHeight;
                    }
                    if (msg.command === 'updateFile') {
                        let card = fileMap.get(msg.filePath);
                        if (!card) {
                            card = document.createElement('div');
                            card.className = 'file-card';
                            card.innerHTML = \`
                                <div class="file-header">
                                    <span class="file-path">\${msg.filePath}</span>
                                    <span class="error-badge">\${msg.errorsCount || 0} ERRORS</span>
                                </div>
                                <div class="timeline"></div>\`;
                            container.appendChild(card);
                            fileMap.set(msg.filePath, card);
                        }
                        const timeline = card.querySelector('.timeline');
                        const step = document.createElement('div');
                        step.className = 'step ' + (msg.status === 'success' ? 'done success' : (msg.status === 'error' ? 'error' : 'active'));
                        
                        let subDetails = '';
                        if (msg.scratchpad) subDetails += \`<details><summary>🧠 Reasoning</summary><div class="detail-content">\${msg.scratchpad}</div></details>\`;
                        if (msg.patch) subDetails += \`<details><summary>📝 Patch</summary><div class="detail-content">\${msg.patch}</div></details>\`;

                        const icon = msg.status === 'success' ? '✅' : (msg.status === 'error' ? '❌' : '<div class="spinner"></div>');
                        step.innerHTML = \`<div>\${icon} \${msg.details}</div>\${subDetails}\`;
                        timeline.appendChild(step);
                        step.scrollIntoView({ behavior: 'smooth', block: 'end' });
                    }
                });
            </script>
        </body></html>`;
    }
}