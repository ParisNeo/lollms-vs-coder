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
            // Group all diagnostics on the same range or just take the first one?
            // Usually, users fix one or related issues. Let's offer a fix for the primary diagnostic.
            for (const diagnostic of context.diagnostics) {
                const action = new vscode.CodeAction(`Fix with Lollms: ${diagnostic.message}`, vscode.CodeActionKind.QuickFix);
                action.command = {
                    command: 'lollms-vs-coder.fixDiagnostic',
                    title: 'Fix with Lollms',
                    arguments: [document, diagnostic]
                };
                action.diagnostics = [diagnostic];
                action.isPreferred = true; // Makes it the default action (blue lightbulb often)
                codeActions.push(action);
            }
        }

        // 2. Existing Prompt Actions (Refactor, etc.) - Only when there is a selection or non-empty range
        // Note: Quick Fixes often come with an empty selection (cursor placement), so we separate this check.
        if (!range.isEmpty) {
            const prompts = await this.promptManager.getCodeActionPrompts();

            // Create an action for each saved prompt
            prompts.forEach(prompt => {
                const action = new vscode.CodeAction(`Lollms: ${prompt.title}`, vscode.CodeActionKind.Refactor);
                action.command = {
                    command: 'lollms-vs-coder.triggerCodeAction',
                    title: prompt.title,
                    arguments: [prompt]
                };
                codeActions.push(action);
            });

            // Add the "Custom Action..." option
            const customAction = new vscode.CodeAction('Lollms: Custom Action...', vscode.CodeActionKind.Refactor);
            customAction.command = {
                command: 'lollms-vs-coder.triggerCodeAction',
                title: 'Lollms Custom Action',
                // Pass a special argument to signal a direct custom action request
                arguments: [{ isCustom: true }]
            };
            codeActions.push(customAction);
        }
        
        return codeActions;
    }
}
