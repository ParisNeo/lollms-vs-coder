import * as vscode from 'vscode';
import { Plan } from '../tools/tool';
import { getNonce } from './chatPanel/getNonce';

export class AgentPanel {
    public static currentPanel: AgentPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri) {
        if (AgentPanel.currentPanel) {
            AgentPanel.currentPanel._panel.reveal(vscode.ViewColumn.Two);
            return AgentPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            'lollmsAgentWorkspace',
            '🤖 Lollms Worker Workspace',
            vscode.ViewColumn.Two,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out')]
            }
        );

        AgentPanel.currentPanel = new AgentPanel(panel, extensionUri);
        return AgentPanel.currentPanel;
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._panel.webview.html = this._getHtmlForWebview();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public updatePlan(plan: Plan | null) {
        this._panel.webview.postMessage({ command: 'displayPlan', plan });
    }

    public dispose() {
        AgentPanel.currentPanel = undefined;
        this._panel.dispose();
    }

    private _getHtmlForWebview() {
        const codiconsUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'));
        const jsUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'chatPanel.bundle.js')); // Reuse renderer
        const nonce = getNonce();

        return `<!DOCTYPE html>
        <html>
        <head>
            <link href="${codiconsUri}" rel="stylesheet" />
            <style>
                body { background: var(--vscode-sideBar-background); color: var(--vscode-foreground); padding: 0; margin: 0; font-family: var(--vscode-font-family); }
                #agent-plan-zone { display: flex; flex-direction: column; height: 100vh; overflow-y: auto; }
            </style>
        </head>
        <body>
            <div id="agent-plan-zone"></div>
            <script nonce="${nonce}" src="${jsUri}"></script>
        </body>
        </html>`;
    }
}