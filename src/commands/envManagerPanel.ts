import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

export class EnvManagerPanel {
    public static currentPanel: EnvManagerPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;

    public static createOrShow(extensionUri: vscode.Uri, workspaceRoot: vscode.Uri) {
        if (EnvManagerPanel.currentPanel) {
            EnvManagerPanel.currentPanel._panel.reveal();
            return;
        }
        const panel = vscode.window.createWebviewPanel('envManager', 'Environment Variables', vscode.ViewColumn.One, { enableScripts: true });
        EnvManagerPanel.currentPanel = new EnvManagerPanel(panel, workspaceRoot);
    }

    private constructor(panel: vscode.WebviewPanel, private root: vscode.Uri) {
        this._panel = panel;
        this.render();
        this._panel.webview.onDidReceiveMessage(async msg => {
            if (msg.command === 'save') {
                const envPath = path.join(this.root.fsPath, '.lollms', '.env');
                await fs.mkdir(path.dirname(envPath), { recursive: true });
                const content = msg.vars.map((v: any) => `${v.key}=${v.value}`).join('\n');
                await fs.writeFile(envPath, content);
                vscode.window.showInformationMessage("Environment variables saved.");
            }
        });
    }

    private async render() {
        const envPath = path.join(this.root.fsPath, '.lollms', '.env');
        let vars: {key: string, value: string}[] = [];
        try {
            const content = await fs.readFile(envPath, 'utf8');
            vars = content.split('\n').filter(l => l.includes('=')).map(l => {
                const [key, ...rest] = l.split('=');
                return { key: key.trim(), value: rest.join('=').trim() };
            });
        } catch {}
        this._panel.webview.html = this.getHtml(vars);
    }

    private getHtml(vars: any[]) {
        return `<!DOCTYPE html>
        <html>
        <body style="padding:20px; font-family:sans-serif;">
            <h3>Environment Variables (.lollms/.env)</h3>
            <div id="list"></div>
            <button onclick="addRow()">Add Variable</button>
            <button onclick="save()">Save</button>
            <script>
                const vscode = acquireVsCodeApi();
                let vars = ${JSON.stringify(vars)};
                function render() {
                    document.getElementById('list').innerHTML = vars.map((v, i) => \`
                        <div style="margin-bottom:10px;">
                            <input value="\${v.key}" onchange="vars[${i}].key=this.value" />
                            <input value="\${v.value}" onchange="vars[${i}].value=this.value" />
                            <button onclick="vars.splice(${i},1); render()">Delete</button>
                        </div>\`).join('');
                }
                function addRow() { vars.push({key:'', value:''}); render(); }
                function save() { vscode.postMessage({command: 'save', vars}); }
                render();
            </script>
        </body></html>`;
    }
}