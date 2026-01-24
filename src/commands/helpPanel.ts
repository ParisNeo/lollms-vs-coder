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
            --header-fg: var(--vscode-sideBarSectionHeader-foreground);
        }
        body { font-family: var(--vscode-font-family); background-color: var(--bg); color: var(--fg); margin: 0; padding: 0; display: flex; height: 100vh; overflow: hidden; }
        
        /* Navigation Sidebar */
        nav { width: 260px; background: var(--sidebar-bg); border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; }
        .nav-header { padding: 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 1.1em; color: var(--header-fg); }
        .nav-header img { width: 24px; height: 24px; }
        .nav-items { flex: 1; overflow-y: auto; padding: 10px 0; }
        .nav-item { padding: 8px 20px; cursor: pointer; display: flex; align-items: center; gap: 10px; font-size: 0.95em; transition: 0.2s; color: var(--fg); }
        .nav-item:hover { background: var(--hover); }
        .nav-item.active { background: var(--active-bg); color: var(--active-fg); border-left: 3px solid var(--link); }
        .nav-item i { font-size: 16px; opacity: 0.8; width: 20px; text-align: center; }

        /* Content Area */
        main { flex: 1; overflow-y: auto; padding: 40px; scroll-behavior: smooth; }
        section { display: none; max-width: 900px; margin: 0 auto; animation: fadeIn 0.3s ease-in-out; }
        section.active { display: block; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

        h1 { font-size: 2.2em; font-weight: 300; margin-bottom: 0.5em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
        h2 { font-size: 1.5em; margin-top: 2em; display: flex; align-items: center; gap: 10px; border-bottom: 1px dashed var(--border); padding-bottom: 5px; }
        h3 { font-size: 1.2em; margin-top: 1.5em; color: var(--link); }
        p, li { line-height: 1.6; font-size: 1em; opacity: 0.9; margin-bottom: 0.8em; }
        ul { padding-left: 20px; }
        
        .card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); padding: 1.5em; border-radius: 6px; margin: 1.5em 0; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
        .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.85em; font-weight: 600; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-right: 8px; }
        code { font-family: var(--vscode-editor-font-family); background: var(--code-bg); padding: 2px 5px; border-radius: 4px; font-size: 0.9em; }
        pre { background: var(--code-bg); padding: 1em; border-radius: 6px; overflow-x: auto; border: 1px solid var(--border); margin: 1em 0; }
        
        .tip { border-left: 4px solid var(--link); background: rgba(0, 122, 204, 0.1); padding: 12px 20px; border-radius: 0 4px 4px 0; margin: 1.5em 0; }
        .warning { border-left: 4px solid var(--vscode-errorForeground); background: rgba(255, 0, 0, 0.05); padding: 12px 20px; border-radius: 0 4px 4px 0; margin: 1.5em 0; }
        
        table { width: 100%; border-collapse: collapse; margin: 1em 0; font-size: 0.95em; }
        th, td { text-align: left; padding: 12px; border-bottom: 1px solid var(--border); }
        th { font-weight: 600; opacity: 0.8; background-color: var(--vscode-editor-inactiveSelectionBackground); }
        tr:hover { background-color: var(--vscode-list-hoverBackground); }

        .feature-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px; margin-top: 15px; }
        .feature-item { padding: 15px; background: var(--vscode-editorWidget-background); border: 1px solid var(--border); border-radius: 6px; }
        .feature-item i { font-size: 24px; color: var(--link); margin-bottom: 10px; display: block; }
        .feature-item strong { display: block; font-size: 1.1em; margin-bottom: 5px; }
    </style>
