import * as vscode from 'vscode';

export class HelpPanel {
    public static currentPanel: HelpPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;

    public static createOrShow(extensionUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (HelpPanel.currentPanel) {
            HelpPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'lollmsHelp',
            'Lollms VS Coder Documentation',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'media'),
                    vscode.Uri.joinPath(extensionUri, 'out')
                ],
                retainContextWhenHidden: true
            }
        );

        HelpPanel.currentPanel = new HelpPanel(panel, extensionUri);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
        this._panel.onDidDispose(() => this.dispose(), null, []);
    }

    public dispose() {
        HelpPanel.currentPanel = undefined;
        this._panel.dispose();
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const lollmsIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'lollms-icon.svg'));
        const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'));

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Lollms Documentation</title>
    <link href="${codiconsUri}" rel="stylesheet" />
    <style>
        :root {
            --bg: var(--vscode-editor-background);
            --fg: var(--vscode-editor-foreground);
            --border: var(--vscode-panel-border);
            --sidebar-bg: var(--vscode-sideBar-background);
            --link: var(--vscode-textLink-foreground);
            --hover: var(--vscode-list-hoverBackground);
            --active-bg: var(--vscode-list-activeSelectionBackground);
            --active-fg: var(--vscode-list-activeSelectionForeground);
            --code-bg: var(--vscode-textCodeBlock-background);
        }
        body { font-family: var(--vscode-font-family); background-color: var(--bg); color: var(--fg); margin: 0; padding: 0; display: flex; height: 100vh; overflow: hidden; }
        
        /* Navigation Sidebar */
        nav { width: 250px; background: var(--sidebar-bg); border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; }
        .nav-header { padding: 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 1.1em; }
        .nav-header img { width: 24px; height: 24px; }
        .nav-items { flex: 1; overflow-y: auto; padding: 10px 0; }
        .nav-item { padding: 8px 20px; cursor: pointer; display: flex; align-items: center; gap: 8px; font-size: 0.95em; transition: 0.2s; }
        .nav-item:hover { background: var(--hover); }
        .nav-item.active { background: var(--active-bg); color: var(--active-fg); }
        .nav-item i { font-size: 16px; opacity: 0.8; }

        /* Content Area */
        main { flex: 1; overflow-y: auto; padding: 40px; scroll-behavior: smooth; }
        section { display: none; max-width: 900px; margin: 0 auto; animation: fadeIn 0.3s ease-in-out; }
        section.active { display: block; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

        h1 { font-size: 2.2em; font-weight: 300; margin-bottom: 0.5em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
        h2 { font-size: 1.6em; margin-top: 2em; display: flex; align-items: center; gap: 10px; }
        h3 { font-size: 1.2em; margin-top: 1.5em; color: var(--link); }
        p, li { line-height: 1.7; font-size: 1.05em; opacity: 0.9; }
        
        .card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); padding: 1.5em; border-radius: 8px; margin: 1.5em 0; }
        .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.8em; font-weight: bold; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-right: 8px; }
        code { font-family: var(--vscode-editor-font-family); background: var(--code-bg); padding: 2px 5px; border-radius: 4px; }
        pre { background: var(--code-bg); padding: 1.2em; border-radius: 8px; overflow-x: auto; border: 1px solid var(--border); }
        
        .tip { border-left: 4px solid var(--link); background: rgba(0, 122, 204, 0.1); padding: 10px 20px; border-radius: 0 4px 4px 0; margin: 1em 0; }
        .warning { border-left: 4px solid var(--vscode-errorForeground); background: rgba(255, 0, 0, 0.05); padding: 10px 20px; border-radius: 0 4px 4px 0; margin: 1em 0; }
        
        table { width: 100%; border-collapse: collapse; margin: 1em 0; }
        th, td { text-align: left; padding: 12px; border-bottom: 1px solid var(--border); }
        th { font-weight: 600; opacity: 0.8; }
    </style>
