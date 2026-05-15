import * as vscode from 'vscode';
import * as path from 'path';
import { LollmsServices } from '../lollmsContext';
import { applyDiff, applySearchReplace } from '../utils';
import { normalizeToDocument } from '../utils/promptUtils';
import { Logger } from '../logger';
import { ChatPanel } from '../commands/chatPanel/chatPanel';

export function registerFileCommands(context: vscode.ExtensionContext, services: LollmsServices, getActiveWorkspace: () => vscode.WorkspaceFolder | undefined) {

    const lastSnapshotWrite = new Map<string, number>();

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
    async function openDiffView(fileUri: vscode.Uri, originalContent: string, snapshotOnly: boolean = false) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
        if (!workspaceFolder) return;
        
        const snapshotsDir = vscode.Uri.joinPath(workspaceFolder.uri, '.lollms', 'snapshots');
        try {
            await vscode.workspace.fs.createDirectory(snapshotsDir);
        } catch (e) {}
        
        const fileName = path.basename(fileUri.fsPath);
        // Use hash of path to avoid filename collisions in snapshots dir
        const crypto = require('crypto');
        const hash = crypto.createHash('md5').update(fileUri.fsPath).digest('hex').substring(0, 8);
        const snapshotUri = vscode.Uri.joinPath(snapshotsDir, `${hash}_${fileName}.orig`);
        
        const now = Date.now();
        const lastWrite = lastSnapshotWrite.get(snapshotUri.toString()) || 0;

        // Overwrite if it's been more than 5 seconds since the last snapshot write
        // This ensures a new AI interaction creates a fresh baseline, while a fast
        // "Apply All" batch preserves the baseline from the start of the batch.
        if (now - lastWrite > 5000) {
            await vscode.workspace.fs.writeFile(snapshotUri, Buffer.from(originalContent, 'utf8'));
            lastSnapshotWrite.set(snapshotUri.toString(), now);
        } else {
            try {
                await vscode.workspace.fs.stat(snapshotUri);
            } catch {
                await vscode.workspace.fs.writeFile(snapshotUri, Buffer.from(originalContent, 'utf8'));
                lastSnapshotWrite.set(snapshotUri.toString(), now);
            }
        }

        if (snapshotOnly) return;

        // Open the Diff Editor
        const title = `${fileName} (Original) ↔ ${fileName} (Proposed)`;
        await vscode.commands.executeCommand('vscode.diff', snapshotUri, fileUri, title, { 
            preview: false,
            preserveFocus: false
        });
    }

    // New command to allow webview to request a diff for a specific file
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showDiff', async (filePath: string) => {
        const activeWorkspace = getActiveWorkspace();
        if (!activeWorkspace) return;

        let fileUri: vscode.Uri;
        if (path.isAbsolute(filePath)) {
            fileUri = vscode.Uri.file(filePath);
        } else {
            fileUri = vscode.Uri.joinPath(activeWorkspace.uri, filePath);
        }

        try {
            const doc = await vscode.workspace.openTextDocument(fileUri);
            await openDiffView(fileUri, doc.getText());
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to open diff for ${filePath}: ${e.message}`);
        }
    }));
    /**
     * Intelligent Workspace Resolver.
     * Maps namespaced paths (Folder/path) to URIs.
     * Falls back to "The Old Way" if no workspace is open.
     */
        /**
     * Intelligent Workspace Resolver.
     * Maps namespaced paths (Folder/path) to URIs.
     */
    /**
     * Strict Namespace Resolver for Multi-Root Workspaces.
     * Enforces that paths must start with the Project Name if multiple roots exist.
     */
    async function resolveWorkspaceFromPath(namespacedPath: string): Promise<{ folder: vscode.WorkspaceFolder | undefined, relativePath: string, uri: vscode.Uri } | null> {
        const folders = vscode.workspace.workspaceFolders || [];
        const normalized = namespacedPath.replace(/\\/g, '/').trim();
        const segments = normalized.split('/');

        if (path.isAbsolute(normalized)) {
            const uri = vscode.Uri.file(normalized);
            return { folder: vscode.workspace.getWorkspaceFolder(uri), relativePath: normalized, uri };
        }

        // --- MULTI-ROOT NAMESPACE ENFORCEMENT ---
        // Priority 1: Exact Namespace Match (ProjectName/path)
        const projectFolder = folders.find(f => f.name === segments[0]);
        if (projectFolder && segments.length > 1) {
            const relativeToRoot = segments.slice(1).join('/');
            const uri = vscode.Uri.joinPath(projectFolder.uri, relativeToRoot);
            // Verify existence for namespaced path
            try {
                await vscode.workspace.fs.stat(uri);
                return { folder: projectFolder, relativePath: relativeToRoot, uri };
            } catch {
                // If it doesn't exist at the namespaced path, it might be a new file 
                // we are intending to create. Return the resolved info.
                return { folder: projectFolder, relativePath: relativeToRoot, uri };
            }
        }

        // Priority 2: Relative path existence check across all roots
        for (const folder of folders) {
            const testUri = vscode.Uri.joinPath(folder.uri, normalized);
            try {
                await vscode.workspace.fs.stat(testUri);
                return { folder, relativePath: normalized, uri: testUri };
            } catch {}
        }

        // --- SINGLE ROOT FLEXIBLE RESOLUTION ---
        const activeFolder = getActiveWorkspace() || folders[0];
        if (activeFolder) {
            // 1. Try absolute match (folder/path)
            const uriDirect = vscode.Uri.joinPath(activeFolder.uri, normalized);
            try {
                await vscode.workspace.fs.stat(uriDirect);
                return { folder: activeFolder, relativePath: normalized, uri: uriDirect };
            } catch {
                // 2. Try stripped match if namespaced (ProjectName/path -> path)
                if ((segments[0] === activeFolder.name || segments[0] === activeFolder.uri.fsPath.split(/[\\\/]/).pop()) && segments.length > 1) {
                    const relStripped = segments.slice(1).join('/');
                    const uriStripped = vscode.Uri.joinPath(activeFolder.uri, relStripped);
                    try {
                        await vscode.workspace.fs.stat(uriStripped);
                        return { folder: activeFolder, relativePath: relStripped, uri: uriStripped };
                    } catch { 
                        // Even if it doesn't exist yet (new file), if the first segment matches the project name, 
                        // we should treat the rest as the relative path to avoid doubling.
                        return { folder: activeFolder, relativePath: relStripped, uri: uriStripped };
                    }
                }
            }

            // 3. Fallback for new files: Use the most logical relative path
            let finalRel = normalized;
            if (segments[0] === activeFolder.name && segments.length > 1) {
                finalRel = segments.slice(1).join('/');
            }
            return { 
                folder: activeFolder, 
                relativePath: finalRel, 
                uri: vscode.Uri.joinPath(activeFolder.uri, finalRel) 
            };
        }

        return null;
    }

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.applyFileContent', async (filePath: string, content: string, options?: { silent?: boolean, autoSave?: boolean }) => {
        // Clean up hallucinated metadata like "(2 hunks)" from the file path
        const sanitizedFilePath = filePath.replace(/\s*\(\d+\s*hunks?\)/i, '').trim();
        
        // Handle Member-Targeted Replacement (path/to/file:ClassName:MethodName)
        let targetMember: string[] =[];
        let cleanPath = sanitizedFilePath;

        if (sanitizedFilePath.includes(':')) {
            const parts = sanitizedFilePath.split(':');
            cleanPath = parts[0];
            targetMember = parts.slice(1);
        }

        const resolution = await services.contextManager.resolveWorkspaceFromPath(cleanPath);
        if (!resolution) {
            vscode.window.showErrorMessage("Could not resolve path: " + filePath);
            return { success: false, error: "Invalid path" };
        }
        
        const { folder, relativePath } = resolution;
        
        try {
            const fileUri = folder 
                ? vscode.Uri.joinPath(folder.uri, relativePath) 
                : vscode.Uri.file(relativePath);
            let originalContent = '';
            let fileExists = false;
            let document: vscode.TextDocument | undefined;

            try {
                await vscode.workspace.fs.stat(fileUri);
                document = await vscode.workspace.openTextDocument(fileUri);
                originalContent = document.getText();
                // Ensure a snapshot exists for diffing later
                await openDiffView(fileUri, originalContent, true); 
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
            if (fileExists && !options?.autoSave) {
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

            // Open Diff View: Original (Disk) vs Proposed (Virtual)
            if (options?.autoSave && document) {
                const edit = new vscode.WorkspaceEdit();
                const lastLine = document.lineCount > 0 ? document.lineCount - 1 : 0;
                const fullRange = new vscode.Range(
                    new vscode.Position(0, 0),
                    document.lineAt(lastLine).range.end
                );
                edit.replace(fileUri, fullRange, content);
                const applied = await vscode.workspace.applyEdit(edit);
                if (applied) {
                    await document.save();
                }
            }

            // The user must review and Save the diff tab to apply changes.
            if (!options?.silent) {
                // Determine discussionId from active panel if available
                const discussionId = ChatPanel.currentPanel?.getCurrentDiscussion()?.id;
                await services.diffManager.openDiff(fileUri, content, discussionId);
            }

            return { success: true, alreadyApplied: !!options?.autoSave };

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

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.saveDraftAsset', async (params: { dataUri: string, suggestedPath: string }) => {
        const activeWorkspace = getActiveWorkspace();
        if (!activeWorkspace) return;

        const defaultUri = vscode.Uri.joinPath(activeWorkspace.uri, params.suggestedPath);
        const ext = path.extname(params.suggestedPath).substring(1) || 'png';

        const targetUri = await vscode.window.showSaveDialog({
            defaultUri: defaultUri,
            filters: { 'Images': [ext], 'All Files': ['*'] },
            saveLabel: 'Commit Asset to Workspace'
        });

        if (targetUri) {
            try {
                const base64Data = params.dataUri.split(',')[1];
                await vscode.workspace.fs.writeFile(targetUri, Buffer.from(base64Data, 'base64'));
                
                // Add to context so LLM knows it exists now
                const relPath = vscode.workspace.asRelativePath(targetUri);
                await vscode.commands.executeCommand('lollms-vs-coder.addFilesToContext', [relPath]);
                
                vscode.window.showInformationMessage(`Asset saved and synced: ${relPath}`);
            } catch (e: any) {
                vscode.window.showErrorMessage(`Save failed: ${e.message}`);
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.saveAssetAs', async (params: { path: string }) => {
        const activeWorkspace = getActiveWorkspace();
        if (!activeWorkspace || !params.path) return;

        const sourceUri = vscode.Uri.joinPath(activeWorkspace.uri, params.path);
        const fileName = path.basename(params.path);
        const ext = path.extname(fileName).substring(1);

        const targetUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(fileName),
            filters: { 'Images': [ext], 'All Files': ['*'] },
            saveLabel: 'Export Asset'
        });

        if (targetUri) {
            try {
                await vscode.workspace.fs.copy(sourceUri, targetUri, { overwrite: true });
                vscode.window.showInformationMessage(`Asset exported to ${path.basename(targetUri.fsPath)}`);
            } catch (e: any) {
                vscode.window.showErrorMessage(`Export failed: ${e.message}`);
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
                
                const applied = await vscode.workspace.applyEdit(edit);
                if (applied) {
                    await originalDoc.save();
                    
                    // Close the diff tab before cleaning up the file
                    if (vscode.window.activeTextEditor?.document.uri.toString() === generatedUri.toString()) {
                        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                    }
                    
                    // Clean up: This deletes the file from disk
                    await services.diffManager.cleanup(generatedUri);
                    
                    await vscode.window.showTextDocument(originalDoc);
                    vscode.window.showInformationMessage("Changes accepted.");
                }
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

    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.replaceCode', async (filePath: string, content: string, panel?: any, messageId?: string, options?: { silent?: boolean, blockIndex?: number, hunkIndex?: number, autoSave?: boolean, undo?: boolean }): Promise<{ success: boolean; error?: string; repaired?: boolean; alreadyApplied?: boolean }> => {
        // Clean up hallucinated metadata
        const sanitizedFilePath = filePath.replace(/\s*\(\d+\s*hunks?\)/i, '').trim();
        const isUndo = options?.undo === true;
        Logger.info(`Executing replaceCode (${isUndo ? 'UNDO' : 'APPLY'}) for: ${sanitizedFilePath}`);

        const folders = vscode.workspace.workspaceFolders || [];

        // Handle "REPAIR_REQUESTED" signal from UI
        if (content === "REPAIR_REQUESTED" && (!options || options.hunkIndex === undefined)) {
            Logger.warn("ReplaceCode called with REPAIR signal but no hunk index. Aborting.");
            return { success: false, error: "Invalid repair context" };
        }

        // Multi-root aware resolution
        const resolution = await services.contextManager.resolveWorkspaceFromPath(sanitizedFilePath);
        if (!resolution || !resolution.uri) {
            Logger.error(`Resolution failed for path: ${sanitizedFilePath}`);
            return { success: false, error: "Invalid path or workspace not found" };
        }

        const { uri: fileUri } = resolution;

        // Standardize on using the TextDocument throughout the whole command
        let document: vscode.TextDocument;
        let fileExists = true;
        try {
            document = await vscode.workspace.openTextDocument(fileUri);
        } catch (e) {
            // Handle new file creation
            fileExists = false;
            const parentDir = path.dirname(fileUri.fsPath);
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(parentDir));
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from('', 'utf8'));
            document = await vscode.workspace.openTextDocument(fileUri);
        }

        // Improved Regex: Allows for optional spaces before markers and handles \r?\n more gracefully
        // Also supports blocks that might have been accidentally double-wrapped
        const normalizedContent = content.replace(/^\s*(<<<<<<< SEARCH|=======|>>>>>>> REPLACE)/gm, '$1');
        const aiderRegex = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
        let matches = [...normalizedContent.matchAll(aiderRegex)];

        if (matches.length === 0) {
            // DEEP SCAN: If no blocks found at start of lines, try a less restrictive match 
            // for models that put chatter inside the code block
            const permissiveRegex = /<<<<<<< SEARCH[\s\S]*?=======[\s\S]*?>>>>>>> REPLACE/g;
            matches = [...normalizedContent.matchAll(permissiveRegex)];

            if (matches.length === 0) {
                if (!options?.silent) vscode.window.showErrorMessage("No valid Search/Replace blocks found.");
                return { success: false, error: "Invalid Aider block format: Markers must be on their own lines." };
            }
        }

        if (options?.hunkIndex !== undefined && matches[options.hunkIndex]) {
            matches = [matches[options.hunkIndex]];
        }
        
        try {
            // Force a refresh of the document in case it was modified by a previous hunk in a bulk operation
            if (options?.autoSave) {
                await vscode.commands.executeCommand('workbench.action.files.save');
            }

            const originalContent = document.getText();
            await openDiffView(fileUri, originalContent, true); // Snapshot for diffs

            let currentContent = originalContent;
            let applyCount = 0;
            let firstChangeLine: number | undefined;
            const errors: string[] = [];

            for (let i = 0; i < matches.length; i++) {
                const match = matches[i];
                // SWAP logic for Undo
                const searchCode = isUndo ? match[2] : match[1];
                const replaceCode = isUndo ? match[1] : match[2];

                // Capture the location of the FIRST match for scrolling
                if (i === 0 && !options?.silent) {
                    const range = findBlockRange(document, searchCode);
                    if (range) {
                        firstChangeLine = document.positionAt(range.start).line;
                    }
                }
                
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
                    Logger.info(`[AiderMatch] Strategy '${result.strategy}' matched block ${i} in ${sanitizedFilePath}`);
                } else {
                    Logger.error(`[AiderMatch] Failed all strategies for block ${i} in ${sanitizedFilePath}. Error: ${result.error}`);
                    errors.push(result.error || "Unknown match error");

                    // IF REPAIR IS REQUESTED (from the manual modal button)
                    if (content === "REPAIR_REQUESTED" && panel && messageId) {
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
                                    return await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', sanitizedFilePath, fixedBlock, panel, messageId, { silent: true });
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

            if (applyCount > 0 || errors.length > 0) {
                const wasActuallyModified = currentContent !== originalContent;

                if (wasActuallyModified) {
                    if (options?.autoSave) {
                        const edit = new vscode.WorkspaceEdit();
                        const fullRange = new vscode.Range(
                            new vscode.Position(0, 0),
                            document.lineAt(document.lineCount - 1).range.end
                        );
                        edit.replace(fileUri, fullRange, currentContent);
                        const applied = await vscode.workspace.applyEdit(edit);
                        if (applied) {
                            await document.save();
                        }
                    }

                    // Use the DiffManager to show the result of the surgical patch
                    if (!options?.silent) {
                        // Determine discussionId from active panel if available
                        const discussionId = ChatPanel.currentPanel?.getCurrentDiscussion()?.id;
                        await services.diffManager.openDiff(fileUri, currentContent, discussionId);
                    }
                }

                if (errors.length > 0) {
                    // Send back the raw content that failed so the UI can populate the manual modal
                    return { 
                        success: false, 
                        error: `Match failure in ${sanitizedFilePath}.`,
                        repaired: false
                    };
                }

                return { success: true, alreadyApplied: !wasActuallyModified || !!options?.autoSave };
            }
            return { success: false, error: "Failed to apply edits to document." };

        } catch(e: any) {
            vscode.window.showErrorMessage(`Error accessing file ${filePath}: ${e.message}`);
            
            return { success: false, error: "Unexpected termination of replaceCode command." };
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
            const applied = await vscode.workspace.applyEdit(edit);
            if (applied) {
                await document.save();
            }

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
            const applied = await vscode.workspace.applyEdit(edit);
            if (applied) {
                await document.save();
            }

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
            edit.deleteFile(uri, { ignoreIfNotExists: true, recursive: true });
        }
        if (await vscode.workspace.applyEdit(edit)) {
            vscode.window.showInformationMessage(`Deleted ${paths.length} file(s)/folder(s).`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.bulkMoveFiles', async (operations: {src: string, dest: string}[]) => {
        const edit = new vscode.WorkspaceEdit();
        let validOps = 0;
        for (const op of operations) {
            const srcRes = await services.contextManager.resolveWorkspaceFromPath(op.src);
            const destRes = await services.contextManager.resolveWorkspaceFromPath(op.dest);

            if (srcRes && destRes) {
                // Ensure parent directory exists for destination
                const destDir = vscode.Uri.joinPath(destRes.uri, '..');
                await vscode.workspace.fs.createDirectory(destDir);

                edit.renameFile(srcRes.uri, destRes.uri, { overwrite: false });
                validOps++;
            }
        }
        if (validOps > 0 && await vscode.workspace.applyEdit(edit)) {
            vscode.window.showInformationMessage(`Moved/Renamed ${validOps} item(s).`);
        } else if (validOps > 0) {
            vscode.window.showErrorMessage(`Failed to apply move operations.`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.bulkCopyFiles', async (operations: {src: string, dest: string}[]) => {
        let successCount = 0;
        for (const op of operations) {
            const srcRes = await services.contextManager.resolveWorkspaceFromPath(op.src);
            const destRes = await services.contextManager.resolveWorkspaceFromPath(op.dest);

            if (srcRes && destRes) {
                try {
                    const destDir = vscode.Uri.joinPath(destRes.uri, '..');
                    await vscode.workspace.fs.createDirectory(destDir);
                    await vscode.workspace.fs.copy(srcRes.uri, destRes.uri, { overwrite: false });
                    successCount++;
                } catch(e: any) {
                    vscode.window.showErrorMessage(`Failed to copy ${op.src} to ${op.dest}: ${e.message}`);
                }
            }
        }
        if (successCount > 0) vscode.window.showInformationMessage(`Copied ${successCount} item(s).`);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.applyPatchContent', async (filePath: string, patchContent: string, options?: { silent?: boolean }) => {
         try {
             const activeWorkspace = getActiveWorkspace();
             if(!activeWorkspace) return;
             
             const fileUri = vscode.Uri.joinPath(activeWorkspace.uri, filePath);
             const doc = await vscode.workspace.openTextDocument(fileUri);
             const originalContent = doc.getText();

             // Parse first hunk line for scrolling
             const hunkMatch = patchContent.match(/@@ -(\d+),/);
             const firstLine = hunkMatch ? parseInt(hunkMatch[1], 10) - 1 : 0;

             try {
                // applyDiff now handles explicit saving internally
                await applyDiff(patchContent, filePath); 
                
                if (!options?.silent) {
                    // Scroll to the patch location
                    const editor = await vscode.window.showTextDocument(doc);
                    const pos = new vscode.Position(Math.max(0, firstLine), 0);
                    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                }

             } catch (diffErr: any) {
                const fixBtn = "Fix with AI";
                const selection = options?.silent ? fixBtn : await vscode.window.showErrorMessage(
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
             
             if (!options?.silent) {
                await openDiffView(fileUri, originalContent);
                vscode.window.showInformationMessage(`Patch applied successfully to ${filePath}. Review changes.`);
             }
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
                    const aiderRegex = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
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
