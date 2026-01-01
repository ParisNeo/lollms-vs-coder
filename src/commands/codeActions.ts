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
            const action = new vscode.CodeAction(`$(sparkle) Fix with Lollms`, vscode.CodeActionKind.QuickFix);
            action.command = {
                command: 'lollms-vs-coder.fixDiagnostic',
                title: 'Fix with Lollms',
                arguments: [document.uri, diagnostic]
            };
            action.diagnostics = [diagnostic];
            action.isPreferred = true; // High priority in the hover/quick-fix menu
            codeActions.push(action);
        }

        // 2. Existing Prompt Actions (Refactor, etc.) - Only when there is a selection
        if (!range.isEmpty) {
            const prompts = await this.promptManager.getCodeActionPrompts();

            prompts.forEach(prompt => {
                const action = new vscode.CodeAction(`Lollms: ${prompt.title}`, vscode.CodeActionKind.Refactor);
                action.command = {
                    command: 'lollms-vs-coder.triggerCodeAction',
                    title: prompt.title,
                    arguments: [prompt]
                };
                codeActions.push(action);
            });

            const customAction = new vscode.CodeAction('Lollms: Custom Action...', vscode.CodeActionKind.Refactor);
            customAction.command = {
                command: 'lollms-vs-coder.triggerCodeAction',
                title: 'Lollms Custom Action',
                arguments: [{ isCustom: true }]
            };
            codeActions.push(customAction);
        }
        
        return codeActions;
    }
}
