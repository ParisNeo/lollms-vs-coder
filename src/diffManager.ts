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
    private generatedToDiscussionId = new Map<string, string>(); // generatedFsPath -> discussionId
    // Caches the user's active cursor selection and scroll viewport position before launching the diff
    private lastPositions = new Map<string, { selection: vscode.Selection, visibleRange: vscode.Range }>();
    private context: vscode.ExtensionContext | undefined;
    private static readonly STORAGE_KEY = 'lollms_diff_state';

    static readonly SCHEME = 'lollms-diff';

    provideTextDocumentContent(uri: vscode.Uri): string {
        return "";
    }

    public async setup(context: vscode.ExtensionContext) {
        this.context = context;
        
        // Restore state
        this.restoreState();
        
        // GC: Purge files from disk that aren't in our current memory state (orphans from previous crashes)
        await this.purgeOrphanedDiffs();

        // Track active editor changes to toggle the buttons in the title bar
        context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
            this.updateContext(editor);
        }));
        
        // Listen for saves on the generated files (Save to Apply)
        context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (doc) => {
            const fsPath = doc.uri.fsPath;
            if (this.generatedToOriginal.has(fsPath)) {
                const discussionId = this.generatedToDiscussionId.get(fsPath);
                const originalPath = this.generatedToOriginal.get(fsPath);
                const applied = await this.applyDiffFromSave(doc);
                if (applied) {
                    // 1. Close the diff tab
                    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

                    // 2. Restore active editor position
                    if (originalPath) {
                        const originalUri = vscode.Uri.file(originalPath);
                        await this.restoreEditorPosition(originalUri);
                    }

                    // 3. Reveal the discussion panel if we have a reference
                    if (discussionId) {
                        const { ChatPanel } = require('./commands/chatPanel/chatPanel');
                        const panel = ChatPanel.panels.get(discussionId);
                        if (panel) {
                            panel._panel.reveal();
                            // Notify webview to collapse all blocks associated with the saved file path
                            const relativeSavedPath = vscode.workspace.asRelativePath(originalUri);
                            panel._panel.webview.postMessage({
                                command: 'fileSavedOnDisk',
                                filePath: relativeSavedPath
                            });
                        } else {
                            vscode.commands.executeCommand('lollms-vs-coder.switchDiscussion', discussionId);
                        }
                    }

                    await this.cleanup(doc.uri);
                }
            }
        }));

        // Cleanup when the user closes the diff tab without saving (to prevent accumulation)
        context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(async (doc) => {
            const fsPath = doc.uri.fsPath;
            if (this.generatedToOriginal.has(fsPath)) {
                await this.cleanup(doc.uri);
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

    public async restoreEditorPosition(originalUri: vscode.Uri) {
        try {
            const doc = await vscode.workspace.openTextDocument(originalUri);
            const editor = await vscode.window.showTextDocument(doc, {
                preview: false,
                preserveFocus: false
            });

            const cached = this.lastPositions.get(originalUri.toString());
            if (cached && editor) {
                editor.selection = cached.selection;
                editor.revealRange(cached.visibleRange, vscode.TextEditorRevealType.InCenter);
                this.lastPositions.delete(originalUri.toString());
            }
        } catch (e) {
            console.error("Failed to restore editor position:", e);
        }
    }

    public async openDiff(originalUri: vscode.Uri, newContent: string, discussionId?: string) {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.uri.toString() === originalUri.toString()) {
            this.lastPositions.set(originalUri.toString(), {
                selection: activeEditor.selection,
                visibleRange: activeEditor.visibleRanges[0]
            });
        }

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
        
        // Use timestamp to match the files shown in user's screenshot and ensure uniqueness
        const diffFileName = `${name}_generated_${Date.now()}${ext}`;
        const generatedUri = vscode.Uri.joinPath(diffDir, diffFileName);

        try {
            // Overwrite the existing "proposed" file for this specific document if it exists
            await vscode.workspace.fs.writeFile(generatedUri, Buffer.from(newContent, 'utf8'));
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to write temp file for diff: ${e.message}`);
            return;
        }

        this.generatedToOriginal.set(generatedUri.fsPath, originalUri.fsPath);
        this.originalToGenerated.set(originalUri.fsPath, generatedUri.fsPath);
        if (discussionId) {
            this.generatedToDiscussionId.set(generatedUri.fsPath, discussionId);
        }
        this.saveState();

        const title = `${fileName} (Disk) ↔ ${fileName} (Edit Right & Save to Apply)`;

        try {
            // Determine the column. If we know this diff belongs to an active companion session,
            // we must target the editor column (non-companion column) so the companion UI stays visible.
            let targetColumn = vscode.ViewColumn.One;
            const activeEditor = vscode.window.activeTextEditor;

            // If the active editor is the companion (or we are on Column Two/Three), force diff to Column One
            if (activeEditor && activeEditor.viewColumn && activeEditor.viewColumn !== vscode.ViewColumn.One) {
                targetColumn = vscode.ViewColumn.One;
            } else if (discussionId && discussionId.startsWith('remote-') === false) {
                // If there's an active companion, force to Column One
                targetColumn = vscode.ViewColumn.One;
            }

            await vscode.commands.executeCommand('vscode.diff', 
                originalUri, 
                generatedUri, 
                title,
                {
                    viewColumn: targetColumn,
                    preserveFocus: true
                }
            );
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to open VS Code diff view: ${e.message}`);
        }

        setTimeout(() => {
            vscode.commands.executeCommand('setContext', 'lollms:isDiffView', true);
        }, 500);
        
        vscode.window.setStatusBarMessage("Lollms Diff: Edit the right side and Ctrl+S to apply changes.", 5000);
    }

    private async applyDiffFromSave(generatedDoc: vscode.TextDocument): Promise<boolean> {
        const originalFsPath = this.generatedToOriginal.get(generatedDoc.uri.fsPath);
        if (!originalFsPath) return false;

        try {
            const originalUri = vscode.Uri.file(originalFsPath);
            const content = generatedDoc.getText();

            let firstDiffLine = 0;
            try {
                const originalDoc = await vscode.workspace.openTextDocument(originalUri);
                const originalText = originalDoc.getText();
                const originalLines = originalText.split(/\r?\n/);
                const generatedLines = content.split(/\r?\n/);

                while (firstDiffLine < originalLines.length && firstDiffLine < generatedLines.length && originalLines[firstDiffLine] === generatedLines[firstDiffLine]) {
                    firstDiffLine++;
                }
                if (firstDiffLine >= originalLines.length && firstDiffLine >= generatedLines.length) {
                    firstDiffLine = 0; // Fallback if no differences found
                }
            } catch (err) {
                console.error("Failed to calculate first difference line:", err);
            }

            await vscode.workspace.fs.writeFile(originalUri, Buffer.from(content, 'utf8'));

            // Cache the position of the first difference line to scroll there after restoring the editor
            this.lastPositions.set(originalUri.toString(), {
                selection: new vscode.Selection(new vscode.Position(firstDiffLine, 0), new vscode.Position(firstDiffLine, 0)),
                visibleRange: new vscode.Range(new vscode.Position(Math.max(0, firstDiffLine - 8), 0), new vscode.Position(firstDiffLine + 8, 0))
            });

            vscode.window.showInformationMessage(`Changes applied to ${path.basename(originalFsPath)}`);
            return true;
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to apply changes: ${e.message}`);
            return false;
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
            this.generatedToDiscussionId.delete(fsPath);
            if (originalPath) this.originalToGenerated.delete(originalPath);
            
            this.saveState();
            
            // Re-evaluate context
            this.updateContext(vscode.window.activeTextEditor);

            try {
                // Force delete the temporary proposed file immediately
                await vscode.workspace.fs.delete(generatedUri, { recursive: false, useTrash: false });
            } catch (e) {
                console.error("Failed to delete diff file", e);
            }
        }
    }

    /**
     * Scans the workspace and deletes any .proposed files that aren't 
     * registered in the current session.
     */
    private async purgeOrphanedDiffs() {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders) return;

        for (const folder of folders) {
            const diffDir = vscode.Uri.joinPath(folder.uri, '.lollms', 'diffs');
            try {
                const entries = await vscode.workspace.fs.readDirectory(diffDir);
                for (const [name, type] of entries) {
                    // Purge both the old .proposed format and the new _generated_ format
                    if (type === vscode.FileType.File && (name.includes('.proposed') || name.includes('_generated_'))) {
                        const fullUri = vscode.Uri.joinPath(diffDir, name);
                        // If not in our active session tracking map, kill it
                        if (!this.generatedToOriginal.has(fullUri.fsPath)) {
                            await vscode.workspace.fs.delete(fullUri, { useTrash: false });
                        }
                    }
                }
            } catch (e) {
                // Directory likely doesn't exist
            }
        }
    }
}
