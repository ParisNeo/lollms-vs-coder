import * as vscode from 'vscode';
import * as path from 'path';
import { LollmsAPI } from '../lollmsAPI';
import { ContextManager } from '../contextManager';
import { getNonce } from './chatPanel/getNonce';
import { stripThinkingTags } from '../utils';

export class CvePanel {
    public static currentPanel: CvePanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri, lollmsApi: LollmsAPI, contextManager: ContextManager) {
        if (CvePanel.currentPanel) {
            CvePanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'lollmsCveBuilder',
            '🛡️ CVE Report Builder',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out')]
            }
        );

        CvePanel.currentPanel = new CvePanel(panel, extensionUri, lollmsApi, contextManager);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, private lollmsApi: LollmsAPI, private contextManager: ContextManager) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._panel.webview.html = this._getHtmlForWebview();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case 'generateFix':
                    await this.handleGenerateFix(msg.data);
                    break;
                case 'applyFix':
                    await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', msg.path, msg.patch, undefined, undefined, { silent: false });
                    break;
                case 'saveReport':
                    await this.handleSaveReport(msg.data);
                    break;
            }
        }, null, this._disposables);
    }

    private async handleGenerateFix(data: any) {
        this._panel.webview.postMessage({ command: 'setLoading', value: true });
        try {
            const systemPrompt = `You are a Senior Security Remediation Expert. 
Your goal is to provide a surgical fix for the described CVE.
STRICT REQUIREMENT: Use AIDER SEARCH/REPLACE format.
Ensure the fix addresses the root cause (e.g., input sanitization, bounds checking) without breaking functionality.`;

            const userPrompt = `### CVE REPORT\nTitle: ${data.title}\nCWE: ${data.cwe}\nDescription: ${data.description}\n\n### TARGET CODE\nFile: ${data.filePath}\n\`\`\`\n${data.sourceCode}\n\`\`\`\n\nGenerate the Aider fix.`;

            const response = await this.lollmsApi.sendChat([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ]);

            this._panel.webview.postMessage({ command: 'fixGenerated', patch: stripThinkingTags(response) });
        } catch (e: any) {
            vscode.window.showErrorMessage("Fix generation failed: " + e.message);
        } finally {
            this._panel.webview.postMessage({ command: 'setLoading', value: false });
        }
    }

    private async handleSaveReport(data: any) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return;

        const cveDir = vscode.Uri.joinPath(workspaceFolder.uri, '.lollms', 'cve');
        await vscode.workspace.fs.createDirectory(cveDir);

        const fileName = `CVE-${Date.now()}.md`;
        const uri = vscode.Uri.joinPath(cveDir, fileName);

        const content = `# CVE Report: ${data.title}\n\n**Severity:** ${data.severity}\n**CWE:** ${data.cwe}\n\n## Description\n${data.description}\n\n## Proposed Fix\n\`\`\`${data.filePath}\n${data.patch}\n\`\`\``;

        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        vscode.window.showInformationMessage(`Report saved to ${vscode.workspace.asRelativePath(uri)}`);
    }

    private dispose() {
        CvePanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) x.dispose();
        }
    }

    private _getHtmlForWebview() {
        const nonce = getNonce();
        return `<!DOCTYPE html>
        <html>
        <head>
            <style>
                :root { 
                    --accent: #e74c3c; 
                    --bg: var(--vscode-editor-background);
                    --card-bg: var(--vscode-editorWidget-background);
                    --fg: var(--vscode-editor-foreground);
                }
                body { font-family: var(--vscode-font-family); background: var(--bg); color: var(--fg); padding: 20px; }
                .dashboard { display: grid; grid-template-columns: 1fr 400px; gap: 20px; max-width: 1200px; margin: 0 auto; }
                .panel { background: var(--card-bg); border: 1px solid var(--vscode-widget-border); border-radius: 8px; padding: 20px; box-shadow: 0 4px 15px rgba(0,0,0,0.3); }
                h2 { color: var(--accent); margin-top: 0; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 10px; }
                label { display: block; margin-top: 15px; font-weight: bold; font-size: 11px; text-transform: uppercase; opacity: 0.8; }
                input, textarea, select { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 8px; border-radius: 4px; box-sizing: border-box; margin-top: 5px; }
                .severity-meter { height: 10px; border-radius: 5px; background: #333; margin-top: 10px; overflow: hidden; }
                .severity-fill { height: 100%; transition: width 0.3s; }
                .btn { background: var(--accent); color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-weight: bold; width: 100%; margin-top: 20px; }
                .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
                .patch-preview { background: #1a1a1a; color: #d4d4d4; padding: 15px; border-radius: 4px; font-family: monospace; font-size: 12px; overflow-x: auto; white-space: pre-wrap; margin-top: 10px; border: 1px dashed #555; }
            </style>
        </head>
        <body>
            <div class="dashboard">
                <div class="panel">
                    <h2>🛡️ Vulnerability Discovery</h2>
                    <label>Exploit Title</label>
                    <input type="text" id="title" placeholder="e.g. Unauthenticated SQL Injection in User Profile">
                    
                    <label>Technical Description</label>
                    <textarea id="description" rows="5" placeholder="Describe the flaw and the affected component..."></textarea>
                    
                    <label>Affected File Path</label>
                    <input type="text" id="filePath" placeholder="src/auth/handler.ts">

                    <label>Remediation (Aider Fix)</label>
                    <div id="patchContainer" class="patch-preview">No fix generated yet...</div>
                    
                    <div style="display:flex; gap:10px;">
                        <button class="btn btn-secondary" onclick="save()">💾 Save Report</button>
                        <button class="btn" id="applyBtn" style="display:none" onclick="apply()">🚀 Apply Fix to Disk</button>
                    </div>
                </div>

                <div class="panel">
                    <h2>📊 Risk Assessment</h2>
                    <label>Severity (CVSS)</label>
                    <select id="severity" onchange="updateMeter()">
                        <option value="Low">Low (0.1 - 3.9)</option>
                        <option value="Medium">Medium (4.0 - 6.9)</option>
                        <option value="High">High (7.0 - 8.9)</option>
                        <option value="Critical">Critical (9.0 - 10.0)</option>
                    </select>
                    <div class="severity-meter"><div id="meter" class="severity-fill"></div></div>
                    
                    <label>CWE ID</label>
                    <input type="text" id="cwe" placeholder="CWE-89">
                    
                    <button class="btn" id="genBtn" onclick="generate()">✨ Generate Surgical Fix</button>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                let currentPatch = "";

                function updateMeter() {
                    const s = document.getElementById('severity').value;
                    const m = document.getElementById('meter');
                    const colors = { 'Low': '#2ecc71', 'Medium': '#f1c40f', 'High': '#e67e22', 'Critical': '#e74c3c' };
                    const widths = { 'Low': '25%', 'Medium': '50%', 'High': '75%', 'Critical': '100%' };
                    m.style.backgroundColor = colors[s];
                    m.style.width = widths[s];
                }

                function generate() {
                    const data = {
                        title: document.getElementById('title').value,
                        description: document.getElementById('description').value,
                        filePath: document.getElementById('filePath').value,
                        cwe: document.getElementById('cwe').value,
                        severity: document.getElementById('severity').value
                    };
                    vscode.postMessage({ command: 'generateFix', data });
                }

                function apply() {
                    const path = document.getElementById('filePath').value;
                    vscode.postMessage({ command: 'applyFix', path, patch: currentPatch });
                }

                function save() {
                    const data = {
                        title: document.getElementById('title').value,
                        description: document.getElementById('description').value,
                        filePath: document.getElementById('filePath').value,
                        cwe: document.getElementById('cwe').value,
                        severity: document.getElementById('severity').value,
                        patch: currentPatch
                    };
                    vscode.postMessage({ command: 'saveReport', data });
                }

                window.addEventListener('message', e => {
                    const m = e.data;
                    if (m.command === 'fixGenerated') {
                        currentPatch = m.patch;
                        document.getElementById('patchContainer').textContent = m.patch;
                        document.getElementById('applyBtn').style.display = 'block';
                    }
                    if (m.command === 'setLoading') {
                        document.getElementById('genBtn').disabled = m.value;
                        document.getElementById('genBtn').textContent = m.value ? 'Thinking...' : '✨ Generate Surgical Fix';
                    }
                });

                updateMeter();
            </script>
        </body>
        </html>`;
    }
}