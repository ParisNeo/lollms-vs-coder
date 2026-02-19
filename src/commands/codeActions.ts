import * as vscode from 'vscode';
import { PromptManager, Prompt } from '../promptManager';

export class LollmsCodeActionProvider implements vscode.CodeActionProvider {

    constructor(private promptManager: PromptManager) {}

    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.Refactor,
        vscode.CodeActionKind.Source,
        vscode.CodeActionKind.QuickFix
    ];

    public async provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): Promise<vscode.CodeAction[]> {
        const codeActions: vscode.CodeAction[] = [];

        // 1. Handle Diagnostics (Quick Fixes) - "Fix with Lollms"
        if (context.diagnostics.length > 0) {
            // Focus on the first diagnostic at this position
            const diagnostic = context.diagnostics[0];
            // Use standard emoji ✨ instead of $(sparkle) because CodeAction titles don't support Codicons
            const action = new vscode.CodeAction(`✨ Fix with Lollms`, vscode.CodeActionKind.QuickFix);
            action.command = {
                command: 'lollms-vs-coder.fixDiagnostic',
                title: 'Fix with Lollms',
                arguments: [document.uri, diagnostic]
            };
            action.diagnostics = [diagnostic];
            action.isPreferred = true; // High priority in the hover/quick-fix menu
            codeActions.push(action);
        }

        // 2. Main Lollms Menu Action
        if (!range.isEmpty) {
            const mainAction = new vscode.CodeAction('👑 Lollms Actions...', vscode.CodeActionKind.Refactor);
            mainAction.command = {
                command: 'lollms-vs-coder.showSelectionMenu',
                title: 'Show Lollms Menu'
            };
            mainAction.isPreferred = true;
            codeActions.push(mainAction);

            const quickModify = new vscode.CodeAction('📝 Modify with Lollms...', vscode.CodeActionKind.Refactor);
            quickModify.command = {
                command: 'lollms-vs-coder.showSelectionMenu', 
                title: 'Modify with AI'
            };
            codeActions.push(quickModify);

            // Directly expose refactoring prompts for quick access
            const prompts = await this.promptManager.getCodeActionPrompts();
            prompts.forEach(prompt => {
                // Use Emojis for icons as $(icon) syntax is not supported in CodeAction labels
                let emoji = '✨';
                if (prompt.title.toLowerCase().includes('bug')) emoji = '🔍';
                if (prompt.title.toLowerCase().includes('doc')) emoji = '📖';
                if (prompt.title.toLowerCase().includes('refactor')) emoji = '🛠️';
                
                const action = new vscode.CodeAction(`${emoji} ${prompt.title}`, vscode.CodeActionKind.Refactor);
                action.command = {
                    command: 'lollms-vs-coder.triggerCodeAction',
                    title: prompt.title,
                    arguments: [prompt]
                };
                codeActions.push(action);
            });
        }
        
        return codeActions;
    }
}
