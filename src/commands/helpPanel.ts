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
            'Lollms VS Coder Help',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
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

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Lollms VS Coder Help</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 2em;
            line-height: 1.7;
        }
        .container { max-width: 900px; margin: 0 auto; }
        .header { display: flex; align-items: center; gap: 15px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 1em; margin-bottom: 2em; }
        .header img { width: 50px; height: 50px; }
        h1 { margin: 0; font-size: 2.2em; font-weight: 300; }
        h2 { font-size: 1.8em; font-weight: 400; margin-top: 2.5em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 0.5em; display: flex; align-items: center; gap: 10px; }
        h3 { font-size: 1.3em; margin-top: 2em; font-weight: 500; }
        p, li { font-size: 1em; color: var(--vscode-foreground); }
        code, pre { font-family: var(--vscode-editor-font-family); background-color: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-textBlockQuote-border); padding: 0.2em 0.4em; border-radius: 4px; font-size: 0.9em; }
        pre { padding: 1em; white-space: pre-wrap; word-wrap: break-word; }
        .codicon { font-family: "codicon"; display: inline-block; vertical-align: middle; font-size: 1.1em; margin-right: 5px;}
        .key-feature { font-weight: 600; color: var(--vscode-textLink-foreground); }
        ul, ol { padding-left: 20px; }
        li { margin-bottom: 0.5em; }
        blockquote {
            background-color: var(--vscode-textBlockQuote-background);
            border-left: 4px solid var(--vscode-textBlockQuote-border);
            margin: 1em 0;
            padding: 0.5em 1.5em;
        }
        details { margin-bottom: 1em; background-color: var(--vscode-editorWidget-background); border-radius: 6px; border: 1px solid var(--vscode-widget-border); }
        summary { padding: 10px; cursor: pointer; font-weight: 600; outline: none; }
        summary:hover { background-color: var(--vscode-list-hoverBackground); }
        .details-content { padding: 15px; border-top: 1px solid var(--vscode-widget-border); }
        .tool-tag { display: inline-block; background-color: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 2px 6px; border-radius: 4px; font-size: 0.8em; margin-right: 5px; }
        .step-list { counter-reset: step; list-style: none; padding: 0; }
        .step-list li { position: relative; padding-left: 35px; margin-bottom: 1em; }
        .step-list li:before { content: counter(step); counter-increment: step; position: absolute; left: 0; top: 0; width: 25px; height: 25px; background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); border-radius: 50%; text-align: center; line-height: 25px; font-weight: bold; font-size: 0.9em; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <img src="${lollmsIconUri.toString()}" alt="Lollms Icon">
            <h1>Lollms VS Coder Help</h1>
        </div>

        <p>Welcome! This guide provides a detailed overview of all features available in the Lollms VS Coder extension, with a special focus on maximizing the potential of the autonomous AI Agent.</p>

        <h2><span class="codicon codicon-book"></span>Core Concepts</h2>

        <h3><span class="codicon codicon-comment-discussion"></span>The AI Chat Panel</h3>
        <p>The chat panel is your central hub. Start a new chat from the <strong>Discussions</strong> view. Here, you can ask questions, request code, and give high-level objectives to the AI.</p>

        <h3><span class="codicon codicon-robot"></span>Agent Mode</h3>
        <p>When you toggle <strong><span class="key-feature">🤖 Agent Mode</span></strong> on, you unlock the ability to delegate complex, multi-step tasks. The AI will:</p>
        <ol>
            <li><strong>Plan</strong>: Break down your objective into a sequence of logical steps.</li>
            <li><strong>Execute</strong>: Use specialized tools (see below) to perform actions like creating files or running commands.</li>
            <li><strong>Self-Correct</strong>: If a step fails, the agent analyzes the error and adjusts its plan automatically.</li>
        </ol>

        <h3><span class="codicon codicon-brain"></span>AI Context Management</h3>
        <p>The <strong>AI Context Files</strong> view controls what the AI sees:</p>
        <ul>
            <li><span style="color: var(--vscode-gitDecoration-addedResourceForeground);"><strong>✓ Included</strong></span>: Full content is sent.</li>
            <li><strong>□ Tree-Only</strong>: Only file paths are visible (saves tokens).</li>
            <li><span style="color: var(--vscode-gitDecoration-ignoredResourceForeground);"><strong>⊘ Excluded</strong></span>: Completely hidden.</li>
        </ul>

        <h2><span class="codicon codicon-beaker"></span>Agent Workflows & Tool Examples</h2>
        <p>The Agent has access to a powerful suite of tools. Here are practical examples of how to use them.</p>

        <details>
            <summary>🌐 Searching the Web & Stack Overflow</summary>
            <div class="details-content">
                <p><strong>Scenario:</strong> You are stuck on a specific library error or need documentation.</p>
                <p><strong>Prompt:</strong> "Find out why 'matplotlib' is failing with error X on Windows and fix it."</p>
                <p><strong>Agent Actions:</strong></p>
                <ul>
                    <li><span class="tool-tag">search_web</span> Queries Google/Stack Overflow for the error message.</li>
                    <li><span class="tool-tag">execute_command</span> Applies the suggested fix (e.g., installing a missing dependency).</li>
                </ul>
                
                <h4>How to Configure Google Search</h4>
                <p>To use the <code>search_web</code> tool, you must configure your Google Custom Search credentials in the extension settings.</p>
                <ol class="step-list">
                    <li>
                        <strong>Get the API Key:</strong>
                        <br>Go to the <a href="https://console.cloud.google.com/apis/credentials">Google Cloud Console Credentials</a> page. Create a new Project (if needed), then click "Create Credentials" -> "API Key". Copy the key.
                    </li>
                    <li>
                        <strong>Get the Search Engine ID (CX):</strong>
                        <br>Go to the <a href="https://programmablesearchengine.google.com/controlpanel/all">Programmable Search Engine</a> control panel. Create a new search engine (you can set "Sites to search" to <code>www.google.com</code> for a broad search). Once created, look for the "Search Engine ID" (often labeled as CX) in the Overview page.
                    </li>
                    <li>
                        <strong>Enable the API:</strong>
                        <br>In the Google Cloud Console, search for "Custom Search API" and enable it for your project.
                    </li>
                    <li>
                        <strong>Configure Extension:</strong>
                        <br>Open the Lollms settings (Click the gear icon in the "Lollms" sidebar). Enter the API Key and Search Engine ID in the "Tools & Search" section.
                    </li>
                </ol>
            </div>
        </details>

        <details>
            <summary>🎨 Image Generation</summary>
            <div class="details-content">
                <p><strong>Scenario:</strong> You need a placeholder image or an asset for your web app.</p>
                <p><strong>Prompt:</strong> "Generate a 1024x1024 pixel art image of a futuristic city and save it to 'assets/city.png'."</p>
                <p><strong>Agent Actions:</strong></p>
                <ul>
                    <li><span class="tool-tag">generate_image</span> Calls the Lollms image generation API and saves the result to the specified path.</li>
                </ul>
            </div>
        </details>

        <details>
            <summary>🔄 Dynamic Plan Altering</summary>
            <div class="details-content">
                <p><strong>Scenario:</strong> The agent is halfway through a task, but you realize you forgot a requirement.</p>
                <p><strong>Prompt:</strong> "Wait, also ensure you generate unit tests for that new module."</p>
                <p><strong>Agent Actions:</strong></p>
                <ul>
                    <li><span class="tool-tag">edit_plan</span> The agent recognizes the new requirement and re-generates the remaining steps of the plan to include test generation.</li>
                </ul>
            </div>
        </details>

        <details>
            <summary>🐍 Python Project Setup</summary>
            <div class="details-content">
                <p><strong>Scenario:</strong> You want to start a new data science project.</p>
                <p><strong>Prompt:</strong> "Create a new folder 'data_analysis', set up a Python virtual environment inside it, and install pandas and matplotlib."</p>
                <p><strong>Agent Actions:</strong></p>
                <ul>
                    <li><span class="tool-tag">create_python_environment</span> Creates <code>data_analysis/venv</code>.</li>
                    <li><span class="tool-tag">install_python_dependencies</span> Installs <code>pandas</code>, <code>matplotlib</code> into that venv.</li>
                    <li><span class="tool-tag">set_vscode_python_interpreter</span> Configures VS Code to use the new venv.</li>
                </ul>
            </div>
        </details>

        <details>
            <summary>🔍 Exploration & Refactoring</summary>
            <div class="details-content">
                <p><strong>Scenario:</strong> You are working on a legacy codebase and want to understand and improve a specific file.</p>
                <p><strong>Prompt:</strong> "Read <code>src/utils/helpers.js</code>, explain what it does, and then refactor the 'formatDate' function to use 'date-fns' library."</p>
                <p><strong>Agent Actions:</strong></p>
                <ul>
                    <li><span class="tool-tag">read_file</span> Reads the content of <code>src/utils/helpers.js</code>.</li>
                    <li><span class="tool-tag">generate_code</span> Rewrites the file with the refactored code.</li>
                    <li><span class="tool-tag">execute_command</span> Might run <code>npm install date-fns</code> if it realizes the library is missing.</li>
                </ul>
            </div>
        </details>

        <details>
            <summary>🐞 Autonomous Debugging</summary>
            <div class="details-content">
                <p><strong>Scenario:</strong> Tests are failing, and you want the AI to fix them.</p>
                <p><strong>Prompt:</strong> "Run the project tests. If any fail, analyze the error, locate the relevant source code, and fix the bug."</p>
                <p><strong>Agent Actions:</strong></p>
                <ul>
                    <li><span class="tool-tag">execute_command</span> Runs <code>npm test</code> (or <code>pytest</code>).</li>
                    <li><span class="tool-tag">read_file</span> Reads the failing test file and the tested code to understand the issue.</li>
                    <li><span class="tool-tag">generate_code</span> Modifies the code to fix the logic.</li>
                    <li><span class="tool-tag">execute_command</span> Re-runs tests to verify the fix.</li>
                </ul>
            </div>
        </details>

        <details>
            <summary>📂 File Management</summary>
            <div class="details-content">
                <p><strong>Scenario:</strong> Organizing a messy project.</p>
                <p><strong>Prompt:</strong> "List all files in the root directory. Move all .log files to a 'logs' folder and delete any .tmp files."</p>
                <p><strong>Agent Actions:</strong></p>
                <ul>
                    <li><span class="tool-tag">list_files</span> Gets the file structure.</li>
                    <li><span class="tool-tag">execute_command</span> Runs <code>mkdir logs</code>, <code>mv *.log logs/</code>, and <code>rm *.tmp</code>.</li>
                </ul>
            </div>
        </details>

        <h3>Available Tools Reference</h3>
        <ul>
            <li><strong>Search:</strong> <code>search_web</code> (Google/Stack Overflow).</li>
            <li><strong>Creative:</strong> <code>generate_image</code>.</li>
            <li><strong>Planning:</strong> <code>edit_plan</code> (Modify future tasks).</li>
            <li><strong>File Ops:</strong> <code>read_file</code>, <code>list_files</code>, <code>generate_code</code> (creates/overwrites).</li>
            <li><strong>Execution:</strong> <code>execute_command</code> (shell), <code>execute_python_script</code>.</li>
            <li><strong>Python:</strong> <code>create_python_environment</code>, <code>install_python_dependencies</code>.</li>
            <li><strong>Context:</strong> <code>auto_select_context_files</code>, <code>deselect_context_files</code>.</li>
            <li><strong>Visualization:</strong> <code>read_code_graph</code> (Agent reads project structure graph).</li>
            <li><strong>Misc:</strong> <code>request_user_input</code>, <code>get_environment_details</code>.</li>
        </ul>

        <h2><span class="codicon codicon-tools"></span>Detailed Feature Guide</h2>

        <h3><span class="codicon codicon-graph"></span> Code Explorer (Code Graph)</h3>
        <p>The <strong>Code Explorer</strong> view provides interactive visualizations of your codebase.</p>
        <ul>
            <li><strong>Visualizations:</strong>
                <ul>
                    <li><strong>Call Graph:</strong> Visualizes function calls and symbol relationships.</li>
                    <li><strong>Import Graph:</strong> Shows file dependencies and import hierarchies.</li>
                    <li><strong>Class Diagram:</strong> Displays classes, methods, and their relationships.</li>
                </ul>
            </li>
            <li><strong>Interaction:</strong> Click on nodes to jump directly to the code definition. Hover to see docstrings and types.</li>
            <li><strong>AI Integration:</strong> Use the <strong>"Add View to Chat"</strong> button to send the current graph to the AI context. This allows the AI to understand the high-level architecture without reading every file.</li>
            <li><strong>Persistence:</strong> The graph is saved to <code>.lollms/code_graph.json</code> for quick loading. Click <strong>"Recreate Graph"</strong> or <strong>"Build Graph"</strong> to refresh it after code changes.</li>
        </ul>

        <h3>Interacting with AI Responses</h3>
        <ul>
            <li><strong><span class="codicon codicon-play"></span>Execute Scripts</strong>: Click the play button on script blocks (Python, Bash, etc.) to run them immediately. Output is fed back to the AI.</li>
            <li><strong><span class="codicon codicon-search"></span>Inspect Code</strong>: Use the magnifier icon on code blocks to scan for bugs and security issues.</li>
            <li><strong><span class="codicon codicon-circuit-board"></span>Diagrams</strong>: <code>mermaid</code> and <code>svg</code> blocks render automatically.</li>
        </ul>
        
        <h3>Advanced Features</h3>
        <ul>
            <li><strong><span class="codicon codicon-copy"></span>Copy Full Prompt</strong>: Located in the <strong>More Actions (...)</strong> menu near the input box. Copies the complete context (system prompt, files, history) sent to the AI. Useful for debugging.</li>
            <li><strong><span class="codicon codicon-target"></span>Entry Point</strong>: Use the target icon in the "More Actions" menu to set the main file for the "Execute Project" button.</li>
        </ul>

        <h3>Advanced File Operations</h3>
        <p>Use the settings to configure <code>File Update Method</code> (Full File vs Diff).</p>
        <ul>
            <li><strong>File: path/to/file.ext</strong>: Indicates a full file update. Click <strong>Apply</strong> to review changes in a diff view.</li>
            <li><strong>Rename/Move</strong>: The AI can propose file moves using a <code>rename</code> block.</li>
            <li><strong>Delete</strong>: The AI can propose deletions using a <code>delete</code> block.</li>
        </ul>

        <h2><span class="codicon codicon-lightbulb"></span>In-Editor Tools</h2>
        <ul>
            <li><strong>Code Actions</strong>: Select code -> <code>Lollms Actions...</code> -> Refactor, Explain, or Custom Prompt.</li>
            <li><strong>Inline Autocomplete</strong>: "Ghost text" suggestions as you type (enable in settings).</li>
            <li><strong>Jupyter Notebooks</strong>: Cell toolbar actions for <strong>Enhance</strong> and <strong>Generate Next</strong>.</li>
            <li><strong>Debugging</strong>: When an exception hits, use the <strong>Fix with Lollms</strong> CodeLens or toolbar button.</li>
        </ul>
        
    </div>
</body>
</html>`;
    }
}
