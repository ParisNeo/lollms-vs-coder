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
            line-height: 1.6;
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
            font-size: 2em;
            font-weight: 300;
        }
        h2 {
            font-size: 1.5em;
            font-weight: 400;
            margin-top: 2em;
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 0.5em;
        }
        h3 {
            font-size: 1.2em;
            margin-top: 1.5em;
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
        kbd {
            background-color: var(--vscode-button-secondaryBackground);
            padding: 0.2em 0.4em;
            border-radius: 4px;
            border: 1px solid var(--vscode-button-secondaryHoverBackground);
        }
        ul {
            padding-left: 20px;
        }
        .feature-icon {
            display: inline-block;
            vertical-align: middle;
            margin-right: 8px;
            font-size: 1.2em;
        }
        .status-bar-example {
            display: flex;
            gap: 15px;
            background-color: var(--vscode-statusBar-background);
            color: var(--vscode-statusBar-foreground);
            padding: 5px 10px;
            border-radius: 5px;
            margin: 1em 0;
            align-items: center;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <img src="${lollmsIconUri}" alt="Lollms Icon">
            <h1>Lollms VS Coder Help</h1>
        </div>

        <p>Welcome to Lollms VS Coder! This extension integrates a powerful AI assistant directly into your editor to help you code smarter and faster. Here's a detailed guide to its features.</p>

        <h2><span class="feature-icon">💬</span> AI Chat</h2>
        <p>The AI Chat is your primary interface for interacting with the assistant.</p>
        <ul>
            <li><strong>Start a Chat:</strong> Click the <span class="feature-icon">$(comment-discussion)</span> icon in the status bar or find the "Discussions" view in the Lollms sidebar and click the <span class="feature-icon">$(add)</span> icon.</li>
            <li><strong>Discussions:</strong> All chats are saved as "Discussions" and listed in the sidebar. You can rename, delete, or organize them into groups.</li>
            <li><strong>Chat Prompts:</strong> Use the "Chat Prompts" view to access a library of predefined prompts. Clicking a prompt will load its content into the chat input box.</li>
        </ul>

        <h2><span class="feature-icon">💡</span> Code Actions</h2>
        <p>Perform AI-powered actions directly on your code.</p>
        <ol>
            <li>Select a block of code in the editor.</li>
            <li>Click the <strong>Lollms Actions...</strong> CodeLens that appears above your selection.</li>
            <li>Choose from a list of predefined actions.</li>
        </ol>
        <p>There are two types of Code Actions:</p>
        <ul>
            <li><strong>Modify Code (e.g., "Refactor Code"):</strong> The AI will suggest changes to your code. A diff view will open, allowing you to review and apply the changes.</li>
            <li><strong>Ask Question about Code (e.g., "Explain Code"):</strong> The AI will provide an answer or explanation in a pop-up message box.</li>
        </ul>

        <h2><span class="feature-icon">✨</span> Inline Autocomplete</h2>
        <p>Get single-line code suggestions as you type or on-demand.</p>
        <h3>Automatic Suggestions (Ghost Text)</h3>
        <p>This feature provides grayed-out suggestions at the end of your current line. It is <strong>disabled by default</strong> to avoid conflicts with other tools.</p>
        <ul>
            <li><strong>To enable:</strong> Go to Settings, search for <code>lollmsVsCoder.enableInlineSuggestions</code>, and check the box. A restart may be required.</li>
            <li><strong>Usage:</strong> Simply start typing, and after a brief pause, the AI will suggest a completion. Press <kbd>Tab</kbd> to accept it.</li>
        </ul>
        <h3>Manual Trigger Button</h3>
        <p>For on-demand suggestions without enabling the automatic feature, use the status bar button.</p>
        <ul>
            <li><strong>Usage:</strong> Place your cursor where you want a suggestion and click the <strong><span class="feature-icon">$(sparkle)</span> Lollms</strong> button in the status bar. The AI will generate and insert a suggestion.</li>
        </ul>
        <div class="status-bar-example">
            <span>Your Status Bar might look like this:</span>
            <span>...</span>
            <span>$(sparkle) Lollms</span>
            <span>$(comment-discussion) Lollms Chat</span>
        </div>

        <h2><span class="feature-icon">🧠</span> AI Context Management</h2>
        <p>Control exactly which files the AI knows about for more accurate responses.</p>
        <ul>
            <li>Find the <strong>AI Context Files</strong> view in the Lollms sidebar.</li>
            <li>Click on any file or folder to cycle through its context state:
                <ul>
                    <li><span class="feature-icon">$(check)</span> <strong>Included:</strong> The file's full content is sent to the AI.</li>
                    <li><span class="feature-icon">$(eye)</span> <strong>Visible:</strong> Only the file's path is sent (AI knows the file exists but not what's inside).</li>
                    <li><span class="feature-icon">$(circle-slash)</span> <strong>Hidden:</strong> The file is completely ignored by the AI.</li>
                </ul>
            </li>
        </ul>

        <h2><span class="feature-icon">📝</span> Prompt Customization</h2>
        <p>Tailor the AI's behavior by creating your own prompts.</p>
        <ul>
            <li><strong>Create/Edit/Delete:</strong> Use the icons in the "Chat Prompts" and "Code Actions" views to manage your custom prompts.</li>
            <li><strong>Default Prompts:</strong> The extension includes a set of useful, undeletable default prompts, marked with a <span class="feature-icon">$(lock)</span> icon.</li>
            <li><strong>Prompt Logic:</strong> Use <code>{{SELECTED_CODE}}</code> in a prompt to automatically include the selected code block.</li>
        </ul>

        <h2><span class="feature-icon">⚙️</span> Configuration</h2>
        <p>Click the <span class="feature-icon">$(settings-gear)</span> icon in the "Discussions" view title bar to open the settings panel, where you can configure your Lollms API URL, API Key, and model name.</p>
    </div>
</body>
</html>`;
    }
}