import * as vscode from 'vscode';
import * as path from 'path';

export type ContextState = 'included' | 'tree-only' | 'fully-excluded';

// Set of default folder/file names to exclude. This is much more efficient than glob patterns for a simple name check.
const DEFAULT_EXCLUSIONS = new Set([
    '.git', '.vscode', '__pycache__', 'node_modules', 'venv', '.venv', 
    'dist', 'build', 'out', 'bin', 'obj', 'target'
]);

export class ContextStateProvider {
    private contextState: { [uri: string]: ContextState } = {};
    private workspaceRoot: string;
    private context: vscode.ExtensionContext;
    private stateKey: string;

    private _onDidChangeState = new vscode.EventEmitter<vscode.Uri>();
    public readonly onDidChangeState: vscode.Event<vscode.Uri> = this._onDidChangeState.event;

    constructor(workspaceRoot: string, context: vscode.ExtensionContext) {
        this.workspaceRoot = workspaceRoot;
        this.context = context;
        this.stateKey = `context-state-${this.workspaceRoot}`;
        this.loadState();
    }

    public async switchWorkspace(newWorkspaceRoot: string) {
        await this.saveState();
        this.workspaceRoot = newWorkspaceRoot;
        this.stateKey = `context-state-${this.workspaceRoot}`;
        this.loadState();
        this._onDidChangeState.fire(vscode.Uri.file(this.workspaceRoot)); 
    }

    private loadState() {
        this.contextState = this.context.workspaceState.get(this.stateKey) || {};
    }

    private async saveState() {
        await this.context.workspaceState.update(this.stateKey, this.contextState);
    }

    /**
     * Gets the effective state of a URI by checking for explicit states, parent exclusions, and default exclusions.
     */
    public getStateForUri(uri: vscode.Uri): ContextState {
        const relativePath = path.relative(this.workspaceRoot, uri.fsPath);

        // 1. Check for an exact explicit state on the item itself.
        if (this.contextState[relativePath]) {
            return this.contextState[relativePath];
        }

        // 2. Traverse upwards to see if any parent directory is explicitly excluded.
        let parent = path.dirname(relativePath);
        while (parent !== '.' && parent !== '') {
            if (this.contextState[parent] === 'fully-excluded') {
                return 'fully-excluded';
            }
            parent = path.dirname(parent);
        }
        
        // 3. Check if the item's base name is in the default exclusion set.
        const baseName = path.basename(relativePath);
        if (DEFAULT_EXCLUSIONS.has(baseName)) {
            return 'fully-excluded';
        }

        // 4. If no other rule applies, it's in the default 'tree-only' state.
        return 'tree-only';
    }

    /**
     * Sets the state for a URI. If a directory is excluded, it efficiently marks only that directory
     * and cleans up any redundant states for its children.
     */
    public async setStateForUri(uri: vscode.Uri, state: ContextState) {
        const stat = await vscode.workspace.fs.stat(uri);
        const relativePath = path.relative(this.workspaceRoot, uri.fsPath);

        // **OPTIMIZATION**: If excluding a directory, just mark the directory itself.
        if (state === 'fully-excluded' && stat.type === vscode.FileType.Directory) {
            this.contextState[relativePath] = state;
            
            // For efficiency and cleanliness, remove any pre-existing explicit states for children.
            for (const key in this.contextState) {
                if (key.startsWith(relativePath + path.sep)) {
                    delete this.contextState[key];
                }
            }
        } else if (state === 'tree-only') {
            // If setting back to default, just remove the explicit state.
            delete this.contextState[relativePath];
        } else {
             // For files, or for setting 'included' state on directories.
             this.contextState[relativePath] = state;
        }

        await this.saveState();
        this._onDidChangeState.fire(uri);
    }

    /**
     * Creates a glob pattern string for use with vscode.workspace.findFiles.
     * This pattern combines default exclusions and user-defined exclusions.
     */
    private _getExcludeGlob(): string {
        const excludedPatterns: string[] = [];
        
        // Add default exclusion patterns.
        DEFAULT_EXCLUSIONS.forEach(folder => {
            excludedPatterns.push(`**/${folder}`);
        });

        // Add user-defined folder exclusions from the state.
        for (const relativePath in this.contextState) {
            if (this.contextState[relativePath] === 'fully-excluded') {
                excludedPatterns.push(relativePath);
            }
        }
        
        // Format for the glob pattern.
        return `{${excludedPatterns.join(',')}}`;
    }

    /**
     * Gets all files in the workspace that are not excluded by default or by user settings.
     * This uses VS Code's fast file search API.
     */
    public async getAllVisibleFiles(): Promise<string[]> {
        const excludeGlob = this._getExcludeGlob();
        const files = await vscode.workspace.findFiles('**/*', excludeGlob);
        return files.map(file => path.relative(this.workspaceRoot, file.fsPath).replace(/\\/g, '/'));
    }

    /**
     * Returns a list of all files that are explicitly marked as 'included'.
     */
    public getIncludedFiles(): string[] {
        const includedFiles: string[] = [];
        for (const relativePath in this.contextState) {
            // Ensure a parent isn't excluded, just in case of stale state.
            const parentIsExcluded = () => {
                let parent = path.dirname(relativePath);
                while (parent !== '.' && parent !== '') {
                    if (this.contextState[parent] === 'fully-excluded') return true;
                    parent = path.dirname(parent);
                }
                return false;
            };

            if (this.contextState[relativePath] === 'included' && !parentIsExcluded()) {
                includedFiles.push(relativePath);
            }
        }
        return includedFiles;
    }

    public async addFilesToContext(fileList: string[]) {
        for (const filePath of fileList) {
            this.contextState[filePath] = 'included';
        }
        await this.saveState();
        // Fire a generic change event for the root, signaling a widespread change.
        this._onDidChangeState.fire(vscode.Uri.file(this.workspaceRoot));
    }
}