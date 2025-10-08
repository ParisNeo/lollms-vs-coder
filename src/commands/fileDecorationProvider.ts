import * as vscode from 'vscode';
import { ContextStateProvider, ContextState } from './contextStateProvider';

export class FileDecorationProvider implements vscode.FileDecorationProvider {
    private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
    readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[]> = this._onDidChangeFileDecorations.event;

    private contextStateProvider: ContextStateProvider | undefined;
    private stateChangeSubscription: vscode.Disposable | undefined;

    constructor(stateProvider: ContextStateProvider | undefined) {
        this.updateStateProvider(stateProvider);
    }

    public updateStateProvider(stateProvider: ContextStateProvider | undefined) {
        if (this.stateChangeSubscription) {
            this.stateChangeSubscription.dispose();
        }
        this.contextStateProvider = stateProvider;
        if (this.contextStateProvider) {
            this.stateChangeSubscription = this.contextStateProvider.onDidChangeState(uri => this._onDidChangeFileDecorations.fire(uri));
        }
        // Trigger a refresh for all visible editors
        vscode.window.visibleTextEditors.forEach(editor => this._onDidChangeFileDecorations.fire(editor.document.uri));

    }

    async provideFileDecoration(uri: vscode.Uri, token: vscode.CancellationToken): Promise<vscode.FileDecoration | undefined> {
        if (!this.contextStateProvider) {
            return undefined;
        }

        const state = this.contextStateProvider.getStateForUri(uri);

        switch (state) {
            case 'included':
                return new vscode.FileDecoration('✓', 'Included in AI Context', new vscode.ThemeColor('lollms.included'));
            case 'fully-excluded':
                return new vscode.FileDecoration('⊘', 'Excluded from AI Context');
            case 'tree-only':
            default:
                // Return undefined for the default state so no icon is shown, keeping the explorer clean.
                return undefined;
        }
    }
}