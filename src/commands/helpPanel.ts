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
        .container {
            max-width: 800px;
            margin: 0 auto;
        }
        .header {
            display: flex;
            align-items: center;
            gap: 15px;
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 1em;
            margin-bottom: 2em;
        }
        .header img {
            width: 50px;
            height: 50px;
        }
        h1 {
            margin: 0;
            font-size: 2.2em;
            font-weight: 300;
        }
        h2 {
            font-size: 1.8em;
            font-weight: 400;
            margin-top: 2.5em;
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 0.5em;
        }
        h3 {
            font-size: 1.3em;
            margin-top: 2em;
            font-weight: 500;
        }
        p, li {
            font-size: 1em;
            color: var(--vscode-foreground);
        }
        code {
            font-family: var(--vscode-editor-font-family);
            background-color: var(--vscode-textBlockQuote-background);
            border: 1px solid var(--vscode-textBlockQuote-border);
            padding: 0.2em 0.4em;
            border-radius: 4px;
        }
        blockquote {
            background-color: var(--vscode-textBlockQuote-background);
            border-left: 4px solid var(--vscode-textBlockQuote-border);
            margin: 1em 0;
            padding: 0.5em 1.5em;
        }
        .feature-icon {
            display: inline-block;
            vertical-align: middle;
            margin-right: 8px;
            font-weight: bold;
        }
        .status-bar-example {
            display: flex;
            gap: 15px;
            background-color: var(--vscode-statusBar-background);
            color: var(--vscode-statusBar-foreground);
            padding: 5px 15px;
            border-radius: 5px;
            margin: 1em 0;
            align-items: center;
            font-family: var(--vscode-editor-font-family);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <img src="${lollmsIconUri}" alt="Lollms Icon">
            <h1>Lollms VS Coder Help</h1>
        </div>

        <p>Welcome to Lollms VS Coder! This extension integrates a powerful AI assistant directly into your editor. This guide covers its main features, from basic chat to the advanced, self-correcting AI Agent.</p>

        <h2><span class="feature-icon">🤖</span> Agent Mode</h2>
        <p>Agent Mode is the most powerful feature. It allows the AI to create and execute a multi-step plan to achieve a complex objective, like building an entire application from a single prompt. It can create files, write code, run commands, and even correct its own mistakes.</p>
        
        <h3>Activation</h3>
        <ol>
            <li>Open the AI Chat panel.</li>
            <li>Click the <span class="feature-icon">🤖 Agent</span> toggle switch in the input area. The switch will turn blue.</li>
            <li>The agent will confirm its activation and the model it's using.</li>
            <li>Type your objective in the input box (e.g., "build a snake game in python with a virtual environment") and press Enter.</li>
        </ol>

        <h3>The Execution Plan</h3>
        <p>Once you provide an objective, the agent will first create an **Execution Plan**. This is a dynamic list of tasks that will appear in the chat window. The agent will execute these tasks one by one.</p>
        <ul>
            <li><span class="feature-icon">⚪ Pending:</span> The task has not yet started.</li>
            <li><span class="feature-icon">⏳ In Progress:</span> The agent is currently working on this task.</li>
            <li><span class="feature-icon">✅ Completed:</span> The task finished successfully.</li>
            <li><span class="feature-icon">❌ Failed:</span> The task encountered an error.</li>
        </ul>

        <h3>Autonomous Self-Correction</h3>
        <p>When a task fails, the agent will automatically try to fix the problem. It will analyze the error and generate a new set of tasks to correct the mistake. The number of self-correction attempts can be configured in the settings.</p>
        
        <h3>User Intervention</h3>
        <p>If the agent cannot fix a problem on its own after its configured number of retries, it will stop and ask for your help with a dialog box:</p>
        <ul>
            <li><strong>Stop:</strong> Halts the execution of the plan permanently.</li>
            <li><strong>Continue Anyway:</strong> Ignores the error and proceeds to the next task. (Use with caution).</li>
            <li><strong>View Log:</strong> Opens a panel showing the detailed error message (STDOUT/STDERR) from the failed task.</li>
        </ul>

        <h2><span class="feature-icon">💬</span> AI Chat</h2>
        <p>For general-purpose questions, brainstorming, or getting quick code snippets, you can use the standard AI Chat.</p>
        <ul>
            <li><strong>Start a Chat:</strong> Click the <span class="feature-icon">$(comment-discussion) Lollms Chat</span> icon in the status bar.</li>
            <li><strong>Select a Model:</strong> Click the model name (e.g., <span class="feature-icon">$(chip) ollama/mistral</span>) in the status bar to choose from any model available on your Lollms server.</li>
            <li><strong>Discussions:</strong> All chats are saved as "Discussions" in the Lollms sidebar. You can rename, delete, or organize them into groups.</li>
        </ul>

        <h2><span class="feature-icon">💡</span> Code Actions</h2>
        <p>Perform AI-powered actions directly on your code.</p>
        <ol>
            <li>Select a block of code in the editor.</li>
            <li>Click the <strong>Lollms Actions...</strong> CodeLens that appears above it.</li>
            <li>Choose from a list of predefined actions or create a "Custom Prompt..." using the new modal window.</li>
        </ol>

        <h2><span class="feature-icon">🧠</span> AI Context Management</h2>
        <p>Control exactly which files the AI knows about for more accurate responses via the <strong>AI Context Files</strong> view in the Lollms sidebar. Click on any file or folder to cycle through its state.</p>
        
        <h2><span class="feature-icon">⚙️</span> Configuration</h2>
        <p>Click the <span class="feature-icon">$(gear)</span> icon in any Lollms view's title bar to open the settings panel. Here you can configure:</p>
        <ul>
            <li>API Host, API Key, and Model Name.</li>
            <li><strong>Agent Self-Correction Retries:</strong> The number of times the agent will try to fix a failed task before asking for your help.</li>
        </ul>

        <h2><span class="feature-icon">📊</span> Status Bar</h2>
        <p>The status bar provides quick access to key features:</p>
        <div class="status-bar-example">
            <span>...</span>
            <span>$(chip) ollama/mistral</span>
            <span>$(comment-discussion) Lollms Chat</span>
        </div>
        <ul>
            <li><span class="feature-icon">$(chip) Model Name:</span> Click to select a different model for the chat and agent.</li>
            <li><span class="feature-icon">$(comment-discussion) Lollms Chat:</span> Click to open a new chat panel.</li>
        </ul>
        
    </div>
</body>
</html>`;
    }
}