</head>
<body>
    <nav>
        <div class="nav-header">
            <img src="${lollmsIconUri}" alt="Logo">
            <span>Documentation</span>
        </div>
        <div class="nav-items">
            <div class="nav-item active" onclick="showSection('intro')"><i class="codicon codicon-home"></i> Overview</div>
            <div class="nav-item" onclick="showSection('agent')"><i class="codicon codicon-robot"></i> Agent Loop</div>
            <div class="nav-item" onclick="showSection('context')"><i class="codicon codicon-layers"></i> Context Mastery</div>
            <div class="nav-item" onclick="showSection('workflow')"><i class="codicon codicon-briefcase"></i> Pro Workflow</div>
            <div class="nav-item" onclick="showSection('jupyter')"><i class="codicon codicon-notebook"></i> Jupyter Integration</div>
            <div class="nav-item" onclick="showSection('custom')"><i class="codicon codicon-tools"></i> Customization</div>
            <div class="nav-item" onclick="showSection('mcp')"><i class="codicon codicon-plug"></i> MCP & Tools</div>
        </div>
    </nav>

    <main id="main-content">
        <!-- OVERVIEW -->
        <section id="intro" class="active">
            <h1>Expert Overview</h1>
            <p>Lollms VS Coder is not just a chatbot; it's a <strong>Surgical Code Modification Engine</strong>. It allows developers to maintain full control over the AI's context while leveraging autonomous agents for multi-file refactoring and research.</p>
            
            <h2>Key Architecture</h2>
            <ul>
                <li><strong>Local-First:</strong> Designed to work with local LLMs (Ollama, Lollms) to keep your code private.</li>
                <li><strong>Stateless Logic:</strong> Each discussion carries its own capabilities and model selection.</li>
                <li><strong>Token-Efficient:</strong> Uses surgical context states (Definitions, Tree-only) to minimize input size.</li>
            </ul>

            <div class="tip">
                <strong>Expert Shortcut:</strong> Open the <strong>Companion</strong> instantly with <span class="shortcut">Ctrl+Shift+L</span> to query the AI about your current selection without breaking your flow.
            </div>
        </section>

        <!-- AGENT LOOP -->
        <section id="agent">
            <h1>Autonomous Agent Loop</h1>
            <p>Agent Mode switches the AI from a <em>Responder</em> to an <em>Actor</em>. It operates on a <strong>Plan-Execute-Observe</strong> cycle.</p>
            
            <div class="card">
                <h3>The JSON Execution Loop</h3>
                <p>When you provide an objective, the AI generates a JSON task list. Each task includes an <code>action</code> and <code>parameters</code>. The extension executes these using native VS Code APIs or shell commands.</p>
                <ol>
                    <li><strong>Grounding:</strong> The agent uses <code>list_files</code> and <code>read_file</code> to understand your environment before proposing changes.</li>
                    <li><strong>Scratchpad:</strong> You can watch the agent "thinking" in the Scratchpad section of the plan. This reveals self-corrections and logic transitions.</li>
                    <li><strong>Self-Correction:</strong> If a <code>terminal</code> command returns a non-zero exit code, the agent automatically interprets the error and rewrites the remaining plan.</li>
                </ol>
            </div>

            <h3>Best Practices for Agent Objectives</h3>
            <p>Be specific about boundaries. Instead of "Fix my app," use:</p>
            <pre>"Read the imports in main.ts, find where the Database class is defined, and refactor its connect method to use async/await."</pre>
        </section>

        <!-- CONTEXT MASTERY -->
        <section id="context">
            <h1>Smart Context Mastery</h1>
            <p>Context is the most expensive and critical part of AI prompting. Lollms gives you 5 specific states for every file in your project.</p>
            
            <table>
                <tr><th>State</th><th>What the AI Sees</th><th>Best For...</th></tr>
                <tr><td><span class="badge">Included</span></td><td>Full file source code.</td><td>Files being modified.</td></tr>
                <tr><td><span class="badge">Definitions</span></td><td>Function signatures, Class names, but NO bodies.</td><td>Libraries and dependencies.</td></tr>
                <tr><td><span class="badge">Tree-Only</span></td><td>Only the filename and path.</td><td>Discovery and navigation.</td></tr>
                <tr><td><span class="badge">Collapsed</span></td><td>The folder name is visible, content is hidden.</td><td>Clean sidebar.</td></tr>
                <tr><td><span class="badge">Excluded</span></td><td>Nothing.</td><td>Binary files, node_modules.</td></tr>
            </table>

            <h3>Auto-Selection Logic</h3>
            <p>The <strong>Auto-Select Context</strong> feature uses a specialized prompt that sends your project's file tree to a "High-Reasoning" model to determine dependencies. It toggles files automatically based on your high-level objective.</p>
        </section>

        <!-- PRO WORKFLOW -->
        <section id="workflow">
            <h1>Professional Workflow</h1>
            
            <h3>Surgical Replacements</h3>
            <p>Lollms prefers the <code>Replace:</code> and <code>Insert:</code> formats. This allows the AI to suggest changes to specific blocks of code rather than regenerating 1,000 lines of code just to change one variable.</p>

            <h3>Inline Diffing</h3>
            <p>In the <strong>Companion</strong> or via <strong>CodeActions</strong>, suggested code doesn't just overwrite your file. It triggers a CodeLens provider that highlights the change. You can <code>Accept</code>, <code>Reject</code>, or <code>Refine</code> the code using a feedback loop.</p>

            <h3>Debugger Integration</h3>
            <p>Lollms listens to the <code>onDidChangeActiveStackItem</code> event. If a debug session halts on an unhandled exception, it extracts the <strong>Exception Info</strong> and <strong>Stack Trace</strong>. The "Fix with Lollms" button then combines this with your "Included" context files to provide an immediate patch.</p>
        </section>

        <!-- JUPYTER -->
        <section id="jupyter">
            <h1>Jupyter & Data Science</h1>
            <p>Data science requires a iterative feedback loop. Lollms integrates directly into the <code>.ipynb</code> cell metadata.</p>
            
            <div class="grid">
                <div class="card">
                    <h4><i class="codicon codicon-graph"></i> Data Visualization</h4>
                    <p>When you run <code>Visualize</code> on a cell, Lollms reads the <strong>Output Data MIME Type</strong> (CSV, JSON, or Table) and generates Matplotlib/Seaborn code to render it.</p>
                </div>
                <div class="card">
                    <h4><i class="codicon codicon-wand"></i> Cell Chaining</h4>
                    <p><code>Generate Next</code> looks at all previous cells in the notebook to maintain state and variable definitions, ensuring the new code is logical.</p>
                </div>
            </div>
        </section>

        <!-- CUSTOMIZATION -->
        <section id="custom">
            <h1>Advanced Customization</h1>
            
            <h3>Personalities vs. Personas</h3>
            <p><strong>Chat Persona:</strong> Sets the behavior for standard discussions (Pedagogical vs. Concise).<br>
            <strong>Agent Persona:</strong> Sets the behavior for autonomous sub-agents (Meticulous vs. Experimental).</p>

            <h3>Interactive Placeholders</h3>
            <p>You can create prompts that generate custom UI forms using the <code>@<variable>@</code> syntax:</p>
            <pre>
