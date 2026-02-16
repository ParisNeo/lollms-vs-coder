import * as vscode from 'vscode';

/**
 * Provides a CodeLens above any active text selection to offer quick Lollms actions.
 */
export class SelectionCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    constructor() {
        // Refresh the CodeLens whenever the selection changes so it follows the user's cursor
        vscode.window.onDidChangeTextEditorSelection(() => {
            this._onDidChangeCodeLenses.fire();
        });
    }

    public provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document !== document) {
            return [];
        }

        const selection = editor.selection;
        // Only show if there's a non-empty selection
        if (selection.isEmpty) {
            return [];
        }

        // Place the CodeLens on the line where the selection starts
        const range = new vscode.Range(selection.start.line, 0, selection.start.line, 0);
        
        return [
            new vscode.CodeLens(range, {
                title: "$(robot) Lollms Actions",
                command: "lollms-vs-coder.showSelectionMenu",
                tooltip: "Click to open Lollms AI Actions"
            })
        ];
    }
}
