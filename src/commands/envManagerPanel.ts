import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

export class EnvManagerPanel {
    public static currentPanel: EnvManagerPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _workspaceRoot: vscode.Uri;

    public static createOrShow(extensionUri: vscode.Uri, workspaceRoot: vscode.Uri) {
        if (EnvManagerPanel.currentPanel) {
            EnvManagerPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'envManager', 
            'Environment Variables', 
            vscode.ViewColumn.One, 
            { 
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );
        EnvManagerPanel.currentPanel = new EnvManagerPanel(panel, workspaceRoot);
    }

    private constructor(panel: vscode.WebviewPanel, workspaceRoot: vscode.Uri) {
        this._panel = panel;
        this._workspaceRoot = workspaceRoot;

        this._panel.onDidDispose(() => {
            EnvManagerPanel.currentPanel = undefined;
        });

        this._panel.webview.onDidReceiveMessage(async msg => {
            switch (msg.command) {
                case 'save':
                    try {
                        const envPath = path.join(this._workspaceRoot.fsPath, '.lollms', '.env');
                        await fs.mkdir(path.dirname(envPath), { recursive: true });
                        const content = (msg.vars || [])
                            .filter((v: any) => v && (v.key || v.value))
                            .map((v: any) => `${(v.key || '').trim()}=${(v.value || '').trim()}`)
                            .join('\n');
                        await fs.writeFile(envPath, content, 'utf8');
                        vscode.window.showInformationMessage("Environment variables saved to .lollms/.env");
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to save environment variables: ${err.message}`);
                    }
                    break;
            }
        });

        this.render();
    }

    private async render() {
        const lollmsEnvPath = path.join(this._workspaceRoot.fsPath, '.lollms', '.env');
        const rootEnvPath = path.join(this._workspaceRoot.fsPath, '.env');
        let vars: { key: string; value: string }[] = [];

        try {
            let content = '';
            try {
                content = await fs.readFile(lollmsEnvPath, 'utf8');
            } catch {
                content = await fs.readFile(rootEnvPath, 'utf8');
            }

            vars = content.split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0 && !line.startsWith('#') && line.includes('='))
                .map(line => {
                    const eqIdx = line.indexOf('=');
                    const key = line.substring(0, eqIdx).trim();
                    const value = line.substring(eqIdx + 1).trim();
                    return { key, value };
                });
        } catch {
            vars = [];
        }

        if (vars.length === 0) {
            vars.push({ key: '', value: '' });
        }

        this._panel.webview.html = this.getHtml(vars);
    }

    private getHtml(vars: { key: string; value: string }[]): string {
        const serializedVars = JSON.stringify(vars);

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Environment Variables</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-editor-foreground);
            background-color: var(--vscode-editor-background);
            padding: 24px;
            margin: 0;
            box-sizing: border-box;
        }

        .header {
            margin-bottom: 20px;
            border-bottom: 1px solid var(--vscode-widget-border);
            padding-bottom: 12px;
        }

        h2 {
            margin: 0 0 6px 0;
            font-size: 16px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .description {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin: 0;
        }

        .table-container {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-bottom: 20px;
        }

        .row-header {
            display: grid;
            grid-template-columns: 1fr 1fr 60px;
            gap: 12px;
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
            padding: 0 4px;
        }

        .env-row {
            display: grid;
            grid-template-columns: 1fr 1fr 60px;
            gap: 12px;
            align-items: center;
        }

        input {
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 6px 10px;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            outline: none;
            box-sizing: border-box;
            width: 100%;
        }

        input:focus {
            border-color: var(--vscode-focusBorder);
        }

        .actions-bar {
            display: flex;
            gap: 10px;
            margin-top: 16px;
        }

        button {
            border: none;
            border-radius: 4px;
            padding: 6px 14px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            transition: background-color 0.15s ease;
        }

        .btn-primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .btn-primary:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .btn-secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        .btn-secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        .btn-danger {
            background-color: transparent;
            color: var(--vscode-charts-red);
            border: 1px solid var(--vscode-charts-red);
            padding: 5px 8px;
            font-size: 11px;
        }

        .btn-danger:hover {
            background-color: var(--vscode-charts-red);
            color: #ffffff;
        }
    </style>
</head>
<body>
    <div class="header">
        <h2>Environment Variables</h2>
        <p class="description">Configure environment variables stored in <code>.lollms/.env</code> for your active project.</p>
    </div>

    <div class="table-container">
        <div class="row-header">
            <div>Variable Name (KEY)</div>
            <div>Value</div>
            <div></div>
        </div>
        <div id="list"></div>
    </div>

    <div class="actions-bar">
        <button class="btn-secondary" onclick="addRow()">+ Add Variable</button>
        <button class="btn-primary" onclick="save()">Save to .env</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let envVars = ${serializedVars};

        function render() {
            const listEl = document.getElementById('list');
            listEl.innerHTML = '';

            if (envVars.length === 0) {
                envVars.push({ key: '', value: '' });
            }

            envVars.forEach((v, index) => {
                const row = document.createElement('div');
                row.className = 'env-row';
                row.style.marginBottom = '8px';

                const keyInput = document.createElement('input');
                keyInput.type = 'text';
                keyInput.placeholder = 'e.g. API_KEY';
                keyInput.value = v.key || '';
                keyInput.oninput = (e) => { envVars[index].key = e.target.value; };

                const valInput = document.createElement('input');
                valInput.type = 'text';
                valInput.placeholder = 'Value';
                valInput.value = v.value || '';
                valInput.oninput = (e) => { envVars[index].value = e.target.value; };

                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'btn-danger';
                deleteBtn.textContent = 'Delete';
                deleteBtn.onclick = () => {
                    envVars.splice(index, 1);
                    render();
                };

                row.appendChild(keyInput);
                row.appendChild(valInput);
                row.appendChild(deleteBtn);
                listEl.appendChild(row);
            });
        }

        function addRow() {
            envVars.push({ key: '', value: '' });
            render();
            const inputs = document.querySelectorAll('input');
            if (inputs.length > 0) {
                inputs[inputs.length - 2].focus();
            }
        }

        function save() {
            vscode.postMessage({ command: 'save', vars: envVars });
        }

        render();
    </script>
</body>
</html>`;
    }
}