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
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) return null;

        const selection = editor.selection;
        const line = document.lineAt(selection.start.line);
        
        // Only show hover if the mouse is near the beginning of the selection
        if (position.line === selection.start.line && Math.abs(position.character - selection.start.character) <= 1) {
            const contents = new vscode.MarkdownString();
            contents.isTrusted = true;
            contents.supportHtml = true;
            
            contents.appendMarkdown(`### 👑 Lollms AI\n\n`);
            contents.appendMarkdown(`Click the **Lollms Actions** CodeLens above or use the link below:\n\n`);
            contents.appendMarkdown(`[$(rocket) **OPEN ACTIONS MENU**](command:lollms-vs-coder.showSelectionMenu)\n\n`);
            
            return new vscode.Hover(contents);
        }
        
        return null;
    }
}