@&lt;API_ENDPOINT&gt;@
title: Target URL
type: str
default: https://api.example.com
help: Enter the base URL for the test
@&lt;/API_ENDPOINT&gt;@</pre>
            <p>When you trigger a prompt with this syntax, a modal will appear asking for these values before the AI is even contacted.</p>
        </section>

        <!-- MCP & TOOLS -->
        <section id="mcp">
            <h1>MCP & Tool Extensions</h1>
            <p>Lollms supports the <strong>Model Context Protocol (MCP)</strong>. This allows the Agent to use any server that implements the standard MCP spec.</p>
            
            <h3>Configuring MCP Servers</h3>
            <p>In settings, you can map server names to execution commands:</p>
            <pre>"mcpServers": {
    "filesystem": "npx -y @modelcontextprotocol/server-filesystem /path/to/search",
    "google-maps": "npx -y @modelcontextprotocol/server-google-maps"
}</pre>

            <div class="warning">
                <strong>Grounding Check:</strong> The agent is instructed to use <code>search_web</code> whenever it encounters a library it doesn't recognize. Ensure your <strong>Google Search API Key</strong> and <strong>CX</strong> are set to enable this autonomous research capability.
            </div>
        </section>
    </main>

    <script>
        function showSection(id) {
            // Update Nav
            document.querySelectorAll('.nav-item').forEach(item => {
                item.classList.remove('active');
                if (item.getAttribute('onclick').includes(id)) item.classList.add('active');
            });
            
            // Update Content
            document.querySelectorAll('section').forEach(sec => {
                sec.classList.remove('active');
            });
            document.getElementById(id).classList.add('active');
            
            // Scroll to top
            document.getElementById('main-content').scrollTop = 0;
        }
    </script>
</body>
</html>`;
    }
}
