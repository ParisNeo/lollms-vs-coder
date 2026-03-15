import * as vscode from 'vscode';

export class HelpPanel {
    public static currentPanel: HelpPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

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
        
        // Listen for when the panel is disposed
        // This happens when the user closes the panel or when the panel is closed programmatically
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public dispose() {
        HelpPanel.currentPanel = undefined;
        
        // Clean up our resources
        this._panel.dispose();
        
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        // Generate URIs for local content
        const iconPath = vscode.Uri.joinPath(this._extensionUri, 'media', 'lollms-icon.svg');
        const stylePath = vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css');

        const lollmsIconUri = webview.asWebviewUri(iconPath);
        const codiconsUri = webview.asWebviewUri(stylePath);
        
        // Content Security Policy
        const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'unsafe-inline'; font-src ${webview.cspSource};`;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
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
        nav { width: 280px; background: var(--sidebar-bg); border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; }
        .nav-header { padding: 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 1.1em; color: var(--header-fg); }
        .nav-header img { width: 24px; height: 24px; }
        .nav-items { flex: 1; overflow-y: auto; padding: 10px 0; }
        
        /* Chapter Groups */
        .nav-group { margin-bottom: 5px; }
        .nav-group-header { 
            padding: 10px 20px; 
            display: flex; 
            justify-content: space-between; 
            align-items: center; 
            cursor: pointer; 
            font-weight: bold; 
            font-size: 0.85em; 
            text-transform: uppercase; 
            opacity: 0.7; 
            letter-spacing: 1px;
        }
        .nav-group-header:hover { opacity: 1; color: var(--link); }
        .nav-group-content { display: none; padding-left: 10px; }
        .nav-group.open .nav-group-content { display: block; }
        .nav-group.open .chevron { transform: rotate(90deg); }
        .chevron { font-size: 10px; transition: transform 0.2s; }

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
            
            <div class="nav-group open">
                <div class="nav-group-header" onclick="toggleGroup(this)">Fundamentals <i class="codicon codicon-chevron-right chevron"></i></div>
                <div class="nav-group-content">
                    <div class="nav-item" onclick="showSection('context')"><i class="codicon codicon-layers"></i> Smart Context</div>
                    <div class="nav-item" onclick="showSection('graph')"><i class="codicon codicon-graph"></i> Code Graph</div>
                    <div class="nav-item" onclick="showSection('profiles')"><i class="codicon codicon-settings-gear"></i> Response Styles</div>
                    <div class="nav-item" onclick="showSection('skills')"><i class="codicon codicon-lightbulb"></i> Skills & Memory</div>
                </div>
            </div>

            <div class="nav-group">
                <div class="nav-group-header" onclick="toggleGroup(this)">Agentic Workflow <i class="codicon codicon-chevron-right chevron"></i></div>
                <div class="nav-group-content">
                    <div class="nav-item" onclick="showSection('agent')"><i class="codicon codicon-robot"></i> Agent Mode</div>
                    <div class="nav-item" onclick="showSection('automation')"><i class="codicon codicon-zap"></i> Auto-Repair</div>
                    <div class="nav-item" onclick="showSection('advanced-debug')"><i class="codicon codicon-bug"></i> Live Debugging</div>
                </div>
            </div>

            <div class="nav-group">
                <div class="nav-group-header" onclick="toggleGroup(this)">Specialized Tools <i class="codicon codicon-chevron-right chevron"></i></div>
                <div class="nav-group-content">
                    <div class="nav-item" onclick="showSection('research')"><i class="codicon codicon-globe"></i> Web Discovery</div>
                    <div class="nav-item" onclick="showSection('jupyter')"><i class="codicon codicon-notebook"></i> Notebooks</div>
                    <div class="nav-item" onclick="showSection('git')"><i class="codicon codicon-git-commit"></i> Git Mastery</div>
                </div>
            </div>

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

        <!-- AUTOMATION -->
        <section id="automation">
            <h1>🚀 Automation & Workspace Repair</h1>
            <p>Lollms can operate in "Hands-Free" mode, performing repetitive tasks or fixing workspace-wide errors without constant supervision.</p>

            <div class="card">
                <h3>Auto-Apply Mode</h3>
                <p>When enabled in <b>Discussion Settings (⚙️)</b>, the AI won't show an "Apply" button. It will directly modify your files as it thinks.</p>
                <ul>
                    <li><b>Safety:</b> It is recommended to use this with a clean Git state.</li>
                    <li><b>Feedback:</b> You will see a list of modified files appearing at the bottom of the message.</li>
                </ul>
            </div>

            <h2>🛠️ Workspace-Wide Error Repair</h2>
            <p>Have a project full of TypeScript or Python errors? Use the <b>Fix All Workspace Errors</b> tool from the Actions view.</p>
            <ol>
                <li>The engine scans your entire project for <code>Error</code> diagnostics.</li>
                <li>It presents a list of "Discovery" hits.</li>
                <li>Click <b>Start Repair</b>, and a dedicated Automation Panel opens.</li>
                <li>The AI iterates through every file, reads dependencies, applies fixes, and <b>verifies</b> if the error disappeared before moving on.</li>
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

            <h2>🔍 Pro Search Engine</h2>
            <p>The manual search tool (Search icon in the context bubble) supports advanced logic to help you find specific files or code patterns in large projects.</p>
            
            <table>
                <tr><th>Feature</th><th>Syntax</th><th>Description</th></tr>
                <tr><td><strong>AND</strong></td><td><code>term1 term2</code></td><td>Finds results containing both terms (separated by space).</td></tr>
                <tr><td><strong>OR</strong></td><td><code>term1 | term2</code></td><td>Finds results containing either term.</td></tr>
                <tr><td><strong>NOT</strong></td><td><code>-term</code></td><td>Excludes results containing the specified term.</td></tr>
                <tr><td><strong>Extension</strong></td><td><code>ext:py</code></td><td>Narrows search to a specific file extension.</td></tr>
            </table>

            <div class="card">
                <strong>Example Query:</strong><br>
                <code>auth service -test ext:ts</code>
                <p style="margin-top:5px; font-size: 0.9em; opacity: 0.8;">This finds TypeScript files containing "auth" and "service", but excludes any file containing "test".</p>
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
            <p>Lollms supercharges <code>.ipynb</code> notebooks with context-aware buttons in the cell toolbar.</p>
            
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

        <!-- RESEARCH -->
        <section id="research">
            <h1>🌍 Research & Web Discovery</h1>
            <p>Enable the <b>Web Search</b> badge to allow the AI to fact-check or read documentation from the internet.</p>

            <h3>The Research Librarian</h3>
            <p>Lollms doesn't just "search"; it spawns a specialized Librarian Agent that:</p>
            <ul>
                <li>Decides if your question needs external data.</li>
                <li>Plans multiple queries (Google, Wikipedia, ArXiv).</li>
                <li>Scrapes the resulting pages.</li>
                <li><b>Distills</b> the content to fit only the relevant info into your context.</li>
            </ul>

            <div class="tip">
                <strong>Manual Web Discovery:</strong> Click the <b>Paperclip -> Web</b> button. You can search Wikipedia, ArXiv, or Google directly from the UI and select which results to "Inject" into your context.
            </div>

            <h2>📚 Big Data Processing</h2>
            <p>If you attach a file larger than 128k characters (like a massive CSV or a 200-page PDF), Lollms uses a <b>Map-Reduce</b> strategy:</p>
            <ol>
                <li>It splits the file into semantic chunks.</li>
                <li>Summarizes each chunk based on your instruction.</li>
                <li>Synthesizes the summaries into a final, coherent answer.</li>
            </ol>
        </section>
            <h1>📓 Jupyter Integration</h1>
            <p>Lollms supercharges \`.ipynb\` notebooks with context-aware buttons in the cell toolbar.</p>
            
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

        <!-- ADVANCED DEBUGGING -->
        <section id="advanced-debug">
            <h1>🐞 Advanced Debugging & UI Apps</h1>
            <p>Debugging logic errors is easy, but debugging runtime behavior in complex or GUI apps requires a specific setup.</p>

            <div class="card">
                <h3>The "Active Duo": Agent + Debug</h3>
                <p>To have the AI actually <b>fix</b> your code in real-time, you must activate both modes:</p>
                <ul>
                    <li><span class="badge" style="background:var(--vscode-charts-orange); color:white;">Agent Mode</span>: Gives the AI the <b>Tools</b> (Terminal, Filesystem).</li>
                    <li><span class="badge" style="background:var(--vscode-charts-red); color:white;">Debug Mode</span>: Gives the AI the <b>Reasoning</b> (Permission to use the Debugger).</li>
                </ul>
                <p>When both are on, the Architect will set breakpoints, start sessions, and inspect variables to find the root cause of a crash.</p>
            </div>

            <h2>🖥️ Debugging GUI Apps (PyQt, Tkinter, etc.)</h2>
            <p>GUI apps are unique because they don't exit; they wait for events. Lollms uses a <b>Vision & Automation</b> strategy for these:</p>
            
            <div class="tip">
                <strong>Step 1: Enable Screen Capture</strong><br>
                Go to <code>Settings -> Agent & Tools -> Permissions</code> and check <b>Screen Capture (Desktop)</b>. For privacy, this is disabled by default.
            </div>

            <h3>The Workflow</h3>
            <ol>
                <li><strong>Instrumentation:</strong> The agent writes a test script using <code>pyautogui</code> or <code>pytest-qt</code>.</li>
                <li><strong>Non-blocking Launch:</strong> It launches your app in the background.</li>
                <li><strong>Visual Analysis:</strong> It uses the <code>capture_desktop</code> tool to "see" your app's window and verify UI states or error dialogs.</li>
                <li><strong>State Inspection:</strong> It uses the <code>vscode_debugger</code> to step through the event loop while the UI is alive.</li>
            </ol>

            <div class="warning">
                <strong>Pro Tip:</strong> If your app hangs, the agent is trained to use <code>taskkill</code> or <code>pkill</code> as a final cleanup step to ensure your workspace stays clean.
            </div>
        </section>

        <!-- GIT -->
        <section id="git">
            <h1>🐙 Git & Security (CVE) Workflow</h1>
            
            <div class="card">
                <h3>🛡️ CVE Fix Tracking</h3>
                <p>For security researchers, tracking the exact commit ID of a fix is mandatory. Lollms makes this easy:</p>
                <ul>
                    <li><strong>Instant Hash Capture:</strong> Whenever you commit via the Lollms Git interface, the full SHA-1 hash is injected into the chat and saved to the Git menu.</li>
                    <li><strong>One-Click Copy:</strong> Click the Git Branch badge -> <code>Copy Last Hash</code> to grab the ID for your report.</li>
                    <li><strong>Agentic Checkpoints:</strong> When using Agent Mode, the agent is trained to perform "Checkpoints" before and after risky security fixes.</li>
                </ul>
            </div>

            <h3>Commit Message Generation</h3>
            <p>Lollms writes <strong>Conventional Commits</strong>. It analyzes your diff and suggests <code>feat:</code>, <code>fix:</code>, or <code>chore:</code> labels automatically. If you are fixing a CVE, mention it in the chat (e.g., "Fix CVE-2024-1234"), and the generated message will include it.</p>

            <h3>The Git Dashboard</h3>
            <p>Access the <strong>Git Dashboard</strong> from the Actions sidebar to get a full overview of your repository:</p>
            <ul>
                <li><strong>Tree Management:</strong> View all Staged, Unstaged, and Untracked files with buttons to Stage/Unstage/Discard.</li>
                <li><strong>Branching:</strong> Create new branches or switch between existing ones instantly.</li>
                <li><strong>Stash Support:</strong> Quickly stash all current changes or apply them from your stash history.</li>
                <li><strong>Commit Log:</strong> See a quick preview of your last 10 commits.</li>
            </ul>
            
            <h3>The Git Manager</h3>
            <ul>
                <li><strong>Natural Language Search:</strong> Use the Git Manager to ask "Find the commit where I added the eval() call" or "Who modified the auth logic last month?".</li>
                <li><strong>Security Export:</strong> Once an analysis is generated in the Commit Inspector, you can <strong>Copy</strong> it to your report, <strong>Save</strong> it as a Markdown file, or <strong>Send to Chat</strong>.</li>
                <li><strong>Discussion Loop:</strong> Sending an analysis to chat creates a new discussion where the AI "remembers" the security audit, allowing you to ask follow-up questions like <em>"Is this fix sufficient for CVE-2024-XXX?"</em>.</li>
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

            <div class="tip">
                <strong>Source of Truth:</strong> When a skill is active, the AI treats it as a "Diamond Protocol." It will prioritize the skill's instructions over its general training data.
            </div>
        </section>

        <!-- PROFILES -->
        <section id="profiles">
            <h1>🎭 Response Profiles</h1>
            <p>You can switch the "Personality Mode" of the AI at any time using the badge next to the model name.</p>
            
            <table>
                <tr><th>Profile</th><th>Behavior</th></tr>
                <tr><td><b>Balanced</b></td><td>Explanation first, then code. Professional and helpful.</td></tr>
                <tr><td><b>Structured</b></td><td>Strict <i>Problem / Hypothesis / Fix</i> layout. Best for complex debugging.</td></tr>
                <tr><td><b>Minimalist</b></td><td>No talking. Just the code or the direct answer.</td></tr>
                <tr><td><b>Pedagogical</b></td><td>Acts as a teacher. Explains the "Why" deeply with analogies.</td></tr>
            </table>

            <div class="tip">
                <strong>Custom Profiles:</strong> You can create your own profiles in the Discussion Settings (⚙️). For example, a "Senior Architect" profile that only responds with UML and Design Patterns.
            </div>
        </section>
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
        function toggleGroup(header) {
            const group = header.parentElement;
            group.classList.toggle('open');
        }

        function showSection(id) {
            // Update Nav item activation
            document.querySelectorAll('.nav-item').forEach(item => {
                item.classList.remove('active');
                // Use a more precise check to find the clicked section ID
                if (item.getAttribute('onclick') && item.getAttribute('onclick').includes("'"+id+"'")) {
                    item.classList.add('active');
                    // Ensure the parent group is open
                    const group = item.closest('.nav-group');
                    if (group) group.classList.add('open');
                }
            });
            
            // Update Content Visibility
            document.querySelectorAll('section').forEach(sec => {
                sec.classList.remove('active');
            });
            const target = document.getElementById(id);
            if (target) {
                target.classList.add('active');
                document.getElementById('main-content').scrollTop = 0;
            } else {
                console.error("Section not found:", id);
            }
        }
    </script>
</body>
</html>`;
    }
}
