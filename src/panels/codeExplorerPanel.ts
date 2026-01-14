import * as vscode from 'vscode';
import { CodeGraphManager } from '../codeGraphManager';

export class CodeExplorerPanel {
    static current: CodeExplorerPanel | undefined;
    private panel: vscode.WebviewPanel;

    static open(ctx: vscode.ExtensionContext, graph: CodeGraphManager) {
        if (this.current) {
            this.current.panel.reveal();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'codeExplorer',
            'Code Explorer',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        this.current = new CodeExplorerPanel(panel, ctx, graph);
    }

    constructor(
        panel: vscode.WebviewPanel,
        ctx: vscode.ExtensionContext,
        graph: CodeGraphManager
    ) {
        this.panel = panel;
        this.panel.webview.html = this.html(panel.webview, ctx.extensionUri);

        panel.webview.onDidReceiveMessage(async m => {
            if (m.type === 'requestData') {
                panel.webview.postMessage({
                    type: 'data',
                    classDiagram: graph.generateMermaidClassDiagram(),
                    callGraph: graph.getCallGraphELK()
                });
            }

            if (m.type === 'open') {
                const doc = await vscode.workspace.openTextDocument(m.file);
                vscode.window.showTextDocument(doc, {
                    selection: new vscode.Range(m.line, 0, m.line, 0)
                });
            }
        });

        panel.onDidDispose(() => CodeExplorerPanel.current = undefined);
    }

    private html(webview: vscode.Webview, uri: vscode.Uri) {
        const base = webview.asWebviewUri(uri);
        return `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/elkjs/lib/elk.bundled.js"></script>
<style>
html,body { margin:0;height:100%;background:#1e1e1e;color:#ddd;font-family:var(--vscode-font-family);}
#toolbar {display:flex;gap:8px;padding:8px;border-bottom:1px solid #333}
#view {background:#252526;color:#ddd}
#canvas {height:calc(100% - 42px);overflow:auto}
svg {width:100%;height:100%}
</style>
</head>
<body>
<div id="toolbar">
<select id="view">
<option value="class">Class diagram</option>
<option value="call">Call graph</option>
</select>
<button onclick="request()">Rebuild</button>
</div>
<div id="canvas"></div>
<script src="${base}/webview/explorer.js"></script>
</body>
</html>`;
    }
}
