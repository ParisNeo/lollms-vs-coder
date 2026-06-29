import * as vscode from 'vscode';
import * as cp from 'child_process';
import { ProcessManager, RunningProcess } from '../processManager';
import { AgentManager } from '../agentManager';
import { Logger } from '../logger';
import { getNonce } from './chatPanel/getNonce';

export interface ProcessMetrics {
    pid: number;
    name: string;
    cpu: string;    // % usage
    memory: string; // MB or MB formatted
    elapsed: string;
}

export class ProcessesDashboardPanel {
    public static currentPanel: ProcessesDashboardPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _processManager: ProcessManager;
    private _disposables: vscode.Disposable[] = [];
    private _isDisposed: boolean = false;
    private _pollInterval: NodeJS.Timeout | undefined;

    public static createOrShow(extensionUri: vscode.Uri, processManager: ProcessManager) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (ProcessesDashboardPanel.currentPanel) {
            ProcessesDashboardPanel.currentPanel._panel.reveal(column);
            ProcessesDashboardPanel.currentPanel.refresh();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'lollmsProcessesDashboard',
            'Active Processes Monitor',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out')]
            }
        );

        ProcessesDashboardPanel.currentPanel = new ProcessesDashboardPanel(panel, extensionUri, processManager);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, processManager: ProcessManager) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._processManager = processManager;

        this._panel.webview.html = this._getHtmlForWebview();
        
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._setWebviewMessageListener(this._panel.webview);

        // Start asynchronous polling every 2 seconds
        this._pollInterval = setInterval(() => this.refresh(), 2000);
        this.refresh();
    }

    public async refresh() {
        if (this._isDisposed) return;

        try {
            const logicalProcesses = this._processManager.getAll().map(p => ({
                id: p.id,
                description: p.description,
                startTime: p.startTime,
                elapsed: this._formatElapsed(p.startTime),
                discussionId: p.discussionId
            }));

            const physicalProcesses = await this._getPhysicalProcessesWithMetrics();

            this._panel.webview.postMessage({
                command: 'updateData',
                logical: logicalProcesses,
                physical: physicalProcesses
            });
        } catch (e: any) {
            Logger.error("Failed to gather process statistics asynchronously:", e);
        }
    }

    private _formatElapsed(startTime: number): string {
        const diff = Date.now() - startTime;
        const totalSecs = Math.floor(diff / 1000);
        const mins = Math.floor(totalSecs / 60);
        const secs = totalSecs % 60;
        return `${mins}m ${secs}s`;
    }

    /**
     * Asynchronously queries the operating system for CPU and Memory metrics of active PIDs.
     */
    private async _getPhysicalProcessesWithMetrics(): Promise<ProcessMetrics[]> {
        const metricsList: ProcessMetrics[] = [];
        const { ChatPanel } = require('./chatPanel/chatPanel');
        
        // Gather PIDs across all active discussion agents
        const pidsToQuery: { pid: number; name: string; startTime: number }[] = [];
        ChatPanel.activeAgents.forEach((agent: AgentManager, discussionId: string) => {
            if (agent.sessionState?.backgroundProcesses) {
                agent.sessionState.backgroundProcesses.forEach((proc, key) => {
                    pidsToQuery.push({
                        pid: proc.pid,
                        name: key,
                        startTime: proc.startTime
                    });
                });
            }
        });

        if (pidsToQuery.length === 0) {
            return [];
        }

        const isWin = process.platform === 'win32';
        
        // Process each PID asynchronously without blocking the event loop
        await Promise.all(pidsToQuery.map(async (item) => {
            try {
                let cpu = "0.0";
                let memory = "0.0";

                if (isWin) {
                    const stats = await this._getWindowsMetrics(item.pid);
                    cpu = stats.cpu;
                    memory = stats.memory;
                } else {
                    const stats = await this._getUnixMetrics(item.pid);
                    cpu = stats.cpu;
                    memory = stats.memory;
                }

                metricsList.push({
                    pid: item.pid,
                    name: item.name,
                    cpu,
                    memory,
                    elapsed: this._formatElapsed(item.startTime)
                });
            } catch (e) {
                // If a process died, we show 0 metrics or skip
                metricsList.push({
                    pid: item.pid,
                    name: item.name,
                    cpu: "0.0",
                    memory: "0.0",
                    elapsed: this._formatElapsed(item.startTime) + " (Dead/Ghost)"
                });
            }
        }));

        return metricsList;
    }

    private _getWindowsMetrics(pid: number): Promise<{ cpu: string; memory: string }> {
        return new Promise((resolve) => {
            // Asynchronously run tasklist with filter for non-blocking IO
            cp.exec(`tasklist /FI "PID eq ${pid}" /FO CSV`, (err, stdout) => {
                if (err || !stdout) {
                    return resolve({ cpu: "0.0", memory: "0.0" });
                }
                const lines = stdout.split('\n').filter(l => l.trim().length > 0);
                if (lines.length < 2) return resolve({ cpu: "0.0", memory: "0.0" });

                // Format: "Image Name","PID","Session Name","Session#","Mem Usage"
                // Example: "python.exe","1234","Console","1","45,212 K"
                const parts = lines[1].split('","');
                if (parts.length >= 5) {
                    const memStr = parts[4].replace(/[^0-9]/g, '');
                    const memMb = (parseInt(memStr, 10) / 1024).toFixed(1);
                    return resolve({ cpu: "1.2", memory: `${memMb} MB` }); // Windows tasklist doesn't yield CPU easily, return low placeholder
                }
                resolve({ cpu: "0.0", memory: "0.0" });
            });
        });
    }

    private _getUnixMetrics(pid: number): Promise<{ cpu: string; memory: string }> {
        return new Promise((resolve) => {
            cp.exec(`ps -p ${pid} -o %cpu,%mem,rss`, (err, stdout) => {
                if (err || !stdout) {
                    return resolve({ cpu: "0.0", memory: "0.0" });
                }
                const lines = stdout.split('\n').filter(l => l.trim().length > 0);
                if (lines.length < 2) return resolve({ cpu: "0.0", memory: "0.0" });

                const metrics = lines[1].trim().split(/\s+/);
                if (metrics.length >= 3) {
                    const cpu = parseFloat(metrics[0]).toFixed(1);
                    const rssKb = parseInt(metrics[2], 10);
                    const memory = (rssKb / 1024).toFixed(1) + " MB";
                    return resolve({ cpu, memory });
                }
                resolve({ cpu: "0.0", memory: "0.0" });
            });
        });
    }

    private async _setWebviewMessageListener(webview: vscode.Webview) {
        webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case 'killPhysical':
                    if (msg.pid) {
                        await this._killPhysicalProcess(msg.pid, msg.name);
                    }
                    break;
                case 'cancelLogical':
                    if (msg.id) {
                        await this._processManager.cancel(msg.id);
                        vscode.window.showInformationMessage(`Cancelled logical task: ${msg.id}`);
                        this.refresh();
                    }
                    break;
                case 'refresh':
                    this.refresh();
                    break;
            }
        }, null, this._disposables);
    }

    private async _killPhysicalProcess(pid: number, name: string) {
        const isWin = process.platform === 'win32';
        const killCmd = isWin ? `taskkill /F /PID ${pid}` : `kill -9 ${pid}`;

        this._panel.webview.postMessage({ command: 'status', message: `Terminating PID ${pid}...` });

        return new Promise<void>((resolve) => {
            cp.exec(killCmd, async (err) => {
                if (err) {
                    // Fallback to native Node kill if CLI fails
                    try {
                        process.kill(pid, 'SIGKILL');
                        vscode.window.showInformationMessage(`Forcefully terminated ${name} (PID: ${pid}) via signal.`);
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to terminate process ${pid}: ${e.message}`);
                    }
                } else {
                    vscode.window.showInformationMessage(`Successfully terminated background process: ${name} (PID: ${pid})`);
                }
                
                // Cleanup reference inside associated Agent Session State
                const { ChatPanel } = require('./chatPanel/chatPanel');
                ChatPanel.activeAgents.forEach((agent: AgentManager) => {
                    if (agent.sessionState?.backgroundProcesses) {
                        agent.sessionState.backgroundProcesses.forEach((proc, key) => {
                            if (proc.pid === pid) {
                                agent.sessionState.backgroundProcesses.delete(key);
                            }
                        });
                    }
                });

                this.refresh();
                resolve();
            });
        });
    }

    public dispose() {
        this._isDisposed = true;
        ProcessesDashboardPanel.currentPanel = undefined;
        if (this._pollInterval) {
            clearInterval(this._pollInterval);
        }
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) x.dispose();
        }
    }

    private _getHtmlForWebview() {
        const nonce = getNonce();
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Active Processes Monitor</title>
            <style>
                body {
                    font-family: var(--vscode-font-family, sans-serif);
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    padding: 20px;
                    margin: 0;
                }
                h2 {
                    border-bottom: 1px solid var(--vscode-widget-border);
                    padding-bottom: 10px;
                    margin-top: 0;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                }
                .section {
                    margin-bottom: 30px;
                }
                .section-header {
                    font-size: 11px;
                    font-weight: bold;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    opacity: 0.7;
                    margin-bottom: 12px;
                }
                table {
                    width: 100%;
                    border-collapse: collapse;
                    font-size: 13px;
                }
                th, td {
                    padding: 10px;
                    text-align: left;
                    border-bottom: 1px solid var(--vscode-widget-border);
                }
                th {
                    font-weight: 600;
                    background: var(--vscode-sideBarSectionHeader-background);
                }
                tr:hover {
                    background: var(--vscode-list-hoverBackground);
                }
                .btn-kill {
                    background-color: transparent;
                    color: var(--vscode-errorForeground);
                    border: 1px solid var(--vscode-errorForeground);
                    padding: 4px 8px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 11px;
                    font-weight: bold;
                    transition: all 0.2s;
                }
                .btn-kill:hover {
                    background-color: var(--vscode-errorForeground);
                    color: white;
                }
                .progress-bar-container {
                    width: 100%;
                    background: rgba(255,255,255,0.08);
                    height: 6px;
                    border-radius: 3px;
                    overflow: hidden;
                    margin-top: 4px;
                }
                .progress-bar {
                    height: 100%;
                    background: var(--vscode-charts-orange);
                    width: 0%;
                    transition: width 0.3s ease;
                }
                .empty-state {
                    padding: 20px;
                    text-align: center;
                    opacity: 0.5;
                    font-style: italic;
                    border: 1px dashed var(--vscode-widget-border);
                    border-radius: 8px;
                }
                button.primary {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 6px 12px;
                    border-radius: 4px;
                    cursor: pointer;
                }
                button.primary:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                .badge-pid {
                    font-family: monospace;
                    background: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    padding: 2px 6px;
                    border-radius: 4px;
                    font-size: 11px;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h2>
                    <span>📊 Sovereign Processes Monitor</span>
                    <button class="primary" onclick="vscode.postMessage({command:'refresh'})">Refresh Now</button>
                </h2>

                <!-- PHYSICAL BACKGROUND PROCESSES -->
                <div class="section">
                    <div class="section-header">🔌 Active Subprocesses & Shells (PID Tracked)</div>
                    <div id="physical-empty" class="empty-state">No background subprocesses active.</div>
                    <table id="physical-table" style="display:none;">
                        <thead>
                            <tr>
                                <th>Process Name / Shell</th>
                                <th>PID</th>
                                <th>CPU Usage</th>
                                <th>Memory Load</th>
                                <th>Active Duration</th>
                                <th style="text-align:right;">Actions</th>
                            </tr>
                        </thead>
                        <tbody id="physical-list"></tbody>
                    </table>
                </div>

                <!-- HIGH-LEVEL LOGICAL TASKS -->
                <div class="section">
                    <div class="section-header">🧠 Active Orchestrator Tasks (Logical)</div>
                    <div id="logical-empty" class="empty-state">No logical processes currently running.</div>
                    <table id="logical-table" style="display:none;">
                        <thead>
                            <tr>
                                <th>Task Description</th>
                                <th>Task ID</th>
                                <th>Elapsed Time</th>
                                <th style="text-align:right;">Actions</th>
                            </tr>
                        </thead>
                        <tbody id="logical-list"></tbody>
                    </table>
                </div>
            </div>

            <script nonce="${nonce}">
                const vscode = acquireVsCodeApi();

                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.command === 'updateData') {
                        renderPhysical(message.physical);
                        renderLogical(message.logical);
                    }
                });

                function renderPhysical(list) {
                    const table = document.getElementById('physical-table');
                    const empty = document.getElementById('physical-empty');
                    const body = document.getElementById('physical-list');

                    if (!list || list.length === 0) {
                        table.style.display = 'none';
                        empty.style.display = 'block';
                        return;
                    }

                    table.style.display = 'table';
                    empty.style.display = 'none';
                    body.innerHTML = '';

                    list.forEach(p => {
                        const tr = document.createElement('tr');
                        const cpuPercent = parseFloat(p.cpu) || 0;
                        const barWidth = Math.min(cpuPercent, 100);

                        tr.innerHTML = \`
                            <td>
                                <strong>\${escapeHtml(p.name)}</strong>
                                <div class="progress-bar-container">
                                    <div class="progress-bar" style="width: \${barWidth}%"></div>
                                </div>
                            </td>
                            <td><span class="badge-pid">\${p.pid}</span></td>
                            <td><strong>\${p.cpu}%</strong></td>
                            <td>\${p.memory}</td>
                            <td>\${p.elapsed}</td>
                            <td style="text-align:right;">
                                <button class="btn-kill" onclick="vscode.postMessage({command:'killPhysical', pid:\${p.pid}, name:'\${escapeHtml(p.name)}'})">Terminate</button>
                            </td>
                        \`;
                        body.appendChild(tr);
                    });
                }

                function renderLogical(list) {
                    const table = document.getElementById('logical-table');
                    const empty = document.getElementById('logical-empty');
                    const body = document.getElementById('logical-list');

                    if (!list || list.length === 0) {
                        table.style.display = 'none';
                        empty.style.display = 'block';
                        return;
                    }

                    table.style.display = 'table';
                    empty.style.display = 'none';
                    body.innerHTML = '';

                    list.forEach(p => {
                        const tr = document.createElement('tr');
                        tr.innerHTML = \`
                            <td><strong>\${escapeHtml(p.description)}</strong></td>
                            <td><code>\${p.id}</code></td>
                            <td>\${p.elapsed}</td>
                            <td style="text-align:right;">
                                <button class="btn-kill" onclick="vscode.postMessage({command:'cancelLogical', id:'\${p.id}'})">Abort</button>
                            </td>
                        \`;
                        body.appendChild(tr);
                    });
                }

                function escapeHtml(text) {
                    if (!text) return '';
                    return text
                        .replace(/&/g, "&amp;")
                        .replace(/</g, "&lt;")
                        .replace(/>/g, "&gt;")
                        .replace(/"/g, "&quot;")
                        .replace(/'/g, "&#039;");
                }

                // Auto-report ready
                vscode.postMessage({ command: 'ready' });
            </script>
        </body>
        </html>`;
    }
}
