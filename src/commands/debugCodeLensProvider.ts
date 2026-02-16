import * as vscode from 'vscode';

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
        
        // Refresh lenses when a runtime debug error occurs
        this.debugErrorManager.onDidChange(() => {
            this._onDidChangeCodeLenses.fire();
        });

        // Refresh lenses when static diagnostics (errors/warnings) change
        vscode.languages.onDidChangeDiagnostics(() => {
            this._onDidChangeCodeLenses.fire();
        });
    }

    public provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
        const lenses: vscode.CodeLens[] = [];

        // Ignore documents in the diffs directory or markers to avoid UI clutter
        const fsPath = document.uri.fsPath;
        if (fsPath.includes('.lollms') && (fsPath.includes('diffs') || fsPath.includes('temp_scripts'))) {
            return [];
        }

        // 1. Runtime Debug Errors (from Debug Session)
        const error = this.debugErrorManager.lastError;
        if (error && error.filePath && error.filePath.fsPath === document.uri.fsPath && error.line) {
            const line = error.line - 1; 
            if (line >= 0 && line < document.lineCount) {
                const range = document.lineAt(line).range;

                const fixCommand: vscode.Command = {
                    title: '$(sparkle) Fix Runtime Error with Lollms',
                    command: 'lollms-vs-coder.debugErrorWithAI',
                    tooltip: 'Ask Lollms to analyze and fix this exception using full project context.'
                };
                lenses.push(new vscode.CodeLens(range, fixCommand));

                const sendCommand: vscode.Command = {
                    title: '$(send) Send to Discussion',
                    command: 'lollms-vs-coder.debugErrorSendToDiscussion',
                    tooltip: 'Send this error details to the active Lollms discussion.'
                };
                lenses.push(new vscode.CodeLens(range, sendCommand));
            }
        }

        // 2. Static Diagnostics (Red Squiggles from Language Server)
        const diagnostics = vscode.languages.getDiagnostics(document.uri);
        for (const diagnostic of diagnostics) {
            // Only show CodeLens for Errors to avoid cluttering warnings
            if (diagnostic.severity === vscode.DiagnosticSeverity.Error) {
                // Ensure the CodeLens is attached to the start of the error range
                const range = new vscode.Range(diagnostic.range.start, diagnostic.range.end);
                
                const fixStaticCommand: vscode.Command = {
                    title: `$(sparkle) Fix with Lollms`,
                    command: 'lollms-vs-coder.fixDiagnostic',
                    arguments: [document.uri, diagnostic],
                    tooltip: `Ask Lollms to fix: ${diagnostic.message}`
                };
                
                lenses.push(new vscode.CodeLens(range, fixStaticCommand));
            }
        }

        return lenses;
    }
}
