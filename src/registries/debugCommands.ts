import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { debugErrorManager } from '../extensionState';
import { startDiscussionWithInitialPrompt } from '../utils/discussionUtils';
import { ChatPanel } from '../commands/chatPanel/chatPanel';

export function registerDebugCommands(context: vscode.ExtensionContext, services: LollmsServices, getActiveWorkspace: () => vscode.WorkspaceFolder | undefined) {
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.fixDiagnosticAtPosition', async (pos?: vscode.Position) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        
        // Use the passed position (from hover) or fallback to current cursor
        const position = pos ? new vscode.Position(pos.line, pos.character) : editor.selection.active;
        const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
        
        // Find the diagnostic at the specified position
        const diagnostic = diagnostics.find(d => d.range.contains(position));
        
        if (diagnostic) {
            await vscode.commands.executeCommand('lollms-vs-coder.fixDiagnostic', editor.document.uri, diagnostic);
        } else {
            vscode.window.showInformationMessage("No code issue found at the current cursor position.");
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.fixDiagnostic', async (uri: vscode.Uri, diagnostic: vscode.Diagnostic) => {
        try {
            const document = await vscode.workspace.openTextDocument(uri);
            const range = diagnostic.range;
            const errorLine = range.start.line + 1;
            
            // 1. Build a visual code snippet with pointers and line numbers
            const startLine = Math.max(0, range.start.line - 10);
            const endLine = Math.min(document.lineCount - 1, range.end.line + 10);
            
            let codeSnippet = "";
            for (let i = startLine; i <= endLine; i++) {
                const lineText = document.lineAt(i).text;
                const lineNum = i + 1;
                // Highlight the line if it falls within the diagnostic range
                const isTarget = (i >= range.start.line && i <= range.end.line);
                codeSnippet += `${isTarget ? ' -> ' : '    '}${lineNum.toString().padStart(4)} | ${lineText}\n`;
            }

            const relativePath = vscode.workspace.asRelativePath(uri);
            const severityLabel = diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : 'WARNING';

            let prompt = `### ⚠️ CODE ${severityLabel} DETECTED\n\n`;
            prompt += `**File:** \`${relativePath}\`\n`;
            prompt += `**Message:** \`${diagnostic.message}\`\n\n`;
            prompt += `#### 🔍 CODE CONTEXT (Line ${errorLine})\n`;
            prompt += `\`\`\`${document.languageId}\n${codeSnippet}\`\`\`\n\n`;
            prompt += `**TASK:**\n`;
            prompt += `1. Identify the cause of the ${severityLabel.toLowerCase()} at the highlighted line(s).\n`;
            prompt += `2. Suggest a concise fix using the **SEARCH/REPLACE (AIDER)** format if possible.\n`;

            const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
            if (workspaceFolder) {
                 await startDiscussionWithInitialPrompt(services, prompt, workspaceFolder);
            } else if (getActiveWorkspace()) {
                 await startDiscussionWithInitialPrompt(services, prompt, getActiveWorkspace()!);
            } else {
                vscode.window.showErrorMessage("No workspace folder found for this file.");
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to open file for diagnostic fix: ${e.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.debugErrorWithAI', async () => {
        const error = debugErrorManager.lastError;
        if (!error) return;

        // 1. Deactivate the debugger
        await vscode.commands.executeCommand('workbench.action.debug.stop');

        // 2. Deactivate the debug badge if it's active
        if (ChatPanel.currentPanel) {
            await ChatPanel.currentPanel.updateCapabilities({ debugMode: false });
        }
        
        const includedFiles = services.contextManager.getContextStateProvider()?.getIncludedFiles().map(f => f.path) || [];
        
        let prompt = `### 🛑 RUNTIME EXCEPTION DETECTED\n\n`;
        prompt += `**Error:** \`${error.message}\`\n`;

        // 1. Precise Code Snippet Extraction
        if (error.filePath && error.line) {
            try {
                const document = await vscode.workspace.openTextDocument(error.filePath);
                const relPath = vscode.workspace.asRelativePath(error.filePath);
                
                const startLine = Math.max(0, error.line - 6);
                const endLine = Math.min(document.lineCount - 1, error.line + 4);
                
                let codeSnippet = "";
                for (let i = startLine; i <= endLine; i++) {
                    const lineText = document.lineAt(i).text;
                    const lineNum = i + 1;
                    const isErrorLine = lineNum === error.line;
                    
                    // Add a visual pointer and highlight the error line
                    codeSnippet += `${isErrorLine ? ' -> ' : '    '}${lineNum.toString().padStart(4)} | ${lineText}\n`;
                }

                prompt += `**Location:** \`${relPath}\` at Line ${error.line}\n\n`;
                prompt += `#### 🔍 CODE CONTEXT\n`;
                prompt += `\`\`\`${document.languageId}\n${codeSnippet}\`\`\`\n\n`;

                // If file is not in context, offer full file as well
                if (!includedFiles.includes(relPath)) {
                    prompt += `*(Note: The full content of this file is currently hidden from your primary context. Refer to the snippet above or use \`read_file\` if needed.)*\n\n`;
                }
            } catch (e) {
                prompt += `**Location:** \`${error.filePath.fsPath}\` (File could not be read)\n\n`;
            }
        }

        // 2. Live State (Locals)
        if (error.locals) {
            prompt += `#### 🧪 RUNTIME STATE (LOCALS)\n`;
            prompt += `Values at moment of crash:\n`;
            prompt += `\`\`\`\n${error.locals}\n\`\`\`\n\n`;
        }

        // 3. Stack Trace
        if (error.stack) {
            prompt += `#### 📜 STACK TRACE\n`;
            prompt += `\`\`\`\n${error.stack}\n\`\`\`\n\n`;
        }

        // 4. Critical Instructions
        prompt += `**TASK:**\n`;
        prompt += `1. Analyze the code snippet and the error message.\n`;
        prompt += `2. Use the runtime variables to understand why the logic failed at the highlighted line.\n`;
        prompt += `3. Provide a fix using the **SEARCH/REPLACE (AIDER)** format if the file is in context, or provide the corrected code block.\n`;

        if (getActiveWorkspace()) {
            await startDiscussionWithInitialPrompt(services, prompt, getActiveWorkspace()!);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.debugErrorSendToDiscussion', async () => {
        const error = debugErrorManager.lastError;
        if (!error || !error.filePath) {
            vscode.window.showWarningMessage("No debug error with source captured.");
            return;
        }

        const panel = ChatPanel.currentPanel;
        if (!panel) {
            vscode.window.showErrorMessage("Open a Lollms chat first.");
            return;
        }

        let sourceLine = "";
        let langId = "plaintext";
        try {
            const doc = await vscode.workspace.openTextDocument(error.filePath);
            langId = doc.languageId;
            if (error.line && error.line <= doc.lineCount) {
                sourceLine = doc.lineAt(error.line - 1).text;
            }
        } catch (e) {}

        const reportData = {
            message: error.message,
            file: vscode.workspace.asRelativePath(error.filePath),
            line: error.line,
            code: sourceLine,
            language: langId,
            variables: error.locals,
            stack: error.stack
        };

        // Wrap in a custom tag for the specialized renderer
        const errorText = `<debug_report data='${JSON.stringify(reportData).replace(/'/g, "&apos;")}' />\n\nPlease analyze this error and suggest a fix.`;

        await panel.addMessageToDiscussion({
            id: 'user_debug_err_' + Date.now(),
            role: 'user',
            content: errorText
        });

        panel._panel.reveal();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.fixFileErrors', async (uri?: vscode.Uri) => {
        const targetUri = uri || vscode.window.activeTextEditor?.document.uri;
        if (!targetUri) {
            vscode.window.showErrorMessage("No file selected.");
            return;
        }

        const diagnostics = vscode.languages.getDiagnostics(targetUri);
        const issues = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning);

        if (issues.length === 0) {
            vscode.window.showInformationMessage("No errors or warnings found in this file.");
            return;
        }

        try {
            const document = await vscode.workspace.openTextDocument(targetUri);
            const fileContent = document.getText();
            const relativePath = vscode.workspace.asRelativePath(targetUri);

            let prompt = `I have ${issues.length} issue(s) (errors/warnings) in \`${relativePath}\`.\n\n`;
            
            prompt += `**Issues:**\n`;
            issues.forEach((issue, index) => {
                const line = issue.range.start.line + 1;
                const severity = issue.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning';
                prompt += `${index + 1}. [Line ${line}] ${severity}: ${issue.message} (${issue.source || 'unknown'})\n`;
            });

            prompt += `\n**File Content:**\n\`\`\`${document.languageId}\n${fileContent}\n\`\`\`\n\n`;
            prompt += `Please analyze these issues and provide the corrected code.`;

            const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetUri) || getActiveWorkspace();
            
            if (workspaceFolder) {
                // Automatically add the file to context so AI has full awareness
                await vscode.commands.executeCommand('lollms-vs-coder.setContextIncluded', targetUri, [targetUri]);
                
                await startDiscussionWithInitialPrompt(services, prompt, workspaceFolder);
            } else {
                vscode.window.showErrorMessage("No workspace folder found for this file.");
            }

        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to process file: ${e.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.inspectCode', async (args?: { code: string, language: string }) => {
        if (!ChatPanel.currentPanel) {
            vscode.window.showErrorMessage("Please open a Lollms chat panel to show inspection results.");
            return;
        }
        if (args && args.code) {
            ChatPanel.currentPanel.handleInspectCode(args);
        } else {
            const editor = vscode.window.activeTextEditor;
            if (editor && !editor.selection.isEmpty) {
                const code = editor.document.getText(editor.selection);
                const language = editor.document.languageId;
                ChatPanel.currentPanel.handleInspectCode({ code, language });
            }
        }
    }));
}
