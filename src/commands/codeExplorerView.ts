import * as vscode from 'vscode';
import { CodeGraphNode } from '../codeGraphManager';

export class CodeExplorerPanel {
    public static currentPanel: CodeExplorerPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;

    public static createOrShow(extensionUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (CodeExplorerPanel.currentPanel) {
            CodeExplorerPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'lollmsCodeExplorer',
            'Code Explorer',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
            }
        );

        CodeExplorerPanel.currentPanel = new CodeExplorerPanel(panel, extensionUri);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._panel.webview.html = this._getHtmlForWebview("[]"); // Initial empty state
        this._panel.onDidDispose(() => this.dispose(), null, []);
    }

    public updateGraph(graphData: CodeGraphNode[]) {
        this._panel.webview.html = this._getHtmlForWebview(JSON.stringify(graphData));
    }

    public dispose() {
        CodeExplorerPanel.currentPanel = undefined;
        this._panel.dispose();
    }

    private _getHtmlForWebview(graphDataJson: string): string {
        const iconMapping = {
            file: 'file-code',
            class: 'symbol-class',
            function: 'symbol-method',
            method: 'symbol-method',
            enum: 'symbol-enum'
        };

        function buildHtml(nodes: CodeGraphNode[]): string {
            if (!nodes || nodes.length === 0) return '';
            let html = '<ul>';
            for (const node of nodes) {
                const icon = iconMapping[node.type] || 'symbol-misc';
                html += `<li>
                    <span class="codicon codicon-${icon}"></span>
                    <strong>${node.label}</strong>
                    <span class="details"> - ${node.filePath}:${node.startLine + 1}</span>
                    ${buildHtml(node.children)}
                </li>`;
            }
            html += '</ul>';
            return html;
        }
        
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Code Explorer</title>
    <link href="${this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css'))}" rel="stylesheet" />
    <style>
        body {
            font-family: var(--vscode-font-family);
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 1em;
        }
        ul { list-style-type: none; padding-left: 20px; }
        li { padding: 4px 0; }
        .codicon { vertical-align: middle; margin-right: 5px; }
        .details { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
    </style>
</head>
<body>
    <h1>Code Structure Graph</h1>
    <div id="graph-container"></div>

    <script>
        const graphData = ${graphDataJson};
        const container = document.getElementById('graph-container');
        
        const iconMapping = {
            file: 'file-code',
            class: 'symbol-class',
            function: 'symbol-method',
            method: 'symbol-method',
            enum: 'symbol-enum'
        };

        function buildHtml(nodes) {
            if (!nodes || nodes.length === 0) return '';
            let html = '<ul>';
            for (const node of nodes) {
                const icon = iconMapping[node.type] || 'symbol-misc';
                html += \`<li>
                    <div>
                      <span class="codicon codicon-\${icon}"></span>
                      <strong>\${node.label}</strong>
                    </div>
                    \${buildHtml(node.children)}
                </li>\`;
            }
            html += '</ul>';
            return html;
        }

        if (graphData.length === 0) {
            container.innerHTML = "<p>No code structure found or graph has not been built yet. Click the refresh icon in the Code Explorer sidebar view.</p>";
        } else {
            container.innerHTML = buildHtml(graphData);
        }
    </script>
</body>
</html>`;
    }
}