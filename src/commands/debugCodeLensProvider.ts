import * as vscode from 'vscode';

// A simplified interface to decouple the provider from the main extension file
export interface DebugErrorManager {
    lastError: { filePath?: vscode.Uri; line?: number; } | null;
    onDidChange: vscode.Event<void>;
}

export class DebugCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    constructor(private debugErrorManager: DebugErrorManager) {
        // When the error manager signals a change (error captured or cleared), we tell VS Code to refresh CodeLenses
        this.debugErrorManager.onDidChange(() => {
            this._onDidChangeCodeLenses.fire();
        });
    }

    public provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] {
        const errorInfo = this.debugErrorManager.lastError;
        
        // No error, or error has no file info, so no CodeLens
        if (!errorInfo || !errorInfo.filePath || !errorInfo.line) {
            return [];
        }

        // Check if the current document is the one with the error
        if (document.uri.fsPath !== errorInfo.filePath.fsPath) {
            return [];
        }

        // Line number from debug adapter is 1-based, VS Code's Position is 0-based
        const errorLine = errorInfo.line - 1;
        if (errorLine < 0 || errorLine >= document.lineCount) {
            return [];
        }

        const range = document.lineAt(errorLine).range;
        const command: vscode.Command = {
            title: '$(lightbulb-sparkle) Lollms: Fix This Error',
            command: 'lollms-vs-coder.debugErrorWithAI',
            tooltip: 'Ask Lollms to analyze this error and suggest a fix.'
        };

        return [new vscode.CodeLens(range, command)];
    }
}