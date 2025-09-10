import * as vscode from 'vscode';

export class CodeActionProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    constructor() {
        vscode.workspace.onDidChangeConfiguration(() => {
            this._onDidChangeCodeLenses.fire();
        });
        
        vscode.window.onDidChangeTextEditorSelection(() => {
            this._onDidChangeCodeLenses.fire();
        });
    }

    public provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
        const isEnabled = vscode.workspace.getConfiguration('lollmsVsCoder').get('enableCodeActions');
        if (!isEnabled) {
            return [];
        }

        const codeLenses: vscode.CodeLens[] = [];
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === document && !editor.selection.isEmpty) {
            // Place the CodeLens on the first line of the selection
            const startPosition = editor.selection.start;
            const range = new vscode.Range(startPosition, startPosition);
            
            const command: vscode.Command = {
                title: "$(lollms-icon) Lollms Actions...",
                command: "lollms-vs-coder.triggerCodeAction",
                tooltip: "Apply a Lollms AI action to the selected code"
            };
            codeLenses.push(new vscode.CodeLens(range, command));
        }
        return codeLenses;
    }
}