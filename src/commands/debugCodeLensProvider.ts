import * as vscode from 'vscode';

// A simplified version of the debug error manager for demonstration
interface DebugErrorManager {
    lastError: {
        message: string;
        stack?: string;
        filePath?: vscode.Uri;
        line?: number;
    } | null;
    onDidChange: vscode.Event<void>;
}


export class DebugCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;
    private debugErrorManager: DebugErrorManager;

    constructor(debugErrorManager: DebugErrorManager) {
        this.debugErrorManager = debugErrorManager;
        this.debugErrorManager.onDidChange(() => {
            this._onDidChangeCodeLenses.fire();
        });
    }

    public provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
        const lenses: vscode.CodeLens[] = [];
        const error = this.debugErrorManager.lastError;

        if (error && error.filePath && error.filePath.fsPath === document.uri.fsPath && error.line) {
            const line = error.line - 1; // line is 1-based, VS Code API is 0-based
            if (line >= 0 && line < document.lineCount) {
                const range = document.lineAt(line).range;

                const fixCommand: vscode.Command = {
                    title: 'Lollms: Fix This Error',
                    command: 'lollms-vs-coder.debugErrorWithAI',
                    tooltip: 'Ask Lollms to generate a fix for this error in a new discussion.'
                };
                lenses.push(new vscode.CodeLens(range, fixCommand));

                const sendCommand: vscode.Command = {
                    title: 'Lollms: Send to Discussion',
                    command: 'lollms-vs-coder.debugErrorSendToDiscussion',
                    tooltip: 'Send this error to the current Lollms discussion.'
                };
                lenses.push(new vscode.CodeLens(range, sendCommand));
            }
        }
        return lenses;
    }
}