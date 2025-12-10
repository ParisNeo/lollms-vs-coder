import * as vscode from 'vscode';
import { LollmsAPI } from './lollmsAPI';
import { InlineDiffProvider } from './commands/inlineDiffProvider';
import { stripThinkingTags } from './utils';
import { CompanionPanel } from './commands/companionPanel';

export class QuickEditManager {
    constructor(
        private lollmsAPI: LollmsAPI,
        private inlineDiffProvider: InlineDiffProvider
    ) {}

    public async triggerQuickEdit() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('Please open a file to use Companion.');
            return;
        }

        const selection = editor.selection;
        const selectedText = editor.document.getText(selection);
        const hasSelection = !selection.isEmpty && selectedText.trim().length > 0;

        // Prompt user for instruction
        const instruction = await vscode.window.showInputBox({
            placeHolder: hasSelection 
                ? "Ask a question or request a change for the selected code..." 
                : "Ask a question or request code generation...",
            prompt: hasSelection ? "Lollms Companion (Context: Selection)" : "Lollms Companion (Context: Cursor Location)",
            ignoreFocusOut: true
        });

        if (!instruction) return;

        // Show loading progress
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Lollms Companion: Thinking...",
            cancellable: true
        }, async (progress, token) => {
            try {
                // Build Prompt
                const document = editor.document;
                const languageId = document.languageId;
                
                let prompt = "";
                
                if (hasSelection) {
                    prompt = `I have selected the following code in a ${languageId} file:\n\n` +
                             `\`\`\`${languageId}\n${selectedText}\n\`\`\`\n\n` +
                             `My instruction/question is: "${instruction}"\n\n` +
                             `Please respond with markdown. If you provide code, use code blocks.`;
                } else {
                    // Context around cursor
                    const position = selection.active;
                    const rangeBefore = new vscode.Range(new vscode.Position(Math.max(0, position.line - 20), 0), position);
                    const contextBefore = document.getText(rangeBefore);
                    
                    prompt = `I am working in a ${languageId} file.\n\n` +
                             `Context before cursor:\n\`\`\`${languageId}\n${contextBefore}\n\`\`\`\n\n` +
                             `My instruction/question is: "${instruction}"\n\n` +
                             `Please respond with markdown.`;
                }

                const systemPrompt = "You are Lollms, a helpful AI coding companion. Provide clear, concise answers. When generating code, ensure it is correct and ready to use.";

                // Call API
                const response = await this.lollmsAPI.sendChat([
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: prompt }
                ], null, undefined); // undefined signal for now, could link token.onCancellationRequested

                const cleanResponse = stripThinkingTags(response);

                // Show in Companion Panel instead of inline editing
                const panel = CompanionPanel.createOrShow(
                    vscode.extensions.getExtension('parisneo.lollms-vs-coder')!.extensionUri, 
                    "Lollms Companion"
                );
                
                panel.updateContent(cleanResponse, selectedText);

            } catch (error: any) {
                vscode.window.showErrorMessage(`Lollms Companion Error: ${error.message}`);
            }
        });
    }
}
