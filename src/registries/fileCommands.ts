import * as vscode from 'vscode';
import * as path from 'path';
import { LollmsServices } from '../lollmsContext';
import { applyDiff } from '../utils';
import { normalizeToDocument } from '../utils/promptUtils';
import { Logger } from '../logger';
import { ChatPanel } from '../commands/chatPanel/chatPanel';

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
                
                return { 
                    start: document.offsetAt(startPos), 
                    end: document.offsetAt(endPos) 
                };
            }
        }

        return null;
    }

    /**
     * Common logic to show a diff view comparing the state BEFORE the AI change 
     * vs the state AFTER the AI change.
     */
    async function openDiffView(fileUri: vscode.Uri, originalContent: string) {
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
        
        // Save the "Before" state to a temp file
        await vscode.workspace.fs.writeFile(snapshotUri, Buffer.from(originalContent, 'utf8'));

        // Open the Diff Editor
        const title = `${fileName} (Original) ↔ ${fileName} (Proposed)`;
        await vscode.commands.executeCommand('vscode.diff', snapshotUri, fileUri, title, { 
            preview: false,
            preserveFocus: false // We want focus to shift to the new diff
        });
    }

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.applyFileContent', async (filePath: string, content: string) => {
        const activeWorkspace = getActiveWorkspace();
        if (!activeWorkspace) {
            vscode.window.showErrorMessage("No active workspace.");
            return;
        }
        
        try {
            const fileUri = vscode.Uri.joinPath(activeWorkspace.uri, filePath);
            let originalContent = '';

            try {
                await vscode.workspace.fs.stat(fileUri);
                // File exists: capture original content for diff
                const doc = await vscode.workspace.openTextDocument(fileUri);
                originalContent = doc.getText();
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

            // Apply full content replacement
            const document = await vscode.workspace.openTextDocument(fileUri);
            const fullRange = new vscode.Range(new vscode.Position(0, 0), document.lineAt(document.lineCount - 1).range.end);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(fileUri, fullRange, content);
            await vscode.workspace.applyEdit(edit);

            // Open Snapshot Diff
            await openDiffView(fileUri, originalContent);

        } catch (e: any) {
            Logger.error(`Error applying file content: ${e.message}`, e);
            vscode.window.showErrorMessage(`Error applying file content: ${e.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.saveCodeToFile', async (content: string, language: string) => {
        const activeWorkspace = getActiveWorkspace();
        const langMap: { [key: string]: string } = {
            'python': 'py', 'javascript': 'js', 'typescript': 'ts', 'html': 'html', 'css': 'css',
            'c': 'c', 'cpp': 'cpp', 'csharp': 'cs', 'java': 'java', 'rust': 'rs', 'go': 'go'
        };
        const ext = langMap[language.toLowerCase()] || 'txt';

        const uri = await vscode.window.showSaveDialog({
            defaultUri: activeWorkspace ? vscode.Uri.joinPath(activeWorkspace.uri, `generated_code.${ext}`) : undefined,
            filters: { 'Source Code': [ext], 'All Files': ['*'] },
            saveLabel: 'Save AI Generated Code'
        });

        if (uri) {
            try {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
                vscode.window.showInformationMessage(`Successfully saved to ${path.basename(uri.fsPath)}`);
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to save file: ${e.message}`);
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.saveInfoToFile', async (content: string) => {
        const activeWorkspace = getActiveWorkspace();
        const uri = await vscode.window.showSaveDialog({
            defaultUri: activeWorkspace ? vscode.Uri.joinPath(activeWorkspace.uri, 'information.md') : undefined,
            filters: { 'Markdown': ['md'], 'Text': ['txt'] },
            saveLabel: 'Save Information'
        });

        if (uri) {
            try {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
                vscode.window.showInformationMessage(`Information saved to ${path.basename(uri.fsPath)}`);
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to save info: ${e.message}`);
            }
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

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.triggerInlineDiff', async (editor: vscode.TextEditor, selection: vscode.Selection, text: string) => {
        await services.inlineDiffProvider.startSession(
            editor,
            selection,
            text,
            [],
            text
        );
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.replaceCode', async (filePath: string, content: string, panel?: ChatPanel, messageId?: string) => {
        const activeWorkspace = getActiveWorkspace();
        if (!activeWorkspace) return;

        // Use strict line-anchored regex to find all hunks
        const aiderRegex = /^<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/gm;
        const matches = [...content.matchAll(aiderRegex)];
        
        if (matches.length === 0) {
             vscode.window.showErrorMessage("No valid Search/Replace blocks found. Ensure markers start at the beginning of the line.");
             return;
        }
        
        const fileUri = vscode.Uri.joinPath(activeWorkspace.uri, filePath);
        
        try {
            const document = await vscode.workspace.openTextDocument(fileUri);
            let currentContent = document.getText();
            const originalContent = currentContent;
            
            let applyCount = 0;
            const { applySearchReplace } = require('../utils');

            for (const match of matches) {
                const searchCode = match[1];
                const replaceCode = match[2];
                const result = applySearchReplace(currentContent, searchCode, replaceCode);

                if (result.success) {
                    currentContent = result.result;
                    applyCount++;
                } else {
                    const fixBtn = "Fix with AI";
                    const selection = await vscode.window.showErrorMessage(
                        `Could not apply search/replace block in ${filePath}: ${result.error}`,
                        fixBtn, "Cancel"
                    );

                    if (selection === fixBtn && panel && messageId) {
                        // --- SILENT BACKGROUND REPAIR ---
                        await vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: `Lollms: Repairing block for ${filePath}...`,
                            cancellable: false
                        }, async () => {
                            const repairPrompt = `The following Search/Replace block failed to match in \`${filePath}\`.\n\n` +
                                `**Error:** ${result.error}\n\n` +
                                `**Current File Content:**\n\`\`\`\n${originalContent}\n\`\`\`\n\n` +
                                `**Your failing attempt:**\n\`\`\`\n${match[0]}\n\`\`\`\n\n` +
                                `Please provide the CORRECTED Search/Replace block. Ensure the SEARCH part matches the file content exactly, including whitespace and indentation.`;
                            
                            try {
                                const response = await panel._lollmsAPI.sendChat([
                                    { role: 'system', content: "You are a precise code repair assistant. Output ONLY the corrected block." },
                                    { role: 'user', content: repairPrompt }
                                ]);

                                const fixedBlockMatch = response.match(/<<<<<<< SEARCH[\s\S]*?>>>>>>> REPLACE/);
                                if (fixedBlockMatch) {
                                    const fixedBlock = fixedBlockMatch[0];
                                    
                                    // 1. Update the message content in the UI
                                    const currentDiscussion = panel.getCurrentDiscussion();
                                    if (currentDiscussion) {
                                        const msg = currentDiscussion.messages.find(m => m.id === messageId);
                                        if (msg && typeof msg.content === 'string') {
                                            const updatedContent = msg.content.replace(match[0], fixedBlock);
                                            await panel.updateMessageContent(messageId, updatedContent);
                                        }
                                    }

                                    // 2. Automatically retry applying the NEW content
                                    vscode.window.showInformationMessage(vscode.l10n.t("Block repaired. Retrying apply..."));
                                    await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', filePath, fixedBlock, panel, messageId);
                                } else {
                                    // NOTIFY USER OF FORMAT FAILURE
                                    vscode.window.showWarningMessage(
                                        vscode.l10n.t("Lollms: The AI suggested a fix but failed to follow the SEARCH/REPLACE format. Please fix it manually.")
                                    );
                                }
                            } catch (err: any) {
                                vscode.window.showErrorMessage(`Repair failed: ${err.message}`);
                            }
                        });
                        return; 
                    }
                }
            }

            if (applyCount > 0) {
                const edit = new vscode.WorkspaceEdit();
                const fullRange = new vscode.Range(new vscode.Position(0, 0), document.lineAt(document.lineCount - 1).range.end);
                edit.replace(fileUri, fullRange, currentContent);
                await vscode.workspace.applyEdit(edit);
                await openDiffView(fileUri, originalContent);
                vscode.window.showInformationMessage(`Applied ${applyCount} change(s) to ${filePath}.`);
            }

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
            const originalContent = document.getText();
            const range = findBlockRange(document, contextCode);
            
            if (!range) {
                vscode.window.showErrorMessage(`Could not locate context code in ${filePath}.`);
                return;
            }
            
            const insertPosIndex = range.end;
            const before = originalContent.substring(0, insertPosIndex);
            const after = originalContent.substring(insertPosIndex);
            const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
            const newFullContent = before + eol + insertCode + after;

            const edit = new vscode.WorkspaceEdit();
            edit.replace(fileUri, new vscode.Range(new vscode.Position(0, 0), document.lineAt(document.lineCount - 1).range.end), newFullContent);
            await vscode.workspace.applyEdit(edit);

            await openDiffView(fileUri, originalContent);

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
            const originalContent = document.getText();
            const range = findBlockRange(document, codeToDelete);
            
            if (!range) {
                vscode.window.showErrorMessage(`Could not locate code to delete in ${filePath}.`);
                return;
            }
            
            const before = originalContent.substring(0, range.start);
            let after = originalContent.substring(range.end);
            
            if (after.startsWith('\r\n')) {
                after = after.substring(2);
            } else if (after.startsWith('\n')) {
                after = after.substring(1);
            }

            const newFullContent = before + after;

            const edit = new vscode.WorkspaceEdit();
            edit.replace(fileUri, new vscode.Range(new vscode.Position(0, 0), document.lineAt(document.lineCount - 1).range.end), newFullContent);
            await vscode.workspace.applyEdit(edit);

            await openDiffView(fileUri, originalContent);

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
             const doc = await vscode.workspace.openTextDocument(fileUri);
             const originalContent = doc.getText();

             try {
                await applyDiff(patchContent, filePath); 
             } catch (diffErr: any) {
                const fixBtn = "Fix with AI";
                const selection = await vscode.window.showErrorMessage(
                    `Failed to apply patch to ${filePath}: ${diffErr.message}`,
                    fixBtn, "Cancel"
                );

                if (selection === fixBtn && ChatPanel.currentPanel) {
                    const repairPrompt = `The following unified diff failed to apply to \`${filePath}\`.\n\n` +
                        `**Error:** ${diffErr.message}\n\n` +
                        `**Original File Content:**\n\`\`\`\n${originalContent}\n\`\`\`\n\n` +
                        `**Your failing patch:**\n\`\`\`diff\n${patchContent}\n\`\`\`\n\n` +
                        `Please fix your code. Verify that the context lines in your diff exactly match the original file.`;
                    
                    await ChatPanel.currentPanel.sendMessage({ role: 'user', content: repairPrompt });
                    return;
                }
                throw diffErr;
             }
             
             await openDiffView(fileUri, originalContent);
             vscode.window.showInformationMessage(`Patch applied successfully to ${filePath}. Review changes.`);
         } catch (e: any) {
             // Error already handled or ignored
         }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setEntryPoint', async (targetPath?: string) => {
        const activeWorkspace = getActiveWorkspace();
        if (!activeWorkspace) {
            vscode.window.showErrorMessage("No active workspace found.");
            return;
        }

        let entryPath = targetPath;
        if (!entryPath) {
            const uris = await vscode.window.showOpenDialog({
                canSelectMany: false,
                openLabel: 'Select Main Entry Point',
                title: 'Set Project Launch File',
                filters: { 'Scripts': ['py', 'js', 'ts', 'sh', 'bat', 'ps1', 'exe'] }
            });
            if (uris && uris[0]) {
                entryPath = vscode.workspace.asRelativePath(uris[0]);
            }
        }

        if (!entryPath) return;

        try {
            const launchJsonPath = vscode.Uri.joinPath(activeWorkspace.uri, '.vscode', 'launch.json');
            let launchConfig: any = { version: '0.2.0', configurations: [] };

            try {
                const content = await vscode.workspace.fs.readFile(launchJsonPath);
                launchConfig = JSON.parse(content.toString());
            } catch (e) {
                await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(activeWorkspace.uri, '.vscode'));
            }

            if (!launchConfig.configurations || !Array.isArray(launchConfig.configurations)) {
                launchConfig.configurations = [];
            }

            const ext = path.extname(entryPath).toLowerCase();
            let type = 'node';
            if (ext === '.py') type = 'python';
            else if (ext === '.sh' || ext === '.bat' || ext === '.ps1') type = 'bashdb';

            const newConfig = {
                name: `Lollms: Run ${path.basename(entryPath)}`,
                request: 'launch',
                type: type,
                program: `\${workspaceFolder}/${entryPath}`,
                console: 'integratedTerminal'
            };

            const existingIndex = launchConfig.configurations.findIndex((c: any) => c.program && c.program.includes(entryPath!));
            if (existingIndex !== -1) {
                launchConfig.configurations[existingIndex] = newConfig;
            } else {
                launchConfig.configurations.unshift(newConfig);
            }

            await vscode.workspace.fs.writeFile(launchJsonPath, Buffer.from(JSON.stringify(launchConfig, null, 4), 'utf8'));
            vscode.window.showInformationMessage(`Main entry point set to: ${entryPath}`);
            return entryPath;
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to set entry point: ${e.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.executeProject', async () => {
        const activeWorkspace = getActiveWorkspace();
        if (!activeWorkspace) return;

        const launchConfig = vscode.workspace.getConfiguration('launch', activeWorkspace.uri);
        const configs = launchConfig.get<any[]>('configurations');

        if (!configs || configs.length === 0) {
            const setup = await vscode.window.showInformationMessage(
                "No launch configurations found. Would you like to select a main file to run?",
                "Select Main File", "Cancel"
            );

            if (setup === "Select Main File") {
                const result = await vscode.commands.executeCommand<string>('lollms-vs-coder.setEntryPoint');
                if (!result) return;
            } else {
                return;
            }
        }

        const updatedConfigs = vscode.workspace.getConfiguration('launch', activeWorkspace.uri).get<any[]>('configurations');
        if (updatedConfigs && updatedConfigs.length > 0) {
            const configToRun = updatedConfigs[0];
            try {
                await vscode.debug.startDebugging(activeWorkspace, configToRun.name);
            } catch (e: any) {
                vscode.window.showErrorMessage(`Execution failed: ${e.message}`);
            }
        }
    }));
}
