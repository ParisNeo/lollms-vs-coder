import * as vscode from 'vscode';
import { DiffManager } from '../diffManager';

export class DiffCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    constructor(private diffManager: DiffManager) {}

    public refresh() {
        this._onDidChangeCodeLenses.fire();
    }
    
    public provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
        // Only provide lenses for files managed by DiffManager
        if (!this.diffManager.isLollmsDiff(document.uri)) {
            return [];
        }

        // Create a range at the very top of the file
        const range = new vscode.Range(0, 0, 0, 0);
        
        const acceptCmd: vscode.Command = {
            title: '✅ Accept Changes',
            command: 'lollms-vs-coder.acceptDiff',
            arguments: [document.uri],
            tooltip: 'Apply these changes to the original file on disk'
        };

        const rejectCmd: vscode.Command = {
            title: '❌ Reject',
            command: 'lollms-vs-coder.rejectDiff',
            arguments: [document.uri],
            tooltip: 'Discard these changes'
        };

        return [
            new vscode.CodeLens(range, acceptCmd),
            new vscode.CodeLens(range, rejectCmd)
        ];
    }
}
