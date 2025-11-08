import * as vscode from 'vscode';

export class HelpPanel {
    public static currentPanel: HelpPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode._Uri;

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
        code, pre { font-family: var(--vscode-editor-font-family); background-color: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-textBlockQuote-border); padding: 0.2em 0.4em; border-radius: 4px; }
        pre { padding: 1em; white-space: pre-wrap; word-wrap: break-word; }
        .codicon { font-family: "codicon"; display: inline-block; vertical-align: middle; font-size: 1.1em; margin-right: 5px;}
        .key-feature { font-weight: 600; color: var(--vscode-textLink-foreground); }
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
            <img src="${lollmsIconUri.toString()}" alt="Lollms Icon">
            <h1>Lollms VS Coder Help</h1>
        </div>

        <p>Welcome! This guide provides a detailed overview of all features available in the Lollms VS Coder extension, from basic chat to the advanced, self-correcting AI Agent.</p>

        <h2><span class="codicon codicon-book"></span>Core Concepts</h2>

        <h3><span class="codicon codicon-comment-discussion"></span>The AI Chat Panel</h3>
        <p>The chat panel is your central hub for interacting with Lollms. Start a new chat from the <strong>Discussions</strong> view in the Lollms sidebar. Here, you can ask questions, request code, and give high-level objectives to the AI.</p>

        <h3><span class="codicon codicon-robot"></span>Agent Mode</h3>
        <p>This is the most powerful feature. When you toggle <strong><span class="key-feature">🤖 Agent Mode</span></strong> on, you're giving the AI an objective to complete. The AI will:</p>
        <ol>
            <li><strong>Formulate a Plan</strong>: It creates a step-by-step plan which is displayed in the chat window.</li>
            <li><strong>Execute Tasks</strong>: It executes each task, which can include creating files, running shell commands, or generating code with sub-agents.</li>
            <li><strong>Self-Correct</strong>: If a task fails (e.g., a script has an error), the agent analyzes the failure and revises its plan to fix the mistake.</li>
        </ol>

        <h3><span class="codicon codicon-brain"></span>AI Context Management</h3>
        <p>The <strong>AI Context Files</strong> view in the sidebar gives you precise control over what project information the AI sees. Click any file or folder to cycle its state:</p>
        <ul>
            <li><span style="color: var(--vscode-gitDecoration-addedResourceForeground);"><strong>✓ Included</strong></span>: The file's path AND its full content are sent to the AI.</li>
            <li><strong>□ Tree-Only (Default)</strong>: Only the file's path is included in the project tree structure. Its content is hidden, saving tokens.</li>
            <li><span style="color: var(--vscode-gitDecoration-ignoredResourceForeground);"><strong>⊘ Excluded</strong></span>: The file or folder is completely hidden from the AI.</li>
        </ul>
        <blockquote>Use the <strong><span class="codicon codicon-wand"></span> Auto-Select Context</strong> button in the 'Actions' view to have the AI intelligently pick the most relevant files for an objective.</blockquote>

        <h2><span class="codicon codicon-tools"></span>Detailed Feature Guide</h2>

        <h3>Interacting with AI Responses in Chat</h3>
        <p>The AI can generate special, interactive blocks in its responses.</p>
        <ul>
            <li><strong><span class="codicon codicon-play"></span>Execute Scripts</strong>: Code blocks for shell scripts (Python, Bash, PowerShell) have an <strong>Execute</strong> button. This runs the script, and the output is automatically fed back to the AI for analysis.</li>
            <li><strong><span class="codicon codicon-search"></span>Inspect Code</strong>: Check AI-generated code for bugs and vulnerabilities. The inspector can auto-fix minor issues or provide detailed warnings.</li>
            <li><strong><span class="codicon codicon-circuit-board"></span>Render Diagrams</strong>: If the AI returns a code block with the language <code>svg</code> or <code>mermaid</code>, it will be automatically rendered as a visual diagram directly in the chat.</li>
            <li><strong><span class="codicon codicon-device-camera"></span>Generate Images</strong>: An <code>image_prompt</code> block prefixed with a file path will show a <strong><span class="codicon codicon-sparkle"></span>Generate</strong> button to create the image and save it to your project.</li>
        </ul>
        
        <h3>Advanced File Operations</h3>
        <p>The AI can perform file operations by generating special code blocks. The method it chooses can be configured in the settings under <code>File Update Method</code>.</p>
        <ul>
            <li><strong>Full File Updates</strong>: Signaled with a <code>File: path/to/file.ext</code> line above a code block. Clicking the <strong><span class="codicon codicon-tools"></span>Apply to File</strong> button will show a diff view before overwriting the file.</li>
            <li><strong>Applying Diffs/Patches</strong>: Signaled with a <code>Diff: path/to/file.ext</code> or <code>Patch: ...</code> line. Clicking <strong><span class="codicon codicon-tools"></span>Apply Patch</strong> will apply the changes to the existing file.</li>
            <li><strong>Renaming/Moving Files</strong>: The AI can request a file rename or move by generating a <code>rename</code> code block. A <strong><span class="codicon codicon-git-compare"></span>Move/Rename</strong> button will appear.
                <pre><code>\`\`\`rename
path/to/old_file.ext -> path/to/new_file.ext
\`\`\`</code></pre>
            </li>
            <li><strong>Deleting Files</strong>: The AI can request file deletions by generating a <code>delete</code> code block. A <strong><span class="codicon codicon-trash"></span>Delete</strong> button will appear, which will prompt for confirmation.
                <pre><code>\`\`\`delete
path/to/file_to_delete.ext
another/file/to_delete.js
\`\`\`</code></pre>
            </li>
            <li><strong>Requesting Context</strong>: If the AI needs to see files that are not in its context, it can generate a <code>select</code> block. A <strong><span class="codicon codicon-add"></span>Add to Context</strong> button will appear.
                <pre><code>\`\`\`select
src/api/auth.ts
src/utils/database.ts
\`\`\`</code></pre>
            </li>
        </ul>

        <h3>The "More Actions" <code>...</code> Menu</h3>
        <p>This menu, located to the left of the chat input, provides powerful project-level commands:</p>
        <ul>
            <li><strong><span class="codicon codicon-add"></span>Attach Files</strong>: Manually provide files (including text and images) to the AI for analysis.</li>
            <li><strong><span class="codicon codicon-target"></span>Set Project Entry Point</strong>: Define the main executable file (<code>.js</code>, <code>.py</code>, etc.) for your project. This is used by the "Execute Project" command.</li>
            <li><strong><span class="codicon codicon-play-circle"></span>Execute Project</strong>: Runs your project using the configured entry point. If it fails, the AI automatically analyzes the error output and suggests a fix.</li>
        </ul>

        <h2><span class="codicon codicon-lightbulb"></span>In-Editor Tools</h2>
        <ul>
            <li><strong>Code Actions</strong>: Select code in the editor, click the <code>Lollms Actions...</code> CodeLens that appears, and choose from default actions (Explain, Refactor, Find Bugs, Generate Docs) or trigger your own custom prompts.</li>
            <li><strong>Inline Autocomplete</strong>: Enable "ghost text" suggestions in the extension settings for real-time, single-line code completion as you type.</li>
            <li><strong>Jupyter Notebooks</strong>: When a <code>.ipynb</code> file is active, use the icons in the cell toolbar to <strong><span class="codicon codicon-sparkle"></span>Enhance Cell</strong> (refactor) or <strong><span class="codicon codicon-wand"></span>Generate Next Cell</strong>.</li>
            <li><strong>Debugging</strong>: When an exception occurs during a debug session, Lollms automatically captures it. Buttons will appear in the debug toolbar and as a CodeLens above the error line, allowing you to send the error directly to the AI for analysis.</li>
        </ul>

        <h2><span class="codicon codicon-sidebar-left"></span>Sidebar Views & Git</h2>
        <ul>
            <li><strong>Git Commit Messages</strong>: Click the Lollms icon in the Source Control panel's title bar to generate a conventional commit message based on your changes.</li>
            <li><strong>Sidebar Views</strong>: The Lollms sidebar organizes all features into collapsible views:
                <ul>
                    <li><strong>Actions:</strong> Global commands like Settings, Help, and context management.</li>
                    <li><strong>Discussions:</strong> Manage all your chat histories, including creating temporary chats and organizing them into groups.</li>
                    <li><strong>Code Explorer:</strong> Visualize your project's structure as an interactive graph.</li>
                    <li><strong>Skills:</strong> Save and reuse important code snippets or instructions.</li>
                    <li><strong>Prompts:</strong> Create and manage your library of custom prompts.</li>
                    <li><strong>Running Processes:</strong> View and cancel any active AI tasks.</li>
                </ul>
            </li>
        </ul>
        
    </div>
</body>
</html>`;
    }
}