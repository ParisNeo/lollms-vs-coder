import * as vscode from 'vscode';
import * as path from 'path';
import { LollmsServices } from '../lollmsContext';
import { applyDiff } from '../utils';
import { normalizeToDocument } from '../utils/promptUtils';
import { Logger } from '../logger';

export function registerFileCommands(context: vscode.ExtensionContext, services: LollmsServices, getActiveWorkspace: () => vscode.WorkspaceFolder | undefined) {

    // Helper to open a diff view comparing a snapshot (Original) vs the Active File (Proposed Changes)
    // This allows the user to see the diff, edit the right side (Active File), and Save to disk,
    // while keeping the Left side as the reference snapshot.
    async function applyContentWithDiff(fileUri: vscode.Uri, newContent: string) {
        // 1. Capture current state (Snapshot)
        let originalContent = '';
        try {
            // Try to read from open document first to capture potentially unsaved changes
            const doc = await vscode.workspace.openTextDocument(fileUri);
            originalContent = doc.getText();
        } catch {
            // Fallback to disk if not open/readable as text doc
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
        } catch {} // Ignore if exists
        
        const fileName = path.basename(fileUri.fsPath);
        // Use .orig extension for snapshot
        const snapshotUri = vscode.Uri.joinPath(snapshotsDir, `${fileName}.orig`);
        
        await vscode.workspace.fs.writeFile(snapshotUri, Buffer.from(originalContent, 'utf8'));

        // 2. Close existing editor if open (to prevent "both file and diff opened")
        // We attempt to find if the document is visible and close it.
        const visibleEditor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === fileUri.toString());
        if (visibleEditor) {
            await vscode.window.showTextDocument(visibleEditor.document, {
                viewColumn: visibleEditor.viewColumn,
                preserveFocus: false
            });
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }

        // 3. Open Diff Editor (Left: Snapshot, Right: Real File)
        const title = `${fileName} (Original) ↔ ${fileName} (Proposed)`;
        await vscode.commands.executeCommand('vscode.diff', snapshotUri, fileUri, title, { preview: false });

        // 4. Apply Edit to Real File (Right side)
        // Since the file is open in the diff view, applyEdit will update the buffer, making it Dirty.
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
                // File does not exist: Create it directly (no diff needed for new file)
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

    // Updated acceptDiff to handle both DiffManager (legacy/files) and InlineDiff (CodeLens)
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
            let document = await vscode.workspace.openTextDocument(fileUri);
            const text = document.getText();
            const normalizedSearch = normalizeToDocument(searchCode, document);
            
            const index = text.indexOf(normalizedSearch);
            if (index === -1) {
                vscode.window.showErrorMessage(`Could not locate search block in ${filePath}. Exact match required.`);
                return;
            }
            
            const before = text.substring(0, index);
            const after = text.substring(index + normalizedSearch.length);
            const newFullContent = before + replaceCode + after;

            // Use the improved snapshot diff approach
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
            let document = await vscode.workspace.openTextDocument(fileUri);
            const text = document.getText();
            const searchBlock = normalizeToDocument(contextCode, document);
            
            const index = text.indexOf(searchBlock);
            if (index === -1) {
                vscode.window.showErrorMessage(`Could not locate context code in ${filePath}.`);
                return;
            }
            
            const insertPosIndex = index + searchBlock.length;
            const before = text.substring(0, insertPosIndex);
            const after = text.substring(insertPosIndex);
            const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
            const newFullContent = before + eol + insertCode + after;

            // Use the improved snapshot diff approach
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
            let document = await vscode.workspace.openTextDocument(fileUri);
            const text = document.getText();
            const normalizedSearch = normalizeToDocument(codeToDelete, document);
            const index = text.indexOf(normalizedSearch);
            
            if (index === -1) {
                vscode.window.showErrorMessage(`Could not locate code to delete in ${filePath}.`);
                return;
            }
            
            const before = text.substring(0, index);
            const after = text.substring(index + normalizedSearch.length);
            const newFullContent = before + after;

            // Use the improved snapshot diff approach
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
