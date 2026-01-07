import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

interface DiffState {
    originalFsPath: string;
    generatedFsPath: string;
}

export class DiffManager implements vscode.TextDocumentContentProvider {
    private generatedToOriginal = new Map<string, string>(); // generatedFsPath -> originalFsPath
    private originalToGenerated = new Map<string, string>(); // originalFsPath -> generatedFsPath
    private context: vscode.ExtensionContext | undefined;
    private static readonly STORAGE_KEY = 'lollms_diff_state';

    static readonly SCHEME = 'lollms-diff';

    provideTextDocumentContent(uri: vscode.Uri): string {
        return "";
    }

    public setup(context: vscode.ExtensionContext) {
        this.context = context;
        
        // Restore state
        this.restoreState();

        // Track active editor changes to toggle the buttons in the title bar
        context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
            this.updateContext(editor);
        }));
        
        // Listen for saves on the generated files (Save to Apply)
        context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (doc) => {
            const fsPath = doc.uri.fsPath;
            if (this.generatedToOriginal.has(fsPath)) {
                await this.applyDiffFromSave(doc);
            }
        }));

        // Initial check
        this.updateContext(vscode.window.activeTextEditor);
    }

    private restoreState() {
        if (!this.context) return;
        const stored = this.context.globalState.get<DiffState[]>(DiffManager.STORAGE_KEY, []);
        
        const validStates: DiffState[] = [];
        let changed = false;

        stored.forEach(state => {
            if (fs.existsSync(state.generatedFsPath)) {
                this.generatedToOriginal.set(state.generatedFsPath, state.originalFsPath);
                this.originalToGenerated.set(state.originalFsPath, state.generatedFsPath);
                validStates.push(state);
            } else {
                changed = true;
            }
        });

        if (changed) {
            this.saveState(validStates);
        }
    }

    private saveState(states?: DiffState[]) {
        if (!this.context) return;
        
        if (!states) {
            states = [];
            this.generatedToOriginal.forEach((original, generated) => {
                states!.push({ generatedFsPath: generated, originalFsPath: original });
            });
        }
        
        this.context.globalState.update(DiffManager.STORAGE_KEY, states);
    }

    private updateContext(editor: vscode.TextEditor | undefined) {
        if (!editor) {
            vscode.commands.executeCommand('setContext', 'lollms:isDiffView', false);
            return;
        }

        const fsPath = editor.document.uri.fsPath;
        // Show buttons if we are looking at the generated file OR the original file involved in a diff
        if (this.generatedToOriginal.has(fsPath) || this.originalToGenerated.has(fsPath)) {
            vscode.commands.executeCommand('setContext', 'lollms:isDiffView', true);
        } else {
            vscode.commands.executeCommand('setContext', 'lollms:isDiffView', false);
        }
    }

    /**
     * Checks if a given URI corresponds to a temporary diff file managed by Lollms.
     */
    public isLollmsDiff(uri: vscode.Uri): boolean {
        return this.generatedToOriginal.has(uri.fsPath);
    }

    public getGeneratedFileFor(originalUri: vscode.Uri): vscode.Uri | undefined {
        const genPath = this.originalToGenerated.get(originalUri.fsPath);
        return genPath ? vscode.Uri.file(genPath) : undefined;
    }

    public async openDiff(originalUri: vscode.Uri, newContent: string) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(originalUri);
        if (!workspaceFolder) {
            vscode.window.showErrorMessage("Cannot open diff: file is not in a workspace.");
            return;
        }

        const diffDir = vscode.Uri.joinPath(workspaceFolder.uri, '.lollms', 'diffs');
        try {
            await vscode.workspace.fs.createDirectory(diffDir);
        } catch (e) {
            console.error("Failed to create diff directory (may exist or permission issue):", e);
        }

        const fileName = path.basename(originalUri.fsPath);
        const ext = path.extname(fileName);
        const name = path.basename(fileName, ext);
        const timestamp = Date.now();
        const diffFileName = `${name}_generated_${timestamp}${ext}`;
        const generatedUri = vscode.Uri.joinPath(diffDir, diffFileName);

        try {
            await vscode.workspace.fs.writeFile(generatedUri, Buffer.from(newContent, 'utf8'));
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to write temp file for diff: ${e.message}`);
            return;
        }

        this.generatedToOriginal.set(generatedUri.fsPath, originalUri.fsPath);
        this.originalToGenerated.set(originalUri.fsPath, generatedUri.fsPath);
        this.saveState();

        const title = `${fileName} (Disk) ↔ ${fileName} (Edit Right & Save to Apply)`;
        
        try {
            await vscode.commands.executeCommand('vscode.diff', 
                originalUri, 
                generatedUri, 
                title
            );
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to open VS Code diff view: ${e.message}`);
        }

        setTimeout(() => {
            vscode.commands.executeCommand('setContext', 'lollms:isDiffView', true);
        }, 500);
        
        vscode.window.setStatusBarMessage("Lollms Diff: Edit the right side and Ctrl+S to apply changes.", 5000);
    }

    private async applyDiffFromSave(generatedDoc: vscode.TextDocument) {
        const originalFsPath = this.generatedToOriginal.get(generatedDoc.uri.fsPath);
        if (!originalFsPath) return;

        try {
            const originalUri = vscode.Uri.file(originalFsPath);
            const content = generatedDoc.getText();
            
            await vscode.workspace.fs.writeFile(originalUri, Buffer.from(content, 'utf8'));
            
            vscode.window.showInformationMessage(`Changes applied to ${path.basename(originalFsPath)}`);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to apply changes: ${e.message}`);
        }
    }

    public getOriginalUri(generatedUri: vscode.Uri): vscode.Uri | undefined {
        const originalPath = this.generatedToOriginal.get(generatedUri.fsPath);
        return originalPath ? vscode.Uri.file(originalPath) : undefined;
    }

    public async cleanup(generatedUri: vscode.Uri) {
        const fsPath = generatedUri.fsPath;
        if (this.generatedToOriginal.has(fsPath)) {
            const originalPath = this.generatedToOriginal.get(fsPath);
            this.generatedToOriginal.delete(fsPath);
            if (originalPath) this.originalToGenerated.delete(originalPath);
            
            this.saveState();
            
            // Re-evaluate context
            this.updateContext(vscode.window.activeTextEditor);

            try {
                await vscode.workspace.fs.delete(generatedUri);
            } catch (e) {
                console.error("Failed to delete diff file", e);
            }
        }
    }
}
