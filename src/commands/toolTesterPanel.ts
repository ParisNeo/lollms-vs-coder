import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tools/tool';
import { LollmsServices } from '../lollmsContext';

export class ToolTesterPanel {
    public static currentPanel: ToolTesterPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri, services: LollmsServices, tool: ToolDefinition) {
        if (ToolTesterPanel.currentPanel) {
            ToolTesterPanel.currentPanel.setTool(tool);
            ToolTesterPanel.currentPanel._panel.reveal(vscode.ViewColumn.Two);
            return;
        }
        const panel = vscode.window.createWebviewPanel('lollmsToolTester', `Test: ${tool.name}`, vscode.ViewColumn.Two, { enableScripts: true });
        ToolTesterPanel.currentPanel = new ToolTesterPanel(panel, extensionUri, services, tool);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, private services: LollmsServices, private tool: ToolDefinition) {
        this._panel = panel;
        this._update();
        this._panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === 'run') {
                await this.runTest(msg.params);
            }
        }, null, this._disposables);
    }

    public setTool(tool: ToolDefinition) {
        this.tool = tool;
        this._panel.title = `Test: ${tool.name}`;
        this._update();
    }

    private async runTest(params: any) {
        this._panel.webview.postMessage({ command: 'loading', value: true });
        try {
            const env: ToolExecutionEnv = {
                lollmsApi: this.services.lollmsAPI,
                contextManager: this.services.contextManager,
                workspaceRoot: vscode.workspace.workspaceFolders?.[0],
                currentPlan: null,
                agentManager: (this.services as any).activeAgent // Mocked if exists
            };
            const result = await this.tool.execute(params, env, new AbortController().signal);
            this._panel.webview.postMessage({ command: 'result', result });
        } catch (e: any) {
            this._panel.webview.postMessage({ command: 'result', result: { success: false, output: e.message } });
        } finally {
            this._panel.webview.postMessage({ command: 'loading', value: false });
        }
    }

    private _update() {
        this._panel.webview.html = `
        <html>
        <head>
            <style>
                body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); padding: 20px; background: var(--vscode-editor-background); }
                pre { background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 4px; border: 1px solid var(--vscode-widget-border); overflow: auto; }
                textarea { width: 100%; height: 150px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); font-family: monospace; }
                button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 16px; cursor: pointer; margin-top: 10px; width: 100%; }
                .success { color: var(--vscode-charts-green); }
                .error { color: var(--vscode-charts-red); }
            </style>
        </head>
        <body>
            <h3>Tool: ${this.tool.name}</h3>
            <p style="opacity:0.7; font-size:12px;">${this.tool.description}</p>
            <label style="font-size:11px; font-weight:bold;">INPUT PARAMETERS (JSON)</label>
            <textarea id="params">${JSON.stringify(this.tool.parameters.reduce((acc: any, p) => ({ ...acc, [p.name]: "" }), {}), null, 2)}</textarea>
            <button id="runBtn">Run Tool Execution</button>
            <div id="loader" style="display:none; text-align:center; padding:10px;">⏳ Executing...</div>
            <h4>OUTPUT</h4>
            <pre id="output">No result yet.</pre>
            <script>
                const vscode = acquireVsCodeApi();
                document.getElementById('runBtn').onclick = () => {
                    const params = JSON.parse(document.getElementById('params').value);
                    vscode.postMessage({ command: 'run', params });
                };
                window.addEventListener('message', e => {
                    const m = e.data;
                    if (m.command === 'loading') {
                        document.getElementById('loader').style.display = m.value ? 'block' : 'none';
                        document.getElementById('runBtn').disabled = m.value;
                    }
                    if (m.command === 'result') {
                        const out = document.getElementById('output');
                        out.className = m.result.success ? 'success' : 'error';
                        out.textContent = m.result.output;
                    }
                });
            </script>
        </body></html>`;
    }
}