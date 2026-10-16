import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { KnowledgeManager } from '../knowledgeManager';
import { stripThinkingTags } from '../utils';
import { ChatPanel } from './chatPanel/chatPanel';
import { Logger } from '../logger';

export class KnowledgeGraphPanel {
    public static currentPanel: KnowledgeGraphPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _services: LollmsServices;
    private _disposables: vscode.Disposable[] = [];
    private _km: KnowledgeManager;

    public static createOrShow(extensionUri: vscode.Uri, services: LollmsServices) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : vscode.ViewColumn.One;

        if (KnowledgeGraphPanel.currentPanel) {
            KnowledgeGraphPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'lollmsKnowledgeStudio',
            '🏛️ Architecture & Knowledge Graph Studio',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    extensionUri,
                    vscode.Uri.joinPath(extensionUri, 'out'),
                    vscode.Uri.joinPath(extensionUri, 'out', 'styles'),
                    vscode.Uri.joinPath(extensionUri, 'media')
                ]
            }
        );

        KnowledgeGraphPanel.currentPanel = new KnowledgeGraphPanel(panel, extensionUri, services);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, services: LollmsServices) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._services = services;
        this._km = new KnowledgeManager(services.context);

        this._panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'lollms-icon.svg');
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._setWebviewMessageListener();
        this._panel.webview.html = this._getHtmlForWebview();

        this.initStudioData();
    }

    public dispose() {
        KnowledgeGraphPanel.currentPanel = undefined;
        try {
            this._panel.dispose();
        } catch {}
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    private async initStudioData() {
        const folder = vscode.workspace.workspaceFolders?.[0];
        const elements = await this._km.getHighLevelGraphElements(folder, false, 400);
        const topologyReport = await this._km.renderContextKnowledge(folder);

        this._panel.webview.postMessage({
            command: 'initData',
            elements,
            topologyReport,
            workspaceName: folder ? folder.name : 'Workspace'
        });
    }

    private _setWebviewMessageListener() {
        this._panel.webview.onDidReceiveMessage(async (message) => {
            const folder = vscode.workspace.workspaceFolders?.[0];

            switch (message.command) {
                case 'requestGraphData': {
                    const connectedOnly = message.connectedOnly === true;
                    const viewScope = message.viewScope || 'abox';
                    let elements;
                    if (viewScope === 'tbox') {
                        elements = this._km.getTBoxGraphElements();
                    } else {
                        // Pass viewScope to ensure calls and functions are prioritized and not dropped
                        elements = await this._km.getHighLevelGraphElements(folder, connectedOnly, 400, viewScope);
                    }
                    this._panel.webview.postMessage({
                        command: 'updateGraphElements',
                        elements,
                        viewScope
                    });
                    break;
                }
                case 'rebuildABox': {
                    vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: `Lollms: Compiling ABox & synchronizing Knowledge Graph (${folder ? folder.name : 'Workspace'})...`,
                        cancellable: false
                    }, async (progress) => {
                        this._panel.webview.postMessage({
                            command: 'rebuildProgress',
                            status: 'Parsing AST symbols, dependencies, and docstrings in background...'
                        });

                        try {
                            if (this._services.codeGraphManager) {
                                if (folder) this._services.codeGraphManager.setWorkspaceRoot(folder.uri);
                                this._services.codeGraphManager.reset();
                                await this._services.codeGraphManager.buildGraph(undefined, (p) => {
                                    progress.report({ message: `${p.status} (${p.percentage}%)` });
                                    this._panel.webview.postMessage({
                                        command: 'rebuildProgress',
                                        status: `${p.status} (${p.percentage}%)`
                                    });
                                });

                                progress.report({ message: "Synchronizing semantic ABox into .lollms/knowledge.ttl..." });
                                await this._km.syncCodeGraph(
                                    this._services.codeGraphManager.getGraphData().nodes,
                                    this._services.codeGraphManager.getGraphData().edges,
                                    folder
                                );
                            }

                            const elements = await this._km.getHighLevelGraphElements(folder, false, 400);
                            const topologyReport = await this._km.renderContextKnowledge(folder);

                            this._panel.webview.postMessage({
                                command: 'rebuildComplete',
                                elements,
                                topologyReport
                            });

                            vscode.window.showInformationMessage("✅ Codebase ABox rebuilt! SPARQL queries and graph intelligence are now ready.");
                        } catch (err: any) {
                            Logger.error("Failed to rebuild ABox in background:", err);
                            this._panel.webview.postMessage({
                                command: 'rebuildError',
                                error: err.message
                            });
                            vscode.window.showErrorMessage(`ABox rebuild failed: ${err.message}`);
                        }
                    });
                    break;
                }
                case 'executeSparql': {
                    const query = message.query || '';
                    const result = await this._km.executeSparql(query, folder);
                    const constructedGraph = this._km.lastConstructedGraph;
                    this._panel.webview.postMessage({
                        command: 'sparqlResult',
                        query,
                        result,
                        constructedGraph
                    });
                    break;
                }
                case 'openFile': {
                    if (message.path) {
                        const resolution = await this._services.contextManager.resolveWorkspaceFromPath(message.path);
                        if (resolution) {
                            const doc = await vscode.workspace.openTextDocument(resolution.uri);
                            const editor = await vscode.window.showTextDocument(doc);
                            if (typeof message.line === 'number' && message.line > 0) {
                                const pos = new vscode.Position(message.line, 0);
                                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                            }
                        }
                    }
                    break;
                }
                case 'copilotAsk': {
                    await this.handleCopilotQuestion(message.question);
                    break;
                }
                case 'sendFindingsToChat': {
                    await this.handleSendFindingsToChat(message.question, message.findings);
                    break;
                }
                case 'openKnowledgeRoot': {
                    await vscode.commands.executeCommand('lollms-vs-coder.openKnowledgeRoot');
                    break;
                }
                case 'resetKnowledge': {
                    await this._km.resetKnowledge(folder);
                    const elements = await this._km.getHighLevelGraphElements(folder, false, 100);
                    const topologyReport = await this._km.renderContextKnowledge(folder);
                    this._panel.webview.postMessage({
                        command: 'rebuildComplete',
                        elements,
                        topologyReport
                    });
                    vscode.window.showInformationMessage("🧹 Knowledge Graph (.lollms/knowledge.ttl) has been reset.");
                    break;
                }
            }
        }, null, this._disposables);
    }

    private async handleCopilotQuestion(question: string) {
        if (!question || !question.trim()) return;

        const folder = vscode.workspace.workspaceFolders?.[0];
        const model = this._services.lollmsAPI.getModelName();
        const topology = await this._km.renderContextKnowledge(folder);

        this._panel.webview.postMessage({
            command: 'copilotStreamStart',
            question
        });

        const systemPrompt = `You are the Sovereign Codebase Architecture Copilot.
Your mission is to help the developer understand the architecture and components of their codebase using the Knowledge Graph triplestore (.lollms/knowledge.ttl).

ONTOLOGY SCHEMA:
- Classes:
  * s:SourceFile: A source file on disk
  * s:VueComponent: Vue.js Single File Component (.vue)
  * s:BackendModule: Backend server file / module (Python, Node)
  * s:AutomationScript: Shell / DevOps script (.sh, .bat, .ps1)
  * s:ClassDefinition, s:InterfaceDefinition: Object-oriented classes and interfaces
  * s:FunctionDefinition, s:MethodDefinition: Standalone functions and class methods
  * s:FunctionDescription: Docstrings, Doxygen blocks (/**, /*!, ///), JSDoc, and function descriptions
  * s:APIRoute: REST API endpoints / router paths (FastAPI, Express)
  * s:StateStore: State management stores (Pinia, Vuex)
  * s:ExternalLibrary: Imported packages (e.g. pygame, numpy)
- Properties:
  * s:containsEntity, s:definedInFile: File contains code entity
  * s:memberOfClass: Method belongs to Class
  * s:importsModule: File imports another file/library
  * s:invokesFunction: Function/Method calls another function
  * s:inheritsFrom: Class inheritance
  * s:disjointWith: Redundant same-name functions in different files
  * s:hasFunctionDescription, s:describesFunction: Links function to its documentation
  * s:functionDescription, s:docstring: Literal documentation text
  * s:layer: "Frontend", "Backend", "DevOps", "Shared"
  * s:programmingLanguage: "Vue", "TypeScript", "Python", "Bash", etc.
  * s:filePath: String file path on disk
  * s:name: Symbol or file name

MULTI-QUERY DISCOVERY PROTOCOL:
You can execute up to 3 SPARQL queries in sequence to gather empirical evidence.
To execute a SPARQL query, output a JSON object:
\`\`\`json
{
  "action": "sparql",
  "thought": "Why I need to query this",
  "query": "SELECT ?file ?filePath WHERE { ?file a s:SourceFile ; s:layer 'Frontend' ; s:filePath ?filePath . } LIMIT 25"
}
\`\`\`

When you have sufficient evidence to provide a comprehensive, clear, and direct answer:
Output your final answer:
\`\`\`json
{
  "action": "answer",
  "content": "Clear, direct explanation citing exact file paths, component names, and architecture patterns."
}
\`\`\`
Or simply output clean markdown without JSON.

CURRENT GRAPH TOPOLOGY:
${topology}`;

        const conversation: any[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Developer Question: "${question}"` }
        ];

        const executedQueries: Array<{ query: string; thought: string; matchesCount: number }> = [];
        let maxRounds = 3;
        let finalAnswer = "";

        while (maxRounds > 0) {
            maxRounds--;

            try {
                const response = await this._services.lollmsAPI.sendChat(conversation, null, undefined, model, { thinking: false });
                const clean = stripThinkingTags(response).trim();

                const jsonMatch = clean.match(/```json\s*([\s\S]+?)\s*```/) || clean.match(/\{[\s\S]*\}/);
                let parsed: any = null;
                if (jsonMatch) {
                    try { parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]); } catch {}
                }

                if (parsed && parsed.action === 'sparql' && parsed.query) {
                    const queryText = parsed.query.trim();
                    const thoughtText = parsed.thought || "Querying Knowledge Graph...";

                    this._panel.webview.postMessage({
                        command: 'copilotQueryRunning',
                        query: queryText,
                        thought: thoughtText
                    });

                    const sparqlResult = await this._km.executeSparql(queryText, folder);
                    const matchRows = (sparqlResult.match(/\| \`/g) || []).length;

                    executedQueries.push({
                        query: queryText,
                        thought: thoughtText,
                        matchesCount: matchRows
                    });

                    conversation.push({ role: 'assistant', content: clean });
                    conversation.push({
                        role: 'user',
                        content: `SPARQL Query Execution Result:\n${sparqlResult}\n\nBased on these observations, execute another targeted query if needed, or provide your final clear answer.`
                    });
                    continue;
                }

                if (parsed && parsed.action === 'answer' && parsed.content) {
                    finalAnswer = parsed.content.trim();
                    break;
                }

                finalAnswer = clean.replace(/```json[\s\S]*?```/g, '').trim() || clean;
                break;

            } catch (err: any) {
                finalAnswer = `Architecture Copilot error: ${err.message}`;
                break;
            }
        }

        const constructedGraph = this._km.lastConstructedGraph;

        this._panel.webview.postMessage({
            command: 'copilotAnswerReady',
            question,
            answer: finalAnswer,
            queries: executedQueries,
            constructedGraph
        });
    }

    private async handleSendFindingsToChat(question: string, findings: string) {
        let panel = ChatPanel.currentPanel;
        if (!panel) {
            const all = await this._services.discussionManager.getAllDiscussions();
            const targetId = all.length > 0 ? all[0].id : this._services.discussionManager.createNewDiscussion().id;
            panel = ChatPanel.createOrShow(this._services, targetId);
            await panel.loadDiscussion();
        }

        panel._panel.reveal();

        const formatted = `### 🏛️ Architecture & Knowledge Graph Findings: "${question}"\n\n${findings}\n\n*These architectural findings were investigated and sent from the Architecture & Knowledge Graph Studio.*`;

        await panel.addMessageToDiscussion({
            id: 'arch_findings_' + Date.now(),
            role: 'assistant',
            content: formatted,
            personalityName: '🏛️ Architecture Copilot'
        });

        vscode.window.showInformationMessage("✅ Architectural findings sent to the main discussion!");
    }

    private _getHtmlForWebview(): string {
        const codiconsUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'));
        const cspSource = this._panel.webview.cspSource;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; font-src ${cspSource}; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; connect-src *;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Architecture & Knowledge Graph Studio</title>
    <link href="${codiconsUri}" rel="stylesheet" />
    <script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.28.1/cytoscape.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <style>
        body {
            font-family: var(--vscode-font-family);
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 0;
            margin: 0;
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
        }
        .header {
            padding: 10px 18px;
            background: var(--vscode-editorWidget-background);
            border-bottom: 1px solid var(--vscode-widget-border);
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            flex-shrink: 0;
        }
        .header-title-group {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .header-icon {
            width: 32px;
            height: 32px;
            border-radius: 8px;
            background: rgba(155, 89, 182, 0.2);
            color: var(--vscode-charts-purple);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
        }
        .header-title {
            font-size: 14px;
            font-weight: 800;
            letter-spacing: 0.5px;
            color: var(--vscode-foreground);
        }
        .header-subtitle {
            font-size: 10.5px;
            opacity: 0.75;
        }
        .header-actions {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: bold;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            transition: all 0.15s;
        }
        .btn:hover { filter: brightness(1.15); }
        .btn.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-widget-border);
        }
        .btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
        .nav-tabs {
            display: flex;
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-widget-border);
            padding: 4px 18px 0 18px;
            gap: 4px;
            flex-shrink: 0;
        }
        .tab-btn {
            background: transparent;
            border: 1px solid transparent;
            border-bottom: none;
            color: var(--vscode-foreground);
            padding: 8px 14px;
            font-size: 11.5px;
            font-weight: 600;
            cursor: pointer;
            border-radius: 6px 6px 0 0;
            display: flex;
            align-items: center;
            gap: 6px;
            opacity: 0.7;
            transition: all 0.15s;
        }
        .tab-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
        .tab-btn.active {
            opacity: 1;
            background: var(--vscode-editor-background);
            border-color: var(--vscode-widget-border);
            border-bottom: 1px solid var(--vscode-editor-background);
            margin-bottom: -1px;
            color: var(--vscode-textLink-foreground);
            font-weight: 700;
        }
        .main-container {
            flex: 1;
            display: flex;
            overflow: hidden;
            position: relative;
        }
        .tab-pane {
            display: none;
            width: 100%;
            height: 100%;
            overflow: hidden;
        }
        .tab-pane.active {
            display: flex;
        }

        /* Copilot Tab Styles */
        .copilot-layout {
            display: flex;
            width: 100%;
            height: 100%;
        }
        .copilot-chat-col {
            flex: 1.2;
            display: flex;
            flex-direction: column;
            border-right: 1px solid var(--vscode-widget-border);
            height: 100%;
            background: var(--vscode-editor-background);
        }
        .copilot-messages {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 14px;
        }
        .copilot-input-area {
            padding: 12px 16px;
            background: var(--vscode-sideBar-background);
            border-top: 1px solid var(--vscode-widget-border);
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .chips-row {
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
        }
        .chip {
            background: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-widget-border);
            padding: 3px 8px;
            border-radius: 12px;
            font-size: 10px;
            cursor: pointer;
            transition: all 0.15s;
            user-select: none;
        }
        .chip:hover {
            border-color: var(--vscode-charts-purple);
            color: var(--vscode-charts-purple);
        }
        .copilot-input-row {
            display: flex;
            gap: 8px;
            align-items: flex-end;
        }
        .copilot-textarea {
            flex: 1;
            height: 48px;
            resize: none;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            padding: 8px;
            font-family: inherit;
            font-size: 12px;
            outline: none;
        }
        .copilot-textarea:focus { border-color: var(--vscode-focusBorder); }
        .copilot-side-col {
            flex: 0.8;
            display: flex;
            flex-direction: column;
            background: var(--vscode-sideBar-background);
            padding: 14px;
            overflow-y: auto;
            gap: 12px;
        }

        /* Message Bubbles */
        .msg-bubble {
            padding: 12px 14px;
            border-radius: 8px;
            font-size: 12px;
            line-height: 1.5;
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        .msg-bubble.user {
            background: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-widget-border);
            border-left: 3px solid var(--vscode-charts-blue);
            align-self: flex-end;
            width: 88%;
        }
        .msg-bubble.assistant {
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-widget-border);
            border-left: 3px solid var(--vscode-charts-purple);
            align-self: flex-start;
            width: 95%;
        }
        .query-inspection-card {
            background: rgba(0,0,0,0.25);
            border: 1px dashed var(--vscode-widget-border);
            border-radius: 4px;
            padding: 6px 10px;
            font-family: monospace;
            font-size: 11px;
            margin-top: 4px;
        }

        /* Cytoscape Tab */
        .graph-container {
            width: 100%;
            height: 100%;
            position: relative;
            display: flex;
        }
        #cyCanvas {
            flex: 1;
            height: 100%;
            position: relative;
        }
        .graph-floating-controls {
            position: absolute;
            top: 12px;
            right: 12px;
            display: flex;
            align-items: center;
            gap: 6px;
            z-index: 10;
            background: rgba(30, 30, 30, 0.85);
            padding: 5px 8px;
            border-radius: 8px;
            border: 1px solid var(--vscode-widget-border);
            backdrop-filter: blur(8px);
            box-shadow: 0 4px 14px rgba(0,0,0,0.4);
        }
        .graph-view-selector-bar {
            position: absolute;
            top: 12px;
            left: 12px;
            display: flex;
            align-items: center;
            gap: 6px;
            z-index: 10;
            background: rgba(30, 30, 30, 0.85);
            padding: 5px 8px;
            border-radius: 8px;
            border: 1px solid var(--vscode-widget-border);
            backdrop-filter: blur(8px);
            box-shadow: 0 4px 14px rgba(0,0,0,0.4);
        }
        .view-pill-btn {
            background: transparent;
            border: 1px solid transparent;
            color: var(--vscode-foreground);
            padding: 4px 10px;
            font-size: 11px;
            font-weight: 600;
            border-radius: 6px;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 5px;
            opacity: 0.75;
            transition: all 0.15s;
        }
        .view-pill-btn:hover {
            opacity: 1;
            background: var(--vscode-toolbar-hoverBackground);
        }
        .view-pill-btn.active {
            opacity: 1;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            font-weight: 700;
        }
        .graph-doc-inspector {
            width: 340px;
            border-left: 1px solid var(--vscode-widget-border);
            background: var(--vscode-sideBar-background);
            display: none;
            flex-direction: column;
            height: 100%;
            z-index: 15;
            overflow-y: auto;
            box-sizing: border-box;
            padding: 14px;
            gap: 10px;
            box-shadow: -4px 0 16px rgba(0,0,0,0.3);
        }
        .cy-node-tooltip {
            position: absolute;
            display: none;
            z-index: 1000;
            background: var(--vscode-editorWidget-background);
            color: var(--vscode-editorWidget-foreground);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 6px;
            padding: 10px 12px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.6);
            pointer-events: none;
            max-width: 380px;
            font-size: 11px;
            line-height: 1.45;
            animation: fadeIn 0.15s ease-out;
        }
        .doc-badge {
            font-size: 9px;
            padding: 1px 6px;
            border-radius: 4px;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .doc-badge.has-doc { background: rgba(56, 142, 60, 0.25); color: var(--vscode-charts-green); border: 1px solid var(--vscode-charts-green); }
        .doc-badge.no-doc { background: rgba(244, 71, 71, 0.25); color: var(--vscode-charts-red); border: 1px solid var(--vscode-charts-red); }

        /* SPARQL Studio */
        .sparql-layout {
            display: flex;
            flex-direction: column;
            width: 100%;
            height: 100%;
            padding: 16px;
            box-sizing: border-box;
            gap: 12px;
        }
        .sparql-editor {
            width: 100%;
            height: 140px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 12px;
            padding: 10px;
            box-sizing: border-box;
            resize: vertical;
            outline: none;
        }
        .sparql-editor:focus { border-color: var(--vscode-focusBorder); }
        .sparql-results-table {
            flex: 1;
            overflow: auto;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 6px;
            padding: 10px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 11.5px;
        }
        th, td {
            padding: 6px 10px;
            border-bottom: 1px solid var(--vscode-widget-border);
            text-align: left;
        }
        th { background: var(--vscode-sideBarSectionHeader-background); font-weight: 700; }
        .spinner {
            width: 14px;
            height: 14px;
            border: 2px solid currentColor;
            border-bottom-color: transparent;
            border-radius: 50%;
            display: inline-block;
            animation: spin 0.8s linear infinite;
        }
        @keyframes spin { 100% { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="header">
        <div class="header-title-group">
            <div class="header-icon"><i class="codicon codicon-graph"></i></div>
            <div>
                <div class="header-title">Architecture &amp; Knowledge Graph Studio</div>
                <div class="header-subtitle" id="headerSubtitle">.lollms/knowledge.ttl · Codebase Ontology &amp; Multi-Query Copilot</div>
            </div>
        </div>
        <div class="header-actions">
            <button class="btn secondary" id="btnRebuildABox" title="Rebuild full codebase AST into knowledge.ttl"><i class="codicon codicon-sync"></i> Rebuild ABox</button>
            <button class="btn secondary" id="btnOpenTtl" title="Open .lollms/knowledge.ttl file"><i class="codicon codicon-file-code"></i> Open knowledge.ttl</button>
            <button class="btn secondary" id="btnResetGraph" style="color:var(--vscode-errorForeground)"><i class="codicon codicon-trash"></i> Reset</button>
        </div>
    </div>

    <div class="nav-tabs">
        <button class="tab-btn active" data-tab="tabCopilot"><i class="codicon codicon-comment-discussion"></i> Architecture Copilot (Discussion)</button>
        <button class="tab-btn" data-tab="tabVisual"><i class="codicon codicon-type-hierarchy"></i> Interactive Graph (Cytoscape)</button>
        <button class="tab-btn" data-tab="tabSparql"><i class="codicon codicon-code"></i> SPARQL Studio &amp; Blueprints</button>
    </div>

    <div class="main-container">
        <!-- TAB 1: COPILOT & CODEBASE DISCUSSION -->
        <div class="tab-pane active" id="tabCopilot">
            <div class="copilot-layout">
                <div class="copilot-chat-col">
                    <div class="copilot-messages" id="copilotMessages">
                        <div class="msg-bubble assistant">
                            <div style="font-weight:bold; color:var(--vscode-charts-purple); display:flex; align-items:center; gap:6px;">
                                <i class="codicon codicon-hubot"></i> Architecture Copilot
                            </div>
                            <div>
                                Welcome! I am your <strong>Architecture &amp; Knowledge Copilot</strong>. I query your codebase's triplestore (<code>.lollms/knowledge.ttl</code>) with multiple SPARQL queries to answer architectural questions, trace relationships, and discover components.<br><br>
                                Ask any question, or click one of the suggested prompts below!
                            </div>
                        </div>
                    </div>

                    <div class="copilot-input-area">
                        <div class="chips-row">
                            <span class="chip" data-q="list all front end files">List all frontend files</span>
                            <span class="chip" data-q="show all backend API routes and their files">Show all API endpoints</span>
                            <span class="chip" data-q="which files import other modules across the codebase?">Trace module imports</span>
                            <span class="chip" data-q="find all functions and classes with their source files">List functions &amp; classes</span>
                            <span class="chip" data-q="explain the full-stack architecture of this project">Explain project architecture</span>
                        </div>
                        <div class="copilot-input-row">
                            <textarea id="copilotInput" class="copilot-textarea" placeholder="Ask a question about your codebase architecture (e.g. 'list all front end files', 'how are endpoints wired?')..."></textarea>
                            <button id="btnAskCopilot" class="btn" style="height:48px; width:70px; flex-direction:column; gap:2px; background:var(--vscode-charts-purple);"><i class="codicon codicon-sparkle"></i> Ask</button>
                        </div>
                    </div>
                </div>

                <div class="copilot-sideCol copilot-side-col">
                    <div style="font-size:11px; font-weight:bold; text-transform:uppercase; opacity:0.8; display:flex; align-items:center; gap:6px;">
                        <i class="codicon codicon-info"></i> Codebase Topology &amp; Summary
                    </div>
                    <div id="sideTopologySummary" class="markdown-body" style="font-size:11px; line-height:1.45; opacity:0.9;">
                        Loading topology...
                    </div>
                </div>
            </div>
        </div>

        <!-- TAB 2: INTERACTIVE VISUAL GRAPH -->
        <div class="tab-pane" id="tabVisual">
            <div class="graph-container">
                <!-- MULTIPLE VIEWS SELECTOR (ALL, TBOX, CONSTRUCT, CALLS, IMPORTS, DEPENDENCIES, DESCRIPTIONS) -->
                <div class="graph-view-selector-bar">
                    <span style="font-size:10.5px; font-weight:800; text-transform:uppercase; opacity:0.65; margin-right:2px;"><i class="codicon codicon-eye"></i> View:</span>
                    <button class="view-pill-btn active" data-view="all" title="View all code nodes and relationships (ABox)"><i class="codicon codicon-globe"></i> All (ABox)</button>
                    <button class="view-pill-btn" data-view="tbox" title="View formal TBox Ontology Schema (Classes, Properties, Subclasses, Domain/Range)"><i class="codicon codicon-symbol-structure"></i> TBox (Schema)</button>
                    <button class="view-pill-btn" data-view="construct" id="viewConstructBtn" style="display:none;" title="View graph generated by last SPARQL CONSTRUCT query"><i class="codicon codicon-sparkle"></i> Constructed Graph</button>
                    <button class="view-pill-btn" data-view="imports" title="File-to-file import relationships"><i class="codicon codicon-repo"></i> Imports</button>
                    <button class="view-pill-btn" data-view="calls" title="Function-to-function invocation flow (what calls what)"><i class="codicon codicon-symbol-method"></i> Calls</button>
                    <button class="view-pill-btn" data-view="dependencies" title="Class/Function ownership, file containment & inheritance"><i class="codicon codicon-type-hierarchy"></i> Dependencies</button>
                    <button class="view-pill-btn" data-view="descriptions" title="Functions & Methods with interactive Doxygen / Docstrings"><i class="codicon codicon-book"></i> Descriptions</button>
                </div>

                <div id="cyCanvas"></div>

                <!-- FLOATING HOVER TOOLTIP -->
                <div id="cyTooltip" class="cy-node-tooltip"></div>

                <!-- CONTROLS & LAYOUT BUTTONS -->
                <div class="graph-floating-controls">
                    <button id="btnRunForceLayout" class="btn secondary" style="font-size:10px; height:24px;" title="Run extended physics simulation to align nodes cleanly without overlaps"><i class="codicon codicon-play"></i> Force Align (Relax)</button>
                    <button id="btnLayoutDagre" class="btn secondary" style="font-size:10px; height:24px;" title="Hierarchical top-to-bottom layout"><i class="codicon codicon-list-tree"></i> Hierarchy</button>
                    <button id="btnLayoutCircle" class="btn secondary" style="font-size:10px; height:24px;" title="Concentric circular layout"><i class="codicon codicon-circle-large-outline"></i> Circle</button>
                    <button id="btnLayoutGrid" class="btn secondary" style="font-size:10px; height:24px;" title="Clean grid layout"><i class="codicon codicon-layout"></i> Grid</button>
                    <button id="btnToggleConnected" class="btn secondary" style="font-size:10px; height:24px;" title="Hide disconnected islands"><i class="codicon codicon-filter"></i> Connected Only</button>
                    <button id="btnFitCy" class="btn secondary" style="font-size:10px; height:24px;" title="Zoom to fit all nodes"><i class="codicon codicon-screen-full"></i> Fit</button>
                </div>

                <!-- SIDE INSPECTOR PANEL FOR DOCSTRINGS / DETAILS -->
                <div id="cyDocInspector" class="graph-doc-inspector">
                    <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--vscode-widget-border); padding-bottom:6px;">
                        <span style="font-size:12px; font-weight:800; color:var(--vscode-charts-purple); display:flex; align-items:center; gap:6px;">
                            <i class="codicon codicon-book"></i> Docstring &amp; Details
                        </span>
                        <span id="closeDocInspector" style="cursor:pointer; font-size:18px; line-height:1; opacity:0.7;">&times;</span>
                    </div>
                    <div id="inspectorContent" style="display:flex; flex-direction:column; gap:8px;">
                        <div style="opacity:0.6; font-size:11px;">Click on any function or method in the graph to view its documentation, signature, and callers.</div>
                    </div>
                </div>
            </div>
        </div>

        <!-- TAB 3: SPARQL STUDIO -->
        <div class="tab-pane" id="tabSparql">
            <div class="sparql-layout">
                <div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
                    <div style="display:flex; align-items:center; gap:6px; flex:1;">
                        <span style="font-size:11px; font-weight:bold;">Blueprints:</span>
                        <select id="sparqlBlueprintSelect" style="background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); border:1px solid var(--vscode-dropdown-border); border-radius:4px; font-size:11px; padding:3px 6px; flex:1;">
                            <option value="">-- Select a Working Blueprint Query --</option>
                            <optgroup label="🎨 CONSTRUCT (Interactive Visual Graphs)">
                                <option value="construct_call_graph">CONSTRUCT: Function Call Graph</option>
                                <option value="construct_file_deps">CONSTRUCT: Module Import &amp; Ownership Graph</option>
                                <option value="construct_endpoints">CONSTRUCT: API Routes &amp; Endpoints Map</option>
                            </optgroup>
                            <optgroup label="📋 SELECT (Tabular Data &amp; Search)">
                                <option value="frontend_files">SELECT: Frontend Files &amp; Components</option>
                                <option value="backend_routes">SELECT: API Routes &amp; Endpoints</option>
                                <option value="functions_files">SELECT: Functions &amp; Source Files</option>
                                <option value="classes_methods">SELECT: Classes &amp; Member Methods</option>
                                <option value="file_imports">SELECT: File Imports &amp; Dependencies</option>
                                <option value="class_inheritance">SELECT: Class Inheritance</option>
                            </optgroup>
                        </select>
                    </div>
                    <button id="btnRunStudioSparql" class="btn" style="background:var(--vscode-charts-purple)"><i class="codicon codicon-play"></i> Run SPARQL</button>
                </div>

                <textarea id="sparqlEditor" class="sparql-editor" placeholder="Enter SPARQL SELECT query...">PREFIX s: &lt;http://lollms.io/ontology#&gt;

SELECT DISTINCT ?file ?filePath ?language
WHERE {
  ?file a s:SourceFile ;
        s:layer "Frontend" ;
        s:filePath ?filePath ;
        s:programmingLanguage ?language .
}
LIMIT 25</textarea>

                <div class="sparql-results-table" id="sparqlResultsArea">
                    <div style="opacity:0.6; font-size:11px;">Click 'Run SPARQL' to execute query against knowledge.ttl...</div>
                </div>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let cyInstance = null;
        let latestElements = { nodes: [], edges: [] };
        let isConnectedOnly = false;

        const blueprints = {
            construct_call_graph: "PREFIX s: <http://lollms.io/ontology#>\\n\\nCONSTRUCT {\\n  ?caller s:calls ?callee .\\n}\\nWHERE {\\n  ?caller s:invokesFunction ?callee .\\n}\\nLIMIT 50",
            construct_file_deps: "PREFIX s: <http://lollms.io/ontology#>\\n\\nCONSTRUCT {\\n  ?file s:imports ?dep .\\n  ?file s:contains ?class .\\n}\\nWHERE {\\n  ?file s:importsModule ?dep .\\n  OPTIONAL { ?file s:containsEntity ?class . ?class a s:ClassDefinition . }\\n}\\nLIMIT 50",
            construct_endpoints: "PREFIX s: <http://lollms.io/ontology#>\\n\\nCONSTRUCT {\\n  ?file s:exposes ?route .\\n}\\nWHERE {\\n  ?file s:containsEntity ?route .\\n  ?route a s:APIRoute .\\n}\\nLIMIT 50",
            frontend_files: "PREFIX s: <http://lollms.io/ontology#>\\n\\nSELECT DISTINCT ?file ?filePath ?language\\nWHERE {\\n  ?file a s:SourceFile ;\\n        s:layer \\"Frontend\\" ;\\n        s:filePath ?filePath ;\\n        s:programmingLanguage ?language .\\n}\\nLIMIT 50",
            backend_routes: "PREFIX s: <http://lollms.io/ontology#>\\n\\nSELECT DISTINCT ?route ?file\\nWHERE {\\n  ?file s:containsEntity ?route .\\n  ?route a s:APIRoute .\\n}\\nLIMIT 50",
            functions_files: "PREFIX s: <http://lollms.io/ontology#>\\n\\nSELECT DISTINCT ?func ?file\\nWHERE {\\n  ?file s:containsEntity ?func .\\n  ?func a s:FunctionDefinition .\\n}\\nLIMIT 50",
            classes_methods: "PREFIX s: <http://lollms.io/ontology#>\\n\\nSELECT DISTINCT ?class ?method\\nWHERE {\\n  ?class a s:ClassDefinition ;\\n         s:containsEntity ?method .\\n  ?method a s:MethodDefinition .\\n}\\nLIMIT 50",
            file_imports: "PREFIX s: <http://lollms.io/ontology#>\\n\\nSELECT DISTINCT ?sourceFile ?importedModule\\nWHERE {\\n  ?sourceFile a s:SourceFile ;\\n              s:importsModule ?importedModule .\\n}\\nLIMIT 50",
            class_inheritance: "PREFIX s: <http://lollms.io/ontology#>\\n\\nSELECT DISTINCT ?childClass ?parentClass\\nWHERE {\\n  ?childClass s:inheritsFrom ?parentClass .\\n}\\nLIMIT 50"
        };

        // Tab Navigation
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.onclick = () => {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
                btn.classList.add('active');
                const target = document.getElementById(btn.dataset.tab);
                if (target) {
                    target.classList.add('active');
                    if (btn.dataset.tab === 'tabVisual') {
                        setTimeout(() => {
                            if (cyInstance) { cyInstance.resize(); cyInstance.fit(undefined, 30); }
                            else { renderCytoscape(latestElements); }
                        }, 80);
                    }
                }
            };
        });

        // Chips
        document.querySelectorAll('.chip').forEach(chip => {
            chip.onclick = () => {
                document.getElementById('copilotInput').value = chip.dataset.q;
                document.getElementById('btnAskCopilot').click();
            };
        });

        // Top Toolbar
        document.getElementById('btnRebuildABox').onclick = () => {
            document.getElementById('btnRebuildABox').innerHTML = '<span class="spinner"></span> Rebuilding...';
            vscode.postMessage({ command: 'rebuildABox' });
        };
        document.getElementById('btnOpenTtl').onclick = () => vscode.postMessage({ command: 'openKnowledgeRoot' });
        document.getElementById('btnResetGraph').onclick = () => {
            if (confirm("Reset knowledge graph (.lollms/knowledge.ttl) to baseline ontology?")) {
                vscode.postMessage({ command: 'resetKnowledge' });
            }
        };

        // Copilot Interaction
        const copilotInput = document.getElementById('copilotInput');
        const btnAskCopilot = document.getElementById('btnAskCopilot');
        const copilotMessages = document.getElementById('copilotMessages');

        const askCopilot = () => {
            const q = copilotInput.value.trim();
            if (!q) return;
            copilotInput.value = '';

            const userBubble = document.createElement('div');
            userBubble.className = 'msg-bubble user';
            userBubble.innerHTML = \`<div style="font-weight:bold; margin-bottom:4px;">You</div><div>\${escapeHtml(q)}</div>\`;
            copilotMessages.appendChild(userBubble);
            copilotMessages.scrollTop = copilotMessages.scrollHeight;

            btnAskCopilot.disabled = true;
            btnAskCopilot.innerHTML = '<span class="spinner"></span>';

            vscode.postMessage({ command: 'copilotAsk', question: q });
        };

        btnAskCopilot.onclick = askCopilot;
        copilotInput.onkeydown = (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                askCopilot();
            }
        };

        // SPARQL Studio
        const sparqlBlueprintSelect = document.getElementById('sparqlBlueprintSelect');
        const sparqlEditor = document.getElementById('sparqlEditor');
        const btnRunStudioSparql = document.getElementById('btnRunStudioSparql');
        const sparqlResultsArea = document.getElementById('sparqlResultsArea');

        sparqlBlueprintSelect.onchange = () => {
            const key = sparqlBlueprintSelect.value;
            if (key && blueprints[key]) {
                sparqlEditor.value = blueprints[key];
                btnRunStudioSparql.click();
            }
        };

        btnRunStudioSparql.onclick = () => {
            const q = sparqlEditor.value.trim();
            if (!q) return;
            sparqlResultsArea.innerHTML = '<span class="spinner"></span> Executing SPARQL query against knowledge.ttl...';
            vscode.postMessage({ command: 'executeSparql', query: q });
        };

        // Cytoscape Visualizer with Multiple Views & Extended Force-Field Simulation
        let currentViewMode = 'all';
        let latestConstructedElements = null;
        let latestTBoxElements = null;

        function filterElementsForView(elements, viewMode) {
            const rawNodes = elements.nodes || [];
            const rawEdges = elements.edges || [];

            if (viewMode === 'construct' && latestConstructedElements) {
                return latestConstructedElements;
            }

            if (viewMode === 'tbox' && latestTBoxElements) {
                return latestTBoxElements;
            }

            if (viewMode === 'all') {
                return { nodes: rawNodes, edges: rawEdges };
            }

            if (viewMode === 'imports') {
                // Focus: File-to-file import relationships and libraries
                const importEdges = rawEdges.filter(e => e.label === 'imports');
                const fileOrLibNodeIds = new Set();
                importEdges.forEach(e => {
                    fileOrLibNodeIds.add(e.source);
                    fileOrLibNodeIds.add(e.target);
                });
                // Also include all files if no edges exist yet
                const nodes = rawNodes.filter(n => {
                    const isFileOrLib = ['file', 'component', 'script', 'library'].includes(n.type);
                    return isFileOrLib && (fileOrLibNodeIds.size === 0 || fileOrLibNodeIds.has(n.id));
                });
                const finalNodeIds = new Set(nodes.map(n => n.id));
                const edges = importEdges.filter(e => finalNodeIds.has(e.source) && finalNodeIds.has(e.target));
                return { nodes, edges };
            }

            if (viewMode === 'calls') {
                // Focus: Function-to-function and method-to-function calls (what calls what)
                const callEdges = rawEdges.filter(e => e.label === 'calls' || e.label === 'invokesFunction' || e.label === 's:invokesFunction');
                const callNodeIds = new Set();
                callEdges.forEach(e => {
                    callNodeIds.add(e.source);
                    callNodeIds.add(e.target);
                });

                // If calls exist, show connected nodes + any enclosing file/class context
                // If no call edges were detected yet, show all callables (functions, methods, endpoints) so the view is never an empty void
                const nodes = rawNodes.filter(n => {
                    if (callNodeIds.has(n.id)) return true;
                    if (callEdges.length === 0) {
                        return ['function', 'method', 'endpoint'].includes(n.type);
                    }
                    return false;
                });

                const finalNodeIds = new Set(nodes.map(n => n.id));
                const edges = callEdges.filter(e => finalNodeIds.has(e.source) && finalNodeIds.has(e.target));
                return { nodes, edges };
            }

            if (viewMode === 'dependencies') {
                // Focus: Structure / Ownership (Files contain Classes & Functions; Classes contain Methods; Class inherits Class)
                const depLabels = new Set(['contains', 'definedIn', 'memberOf', 'inherits']);
                const depEdges = rawEdges.filter(e => depLabels.has(e.label));
                const depNodeIds = new Set();
                depEdges.forEach(e => {
                    depNodeIds.add(e.source);
                    depNodeIds.add(e.target);
                });
                const nodes = rawNodes.filter(n => depNodeIds.has(n.id) || ['file', 'class', 'function'].includes(n.type));
                const finalNodeIds = new Set(nodes.map(n => n.id));
                const edges = depEdges.filter(e => finalNodeIds.has(e.source) && finalNodeIds.has(e.target));
                return { nodes, edges };
            }

            if (viewMode === 'descriptions') {
                // Focus: Documentation View (Functions, Methods, Endpoints, with docstring availability)
                const nodes = rawNodes.filter(n => ['function', 'method', 'endpoint', 'class'].includes(n.type));
                const nodeIds = new Set(nodes.map(n => n.id));
                const edges = rawEdges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));
                return { nodes, edges };
            }

            return { nodes: rawNodes, edges: rawEdges };
        }

        // View Mode Switcher Handlers
        document.querySelectorAll('.view-pill-btn').forEach(btn => {
            btn.onclick = () => {
                document.querySelectorAll('.view-pill-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentViewMode = btn.dataset.view;

                const inspector = document.getElementById('cyDocInspector');
                if (inspector) {
                    inspector.style.display = currentViewMode === 'descriptions' ? 'flex' : 'none';
                }

                if (currentViewMode === 'tbox') {
                    vscode.postMessage({ command: 'requestGraphData', viewScope: 'tbox' });
                } else if (currentViewMode === 'calls') {
                    vscode.postMessage({ command: 'requestGraphData', viewScope: 'calls' });
                } else {
                    renderCytoscape(latestElements);
                }
            };
        });

        document.getElementById('closeDocInspector').onclick = () => {
            document.getElementById('cyDocInspector').style.display = 'none';
        };

        function runForceDirectedSimulation() {
            if (!cyInstance) return;

            const btn = document.getElementById('btnRunForceLayout');
            if (btn) btn.innerHTML = '<span class="spinner"></span> Aligning...';

            // High-iteration, high-repulsion force field simulation (COSE layout)
            const coseLayout = cyInstance.layout({
                name: 'cose',
                animate: true,
                animationDuration: 1800,
                animationEasing: 'ease-out',
                randomize: false,
                componentSpacing: 110,           // Ample spacing between disconnected clusters
                nodeRepulsion: function(node) {
                    const isHub = (node.degree() || 0) > 4;
                    return isHub ? 180000 : 95000; // Strong repulsion to push nodes apart and untangle clusters
                },
                nodeOverlap: 60,                // Heavy penalty to strictly prevent overlapping nodes
                idealEdgeLength: function(edge) {
                    return 140;                  // Longer edges give nodes space to align cleanly
                },
                edgeElasticity: function(edge) {
                    return 32;                   // Smooth elasticity prevents jitter
                },
                nestingFactor: 1.2,
                gravity: 0.12,                   // Very low gravity prevents all nodes from collapsing into one giant blob
                numIter: 4500,                   // Run force field for 4500 iterations so nodes settle into an optimal layout
                initialTemp: 1000,
                coolingFactor: 0.99,
                minTemp: 1.0,
                padding: 40
            });

            coseLayout.on('layoutstop', () => {
                if (btn) btn.innerHTML = '<i class="codicon codicon-play"></i> Force Align (Relax)';
                cyInstance.fit(undefined, 40);
            });

            coseLayout.run();
        }

        function renderCytoscape(rawElements) {
            const canvas = document.getElementById('cyCanvas');
            const tooltip = document.getElementById('cyTooltip');
            if (!canvas) return;

            const filtered = filterElementsForView(rawElements, currentViewMode);
            const rawNodesCount = (filtered.nodes || []).length;

            if (rawNodesCount === 0) {
                if (cyInstance) {
                    try { cyInstance.destroy(); } catch {}
                    cyInstance = null;
                }
                const viewLabels = {
                    all: 'nodes',
                    imports: 'import relationships between files',
                    calls: 'function or method invocations (calls)',
                    dependencies: 'class or function containment relationships',
                    descriptions: 'documented functions or docstrings'
                };
                const currentLabel = viewLabels[currentViewMode] || 'elements';
                canvas.innerHTML = \`
                    <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; opacity:0.8; font-size:12px; gap:10px; color:var(--vscode-foreground);">
                        <i class="codicon codicon-type-hierarchy" style="font-size:32px; color:var(--vscode-charts-orange);"></i>
                        <span style="font-weight:600;">No \${currentLabel} found in current view.</span>
                        <span style="font-size:11px; opacity:0.65; max-width:400px; text-align:center;">
                            Switch view to <b>All</b>, or click <b>Rebuild ABox</b> above to index your codebase functions, methods, and call paths.
                        </span>
                    </div>\`;
                return;
            } else {
                canvas.innerHTML = '';
            }

            if (!window.cytoscape) return;

            const cyNodes = [];
            const cyEdges = [];
            const nodeIds = new Set();

            (filtered.nodes || []).forEach(n => {
                const sId = n.id.replace(/^s:/, '');
                nodeIds.add(sId);
                const hasDoc = Boolean(n.docstring && n.docstring.trim().length > 0);

                cyNodes.push({
                    group: 'nodes',
                    data: {
                        id: sId,
                        label: n.label || sId,
                        type: n.type || 'entity',
                        filePath: n.filePath || '',
                        startLine: n.startLine || 0,
                        signature: n.signature || '',
                        docstring: n.docstring || '',
                        docFormat: n.docFormat || '',
                        hasDoc: hasDoc
                    }
                });
            });

            (filtered.edges || []).forEach(e => {
                const s = e.source.replace(/^s:/, '');
                const t = e.target.replace(/^s:/, '');
                if (nodeIds.has(s) && nodeIds.has(t)) {
                    cyEdges.push({
                        group: 'edges',
                        data: {
                            id: \`e_\${s}_\${e.label}_\${t}\`,
                            source: s,
                            target: t,
                            label: e.label || ''
                        }
                    });
                }
            });

            if (cyInstance) {
                try { cyInstance.destroy(); } catch {}
            }

            const cyStyle = [
                {
                    selector: 'node',
                    style: {
                        'label': 'data(label)',
                        'color': '#ffffff',
                        'font-family': 'monospace',
                        'font-size': '10px',
                        'font-weight': 'bold',
                        'text-valign': 'center',
                        'text-halign': 'center',
                        'background-color': '#2d2d2d',
                        'border-width': '2px',
                        'border-color': '#555555',
                        'shape': 'round-rectangle',
                        'width': 'label',
                        'height': 24,
                        'padding': '6px',
                        'text-max-width': '160px'
                    }
                },
                { selector: 'node[type="file"]', style: { 'background-color': '#1f4e79', 'border-color': '#569cd6' } },
                { selector: 'node[type="component"]', style: { 'background-color': '#42b883', 'border-color': '#35495e', 'color': '#ffffff' } },
                { selector: 'node[type="script"]', style: { 'background-color': '#06b6d4', 'border-color': '#0891b2', 'color': '#000000' } },
                { selector: 'node[type="endpoint"]', style: { 'background-color': '#f59e0b', 'border-color': '#d97706', 'shape': 'hexagon', 'color': '#000000' } },
                { selector: 'node[type="store"]', style: { 'background-color': '#8b5cf6', 'border-color': '#7c3aed', 'shape': 'barrel' } },
                { selector: 'node[type="class"]', style: { 'background-color': '#1b5e20', 'border-color': '#4caf50', 'shape': 'ellipse' } },
                { selector: 'node[type="function"]', style: { 'background-color': '#b7791f', 'border-color': '#ecc94b', 'shape': 'ellipse' } },
                { selector: 'node[type="method"]', style: { 'background-color': '#d97706', 'border-color': '#fbbf24', 'font-size': '9px' } },
                { selector: 'node[type="library"]', style: { 'background-color': '#7c2d12', 'border-color': '#ea580c', 'shape': 'diamond' } },
                { selector: 'node[type="tbox-class"]', style: { 'background-color': '#581c87', 'border-color': '#a855f7', 'border-width': '2.5px', 'shape': 'round-rectangle', 'font-size': '11px', 'color': '#ffffff' } },
                { selector: 'node[type="tbox-property"]', style: { 'background-color': '#006064', 'border-color': '#00acc1', 'border-width': '2px', 'shape': 'diamond', 'font-size': '10px' } },
                {
                    selector: 'edge',
                    style: {
                        'width': 1.8,
                        'line-color': '#666666',
                        'target-arrow-color': '#888888',
                        'target-arrow-shape': 'triangle',
                        'curve-style': 'bezier',
                        'label': 'data(label)',
                        'font-size': '8px',
                        'color': '#cccccc'
                    }
                },
                { selector: 'edge[label="calls"]', style: { 'line-color': '#eab308', 'target-arrow-color': '#eab308', 'width': 2.2, 'line-style': 'dotted' } },
                { selector: 'edge[label="imports"]', style: { 'line-color': '#a855f7', 'target-arrow-color': '#a855f7', 'width': 2.0, 'line-style': 'dashed' } },
                { selector: 'edge[label="contains"]', style: { 'line-color': '#3b82f6', 'target-arrow-color': '#3b82f6', 'width': 1.8 } },
                { selector: 'edge[label="inherits"]', style: { 'line-color': '#22c55e', 'target-arrow-color': '#22c55e', 'width': 2.2 } },
                { selector: 'edge[label="subClassOf"]', style: { 'line-color': '#22c55e', 'target-arrow-color': '#22c55e', 'width': 2.5, 'line-style': 'dashed' } },
                { selector: 'edge[label="inverseOf"]', style: { 'line-color': '#ea580c', 'target-arrow-color': '#ea580c', 'width': 2.0, 'line-style': 'dotted' } },
                { selector: 'node:selected', style: { 'border-color': '#ff9d00', 'border-width': '3px', 'box-shadow': '0 0 12px #ff9d00' } }
            ];

            // In description view mode: visually distinguish documented vs undocumented functions
            if (currentViewMode === 'descriptions') {
                cyStyle.push({
                    selector: 'node[?hasDoc]',
                    style: {
                        'border-color': '#22c55e',
                        'border-width': '2.5px',
                        'background-color': '#14532d'
                    }
                });
                cyStyle.push({
                    selector: 'node[!hasDoc]',
                    style: {
                        'border-color': '#ef4444',
                        'border-width': '1.5px',
                        'opacity': 0.75
                    }
                });
            }

            cyInstance = cytoscape({
                container: canvas,
                elements: [...cyNodes, ...cyEdges],
                style: cyStyle,
                layout: {
                    name: 'cose',
                    animate: false,
                    componentSpacing: 100,
                    nodeRepulsion: function() { return 110000; },
                    nodeOverlap: 50,
                    idealEdgeLength: function() { return 130; },
                    edgeElasticity: function() { return 32; },
                    gravity: 0.12,
                    numIter: 4000,
                    padding: 35
                }
            });

            // Double click opens file directly
            cyInstance.on('dblclick', 'node', function(evt) {
                const nodeData = evt.target.data();
                if (nodeData && nodeData.filePath) {
                    vscode.postMessage({
                        command: 'openFile',
                        path: nodeData.filePath,
                        line: nodeData.startLine
                    });
                }
            });

            // Single click inspects node in side panel
            cyInstance.on('tap', 'node', function(evt) {
                const n = evt.target.data();
                updateInspector(n);
            });

            // Mouseover hover card / tooltip showing docstring / Doxygen / details
            cyInstance.on('mouseover', 'node', function(evt) {
                if (!tooltip) return;
                const n = evt.target.data();
                const pos = evt.renderedPosition;

                let docHtml = '';
                if (n.docstring && n.docstring.trim().length > 0) {
                    const formatBadge = n.docFormat ? \`<span class="doc-badge has-doc" style="margin-left:auto;">\${escapeHtml(n.docFormat)}</span>\` : '<span class="doc-badge has-doc" style="margin-left:auto;">Documented</span>';
                    docHtml = \`
                        <div style="margin-top:6px; padding-top:6px; border-top:1px dashed rgba(255,255,255,0.15);">
                            <div style="display:flex; align-items:center; margin-bottom:4px;">
                                <strong style="color:var(--vscode-charts-green);"><i class="codicon codicon-book"></i> Documentation:</strong>
                                \${formatBadge}
                            </div>
                            <div style="background:rgba(0,0,0,0.3); padding:6px 8px; border-radius:4px; max-height:160px; overflow-y:auto; white-space:pre-wrap; font-family:monospace; font-size:10px;">\${escapeHtml(n.docstring)}</div>
                        </div>
                    \`;
                } else if (['function', 'method', 'endpoint'].includes(n.type)) {
                    docHtml = \`
                        <div style="margin-top:6px; padding-top:6px; border-top:1px dashed rgba(255,255,255,0.15); display:flex; align-items:center; gap:6px;">
                            <span class="doc-badge no-doc">No Docstring / Doxygen</span>
                            <span style="opacity:0.6; font-size:10px;">(Undocumented symbol)</span>
                        </div>
                    \`;
                }

                tooltip.innerHTML = \`
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                        <span style="font-weight:bold; font-size:12px; color:var(--vscode-foreground);">\${escapeHtml(n.label)}</span>
                        <span style="font-size:9.5px; opacity:0.75; text-transform:uppercase; background:rgba(255,255,255,0.08); padding:1px 5px; border-radius:3px;">\${escapeHtml(n.type)}</span>
                    </div>
                    \${n.signature ? \`<div style="font-family:monospace; font-size:10px; color:var(--vscode-textLink-foreground); margin-bottom:4px; word-break:break-all;"><code>\${escapeHtml(n.signature)}</code></div>\` : ''}
                    \${n.filePath ? \`<div style="font-size:10px; opacity:0.7; word-break:break-all;"><i class="codicon codicon-file"></i> \${escapeHtml(n.filePath)}\${n.startLine ? \`:\${n.startLine}\` : ''}</div>\` : ''}
                    \${docHtml}
                    <div style="margin-top:6px; font-size:9px; opacity:0.5; font-style:italic;">Double-click to open file &middot; Click to inspect</div>
                \`;

                const containerRect = canvas.getBoundingClientRect();
                const tipWidth = 340;
                let left = pos.x + 15;
                if (left + tipWidth > containerRect.width) {
                    left = pos.x - tipWidth - 15;
                }
                const top = Math.min(pos.y + 10, containerRect.height - 180);

                tooltip.style.left = \`\${Math.max(10, left)}px\`;
                tooltip.style.top = \`\${Math.max(10, top)}px\`;
                tooltip.style.display = 'block';
            });

            cyInstance.on('mouseout', 'node', function() {
                if (tooltip) tooltip.style.display = 'none';
            });

            setTimeout(() => {
                cyInstance.fit(undefined, 35);
            }, 60);
        }

        function updateInspector(n) {
            const inspector = document.getElementById('cyDocInspector');
            const content = document.getElementById('inspectorContent');
            if (!inspector || !content) return;

            const formatBadge = n.hasDoc 
                ? \`<span class="doc-badge has-doc">\${escapeHtml(n.docFormat || 'Documented')}</span>\`
                : \`<span class="doc-badge no-doc">No Documentation</span>\`;

            content.innerHTML = \`
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <div style="font-size:14px; font-weight:800; color:var(--vscode-foreground);">\${escapeHtml(n.label)}</div>
                        <div style="font-size:10px; opacity:0.6; text-transform:uppercase;">\${escapeHtml(n.type)}</div>
                    </div>
                    \${formatBadge}
                </div>

                \${n.signature ? \`
                    <div>
                        <div style="font-size:10px; font-weight:bold; opacity:0.7; text-transform:uppercase;">Signature:</div>
                        <pre style="background:var(--vscode-editor-background); padding:6px 8px; border-radius:4px; font-size:11px; margin:2px 0; overflow-x:auto;"><code>\${escapeHtml(n.signature)}</code></pre>
                    </div>
                \` : ''}

                \${n.filePath ? \`
                    <div>
                        <div style="font-size:10px; font-weight:bold; opacity:0.7; text-transform:uppercase;">Location:</div>
                        <div style="font-size:11px; font-family:monospace; margin-top:2px; display:flex; align-items:center; gap:6px;">
                            <i class="codicon codicon-file"></i>
                            <a href="#" style="color:var(--vscode-textLink-foreground);" onclick="vscode.postMessage({command:'openFile', path:'\${escapeHtml(n.filePath)}', line:\${n.startLine || 0}}); return false;">
                                \${escapeHtml(n.filePath)}\${n.startLine ? \`:\${n.startLine}\` : ''}
                            </a>
                        </div>
                    </div>
                \` : ''}

                <div>
                    <div style="font-size:10px; font-weight:bold; opacity:0.7; text-transform:uppercase;">Docstring / Doxygen Documentation:</div>
                    \${n.docstring ? \`
                        <div class="markdown-body" style="background:var(--vscode-editor-background); border:1px solid var(--vscode-widget-border); border-radius:4px; padding:10px; font-size:11px; line-height:1.45; max-height:220px; overflow-y:auto; margin-top:4px; white-space:pre-wrap;">\${escapeHtml(n.docstring)}</div>
                    \` : \`
                        <div style="padding:10px; background:rgba(255,255,255,0.03); border-radius:4px; font-size:11px; opacity:0.6; font-style:italic; margin-top:4px;">No docstring or Doxygen documentation found for this code symbol.</div>
                    \`}
                </div>

                <div style="display:flex; gap:6px; margin-top:6px;">
                    \${n.filePath ? \`<button class="btn" onclick="vscode.postMessage({command:'openFile', path:'\${escapeHtml(n.filePath)}', line:\${n.startLine || 0}})" style="flex:1; justify-content:center;"><i class="codicon codicon-go-to-file"></i> Go to Source</button>\` : ''}
                </div>
            \`;

            inspector.style.display = 'flex';
        }

        document.getElementById('btnRunForceLayout').onclick = runForceDirectedSimulation;
        document.getElementById('btnLayoutDagre').onclick = () => { if (cyInstance) cyInstance.layout({ name: 'breadthfirst', directed: true, padding: 40 }).run(); };
        document.getElementById('btnLayoutCircle').onclick = () => { if (cyInstance) cyInstance.layout({ name: 'concentric', minNodeSpacing: 60, padding: 40 }).run(); };
        document.getElementById('btnLayoutGrid').onclick = () => { if (cyInstance) cyInstance.layout({ name: 'grid', padding: 40 }).run(); };
        document.getElementById('btnFitCy').onclick = () => { if (cyInstance) cyInstance.fit(undefined, 40); };
        document.getElementById('btnToggleConnected').onclick = () => {
            isConnectedOnly = !isConnectedOnly;
            document.getElementById('btnToggleConnected').classList.toggle('active', isConnectedOnly);
            vscode.postMessage({ command: 'requestGraphData', connectedOnly: isConnectedOnly });
        };

        function escapeHtml(str) {
            return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        // Webview Inbound Handlers
        window.addEventListener('message', (event) => {
            const msg = event.data;
            switch (msg.command) {
                case 'initData':
                    latestElements = msg.elements || { nodes: [], edges: [] };
                    if (msg.topologyReport) {
                        document.getElementById('sideTopologySummary').innerHTML = marked.parse(msg.topologyReport);
                    }
                    if (msg.workspaceName) {
                        document.getElementById('headerSubtitle').textContent = \`\${msg.workspaceName} · .lollms/knowledge.ttl ontology · \${(msg.elements.nodes || []).length} nodes\`;
                    }
                    break;
                case 'rebuildProgress':
                    const rebuildBtn = document.getElementById('btnRebuildABox');
                    if (rebuildBtn) {
                        rebuildBtn.innerHTML = \`<span class="spinner"></span> \${escapeHtml(msg.status || 'Rebuilding...')}\`;
                        rebuildBtn.disabled = true;
                    }
                    break;
                case 'rebuildError':
                    const errBtn = document.getElementById('btnRebuildABox');
                    if (errBtn) {
                        errBtn.innerHTML = '<i class="codicon codicon-error"></i> Rebuild Failed';
                        errBtn.disabled = false;
                        setTimeout(() => {
                            errBtn.innerHTML = '<i class="codicon codicon-sync"></i> Rebuild ABox';
                        }, 4000);
                    }
                    alert("ABox Rebuild Error: " + msg.error);
                    break;
                    break;
                case 'rebuildComplete':
                    document.getElementById('btnRebuildABox').innerHTML = '<i class="codicon codicon-sync"></i> Rebuild ABox';
                    latestElements = msg.elements || { nodes: [], edges: [] };
                    if (msg.topologyReport) {
                        document.getElementById('sideTopologySummary').innerHTML = marked.parse(msg.topologyReport);
                    }
                    renderCytoscape(latestElements);
                    break;
                case 'updateGraphElements':
                    if (msg.viewScope === 'tbox') {
                        latestTBoxElements = msg.elements;
                    } else {
                        latestElements = msg.elements || { nodes: [], edges: [] };
                    }
                    renderCytoscape(latestElements);
                    break;
                case 'sparqlResult':
                    let htmlRes = marked.parse(msg.result || 'No matches found.');
                    if (msg.constructedGraph && msg.constructedGraph.nodes && msg.constructedGraph.nodes.length > 0) {
                        latestConstructedElements = msg.constructedGraph;
                        const constructPill = document.getElementById('viewConstructBtn');
                        if (constructPill) {
                            constructPill.style.display = 'inline-flex';
                            constructPill.innerHTML = \`<i class="codicon codicon-sparkle"></i> Constructed (\${msg.constructedGraph.nodes.length})\`;
                        }
                        htmlRes = \`
                            <div style="padding: 10px 14px; background: rgba(155, 89, 182, 0.12); border: 1.5px solid var(--vscode-charts-purple); border-radius: 8px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; gap: 10px;">
                                <div>
                                    <div style="font-weight: 800; font-size: 12px; color: var(--vscode-charts-purple); display: flex; align-items: center; gap: 6px;">
                                        <i class="codicon codicon-sparkle"></i> Interactive Constructed Graph Generated
                                    </div>
                                    <div style="font-size: 11px; opacity: 0.85; margin-top: 2px;">
                                        Generated \${msg.constructedGraph.nodes.length} nodes and \${msg.constructedGraph.edges.length} relationships from SPARQL CONSTRUCT query.
                                    </div>
                                </div>
                                <button type="button" id="btnPreviewConstructed" class="btn" style="background: var(--vscode-charts-purple); white-space: nowrap;">
                                    <i class="codicon codicon-type-hierarchy"></i> View in Graph Canvas
                                </button>
                            </div>
                        \` + htmlRes;
                    }
                    sparqlResultsArea.innerHTML = htmlRes;

                    const previewBtn = document.getElementById('btnPreviewConstructed');
                    if (previewBtn) {
                        previewBtn.onclick = () => {
                            const visualTabBtn = document.querySelector('.tab-btn[data-tab="tabVisual"]');
                            if (visualTabBtn) visualTabBtn.click();
                            const constructViewBtn = document.getElementById('viewConstructBtn');
                            if (constructViewBtn) constructViewBtn.click();
                        };
                    }
                    break;
                case 'copilotAnswerReady': {
                    btnAskCopilot.disabled = false;
                    btnAskCopilot.innerHTML = '<i class="codicon codicon-sparkle"></i> Ask';

                    const assistantBubble = document.createElement('div');
                    assistantBubble.className = 'msg-bubble assistant';

                    let queriesHtml = '';
                    if (msg.queries && msg.queries.length > 0) {
                        queriesHtml = \`
                            <details style="margin: 4px 0 8px 0; border: 1px dashed var(--vscode-widget-border); border-radius: 4px; padding: 4px 8px; font-size: 11px;">
                                <summary style="cursor: pointer; font-weight: bold; color: var(--vscode-charts-purple);">
                                    <i class="codicon codicon-search"></i> Executed \${msg.queries.length} SPARQL Queries Against Knowledge Graph
                                </summary>
                                <div style="display: flex; flex-direction: column; gap: 6px; margin-top: 6px;">
                                    \${msg.queries.map((q, idx) => \`
                                        <div class="query-inspection-card">
                                            <div><strong>Query \${idx + 1}</strong> (\${q.thought || 'Inspecting'} &middot; \${q.matchesCount} hits):</div>
                                            <pre style="margin: 3px 0 0 0; padding: 4px; overflow-x: auto; background: var(--vscode-editor-background); border-radius: 3px;">\${escapeHtml(q.query)}</pre>
                                        </div>
                                    \`).join('')}
                                </div>
                            </details>
                        \`;
                    }

                    const safeQuestion = escapeHtml(msg.question);
                    const safeFindings = escapeHtml(msg.answer);

                    assistantBubble.innerHTML = \`
                        <div style="font-weight: bold; color: var(--vscode-charts-purple); display: flex; justify-content: space-between; align-items: center;">
                            <span style="display: flex; align-items: center; gap: 6px;"><i class="codicon codicon-hubot"></i> Architecture Copilot</span>
                            <button class="btn send-to-chat-btn" data-q="\${safeQuestion}" style="height: 22px; font-size: 10px; padding: 0 8px; background: var(--vscode-charts-purple); color: white;">
                                <i class="codicon codicon-send"></i> Send Findings to Main Discussion
                            </button>
                        </div>
                        \${queriesHtml}
                        <div class="markdown-body" style="font-size: 12px; line-height: 1.5; margin-top: 4px;">
                            \${marked.parse(msg.answer)}
                        </div>
                    \`;

                    assistantBubble.querySelector('.send-to-chat-btn').onclick = (e) => {
                        const targetBtn = e.currentTarget;
                        targetBtn.innerHTML = '<span class="spinner"></span> Sending...';
                        targetBtn.disabled = true;
                        vscode.postMessage({
                            command: 'sendFindingsToChat',
                            question: msg.question,
                            findings: msg.answer
                        });
                        setTimeout(() => {
                            targetBtn.innerHTML = '<i class="codicon codicon-check"></i> Sent to Chat';
                        }, 800);
                    };

                    copilotMessages.appendChild(assistantBubble);
                    copilotMessages.scrollTop = copilotMessages.scrollHeight;
                    break;
                }
            }
        });
    </script>
</body>
</html>`;
    }
}