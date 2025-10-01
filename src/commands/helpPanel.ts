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
        code { font-family: var(--vscode-editor-font-family); background-color: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-textBlockQuote-border); padding: 0.2em 0.4em; border-radius: 4px; }
        .codicon { font-family: "codicon"; display: inline-block; vertical-align: middle; font-size: 1.1em; margin-right: 5px;}
        .key-feature { font-weight: 600; color: var(--vscode-textLink-foreground); }
        .status-bar-example { display: flex; gap: 15px; background-color: var(--vscode-statusBar-background); color: var(--vscode-statusBar-foreground); padding: 5px 15px; border-radius: 5px; margin: 1em 0; align-items: center; font-family: var(--vscode-editor-font-family); }
        ul { padding-left: 20px; }
        li { margin-bottom: 0.5em; }
        blockquote {
            background-color: var(--vscode-textBlockQuote-background);
            border-left: 4px solid var(--vscode-textBlockQuote-border);
            margin: 1em 0;
            padding: 0.5em 1.5em;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <img src="${lollmsIconUri}" alt="Lollms Icon">
            <h1>Lollms VS Coder Help</h1>
        </div>

        <p>Welcome! This guide provides a detailed overview of all features available in the Lollms VS Coder extension, from basic chat to the advanced, self-correcting AI Agent.</p>

        <h2><span class="codicon codicon-robot"></span>Agent Mode: Your Autonomous Assistant</h2>
        <p>Agent Mode is the most powerful feature. It allows the AI to create and execute a multi-step plan to achieve a complex objective, like building an entire application from a single prompt. It can create files, write code, run commands, and even correct its own mistakes.</p>
        
        <h3>How to Use Agent Mode</h3>
        <ol>
            <li>Open the AI Chat panel by clicking <span class="codicon codicon-comment-discussion"></span><strong>Lollms Chat</strong> in the status bar.</li>
            <li>In the input area, click the <span class="key-feature">🤖 Agent Mode</span> toggle switch.</li>
            <li>The agent will confirm its activation. Type your high-level objective in the input box (e.g., "build a snake game in python with a virtual environment") and press Enter.</li>
        </ol>

        <h3>Understanding the Execution Plan</h3>
        <p>Once you provide an objective, the agent creates an <span class="key-feature">Execution Plan</span>, a dynamic list of tasks displayed in the chat. The agent executes these tasks sequentially, showing the status of each:</p>
        <ul>
            <li><span class="codicon codicon-circle-large-filled"></span><strong>Pending:</strong> The task is waiting to be executed.</li>
            <li><span class="codicon codicon-sync spin"></span><strong>In Progress:</strong> The agent is currently working on this task.</li>
            <li><span class="codicon codicon-check"></span><strong>Completed:</strong> The task finished successfully.</li>
            <li><span class="codicon codicon-error"></span><strong>Failed:</strong> The task encountered an error.</li>
        </ul>

        <h3>Autonomous Self-Correction</h3>
        <p>When a task fails, the agent will automatically try to fix the problem. It analyzes the error output and generates a new set of tasks to correct the mistake. The number of self-correction attempts can be configured in the settings.</p>
        
        <h3>User Intervention</h3>
        <p>If the agent cannot fix a problem on its own, it will pause and ask for your help with a dialog box:</p>
        <ul>
            <li><strong>Stop:</strong> Halts the execution of the plan permanently.</li>
            <li><strong>Continue Anyway:</strong> Ignores the error and proceeds to the next task (use with caution).</li>
            <li><strong>View Log:</strong> Opens a panel showing the detailed error message from the failed task.</li>
        </ul>

        <h2><span class="codicon codicon-comment-discussion"></span>The AI Chat Panel</h2>
        <p>For general-purpose questions, brainstorming, or getting quick code snippets, use the standard AI Chat.</p>
        
        <h3>Interacting with AI Responses</h3>
        <ul>
            <li><strong><span class="codicon codicon-tools"></span>Apply to File</strong>: When the AI suggests creating or modifying a file (e.g., <code>File: src/app.js</code>), a button appears on the code block. Clicking it opens an inline diff view where you can accept or reject the changes.</li>
            <li><strong><span class="codicon codicon-play"></span>Execute</strong>: Code blocks for shell scripts (Python, Bash, PowerShell) have an Execute button. This runs the script in a temporary file, and the output is automatically fed back to the AI for analysis.</li>
            <li><strong><span class="codicon codicon-search"></span>Inspect</strong>: Check AI-generated code for bugs and vulnerabilities. The inspector can auto-fix minor issues or provide detailed warnings.</li>
            <li><strong><span class="codicon codicon-device-camera"></span>Generate Image</strong>: If the AI returns an <code>image_prompt</code> block, a "Generate" button will appear. Clicking it creates the image and saves it to your project.</li>
        </ul>

        <h3>The "More Actions" <code>...</code> Menu</h3>
        <p>This menu, located to the left of the chat input, provides powerful project-level commands:</p>
        <ul>
            <li><strong><span class="codicon codicon-add"></span>Attach Files</strong>: Manually provide files (including text and images) to the AI for analysis or questions.</li>
            <li><strong><span class="codicon codicon-sparkle"></span>Generate Asset...</strong>: Describe an image you want to create (e.g., "a modern logo for a save button"), choose where to save it, and the AI will generate it.</li>
            <li><strong><span class="codicon codicon-target"></span>Set Project Entry Point</strong>: Define the main executable file (`.js`, `.py`, etc.) for your project. This is used by the "Execute Project" command.</li>
            <li><strong><span class="codicon codicon-play-circle"></span>Execute Project</strong>: Runs your project using the configured entry point. If it fails, the AI automatically analyzes the error output and suggests a fix.</li>
        </ul>

        <h2><span class="codicon codicon-brain"></span>AI Context Management</h2>
        <p>The <span class="key-feature">AI Context Files</span> view in the Lollms sidebar gives you precise control over what project information the AI sees. Click any file or folder to cycle through its three states:</p>
        <ul>
            <li><span class="codicon codicon-check"></span><strong>Included</strong>: The file's path AND its full content are sent to the AI.</li>
            <li><span class="codicon codicon-file-text"></span><strong>Tree-Only (Default)</strong>: Only the file's path is included in the project tree structure sent to the AI. Its content is hidden, saving tokens.</li>
            <li><span class="codicon codicon-circle-slash"></span><strong>Excluded</strong>: The file or folder is completely hidden from the AI.</li>
        </ul>
        <blockquote>Use the <strong><span class="codicon codicon-wand"></span>Auto-Select Context</strong> button in the view's toolbar to have the AI intelligently pick the most relevant files for a given objective.</blockquote>

        <h2><span class="codicon codicon-lightbulb"></span>In-Editor Tools</h2>
        <ul>
            <li><strong>Code Actions</strong>: Select code in the editor, click the <code>Lollms Actions...</code> CodeLens that appears, and choose from default actions (Explain, Refactor, Find Bugs, Generate Docs) or trigger your own custom prompts.</li>
            <li><strong>Inline Autocomplete</strong>: Enable "ghost text" suggestions in the extension settings for real-time, single-line code completion as you type.</li>
            <li><strong>Jupyter Notebooks</strong>: When a <code>.ipynb</code> file is active, use the icons in the cell toolbar to <strong>Enhance Cell</strong> (refactor) or <strong>Generate Next Cell</strong> based on the current one.</li>
        </ul>

        <h2><span class="codicon codicon-source-control"></span>Git, Sidebar, and Configuration</h2>
        <ul>
            <li><strong>Git Commit Messages</strong>: Click the Lollms icon in the Source Control panel's title bar to generate a conventional commit message based on your staged changes.</li>
            <li><strong>Sidebar Views</strong>: Use the sidebar to manage Discussions, see Running Processes, and create/organize your custom Prompts into groups.</li>
            <li><strong>Configuration <span class="codicon codicon-gear"></span></strong>: Access the settings UI from the title bar of any Lollms view to configure your API endpoint, select models, and customize agent behavior.</li>
        </ul>
        
    </div>
</body>
</html>`;
    }
}