import * as vscode from 'vscode';
import * as path from 'path';

// Defines the possible states for any file or folder in the context.
export type ContextState = 'included' | 'tree-only' | 'fully-excluded';

/**
 * Manages the AI context state (included, excluded, etc.) for all files and folders
 * within the active workspace. It persists this state and applies default exclusions.
 */
export class ContextStateProvider {
    private _onDidChangeState: vscode.EventEmitter<vscode.Uri | undefined> = new vscode.EventEmitter<vscode.Uri | undefined>();
    readonly onDidChangeState: vscode.Event<vscode.Uri | undefined> = this._onDidChangeState.event;

    private state: { [relativePath: string]: ContextState } = {};
    private stateKey!: string;

    // Default folders and files to exclude from the AI context.
    // FIX: Added '.lollms' to the default list of excluded folders.
    private readonly defaultExcludedFolders = new Set(['.git', 'node_modules', '.vscode', '.lollms']);
    private readonly defaultExcludedFiles = new Set(['.gitignore', '.DS_Store', 'package-lock.json']);

    constructor(private workspaceRoot: string, private context: vscode.ExtensionContext) {
        this.updateStateKey();
        this.loadStateAndApplyDefaults();
    }

    /**
     * Switches to a new workspace, loading its specific context state.
     * @param newWorkspaceRoot The file system path of the new workspace root.
     */
    public async switchWorkspace(newWorkspaceRoot: string) {
        this.workspaceRoot = newWorkspaceRoot;
        this.updateStateKey();
        await this.loadStateAndApplyDefaults();
        this._onDidChangeState.fire(undefined); // Notify decorators to refresh for the new workspace
    }
    
    private updateStateKey() {
        this.stateKey = `context-state-${this.workspaceRoot}`;
    }

    /**
     * Loads the saved context state from workspace storage and applies
     * default exclusions for any files/folders that don't have a state set.
     * This ensures new projects and newly added default patterns are handled correctly.
     */
    private async loadStateAndApplyDefaults() {
        this.state = this.context.workspaceState.get(this.stateKey) || {};
        
        // FIX: Ensure default exclusions are applied at startup.
        const workspaceUri = vscode.Uri.file(this.workspaceRoot);
        try {
            const entries = await vscode.workspace.fs.readDirectory(workspaceUri);
            let stateChanged = false;

            for (const [name, type] of entries) {
                const relativePath = name; // At the root, the name is the relative path.
                
                // Only apply default if the user hasn't already set a state for this item.
                if (this.state[relativePath] === undefined) {
                    const isFolder = type === vscode.FileType.Directory;
                    const isFile = type === vscode.FileType.File;

                    if ((isFolder && this.defaultExcludedFolders.has(name)) || (isFile && this.defaultExcludedFiles.has(name))) {
                        this.state[relativePath] = 'fully-excluded';
                        stateChanged = true;
                    }
                }
            }
            if (stateChanged) {
                await this.saveState();
            }
        } catch (error) {
            console.error(`Lollms: Failed to read workspace directory to apply default exclusions: ${error}`);
        }
    }

    private async saveState() {
        await this.context.workspaceState.update(this.stateKey, this.state);
    }
    
    /**
     * Gets the current context state for a given file URI.
     * @param uri The URI of the file or folder.
     * @returns The current ContextState. Defaults to 'tree-only'.
     */
    public getStateForUri(uri: vscode.Uri): ContextState {
        const relativePath = path.relative(this.workspaceRoot, uri.fsPath);
        return this.state[relativePath] || 'tree-only';
    }

    /**
     * Sets the context state for a given URI and persists the change.
     * @param uri The URI of the file or folder to update.
     * @param newState The new state to set.
     */
    public async setStateForUri(uri: vscode.Uri, newState: ContextState) {
        const relativePath = path.relative(this.workspaceRoot, uri.fsPath);
        if (this.state[relativePath] !== newState) {
            this.state[relativePath] = newState;
            await this.saveState();
            this._onDidChangeState.fire(uri);
        }
    }
    
    /**
     * Retrieves all files that are explicitly marked as 'included'.
     * @returns An array of relative file paths.
     */
    public getIncludedFiles(): string[] {
        return Object.entries(this.state)
            .filter(([, state]) => state === 'included')
            .map(([relativePath]) => relativePath);
    }

    /**
     * Retrieves all files and folders that are not fully excluded.
     * @returns An array of relative paths.
     */
    public async getAllVisibleFiles(): Promise<string[]> {
        const visibleFiles: string[] = [];
        const workspaceUri = vscode.Uri.file(this.workspaceRoot);
        
        const walk = async (dir: vscode.Uri) => {
            const relativeDir = path.relative(this.workspaceRoot, dir.fsPath);
            if (this.getStateForUri(dir) === 'fully-excluded') {
                return;
            }
            if (relativeDir) { // Don't add the root itself
                visibleFiles.push(relativeDir);
            }

            try {
                const entries = await vscode.workspace.fs.readDirectory(dir);
                for (const [name, type] of entries) {
                    const entryUri = vscode.Uri.joinPath(dir, name);
                    const relativePath = path.relative(this.workspaceRoot, entryUri.fsPath);
    
                    if (this.state[relativePath] === 'fully-excluded') {
                        continue;
                    }
    
                    if (type === vscode.FileType.Directory) {
                        await walk(entryUri);
                    } else {
                        visibleFiles.push(relativePath);
                    }
                }
            } catch (error) {
                // Ignore errors for directories that can't be read, etc.
            }
        };

        await walk(workspaceUri);
        return visibleFiles;
    }
}