</head>
<body>
    <nav>
        <div class="nav-header">
            <img src="${lollmsIconUri}" alt="Logo">
            <span>Lollms Manual</span>
        </div>
        <div class="nav-items">
            <div class="nav-item active" onclick="showSection('intro')"><i class="codicon codicon-home"></i> Overview</div>
            <div class="nav-item" onclick="showSection('agent')"><i class="codicon codicon-robot"></i> Agent Mode</div>
            <div class="nav-item" onclick="showSection('context')"><i class="codicon codicon-layers"></i> Smart Context</div>
            <div class="nav-item" onclick="showSection('graph')"><i class="codicon codicon-graph"></i> Visual Code Graph</div>
            <div class="nav-item" onclick="showSection('jupyter')"><i class="codicon codicon-notebook"></i> Notebooks</div>
            <div class="nav-item" onclick="showSection('git')"><i class="codicon codicon-git-commit"></i> Git Mastery</div>
            <div class="nav-item" onclick="showSection('skills')"><i class="codicon codicon-lightbulb"></i> Skills & Memory</div>
            <div class="nav-item" onclick="showSection('custom')"><i class="codicon codicon-settings"></i> Configuration</div>
        </div>
    </nav>

    <main id="main-content">
        <!-- OVERVIEW -->
        <section id="intro" class="active">
            <h1>Welcome to Lollms VS Coder</h1>
            <p>Lollms is your local-first, privacy-focused AI coding partner. It integrates deeply with VS Code to understand your project structure, manage file contexts, and execute complex autonomous tasks.</p>
            
            <div class="feature-grid">
                <div class="feature-item">
                    <i class="codicon codicon-comment-discussion"></i>
                    <strong>Context-Aware Chat</strong>
                    <p>Chat with your codebase. Use the sidebar to precisely control which files the AI sees.</p>
                </div>
                <div class="feature-item">
                    <i class="codicon codicon-robot"></i>
                    <strong>Autonomous Agent</strong>
                    <p>Give high-level objectives. The agent plans, writes code, runs terminals, and self-corrects.</p>
                </div>
                <div class="feature-item">
                    <i class="codicon codicon-sparkle"></i>
                    <strong>Quick Companion</strong>
                    <p>Press <span class="badge">Ctrl+Shift+L</span> for a floating window to quickly edit or query selected code.</p>
                </div>
            </div>

            <h2>Getting Started</h2>
            <ol>
                <li><strong>Select a Model:</strong> Click the model name in the Status Bar (bottom right) or use the settings panel.</li>
                <li><strong>Add Context:</strong> Right-click files in the Explorer -> <code>Lollms: Include in Context</code>.</li>
                <li><strong>Start Chatting:</strong> Click the Lollms icon in the Activity Bar.</li>
            </ol>
        </section>

        <!-- AGENT MODE -->
        <section id="agent">
            <h1>🤖 Agent Mode</h1>
            <p>Turn the AI from a chatbot into an autonomous worker. The Agent can browse files, run shell commands, write code, and use web search.</p>
            
            <div class="card">
                <h3>The Dynamic Plan Zone</h3>
                <p>When you activate Agent Mode, a new <strong>Plan Zone</strong> appears at the top of the chat panel. This area updates in real-time as the agent:</p>
                <ul>
                    <li>Creates a multi-step plan.</li>
                    <li>Executes tools (e.g., <code>read_file</code>, <code>generate_code</code>).</li>
                    <li>Updates its "Scratchpad" (thought process).</li>
                </ul>
                <p>You can continue to chat in the stream below to guide the agent or answer its questions.</p>
            </div>

            <h3>Capabilities</h3>
            <ul>
                <li><strong>Auto-Correction:</strong> If a command fails (e.g., syntax error), the agent sees the error and retries automatically.</li>
                <li><strong>Replanning:</strong> If you change the requirement mid-task, tell the agent "Edit the plan to include X", and it will rewrite its task list.</li>
                <li><strong>Safety:</strong> The agent cannot delete files without permission settings. You can configure capabilities in <em>Settings -> Agent & Tools</em>.</li>
            </ul>
        </section>

        <!-- CONTEXT -->
        <section id="context">
            <h1>🧠 Smart Context Management</h1>
            <p>LLMs have limited context windows. Lollms helps you manage what the AI "sees" to save tokens and improve accuracy.</p>
            
            <h3>File States</h3>
            <table>
                <tr><th>State</th><th>Icon</th><th>Description</th></tr>
                <tr><td><strong>Included</strong></td><td>✅</td><td>Full content is sent to the AI. Use for files you want to edit.</td></tr>
                <tr><td><strong>Tree-Only</strong></td><td>📄</td><td>Only the file path is visible. Good for letting the AI know file locations.</td></tr>
                <tr><td><strong>Definitions</strong></td><td>🔍</td><td>(New) Sends class/function signatures <em>only</em>. Great for libraries/APIs.</td></tr>
                <tr><td><strong>Excluded</strong></td><td>🚫</td><td>Completely hidden.</td></tr>
            </table>

            <div class="tip">
                <strong>Auto-Context:</strong> Click the <span class="codicon codicon-wand"></span> <strong>Auto-Select</strong> button in the sidebar. Describe your task (e.g., "Fix the login page"), and an AI agent will scan your project and automatically select the relevant files for you.
            </div>
        </section>

        <!-- GRAPH -->
        <section id="graph">
            <h1>📊 Visual Code Graph</h1>
            <p>Understand your project's architecture with interactive diagrams. Click the <span class="codicon codicon-graph"></span> icon in the sidebar title area.</p>

            <h3>Views</h3>
            <ul>
                <li><strong>Class Diagram:</strong> UML-style view of classes, methods, and inheritance.</li>
                <li><strong>Call Graph:</strong> Visualization of function calls and file dependencies.</li>
                <li><strong>Import Graph:</strong> Directed graph showing how modules import each other.</li>
            </ul>

            <div class="tip">
                <strong>Export:</strong> You can export diagrams as SVG or PNG images for documentation. You can also click "Add to Chat" to send the diagram structure to the AI for analysis.
            </div>
        </section>

        <!-- NOTEBOOKS -->
        <section id="jupyter">
            <h1>📓 Jupyter Integration</h1>
            <p>Lollms supercharges `.ipynb` notebooks with context-aware buttons in the cell toolbar.</p>
            
            <div class="feature-grid">
                <div class="feature-item">
                    <strong>$(book) Educative</strong>
                    <p>Generates a complete tutorial notebook on a topic, alternating text and code cells.</p>
                </div>
                <div class="feature-item">
                    <strong>$(sparkle) Enhance</strong>
                    <p>Refactors the current cell for performance and readability.</p>
                </div>
                <div class="feature-item">
                    <strong>$(graph) Visualize</strong>
                    <p>Reads the output data of a cell and auto-generates Matplotlib/Seaborn code to plot it.</p>
                </div>
                <div class="feature-item">
                    <strong>$(debug-restart) Fix Error</strong>
                    <p>Appears when a cell fails. Analyzes the stack trace and patches the code.</p>
                </div>
            </div>
        </section>

        <!-- GIT -->
        <section id="git">
            <h1>🐙 Git Mastery</h1>
            
            <h3>Commit Message Generation</h3>
            <p>In the <strong>Source Control</strong> panel, click the Lollms icon to generate a conventional commit message based on your staged changes.</p>

            <h3>Commit Inspector</h3>
            <p>Open the <strong>Lollms Git Manager</strong> (via command palette or status bar) to:</p>
            <ul>
                <li><strong>Natural Language Search:</strong> Ask "When did I break the login?" to find commits.</li>
                <li><strong>Deep Analysis:</strong> Select a commit to have the AI analyze it for security bugs, logic errors, and code quality issues.</li>
            </ul>
        </section>

        <!-- SKILLS -->
        <section id="skills">
            <h1>💡 Skills & Memory</h1>
            <p>Teach the AI new tricks. Skills are reusable snippets of code, prompts, or documentation that you can inject into any conversation.</p>

            <h3>Creating Skills</h3>
            <ol>
                <li>Select code in the editor.</li>
                <li>Right-click -> <code>Lollms: Learn Selection as Skill</code>.</li>
                <li>Give it a name (e.g., "React Component Pattern").</li>
            </ol>

            <h3>Using Skills</h3>
            <p>In a chat, click the <strong>Import Skill</strong> button (paperclip menu) to select from your library. The content is injected into the system prompt, teaching the AI exactly how you like things done.</p>
        </section>

        <!-- CUSTOM -->
        <section id="custom">
            <h1>⚙️ Configuration</h1>
            <p>Access settings via the gear icon in the sidebar.</p>

            <h3>Personas</h3>
            <p>Switch between specialized personalities:</p>
            <ul>
                <li><strong>Lollms Coder:</strong> Balanced helper.</li>
                <li><strong>Senior Architect:</strong> Focuses on design patterns and high-level structure.</li>
                <li><strong>Code Reviewer:</strong> Critical analysis of bugs and security.</li>
                <li><strong>STM32/Embedded Expert:</strong> Specialized hardware knowledge.</li>
            </ul>

            <h3>Model Configuration</h3>
            <p>You can configure different backends (<strong>Ollama, Lollms, OpenAI</strong>). Ensure your API Key and URL are correct. Use the "Test Connection" button in settings to verify.</p>
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
