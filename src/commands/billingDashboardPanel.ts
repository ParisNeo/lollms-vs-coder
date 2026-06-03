import * as vscode from 'vscode';
import { TokenBillingManager, BillingEntry } from '../utils/tokenBillingManager';
import { getNonce } from './chatPanel/getNonce';

export class BillingDashboardPanel {
    public static currentPanel: BillingDashboardPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri) {
        if (BillingDashboardPanel.currentPanel) {
            BillingDashboardPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
            BillingDashboardPanel.currentPanel.update();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'lollmsBillingDashboard',
            '💲 Sovereign Billing Dashboard',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        BillingDashboardPanel.currentPanel = new BillingDashboardPanel(panel, extensionUri);
    }

    private constructor(panel: vscode.WebviewPanel, private extensionUri: vscode.Uri) {
        this._panel = panel;
        this.update();

        this._panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === 'resetLedger') {
                const confirm = await vscode.window.showWarningMessage(
                    "Are you sure you want to permanently clear the entire token billing history?",
                    { modal: true }, "Reset History"
                );
                if (confirm === "Reset History") {
                    await TokenBillingManager.resetLedger();
                    this.update();
                    vscode.window.showInformationMessage("Token billing history cleared.");
                }
            }
        }, null, this._disposables);

        this._panel.onDidDispose(() => {
            BillingDashboardPanel.currentPanel = undefined;
            this._disposables.forEach(d => d.dispose());
        }, null, this._disposables);
    }

    private update() {
        const entries = TokenBillingManager.getEntries();
        this._panel.webview.html = this.getHtml(entries);
    }

    private getHtml(entries: BillingEntry[]): string {
        const nonce = getNonce();
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');

        const billingActive = config.get<boolean>('billing.enabled') ?? true;
        const cappingActive = config.get<boolean>('billing.enableCapping') ?? false;
        const budgetCap = config.get<number>('billing.budgetCap') || 0.00;

        const totalCost = entries.reduce((acc, e) => acc + e.cost, 0);
        const totalInput = entries.reduce((acc, e) => acc + e.inputTokens, 0);
        const totalOutput = entries.reduce((acc, e) => acc + e.outputTokens, 0);

        return `<!DOCTYPE html>
        <html>
        <head>
            <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
            <style>
                body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); padding: 25px; }
                .grid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; margin-bottom: 30px; }
                .metric-card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); padding: 20px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
                .metric-label { font-size: 10px; font-weight: bold; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.5px; }
                .metric-value { font-size: 24px; font-weight: bold; color: var(--vscode-textLink-foreground); margin-top: 5px; }
                .charts-grid { display: grid; grid-template-columns: 2fr 1fr; gap: 20px; margin-bottom: 30px; }
                .chart-container { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); padding: 20px; border-radius: 8px; }
                table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 12px; }
                th, td { padding: 10px; text-align: left; border-bottom: 1px solid var(--vscode-widget-border); }
                th { font-weight: bold; background: var(--vscode-sideBarSectionHeader-background); }
                button.danger { background: transparent; border: 1px solid var(--vscode-errorForeground); color: var(--vscode-errorForeground); padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 11px; }
                button.danger:hover { background: var(--vscode-errorForeground); color: white; }
                .status-badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 9px; font-weight: bold; text-transform: uppercase; margin-left: 10px; }
                .status-active { background: var(--vscode-charts-green); color: white; }
                .status-inactive { background: var(--vscode-charts-red); color: white; }
            </style>
        </head>
        <body>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:25px; border-bottom:1px solid var(--vscode-panel-border); padding-bottom:10px;">
                <h2 style="margin:0; display:flex; align-items:center;">
                    <i class="codicon codicon-credit-card"></i> Sovereign Billing Dashboard
                    <span class="status-badge ${billingActive ? 'status-active' : 'status-inactive'}">${billingActive ? 'Accounting Active' : 'Accounting Deactivated'}</span>
                </h2>
                <button class="danger" onclick="vscode.postMessage({command:'resetLedger'})">Reset Billing Logs</button>
            </div>

            <div class="grid-3">
                <div class="metric-card" style="display: ${billingActive ? 'block' : 'none'};">
                    <div class="metric-label">Total Expenditure (USD)</div>
                    <div class="metric-value">$${totalCost.toFixed(4)}</div>
                </div>
                <div class="metric-card">
                    <div class="metric-label">Daily Budget Cap</div>
                    <div class="metric-value">${cappingActive ? `$${budgetCap.toFixed(2)}` : 'Capping Disabled'}</div>
                </div>
                <div class="metric-card">
                    <div class="metric-label">Total Tokens Processed</div>
                    <div class="metric-value">${(totalInput + totalOutput).toLocaleString()}</div>
                </div>
            </div>

            <div class="charts-grid">
                <div class="chart-container">
                    <span class="metric-label">Weekly Token Consumption (Input vs Output)</span>
                    <canvas id="weeklyTokenChart" style="max-height: 300px; width: 100%;"></canvas>
                </div>
                <div class="chart-container">
                    <span class="metric-label">Token Volume by Model</span>
                    <canvas id="modelChart" style="max-height: 300px; width: 100%;"></canvas>
                </div>
            </div>

            <div class="chart-container" style="margin-top: 20px;">
                <span class="metric-label">Recent Transactions (Ledger)</span>
                <table>
                    <thead>
                        <tr>
                            <th>Time</th>
                            <th>Model</th>
                            <th>Scope</th>
                            <th>Input Tokens</th>
                            <th>Output Tokens</th>
                            <th style="display: ${billingActive ? 'table-cell' : 'none'};">Estimated Cost (USD)</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${entries.slice(-10).reverse().map(e => `
                            <tr>
                                <td>${new Date(e.timestamp).toLocaleTimeString()}</td>
                                <td><code>${e.model}</code></td>
                                <td><code>${e.scope}</code></td>
                                <td>${e.inputTokens.toLocaleString()}</td>
                                <td>${e.outputTokens.toLocaleString()}</td>
                                <td style="display: ${billingActive ? 'table-cell' : 'none'};"><strong>$${e.cost.toFixed(5)}</strong></td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>

            <script nonce="${nonce}">
                const vscode = acquireVsCodeApi();
                const rawData = ${JSON.stringify(entries)};

                // 1. Process Weekly Token usage (Last 7 Days)
                const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                const weeklyInput = Array(7).fill(0);
                const weeklyOutput = Array(7).fill(0);

                const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

                rawData.forEach(e => {
                    if (e.timestamp >= sevenDaysAgo) {
                        const dayIndex = new Date(e.timestamp).getDay();
                        weeklyInput[dayIndex] += e.inputTokens;
                        weeklyOutput[dayIndex] += e.outputTokens;
                    }
                });

                // Re-align days array to start from 7 days ago
                const currentDay = new Date().getDay();
                const orderedDays = [];
                const orderedInput = [];
                const orderedOutput = [];

                for (let i = 6; i >= 0; i--) {
                    const idx = (currentDay - i + 7) % 7;
                    orderedDays.push(daysOfWeek[idx]);
                    orderedInput.push(weeklyInput[idx]);
                    orderedOutput.push(weeklyOutput[idx]);
                }

                // 2. Process Model Volume Distribution
                const modelTokens = {};
                rawData.forEach(e => {
                    modelTokens[e.model] = (modelTokens[e.model] || 0) + e.inputTokens + e.outputTokens;
                });

                // 3. Render Stacked Weekly Bar Chart
                new Chart(document.getElementById('weeklyTokenChart'), {
                    type: 'bar',
                    data: {
                        labels: orderedDays,
                        datasets: [
                            {
                                label: 'Input Tokens',
                                data: orderedInput,
                                backgroundColor: '#36a2eb',
                                stack: 'Stack 0',
                            },
                            {
                                label: 'Output Tokens',
                                data: orderedOutput,
                                backgroundColor: '#ff6384',
                                stack: 'Stack 0',
                            }
                        ]
                    },
                    options: {
                        responsive: true,
                        plugins: { legend: { position: 'top', labels: { color: '#ccc' } } },
                        scales: {
                            x: { stacked: true, grid: { color: '#333' }, ticks: { color: '#999' } },
                            y: { stacked: true, grid: { color: '#333' }, ticks: { color: '#999' } }
                        }
                    }
                });

                // 4. Render Pie/Donut Chart for Models
                new Chart(document.getElementById('modelChart'), {
                    type: 'doughnut',
                    data: {
                        labels: Object.keys(modelTokens),
                        datasets: [{
                            data: Object.values(modelTokens),
                            backgroundColor: ['#ff6384', '#36a2eb', '#cc65fe', '#ffce56', '#2ecc71']
                        }]
                    },
                    options: {
                        responsive: true,
                        plugins: { legend: { position: 'bottom', labels: { color: '#ccc' } } }
                    }
                });
            </script>
        </body>
        </html>`;
    }
}
