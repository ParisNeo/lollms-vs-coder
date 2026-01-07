import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { applyDiff } from '../utils';
import { normalizeToDocument } from '../utils/promptUtils';
import { Logger } from '../logger';

export function registerFileCommands(context: vscode.ExtensionContext, services: LollmsServices, getActiveWorkspace: () => vscode.WorkspaceFolder | undefined) {

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
                // File does not exist: Create it
                const parentDir = vscode.Uri.joinPath(fileUri, '..');
                await vscode.workspace.fs.createDirectory(parentDir);
                const edit = new vscode.WorkspaceEdit();
                edit.createFile(fileUri, { ignoreIfExists: true });
                edit.insert(fileUri, new vscode.Position(0, 0), content);
                await vscode.workspace.applyEdit(edit);
                const doc = await vscode.workspace.openTextDocument(fileUri);
                await vscode.window.showTextDocument(doc);
                vscode.window.showInformationMessage(`Created ${filePath}`);
                return;
            }

            // File exists: Open, Apply changes in-memory (Dirty), and Show Diff with Saved
            const document = await vscode.workspace.openTextDocument(fileUri);
            await vscode.window.showTextDocument(document);
            
            const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(fileUri, fullRange, content);
            
            const applied = await vscode.workspace.applyEdit(edit);
            if (applied) {
                await vscode.commands.executeCommand('workbench.files.action.compareWithSaved');
                vscode.window.showInformationMessage(`Changes applied to ${filePath}. Save to confirm.`);
            } else {
                vscode.window.showErrorMessage(`Failed to apply changes to ${filePath}.`);
            }

        } catch (e: any) {
            Logger.error(`Error applying file content: ${e.message}`, e);
            vscode.window.showErrorMessage(`Error applying file content: ${e.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.acceptDiff', async (uri?: vscode.Uri) => {
        let generatedUri = uri;
        
        if (!generatedUri) {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor) {
                if (services.diffManager.isLollmsDiff(activeEditor.document.uri)) {
                    generatedUri = activeEditor.document.uri;
                } else {
                    const linkedGenerated = services.diffManager.getGeneratedFileFor(activeEditor.document.uri);
                    if (linkedGenerated) generatedUri = linkedGenerated;
                }
            }
        }

        if (!generatedUri) {
            const visibleEditors = vscode.window.visibleTextEditors;
            const diffEditor = visibleEditors.find(e => services.diffManager.isLollmsDiff(e.document.uri));
            if (diffEditor) generatedUri = diffEditor.document.uri;
        }

        if (!generatedUri) {
            vscode.window.showInformationMessage("No active Lollms diff found to accept. Please open the diff first.");
            return;
        }

        const originalUri = services.diffManager.getOriginalUri(generatedUri);
        if (!originalUri) {
            vscode.window.showErrorMessage("Could not find original file for this diff.");
            return;
        }

        const doc = await vscode.workspace.openTextDocument(generatedUri);
        const newContent = doc.getText();
        
        const originalDoc = await vscode.workspace.openTextDocument(originalUri);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(originalUri, new vscode.Range(0, 0, originalDoc.lineCount, 0), newContent);
        
        await vscode.workspace.applyEdit(edit);
        await originalDoc.save();
        
        services.diffManager.cleanup(generatedUri);
        
        if (vscode.window.activeTextEditor && (vscode.window.activeTextEditor.document.uri.toString() === generatedUri.toString() || vscode.window.activeTextEditor.document.uri.toString() === originalUri.toString())) {
             await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }
        
        await vscode.window.showTextDocument(originalDoc);
        vscode.window.showInformationMessage("Changes accepted.");
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.rejectDiff', async (uri?: vscode.Uri) => {
        let generatedUri = uri;
        
        if (!generatedUri) {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor) {
                if (services.diffManager.isLollmsDiff(activeEditor.document.uri)) {
                    generatedUri = activeEditor.document.uri;
                } else {
                    const linkedGenerated = services.diffManager.getGeneratedFileFor(activeEditor.document.uri);
                    if (linkedGenerated) generatedUri = linkedGenerated;
                }
            }
        }
        
        if (generatedUri) {
            services.diffManager.cleanup(generatedUri);
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            vscode.window.showInformationMessage("Changes rejected.");
        }
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

            await services.diffManager.openDiff(fileUri, newFullContent);

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

            await services.diffManager.openDiff(fileUri, newFullContent);

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

            await services.diffManager.openDiff(fileUri, newFullContent);

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
             await applyDiff(patchContent);
             await vscode.commands.executeCommand('workbench.files.action.compareWithSaved');
             vscode.window.showInformationMessage(`Patch applied. Save to confirm.`);
         } catch (e: any) {
             vscode.window.showErrorMessage(`Failed to apply patch: ${e.message}`);
         }
    }));
}
