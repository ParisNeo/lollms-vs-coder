import * as vscode from 'vscode';
import { ContextStateProvider, ContextState } from './contextStateProvider';

export class FileDecorationProvider implements vscode.FileDecorationProvider {
    private _onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[]> = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
    readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[]> = this._onDidChangeFileDecorations.event;

    private stateProvider: ContextStateProvider | undefined;
    private disposables: vscode.Disposable[] = [];

    constructor(provider: ContextStateProvider | undefined) {
        this.updateStateProvider(provider);
    }

    public updateStateProvider(provider: ContextStateProvider | undefined) {
        // Dispose of the old listener if it exists
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];

        this.stateProvider = provider;

        if (this.stateProvider) {
            // Correctly listen to the onDidChangeFileDecorations event
            const disposable = this.stateProvider.onDidChangeFileDecorations(e => {
                // When the state provider fires an event, we fire our own to tell VS Code to update decorations
                this._onDidChangeFileDecorations.fire(e);
            });
            this.disposables.push(disposable);
        }
    }

    provideFileDecoration(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<vscode.FileDecoration> {
        if (!this.stateProvider) {
            return undefined;
        }

        const state: ContextState = this.stateProvider.getStateForUri(uri);

        switch (state) {
            case 'included':
                return new vscode.FileDecoration('✓', 'Included in AI Context', new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
            case 'fully-excluded':
                return new vscode.FileDecoration('⊘', 'Excluded from AI Context', new vscode.ThemeColor('gitDecoration.ignoredResourceForeground'));
            case 'collapsed':
                return new vscode.FileDecoration('C', 'Content Hidden (Collapsed)', new vscode.ThemeColor('gitDecoration.submoduleResourceForeground'));
            case 'definitions-only':
                return new vscode.FileDecoration('D', 'Definitions Only (Structure)', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
            case 'tree-only':
            default:
                // No decoration for the default 'tree-only' state
                return undefined;
        }
    }
}
