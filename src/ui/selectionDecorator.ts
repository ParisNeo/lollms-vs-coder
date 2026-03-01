import * as vscode from 'vscode';
import * as path from 'path';

export class SelectionDecorator {
    private decorationType: vscode.TextEditorDecorationType;
    private extensionUri: vscode.Uri;

    constructor(extensionUri: vscode.Uri) {
        this.extensionUri = extensionUri;

        // Create the decoration type with theme-specific overrides
        this.decorationType = vscode.window.createTextEditorDecorationType({
            // Base properties for the icon inside the text
            before: {
                margin: '0 8px 0 0',
                width: '16px',
                height: '16px',
            },
            // Gutter icon size
            gutterIconSize: 'contain',
            // Light theme overrides
            light: {
                before: {
                    contentIconPath: vscode.Uri.joinPath(this.extensionUri, 'media', 'lollms-icon-light.svg'),
                },
                gutterIconPath: vscode.Uri.joinPath(this.extensionUri, 'media', 'lollms-icon-light.svg'),
            },
            // Dark theme overrides
            dark: {
                before: {
                    contentIconPath: vscode.Uri.joinPath(this.extensionUri, 'media', 'lollms-icon-dark.svg'),
                },
                gutterIconPath: vscode.Uri.joinPath(this.extensionUri, 'media', 'lollms-icon-dark.svg'),
            },
            rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen
        });

        // Update whenever selection changes
        vscode.window.onDidChangeTextEditorSelection(e => this.update(e.textEditor));
    }

    private update(editor: vscode.TextEditor | undefined) {
        if (!editor || editor.selection.isEmpty) {
            editor?.setDecorations(this.decorationType, []);
            return;
        }

        const selection = editor.selection;
        
        // Place the icon at the very start of the selection (first character)
        const decorationRange = new vscode.Range(
            selection.start.line, 
            selection.start.character, 
            selection.start.line, 
            selection.start.character
        );

        editor.setDecorations(this.decorationType, [decorationRange]);
    }

    public dispose() {
        this.decorationType.dispose();
    }
}

/**
 * Hover provider to make the decorated icon "interactive"
 */
export class SelectionHoverProvider implements vscode.HoverProvider {
    public provideHover(
        document: vscode.TextDocument, 
        position: vscode.Position, 
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {
        const contents = new vscode.MarkdownString();
        contents.isTrusted = true;
        contents.supportHtml = true;
        contents.supportIcons = true; // FIX: Enable rendering of $(icon) syntax
        let shouldShow = false;

        // 1. Check for Diagnostic (Error/Warning) under hover
        const diagnostics = vscode.languages.getDiagnostics(document.uri);
        const diag = diagnostics.find(d => d.range.contains(position));
        
        if (diag) {
            contents.appendMarkdown(`### 👑 Lollms AI\n\n`);
            // Serialize the position as an argument to the command
            const args = encodeURIComponent(JSON.stringify([position]));
            contents.appendMarkdown(`[$(sparkle) **Fix this issue with Lollms**](command:lollms-vs-coder.fixDiagnosticAtPosition?${args})\n\n`);
            shouldShow = true;
        }

        // 2. Fallback to existing selection logic if mouse is over a selection
        const editor = vscode.window.activeTextEditor;
        if (editor && !editor.selection.isEmpty && editor.selection.contains(position)) {
            if (!shouldShow) contents.appendMarkdown(`### 👑 Lollms AI\n\n`);
            contents.appendMarkdown(`[$(rocket) **Open Selection Actions**](command:lollms-vs-coder.showSelectionMenu)\n\n`);
            shouldShow = true;
        }
        
        return shouldShow ? new vscode.Hover(contents) : null;
    }
}
