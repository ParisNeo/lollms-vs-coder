import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { debugErrorManager } from '../extensionState';
import { startDiscussionWithInitialPrompt } from '../utils/discussionUtils';
import { ChatPanel } from '../commands/chatPanel/chatPanel';

export function registerDebugCommands(context: vscode.ExtensionContext, services: LollmsServices, getActiveWorkspace: () => vscode.WorkspaceFolder | undefined) {
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.fixDiagnostic', async (uri: vscode.Uri, diagnostic: vscode.Diagnostic) => {
        try {
            const document = await vscode.workspace.openTextDocument(uri);
            const range = diagnostic.range;
            const startLine = Math.max(0, range.start.line - 10);
            const endLine = Math.min(document.lineCount - 1, range.end.line + 10);
            const contextText = document.getText(new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).range.end.character));
            const relativePath = vscode.workspace.asRelativePath(uri);
            const prompt = `I have a ${diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning'} in my code.\n\n**File:** \`${relativePath}\`\n**Line:** ${range.start.line + 1}\n**Diagnostic Message:** ${diagnostic.message}\n\n**Code Context:**\n\`\`\`${document.languageId}\n${contextText}\n\`\`\`\n\nPlease analyze this issue and suggest a fix. Provide the corrected code.`;
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
        
        // We do NOT fetch the full context content here, as the ChatPanel will inject it into the system prompt.
        // We only check if the specific file needs to be added manually.
        const includedFiles = services.contextManager.getContextStateProvider()?.getIncludedFiles().map(f => f.path) || [];
        
        let prompt = "";

        // 1. File Content (if NOT in context)
        if (error.filePath) {
            const errorFileRelative = vscode.workspace.asRelativePath(error.filePath);
            const isFileInContext = includedFiles.includes(errorFileRelative);

            if (!isFileInContext) {
                try {
                    const document = await vscode.workspace.openTextDocument(error.filePath);
                    const fileContent = document.getText();
                    prompt += `**Content of ${errorFileRelative} (Not in context):**\n\`\`\`${document.languageId}\n${fileContent}\n\`\`\`\n\n`;
                } catch (e) {
                    prompt += `(Could not read content of ${errorFileRelative})\n\n`;
                }
            }
        }

        // 2. Error Details
        prompt += `I encountered an exception while debugging my code.\n\n**Error Message:**\n${error.message}\n\n**Location:**\nFile: \`${error.filePath?.fsPath}\`\nLine: ${error.line}\n\n**Stack Trace:**\n\`\`\`\n${error.stack || 'No stack trace available'}\n\`\`\`\n\n`;

        // 3. Instructions
        prompt += `Please analyze the error and provide a fix.`;
        
        if (getActiveWorkspace()) {
            await startDiscussionWithInitialPrompt(services, prompt, getActiveWorkspace()!);
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
