import * as vscode from 'vscode';

export class AutomationPanel {
    public static currentPanel: AutomationPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _onDidCancel = new vscode.EventEmitter<void>();
    public readonly onDidCancel = this._onDidCancel.event;

    public static createOrShow(extensionUri: vscode.Uri): AutomationPanel {
        if (AutomationPanel.currentPanel) {
            AutomationPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
            return AutomationPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            'lollmsAutomation',
            'Lollms: Workspace Repair',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
            }
        );

        AutomationPanel.currentPanel = new AutomationPanel(panel, extensionUri);
        return AutomationPanel.currentPanel;
    }

    private _isReady = false;
    private _queuedMessages: any[] = [];

    private constructor(panel: vscode.WebviewPanel, private _extensionUri: vscode.Uri) {
        this._panel = panel;
        this._panel.webview.html = this._getHtmlForWebview();
        
        this._panel.webview.onDidReceiveMessage(async msg => {
            if (msg.command === 'ready') {
                this._isReady = true;
                this._queuedMessages.forEach(m => this._panel.webview.postMessage(m));
                this._queuedMessages = [];
                return;
            }
            switch (msg.command) {
                case 'cancel':
                    this._onDidCancel.fire();
                    break;
                case 'copyToClipboard':
                    if (msg.text) {
                        await vscode.env.clipboard.writeText(msg.text);
                        vscode.window.showInformationMessage("Error list copied to clipboard.");
                    }
                    break;
                case 'startChatWithErrors':
                    if (msg.text) {
                        const prompt = `Fix these workspace errors:\n\n${msg.text}`;
                        // We use the existing utility to start a discussion
                        await vscode.commands.executeCommand('lollms-vs-coder.newDiscussionFromClipboard', prompt);
                        // Optional: close repair panel if moving to chat
                        // this.dispose();
                    }
                    break;
            }
        }, null, this._disposables);

        this._panel.onDidDispose(() => {
            AutomationPanel.currentPanel = undefined;
        }, null, this._disposables);
    }

    private _postMessage(message: any) {
        if (this._isReady) {
            this._panel.webview.postMessage(message);
        } else {
            this._queuedMessages.push(message);
        }
    }

    public showDiscovery(files: { path: string, errors: { line: number, message: string, snippet: string }[] }[]) {
        this._postMessage({ command: 'discovery', files });
    }

    public updateFileProgress(filePath: string, status: string, details: string, data?: any) {
        // Ensure we explicitly pass reasoning if it's inside the data object
        this._postMessage({ command: 'updateFile', filePath, status, details, ...data });
    }

    public updateOverallProgress(percentage: number, label: string) {
        this._postMessage({ command: 'updateProgress', percentage, label });
    }

    public log(message: string) {
        this._postMessage({ command: 'log', message });
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
                .discovery-item { border-bottom: 1px solid var(--vscode-widget-border); padding: 10px; display: flex; align-items: flex-start; gap: 10px; }
                .discovery-item:hover { background: var(--vscode-list-hoverBackground); }
                .discovery-details { flex: 1; }
                .snippet-box { background: #000; color: #d4d4d4; padding: 8px; border-radius: 4px; font-family: monospace; font-size: 11px; margin-top: 5px; white-space: pre; overflow-x: auto; }
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
                .spinner { width: 10px; height: 10px; border: 2px solid currentColor; border-bottom-color: transparent; border-radius: 50%; animation: spin 1s linear infinite; display: inline-block; margin-right: 10px; flex-shrink: 0; }
                .step-icon { margin-right: 10px; flex-shrink: 0; display: inline-block; width: 16px; text-align: center; }
                @keyframes spin { 100% { transform: rotate(360deg); } }
                .stop-btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 12px; border-radius: 2px; cursor: pointer; font-size: 12px; }
            </style>
        </head>
        <body>
            <div class="sticky-header">
                <div class="header-row">
                    <h3>🛠️ Workspace Repair Engine</h3>
                    <div style="display: flex; gap: 8px;">
                        <button class="stop-btn" id="copy-errors-btn" style="background: var(--vscode-button-secondaryBackground);" title="Copy all error messages to clipboard">Copy Errors</button>
                        <button class="stop-btn" id="chat-errors-btn" style="background: var(--vscode-button-secondaryBackground);" title="Start a new chat to fix these errors">Fix in Chat</button>
                        <button class="stop-btn" id="export-btn" style="background: var(--vscode-button-secondaryBackground);">Export Log</button>
                        <button class="stop-btn" onclick="vscode.postMessage({command:'cancel'})">Stop All</button>
                    </div>
                </div>
                <div class="progress-container"><div id="main-progress" class="progress-bar"></div></div>
                <span id="progress-label" class="progress-label">Initializing...</span>
            </div>
            
            <div id="discovery-container" style="display: none; flex: 1; flex-direction: column; padding-bottom: 200px;">
                <div style="margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center;">
                    <div style="display:flex; flex-direction:column; gap:8px;">
                        <p style="font-size: 12px; opacity: 0.8; margin:0;">Select files and specific errors to repair:</p>
                        <div style="display:flex; gap:10px;">
                            <button class="secondary-button" id="select-all-btn" style="padding: 2px 8px; font-size: 11px;">Select All</button>
                            <button class="secondary-button" id="select-none-btn" style="padding: 2px 8px; font-size: 11px;">Select None</button>
                        </div>
                    </div>
                    <button class="stop-btn" id="start-btn" style="background: var(--vscode-charts-green); color: white;">Start Repair</button>
                </div>
                <div id="discovery-list"></div>
            </div>

            <div id="file-container" style="display: none; flex: 1; overflow-y: auto; padding-bottom: 200px;"></div>

            <div id="console-output" style="position: fixed; bottom: 0; left: 0; right: 0; height: 180px; background: #000; border-top: 2px solid var(--vscode-widget-border); padding: 10px; font-family: 'Consolas', monospace; font-size: 10px; overflow-y: auto; color: #0f0; z-index: 200;">
                <div style="color: #aaa; border-bottom: 1px solid #333; margin-bottom: 5px; padding-bottom: 2px;">LIVE SYSTEM LOGS</div>
                <div id="log-entries"></div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                const container = document.getElementById('file-container');
                const logEntries = document.getElementById('log-entries');
                const fileMap = new Map();
                
                // Track all data for export
                let sessionData = {
                    startTime: new Date().toISOString(),
                    discovery: [],
                    timeline: [],
                    systemLogs: []
                };

                const getErrorSummary = () => {
                    let summary = "Workspace Errors Discovery:\\n\\n";
                    sessionData.discovery.forEach(f => {
                        summary += \`File: \${f.path}\\n\`;
                        f.errors.forEach(e => {
                            summary += \`- [Line \${e.line}] \${e.message}\\n\`;
                            if (e.snippet) {
                                summary += \`  Context: \${e.snippet}\\n\`;
                            }
                        });
                        summary += "\\n";
                    });
                    return summary;
                };

                document.getElementById('copy-errors-btn').onclick = () => {
                    vscode.postMessage({ command: 'copyToClipboard', text: getErrorSummary() });
                };

                document.getElementById('chat-errors-btn').onclick = () => {
                    vscode.postMessage({ command: 'startChatWithErrors', text: getErrorSummary() });
                };

                document.getElementById('export-btn').onclick = () => {
                    vscode.postMessage({ command: 'export', data: sessionData });
                };

                // Notify host that we are ready to receive queued messages
                vscode.postMessage({ command: 'ready' });

                window.addEventListener('message', event => {
                    const msg = event.data;
                    if (msg.command === 'log') {
                        const timestamp = new Date().toLocaleTimeString();
                        sessionData.systemLogs.push({ timestamp, message: msg.message });
                        
                        const entry = document.createElement('div');
                        entry.style.marginBottom = '2px';
                        entry.textContent = \`[\${timestamp}] \${msg.message}\`;
                        logEntries.appendChild(entry);
                        logEntries.scrollTop = logEntries.scrollHeight;
                    } else if (msg.command === 'updateProgress') {
                        document.getElementById('main-progress').style.width = msg.percentage + '%';
                        document.getElementById('progress-label').textContent = msg.label;
                    }
                    if (msg.command === 'discovery') {
                        sessionData.discovery = msg.files;
                        document.getElementById('discovery-container').style.display = 'flex';
                        const list = document.getElementById('discovery-list');
                        list.innerHTML = msg.files.map((f, fIdx) => \`
                            <div class="discovery-item" id="file-row-\${fIdx}">
                                <input type="checkbox" class="file-check" data-path="\${f.path}" checked>
                                <div class="discovery-details">
                                    <div class="file-header" style="background:transparent; padding:0; border:none;">
                                        <span class="file-path">\${f.path}</span>
                                        <span class="error-badge">\${f.errors.length} ERRORS</span>
                                    </div>
                                    <details open style="border:none; margin:0;">
                                        <summary style="padding: 2px 0; opacity: 0.7; font-size: 11px;">Configure Errors</summary>
                                        \${f.errors.map((e, eIdx) => \`
                                            <div style="margin-top:8px; display:flex; gap:10px; align-items:flex-start;">
                                                <input type="checkbox" class="error-check" data-file-path="\${f.path}" data-line="\${e.line}" checked style="margin-top:2px;">
                                                <div style="flex:1;">
                                                    <div style="font-size:10px; color:var(--vscode-charts-orange); font-weight:bold;">Line \${e.line}: \${e.message}</div>
                                                    <div class="snippet-box">\${e.snippet}</div>
                                                </div>
                                            </div>
                                        \`).join('')}
                                    </details>
                                </div>
                            </div>
                        \`).join('');

                        // Auto-check logic: unchecking a file unchecks all its errors, and vice versa
                        document.querySelectorAll('.file-check').forEach(fc => {
                            fc.onchange = (e) => {
                                const row = fc.closest('.discovery-item');
                                row.querySelectorAll('.error-check').forEach(ec => ec.checked = fc.checked);
                            };
                        });

                        document.getElementById('select-all-btn').onclick = () => {
                            document.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
                        };

                        document.getElementById('select-none-btn').onclick = () => {
                            document.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
                        };

                        document.getElementById('start-btn').onclick = () => {
                            const selections = {};
                            document.querySelectorAll('.error-check:checked').forEach(ec => {
                                const path = ec.dataset.filePath;
                                if (!selections[path]) selections[path] = [];
                                selections[path].push(parseInt(ec.dataset.line));
                            });

                            if (Object.keys(selections).length === 0) return;
                            
                            document.getElementById('discovery-container').style.display = 'none';
                            document.getElementById('file-container').style.display = 'block';
                            vscode.postMessage({ command: 'start', selections: selections });
                        };
                    }
                    if (msg.command === 'updateFile') {
                        sessionData.timeline.push({
                            timestamp: new Date().toLocaleTimeString(),
                            file: msg.filePath,
                            status: msg.status,
                            details: msg.details,
                            reasoning: msg.scratchpad
                        });

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
                        
                        // Stop any previous spinners in this timeline
                        const previousActiveSteps = timeline.querySelectorAll('.step.active');
                        previousActiveSteps.forEach(s => {
                            s.classList.remove('active');
                            s.classList.add('done');
                            const spinner = s.querySelector('.spinner');
                            if (spinner) {
                                const check = document.createElement('span');
                                check.textContent = '●'; // Small bullet for completed intermediate steps
                                check.style.opacity = '0.5';
                                check.style.marginRight = '8px';
                                spinner.replaceWith(check);
                            }
                        });

                        const step = document.createElement('div');
                        const isFinal = ['success', 'error'].includes(msg.status);
                        step.className = 'step ' + (msg.status === 'success' ? 'done success' : (msg.status === 'error' ? 'error' : 'active'));
                        
                        let subDetails = '';
                        if (msg.scratchpad && msg.scratchpad !== "No reasoning provided.") {
                            subDetails += \`<details open style="margin-top:8px;"><summary style="color:var(--vscode-charts-purple)">🧠 Reasoning</summary><div class="detail-content">\${msg.scratchpad}</div></details>\`;
                        }
                        if (msg.patch) {
                            subDetails += \`<details style="margin-top:5px;"><summary>📝 Patch Content</summary><div class="detail-content">\${msg.patch}</div></details>\`;
                        }

                        const icon = msg.status === 'success' ? '<span class="step-icon">✅</span>' : (msg.status === 'error' ? '<span class="step-icon">❌</span>' : '<div class="spinner"></div>');
                        step.innerHTML = \`<div style="display:flex; align-items:center;">\${icon} <span style="flex:1;">\${msg.details}</span></div>\${subDetails}\`;
                        timeline.appendChild(step);
                        
                        if (isFinal) {
                            step.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }
                    }
                });
            </script>
        </body></html>`;
    }
}