import * as vscode from 'vscode';
import { ContextStateProvider, ContextState } from './contextStateProvider';

/**
 * Provides file decorations (badges, tooltips) in the Explorer view
 * to indicate the AI context state of files and folders.
 */
export class FileDecorationProvider implements vscode.FileDecorationProvider {
    private _onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined> = new vscode.EventEmitter();
    readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[] | undefined> = this._onDidChangeFileDecorations.event;
    private disposable: vscode.Disposable | undefined;

    constructor(private stateProvider: ContextStateProvider | undefined) {
        if (this.stateProvider) {
            this.disposable = this.stateProvider.onDidChangeState((uri) => this._onDidChangeFileDecorations.fire(uri));
        }
    }

    /**
     * Called by the extension's activation logic to link this decoration provider
     * with the state management provider.
     * @param provider The active ContextStateProvider.
     */
    public updateStateProvider(provider: ContextStateProvider) {
        if (this.disposable) {
            this.disposable.dispose();
        }
        
        this.stateProvider = provider;
        
        if (this.stateProvider) {
            this.disposable = this.stateProvider.onDidChangeState((uri) => {
                this._onDidChangeFileDecorations.fire(uri);
            });
        }
        
        // FIX: When the provider is updated (e.g., on startup or workspace switch),
        // fire an event to tell VS Code to refresh all visible file decorations.
        // This ensures the UI is immediately consistent with the current state.
        this._onDidChangeFileDecorations.fire(undefined); 
    }
    
    /**
     * Provides the decoration for a given file URI.
     * @param uri The URI of the file or folder to decorate.
     * @returns A FileDecoration object or undefined if no decoration is needed.
     */
    public async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
        // Don't decorate if we don't have a state provider or the file isn't in the workspace
        if (!this.stateProvider || !vscode.workspace.getWorkspaceFolder(uri)) {
            return undefined;
        }

        const state = this.stateProvider.getStateForUri(uri);

        switch (state) {
            case 'included':
                return new vscode.FileDecoration('✓', 'Included in AI Context', new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
            case 'fully-excluded':
                return new vscode.FileDecoration('⊘', 'Excluded from AI Context', new vscode.ThemeColor('gitDecoration.ignoredResourceForeground'));
            case 'tree-only':
            default:
                // The default state has no decoration.
                return undefined; 
        }
    }
}