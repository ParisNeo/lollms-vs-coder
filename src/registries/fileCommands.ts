import * as vscode from 'vscode';
import * as path from 'path';
import { LollmsServices } from '../lollmsContext';
import { applyDiff, applySearchReplace } from '../utils';
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
        await vscode.workspace.fs.createDirectory(snapshotsDir).then(undefined, () => {}); 
        
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

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.applyFileContent', async (filePath: string, content: string, options?: { silent?: boolean }) => {
        const activeWorkspace = getActiveWorkspace();
        if (!activeWorkspace) {
            vscode.window.showErrorMessage("No active workspace.");
            return { success: false, error: "No workspace" };
        }
        
        try {
            const fileUri = vscode.Uri.joinPath(activeWorkspace.uri, filePath);
            let originalContent = '';
            let fileExists = false;

            try {
                await vscode.workspace.fs.stat(fileUri);
                const doc = await vscode.workspace.openTextDocument(fileUri);
                originalContent = doc.getText();
                fileExists = true;
            } catch {
                const parentDir = vscode.Uri.joinPath(fileUri, '..');
                await vscode.workspace.fs.createDirectory(parentDir);
                
                const edit = new vscode.WorkspaceEdit();
                edit.createFile(fileUri, { ignoreIfExists: true });
                edit.insert(fileUri, new vscode.Position(0, 0), content);
                
                await vscode.workspace.applyEdit(edit);
                
                try {
                    await vscode.commands.executeCommand('lollms-vs-coder.addFilesToContext', [filePath]);
                } catch (e) {
                    Logger.warn(`Failed to auto-add new file to context: ${e}`);
                }

                if (!options?.silent) {
                    const doc = await vscode.workspace.openTextDocument(fileUri);
                    await vscode.window.showTextDocument(doc);
                }
                return { success: true, alreadyApplied: false };
            }

            // --- PLACEHOLDER & SIZE SAFETY CHECK ---
            if (fileExists) {
                // Improved detection: Only flag "..." if it's on a line by itself or in a comment, 
                // not inside a long string like print("Phase 2...")
                const lines = content.split('\n');
                const hasPlaceholder = lines.some(line => {
                    const trimmed = line.trim();
                    // 1. Line is just "..." or a comment followed by "..." (e.g. # ...)
                    if (/^(\.{3,}|#\s*\.{3,}|(\/\/|--|;)\s*\.{3,})$/.test(trimmed)) return true;
                    // 2. Specific "rest of code" markers commonly used by AI
                    if (/(#|\/\/)\s*\.{3,}\s*(rest|same|logic|etc)/i.test(trimmed)) return true;
                    return false;
                });

                const sizeRatio = content.length / (originalContent.length || 1);

                // If content is < 40% of original or has a structural placeholder
                if (hasPlaceholder || sizeRatio < 0.4) {
                    const warningMsg = hasPlaceholder 
                        ? `The AI generated code contains potential placeholders (like '...') which will break your file.`
                        : `The new code is significantly smaller than the original (${Math.round(sizeRatio * 100)}% of original size). It might be incomplete.`;
                    
                    const choices = ["Apply Anyway", "Ask AI for Full Code", "Cancel"];
                    const result = await vscode.window.showWarningMessage(
                        `⚠️ Potential Placeholder Detected in ${filePath}: ${warningMsg}`,
                        { modal: true },
                        ...choices
                    );

                    if (result === "Ask AI for Full Code") {
                        if (ChatPanel.currentPanel) {
                            ChatPanel.currentPanel.sendMessage({
                                role: 'user',
                                content: `The code you provided for \`${filePath}\` appears to be incomplete or uses placeholders. Please provide the 100% COMPLETE file content from line 1 to the end, without skipping any sections.`
                            } as any);
                        }
                        return { success: false, error: "AI repair requested" };
                    }
                    if (result !== "Apply Anyway") {
                        return { success: false, error: "User cancelled risky apply" };
                    }
                }
            }

            const document = await vscode.workspace.openTextDocument(fileUri);
            
            // Real-time Disk Verification: Is the content already there?
            if (document.getText() === content) {
                return { success: true, alreadyApplied: true };
            }

            const fullRange = new vscode.Range(new vscode.Position(0, 0), document.lineAt(document.lineCount - 1).range.end);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(fileUri, fullRange, content);
            const applied = await vscode.workspace.applyEdit(edit);

            if (applied) {
                await document.save();
                if (!options?.silent) {
                    await openDiffView(fileUri, originalContent);
                }
                return { success: true, alreadyApplied: false };
            }
            return { success: false, error: "VS Code failed to apply the WorkspaceEdit. The file might be locked or read-only." };

        } catch (e: any) {
            Logger.error(`Error applying file content: ${e.message}`, e);
            vscode.window.showErrorMessage(`Error applying file content: ${e.message}`);
            return { success: false, error: e.message };
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

    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.replaceCode', async (filePath: string, content: string, panel?: any, messageId?: string, options?: { silent?: boolean, blockIndex?: number, hunkIndex?: number }): Promise<{ success: boolean, error?: string, repaired?: boolean }> => {
        const activeWorkspace = getActiveWorkspace();
        if (!activeWorkspace) return { success: false, error: "No active workspace" };

        const fileUri = vscode.Uri.joinPath(activeWorkspace.uri, filePath);

        // CRITICAL: Force VS Code to provide the absolute current state of the document
        // This prevents "Apply All" from failing due to stale text buffers.
        let document: vscode.TextDocument;
        try {
            document = await vscode.workspace.openTextDocument(fileUri);
            if (document.isDirty) {
                await document.save();
            }
        } catch (e) {
            return { success: false, error: `Could not open file ${filePath}` };
        }

        const aiderRegex = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/gm;
        let matches = [...content.matchAll(aiderRegex)];
        
        if (matches.length === 0) {
             if (!options?.silent) vscode.window.showErrorMessage("No valid Search/Replace blocks found. Ensure markers start at the beginning of the line.");
             return { success: false, error: "Invalid Aider block format" };
        }

        // If a specific hunk is requested (Bulk Apply mode), only process that one
        if (options?.hunkIndex !== undefined && matches[options.hunkIndex]) {
            matches = [matches[options.hunkIndex]];
        }
        
        try {
            let currentContent = "";
            let fileExists = false;
            try {
                await vscode.workspace.fs.stat(fileUri);
                const document = await vscode.workspace.openTextDocument(fileUri);
                currentContent = document.getText();
                fileExists = true;
            } catch {
                currentContent = "";
                fileExists = false;
            }

            const originalContent = currentContent;
            let applyCount = 0;

            for (const match of matches) {
                const searchCode = match[1];
                const replaceCode = match[2];
                
                // --- SPECIAL CASE: EMPTY SEARCH BLOCK ---
                // If search is empty, treat as "Create File" if new, or "Append to end" if existing.
                if (searchCode.trim() === "") {
                    const eol = currentContent.includes('\r\n') ? '\r\n' : '\n';
                    if (!fileExists && applyCount === 0) {
                        currentContent = replaceCode;
                    } else {
                        // Append to the very end of the current content
                        currentContent = currentContent.trimEnd() + eol + replaceCode;
                    }
                    applyCount++;
                    continue;
                }

                // Idempotency check: If content is already present, count as success
                if (currentContent.includes(replaceCode.trim())) {
                    applyCount++;
                    continue; 
                }

                const result = applySearchReplace(currentContent, searchCode, replaceCode);

                if (result.success) {
                    currentContent = result.result;
                    applyCount++;
                } else {
                    const fixBtn = "Fix with AI";
                    const isAutoFixEnabled = panel?._discussionCapabilities?.autoFix !== false;

                    // 1. If AutoFix is disabled, just report the error and stop.
                    if (!isAutoFixEnabled) {
                        if (!options?.silent) {
                            vscode.window.showErrorMessage(`Failed to apply patch to ${filePath}: ${result.error}`);
                        }
                        return { success: false, error: result.error };
                    }

                    // 2. If enabled, proceed with the UI prompt or silent repair
                    const selection = options?.silent ? fixBtn : await vscode.window.showErrorMessage(
                        `Could not apply search/replace block in ${filePath}: ${result.error}`,
                        fixBtn, "Cancel"
                    );

                    if (selection === fixBtn && panel && messageId) {
                        // --- ENHANCED SILENT REPAIR ---
                        return await vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: `Lollms: Repairing block for ${filePath}...`,
                            cancellable: true
                        }, async (progress, token) => {
                            const abortController = new AbortController();
                            token.onCancellationRequested(() => abortController.abort());

                            const repairPrompt = `### 🛑 SEARCH/REPLACE FAILURE REPORT
The following block failed to apply to \`${filePath}\`.

**CRITICAL ERROR:** 
"${result.error}"

**YOUR PREVIOUS ATTEMPT:**
\`\`\`
${match[0]}
\`\`\`

**ACTUAL FILE CONTENT (REFERENCE):**
\`\`\`
${originalContent}
\`\`\`

**INSTRUCTIONS FOR REPAIR:**
1. Your SEARCH block was NOT a literal, character-for-character match of the file content.
2. Check for **indentation differences** (spaces vs tabs) and **trailing whitespace**.
3. Provide the CORRECTED block. Include 2-3 lines of unchanged context in the SEARCH section to ensure a unique match.
4. Output **ONLY** the corrected \`<<<<<<< SEARCH ... >>>>>>> REPLACE\` block. Do not wrap it in other code blocks.
`;
                            
                            try {
                                const response = await panel._lollmsAPI.sendChat([
                                    { role: 'system', content: "You are a surgical code repair engine. You only output valid Aider-style Search/Replace blocks." },
                                    { role: 'user', content: repairPrompt }
                                ], null, abortController.signal);

                                if (token.isCancellationRequested) return { success: false, error: "Cancelled" };

                                // Robust Block Extraction
                                let fixedBlock = "";
                                const startTag = "<<<<<<< SEARCH";
                                const endTag = ">>>>>>> REPLACE";
                                
                                const startIdx = response.indexOf(startTag);
                                const endIdx = response.indexOf(endTag);

                                if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
                                    fixedBlock = response.substring(startIdx, endIdx + endTag.length);
                                }

                                if (fixedBlock) {
                                    // 1. Update the message content in the UI
                                    const currentDiscussion = panel.getCurrentDiscussion();
                                    if (currentDiscussion) {
                                        const msg = currentDiscussion.messages.find((m: any) => m.id === messageId);
                                        if (msg && typeof msg.content === 'string') {
                                            const updatedContent = msg.content.replace(match[0], fixedBlock);
                                            await panel.updateMessageContent(messageId, updatedContent);
                                        }
                                    }

                                    // 2. Automatically retry applying the NEW content
                                    if (token.isCancellationRequested) return { success: false, error: "Cancelled" };
                                    
                                    vscode.window.showInformationMessage(vscode.l10n.t("Block repaired. Retrying apply..."));
                                    return await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', filePath, fixedBlock, panel, messageId, { silent: true });
                                } else {
                                    vscode.window.showWarningMessage(
                                        vscode.l10n.t("Lollms: The AI suggested a fix but the response format was unrecognizable.")
                                    );
                                    return { success: false, error: "AI repair produced invalid format" };
                                }
                            } catch (err: any) {
                                vscode.window.showErrorMessage(`Repair failed: ${err.message}`);
                                return { success: false, error: `Repair failed: ${err.message}` };
                            }
                        });
                    }
                    return { success: false, error: result.error };
                }
            }

            if (applyCount > 0) {
                const wasActuallyModified = currentContent !== originalContent;

                const parentDir = path.dirname(filePath);
                const parentUri = vscode.Uri.joinPath(activeWorkspace.uri, parentDir);
                // Fix: ensure the directory creation actually happens
                await vscode.workspace.fs.createDirectory(parentUri);

                await vscode.workspace.fs.writeFile(fileUri, Buffer.from(currentContent, 'utf8'));
                
                if (!options?.silent && wasActuallyModified) {
                    openDiffView(fileUri, originalContent).catch(() => {});
                }
                return { success: true, alreadyApplied: !wasActuallyModified };
            }
            return { success: false, error: "Failed to apply edits to document." };

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

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.verifyHunks', async (changes: any[]): Promise<Record<string, 'applied' | 'ready' | 'incompatible'>> => {
        const activeWorkspace = getActiveWorkspace();
        if (!activeWorkspace) return {};

        const results: Record<string, 'applied' | 'ready' | 'incompatible'> = {};

        for (const change of changes) {
            const fileUri = vscode.Uri.joinPath(activeWorkspace.uri, change.path);
            const key = `${change.blockIndex}-${change.hunkIndex ?? 'full'}`;
            
            try {
                const doc = await vscode.workspace.openTextDocument(fileUri);
                const currentContent = doc.getText();
                const normalizedDoc = currentContent.replace(/\s+/g, ' ').trim();

                const rawContent = change.content || "";
                const isAider = rawContent.includes('<<<<<<< SEARCH');

                if (isAider) {
                    const aiderRegex = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/gm;
                    const matches = [...rawContent.matchAll(aiderRegex)];
                    
                    // If verifying a specific hunk from the list
                    if (change.hunkIndex !== undefined && matches[change.hunkIndex]) {
                        const searchPart = matches[change.hunkIndex][1].replace(/\s+/g, ' ').trim();
                        const replacePart = matches[change.hunkIndex][2].replace(/\s+/g, ' ').trim();

                        if (normalizedDoc.includes(replacePart)) {
                            results[key] = 'applied';
                        } else if (normalizedDoc.includes(searchPart) || searchPart === "") {
                            results[key] = 'ready';
                        } else {
                            results[key] = 'incompatible';
                        }
                    } else {
                        // Verifying whole block: all hunks must be applied to be 'applied'
                        let allApplied = true;
                        let allReady = true;

                        for (const match of matches) {
                            const s = match[1].replace(/\s+/g, ' ').trim();
                            const r = match[2].replace(/\s+/g, ' ').trim();
                            if (!normalizedDoc.includes(r)) allApplied = false;
                            if (!normalizedDoc.includes(s) && s !== "") allReady = false;
                        }

                        if (allApplied) results[key] = 'applied';
                        else if (allReady) results[key] = 'ready';
                        else results[key] = 'incompatible';
                    }
                } else {
                    // Full file or snippet check
                    const cleanTarget = rawContent.replace(/```\w*\n?/, '').replace(/\n?```$/, '').replace(/\s+/g, ' ').trim();
                    if (normalizedDoc.includes(cleanTarget)) {
                        results[key] = 'applied';
                    } else {
                        results[key] = 'ready'; // Snippets are usually ready to be inserted
                    }
                }
            } catch {
                results[key] = 'incompatible';
            }
        }
        return results;
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
