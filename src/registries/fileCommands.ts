import * as vscode from 'vscode';
import * as path from 'path';
import { LollmsServices } from '../lollmsContext';
import { applyDiff } from '../utils';
import { normalizeToDocument } from '../utils/promptUtils';
import { Logger } from '../logger';

export function registerFileCommands(context: vscode.ExtensionContext, services: LollmsServices, getActiveWorkspace: () => vscode.WorkspaceFolder | undefined) {

    // Helper to find a block of code in a document with flexible whitespace matching
    function findBlockRange(document: vscode.TextDocument, searchBlock: string): { start: number, end: number } | null {
        const text = document.getText();
        
        // 1. Try Exact Match first (fastest)
        const normalizedSearch = normalizeToDocument(searchBlock, document);
        const index = text.indexOf(normalizedSearch);
        if (index !== -1) {
            return { start: index, end: index + normalizedSearch.length };
        }

        // 2. Try Line-by-Line Match (Robust against indentation/whitespace changes)
        const docLines = text.split(/\r?\n/);
        const searchLines = searchBlock.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

        if (searchLines.length === 0) return null;

        for (let i = 0; i < docLines.length; i++) {
            // Quick check: does the current doc line match the first search line?
            if (docLines[i].trim() !== searchLines[0]) continue;

            let match = true;
            let docOffset = 0;
            let lastMatchedLineIndex = i;

            // Verify subsequent lines
            for (let j = 0; j < searchLines.length; j++) {
                // Skip empty lines in document to be lenient (e.g. AI skipped a blank line)
                while (i + docOffset < docLines.length && docLines[i + docOffset].trim().length === 0) {
                    docOffset++;
                }

                if (i + docOffset >= docLines.length) {
                    match = false;
                    break;
                }

                if (docLines[i + docOffset].trim() !== searchLines[j]) {
                    match = false;
                    break;
                }
                
                lastMatchedLineIndex = i + docOffset;
                docOffset++;
            }

            if (match) {
                // We found a match!
                // Start index is the start of line 'i'
                const startPos = document.lineAt(i).range.start;
                
                // End index: We want to include the full content of the last matched line
                const endPos = document.lineAt(lastMatchedLineIndex).range.end;
                
                // Usually we want to consume the newline after the block if deleting
                return { 
                    start: document.offsetAt(startPos), 
                    end: document.offsetAt(endPos) 
                };
            }
        }

        return null;
    }

    // Helper to open a diff view comparing a snapshot (Original) vs the Active File (Proposed Changes)
    async function applyContentWithDiff(fileUri: vscode.Uri, newContent: string) {
        // 1. Capture current state (Snapshot)
        let originalContent = '';
        try {
            const doc = await vscode.workspace.openTextDocument(fileUri);
            originalContent = doc.getText();
        } catch {
            try {
                const fileBytes = await vscode.workspace.fs.readFile(fileUri);
                originalContent = Buffer.from(fileBytes).toString('utf8');
            } catch (e) {
                // File might not exist
            }
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
        if (!workspaceFolder) {
             throw new Error("File is not in a workspace folder.");
        }
        
        const snapshotsDir = vscode.Uri.joinPath(workspaceFolder.uri, '.lollms', 'snapshots');
        try {
            await vscode.workspace.fs.createDirectory(snapshotsDir);
        } catch {} 
        
        const fileName = path.basename(fileUri.fsPath);
        const snapshotUri = vscode.Uri.joinPath(snapshotsDir, `${fileName}.orig`);
        
        await vscode.workspace.fs.writeFile(snapshotUri, Buffer.from(originalContent, 'utf8'));

        // 2. Close existing editor if open
        const visibleEditor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === fileUri.toString());
        if (visibleEditor) {
            await vscode.window.showTextDocument(visibleEditor.document, {
                viewColumn: visibleEditor.viewColumn,
                preserveFocus: false
            });
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }

        // 3. Open Diff Editor
        const title = `${fileName} (Original) ↔ ${fileName} (Proposed)`;
        await vscode.commands.executeCommand('vscode.diff', snapshotUri, fileUri, title, { preview: false });

        // 4. Apply Edit
        const document = await vscode.workspace.openTextDocument(fileUri);
        const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(fileUri, fullRange, newContent);
        
        const applied = await vscode.workspace.applyEdit(edit);
        
        if (applied) {
            vscode.window.showInformationMessage(`Review changes. Press Ctrl+S to save.`);
        } else {
            throw new Error("Failed to apply edit to document.");
        }
    }

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.applyFileContent', async (filePath: string, content: string) => {
        const activeWorkspace = getActiveWorkspace();
        if (!activeWorkspace) {
            vscode.window.showErrorMessage("No active workspace.");
            return;
        }
        
        try {
            const fileUri = vscode.Uri.joinPath(activeWorkspace.uri, filePath);
            
            try {
                await vscode.workspace.fs.stat(fileUri);
            } catch {
                // File does not exist: Create it directly
                const parentDir = vscode.Uri.joinPath(fileUri, '..');
                await vscode.workspace.fs.createDirectory(parentDir);
                
                const edit = new vscode.WorkspaceEdit();
                edit.createFile(fileUri, { ignoreIfExists: true });
                edit.insert(fileUri, new vscode.Position(0, 0), content);
                
                await vscode.workspace.applyEdit(edit);
                const doc = await vscode.workspace.openTextDocument(fileUri);
                await vscode.window.showTextDocument(doc);
                vscode.window.showInformationMessage(`Created new file: ${filePath}`);
                return;
            }

            // File exists: Open Snapshot Diff
            await applyContentWithDiff(fileUri, content);

        } catch (e: any) {
            Logger.error(`Error applying file content: ${e.message}`, e);
            vscode.window.showErrorMessage(`Error applying file content: ${e.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.acceptDiff', async (arg?: vscode.Uri | string) => {
        if (typeof arg === 'string') {
            await services.inlineDiffProvider.accept(arg);
            return;
        }

        let generatedUri = arg;
        if (!generatedUri) {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor && services.diffManager.isLollmsDiff(activeEditor.document.uri)) {
                generatedUri = activeEditor.document.uri;
            }
        }

        if (generatedUri && services.diffManager.isLollmsDiff(generatedUri)) {
            const originalUri = services.diffManager.getOriginalUri(generatedUri);
            if (originalUri) {
                const doc = await vscode.workspace.openTextDocument(generatedUri);
                const newContent = doc.getText();
                
                const originalDoc = await vscode.workspace.openTextDocument(originalUri);
                const edit = new vscode.WorkspaceEdit();
                edit.replace(originalUri, new vscode.Range(0, 0, originalDoc.lineCount, 0), newContent);
                
                await vscode.workspace.applyEdit(edit);
                await originalDoc.save();
                
                services.diffManager.cleanup(generatedUri);
                
                if (vscode.window.activeTextEditor?.document.uri.toString() === generatedUri.toString()) {
                     await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                }
                
                await vscode.window.showTextDocument(originalDoc);
                vscode.window.showInformationMessage("Changes accepted.");
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.rejectDiff', async (arg?: vscode.Uri | string) => {
        if (typeof arg === 'string') {
            await services.inlineDiffProvider.reject(arg);
            return;
        }

        let generatedUri = arg;
        if (!generatedUri) {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor && services.diffManager.isLollmsDiff(activeEditor.document.uri)) {
                generatedUri = activeEditor.document.uri;
            }
        }
        
        if (generatedUri && services.diffManager.isLollmsDiff(generatedUri)) {
            services.diffManager.cleanup(generatedUri);
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            vscode.window.showInformationMessage("Changes rejected.");
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.refineDiff', async (sessionId: string) => {
        await services.inlineDiffProvider.refine(sessionId);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.replaceCode', async (filePath: string, content: string) => {
        const activeWorkspace = getActiveWorkspace();
        if (!activeWorkspace) return;

        const match = content.match(/<<<<<<< SEARCH([\s\S]*?)=======\s*([\s\S]*?)(?:>>>>>>> REPLACE|$)/);
        if (!match) {
             vscode.window.showErrorMessage("Invalid replace block format.");
             return;
        }
        
        const searchCode = match[1].trim(); 
        const replaceCode = match[2].trim();
        const fileUri = vscode.Uri.joinPath(activeWorkspace.uri, filePath);
        
        try {
            let document;
            try {
                document = await vscode.workspace.openTextDocument(fileUri);
            } catch(e: any) {
                if (e.message && e.message.includes('binary')) {
                    vscode.window.showErrorMessage(`Cannot modify binary file '${filePath}' with text operations.`);
                    return;
                }
                throw e;
            }

            const text = document.getText();
            const range = findBlockRange(document, searchCode);
            
            if (!range) {
                vscode.window.showErrorMessage(`Could not locate search block in ${filePath}. Exact match required.`);
                return;
            }
            
            const before = text.substring(0, range.start);
            const after = text.substring(range.end);
            const newFullContent = before + replaceCode + after;

            await applyContentWithDiff(fileUri, newFullContent);

        } catch(e: any) {
            vscode.window.showErrorMessage(`Error accessing file ${filePath}: ${e.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.insertCode', async (filePath: string, content: string) => {
        const activeWorkspace = getActiveWorkspace();
        if (!activeWorkspace) return;
        
        const match = content.match(/<<<<([\s\S]*?)====([\s\S]*?)(?:>>>>|====|$)/);
        if (!match) {
             vscode.window.showErrorMessage("Invalid insertion block format.");
             return;
        }
        
        const contextCode = match[1].replace(/^\s*[\r\n]/, '').replace(/[\r\n]\s*$/, ''); 
        let insertCode = match[2].replace(/^\s*[\r\n]/, '').replace(/[\r\n]\s*$/, '');
        insertCode = insertCode.replace(/====$/, '').trimEnd();
        
        if (insertCode.startsWith(contextCode)) {
            insertCode = insertCode.substring(contextCode.length).trimStart();
        }

        const fileUri = vscode.Uri.joinPath(activeWorkspace.uri, filePath);
        
        try {
            let document;
            try {
                document = await vscode.workspace.openTextDocument(fileUri);
            } catch(e: any) {
                if (e.message && e.message.includes('binary')) {
                    vscode.window.showErrorMessage(`Cannot modify binary file '${filePath}' with text operations.`);
                    return;
                }
                throw e;
            }

            const text = document.getText();
            const range = findBlockRange(document, contextCode);
            
            if (!range) {
                vscode.window.showErrorMessage(`Could not locate context code in ${filePath}.`);
                return;
            }
            
            const insertPosIndex = range.end;
            const before = text.substring(0, insertPosIndex);
            const after = text.substring(insertPosIndex);
            const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
            const newFullContent = before + eol + insertCode + after;

            await applyContentWithDiff(fileUri, newFullContent);

        } catch(e: any) {
            vscode.window.showErrorMessage(`Error accessing file: ${e.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.deleteCodeBlock', async (filePath: string, content: string) => {
        const activeWorkspace = getActiveWorkspace();
        if (!activeWorkspace) return;

        const match = content.match(/<<<<([\s\S]*?)>>>>/);
        const codeToDelete = match ? match[1].trim() : content.trim();
        const fileUri = vscode.Uri.joinPath(activeWorkspace.uri, filePath);
        
        try {
            let document;
            try {
                document = await vscode.workspace.openTextDocument(fileUri);
            } catch(e: any) {
                // Handle binary file error gracefully
                if (e.message && e.message.includes('binary')) {
                     const deleteFile = await vscode.window.showWarningMessage(
                        `'${filePath}' appears to be a binary file. "Delete Code" cannot remove lines from binaries. Do you want to delete the whole file instead?`,
                        'Yes, Delete File', 'Cancel'
                    );
                    
                    if (deleteFile === 'Yes, Delete File') {
                        await vscode.commands.executeCommand('lollms-vs-coder.deleteFile', filePath);
                    }
                    return;
                }
                throw e;
            }

            const text = document.getText();
            const range = findBlockRange(document, codeToDelete);
            
            if (!range) {
                vscode.window.showErrorMessage(`Could not locate code to delete in ${filePath}.`);
                return;
            }
            
            const before = text.substring(0, range.start);
            let after = text.substring(range.end);
            
            // Try to consume the following newline to avoid leaving a blank line
            if (after.startsWith('\r\n')) {
                after = after.substring(2);
            } else if (after.startsWith('\n')) {
                after = after.substring(1);
            }

            const newFullContent = before + after;

            await applyContentWithDiff(fileUri, newFullContent);

        } catch(e: any) {
            vscode.window.showErrorMessage(`Error accessing file ${filePath}: ${e.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.renameFile', async (oldPath: string, newPath: string) => {
        const activeWorkspace = getActiveWorkspace();
        if (!activeWorkspace) return;
        const oldUri = vscode.Uri.joinPath(activeWorkspace.uri, oldPath);
        const newUri = vscode.Uri.joinPath(activeWorkspace.uri, newPath);
        try {
            const edit = new vscode.WorkspaceEdit();
            edit.renameFile(oldUri, newUri, { overwrite: false });
            if (await vscode.workspace.applyEdit(edit)) {
                vscode.window.showInformationMessage(`Renamed ${oldPath} to ${newPath}`);
            } else {
                vscode.window.showErrorMessage(`Failed to rename ${oldPath}. Check if file exists.`);
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Error renaming file: ${e.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.deleteFile', async (pathsStr: string) => {
        const activeWorkspace = getActiveWorkspace();
        if (!activeWorkspace) return;
        const paths = pathsStr.split(/[\n,]/).map(p => p.trim()).filter(p => p);
        const edit = new vscode.WorkspaceEdit();
        for (const p of paths) {
            const uri = vscode.Uri.joinPath(activeWorkspace.uri, p);
            edit.deleteFile(uri, { ignoreIfNotExists: true });
        }
        if (await vscode.workspace.applyEdit(edit)) {
            vscode.window.showInformationMessage(`Deleted ${paths.length} file(s).`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.applyPatchContent', async (filePath: string, patchContent: string) => {
         try {
             const activeWorkspace = getActiveWorkspace();
             if(!activeWorkspace) return;
             
             const fileUri = vscode.Uri.joinPath(activeWorkspace.uri, filePath);
             
             // 1. Snapshot
             let originalContent = '';
             try {
                 const doc = await vscode.workspace.openTextDocument(fileUri);
                 originalContent = doc.getText();
             } catch {
                 const bytes = await vscode.workspace.fs.readFile(fileUri);
                 originalContent = Buffer.from(bytes).toString('utf8');
             }
             
             const snapshotsDir = vscode.Uri.joinPath(activeWorkspace.uri, '.lollms', 'snapshots');
             try { await vscode.workspace.fs.createDirectory(snapshotsDir); } catch {}
             const fileName = path.basename(filePath);
             const snapshotUri = vscode.Uri.joinPath(snapshotsDir, `${fileName}.orig`);
             await vscode.workspace.fs.writeFile(snapshotUri, Buffer.from(originalContent, 'utf8'));
             
             // 2. Open Diff (Snapshot vs Real)
             const title = `${fileName} (Original) ↔ ${fileName} (Patched)`;
             await vscode.commands.executeCommand('vscode.diff', snapshotUri, fileUri, title, { preview: false });
             
             // 3. Apply Patch
             await applyDiff(patchContent); 
             
             vscode.window.showInformationMessage(`Patch applied. Review changes and Save.`);
         } catch (e: any) {
             vscode.window.showErrorMessage(`Failed to apply patch: ${e.message}`);
         }
    }));
}
