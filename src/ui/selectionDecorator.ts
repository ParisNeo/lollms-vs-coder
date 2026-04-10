import * as vscode from 'vscode';
import * as path from 'path';

export class SelectionDecorator {
    private decorationType: vscode.TextEditorDecorationType;
    private extensionUri: vscode.Uri;

    constructor(extensionUri: vscode.Uri) {
        this.extensionUri = extensionUri;

        // Create the decoration type with theme-specific overrides
        // Using only gutter icon - no inline decoration to avoid tab-like appearance
        this.decorationType = vscode.window.createTextEditorDecorationType({
            // Gutter icon only - appears in the left margin, not inline
            gutterIconSize: 'contain',
            // Light theme overrides
            light: {
                gutterIconPath: vscode.Uri.joinPath(this.extensionUri, 'media', 'lollms-icon-light.svg'),
            },
            // Dark theme overrides
            dark: {
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
        const contents = new vscode.MarkdownString('', true);
        contents.isTrusted = true;
        contents.supportHtml = true;
        let shouldShow = false;

        // 1. Check for Diagnostic (Error/Warning) under hover
        const diagnostics = vscode.languages.getDiagnostics(document.uri);
        const diag = diagnostics.find(d => d.range.contains(position));
        
        if (diag) {
            contents.appendMarkdown(`### 👑 Lollms AI\n\n`);
            const args = encodeURIComponent(JSON.stringify([position]));
            contents.appendMarkdown(`[✨ **Fix this issue with Lollms**](command:lollms-vs-coder.fixDiagnosticAtPosition?${args})\n\n`);
            shouldShow = true;
        }

        // 2. Check for Symbol Definition (The New Hover HUD)
        // We look for words that look like class/function definitions on the current line
        const lineText = document.lineAt(position.line).text;
        const symbolMatch = lineText.match(/(?:class|function|def)\s+([a-zA-Z0-9_]+)/);
        const wordRange = document.getWordRangeAtPosition(position);
        
        if (symbolMatch && wordRange && symbolMatch[0].includes(document.getText(wordRange))) {
            if (!shouldShow) contents.appendMarkdown(`### 👑 Lollms AI\n\n`);
            const symbolName = symbolMatch[1];
            // Mocking the symbol info for the existing command
            const symbolInfo = { 
                name: symbolName, 
                location: { range: new vscode.Range(position.line, 0, position.line, lineText.length) } 
            };
            const args = encodeURIComponent(JSON.stringify([document.uri, symbolInfo]));
            const graphArgs = encodeURIComponent(JSON.stringify([{ label: symbolName, type: symbolMatch[0].split(' ')[0] }]));
            
            contents.appendMarkdown(`[✨ **Lollms HUD: Analyze ${symbolName}**](command:lollms-vs-coder.triggerSurgicalInsight?${args})\n\n`);
            contents.appendMarkdown(`[📊 **Locate in Architecture Graph**](command:lollms-vs-coder.findInGraph?${graphArgs})\n\n`);
            
            shouldShow = true;
        }

        // 3. Fallback to selection logic
        const editor = vscode.window.activeTextEditor;
        if (editor && !editor.selection.isEmpty && editor.selection.contains(position)) {
            if (!shouldShow) contents.appendMarkdown(`### 👑 Lollms AI\n\n`);
            contents.appendMarkdown(`[$(rocket) **Open Selection Actions**](command:lollms-vs-coder.showSelectionMenu)\n\n`);
            shouldShow = true;
        }
        
        return shouldShow ? new vscode.Hover(contents) : null;
    }
}
