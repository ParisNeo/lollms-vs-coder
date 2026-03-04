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

        // 1. Handle Diagnostics (Quick Fixes)
        for (const diagnostic of context.diagnostics) {
            const action = new vscode.CodeAction(`✨ Fix with Lollms`, vscode.CodeActionKind.QuickFix);
            action.command = {
                command: 'lollms-vs-coder.fixDiagnostic',
                title: 'Fix with Lollms',
                arguments: [document.uri, diagnostic]
            };
            action.diagnostics = [diagnostic];
            action.isPreferred = true; 
            codeActions.push(action);
        }

        // 2. Direct Actions for Selection
        if (!range.isEmpty) {
            // New "Modify" action that opens the beautiful modal directly
            const modifyAction = new vscode.CodeAction('📝 Modify with Lollms...', vscode.CodeActionKind.Refactor);
            modifyAction.command = {
                command: 'lollms-vs-coder.triggerCodeAction',
                title: 'Modify with Lollms',
                arguments: [{ isCustom: true }]
            };
            modifyAction.isPreferred = true;
            codeActions.push(modifyAction);

            // Directly expose specific library prompts in the lightbulb
            const prompts = await this.promptManager.getCodeActionPrompts();
            prompts.forEach(prompt => {
                let emoji = '✨';
                if (prompt.title.toLowerCase().includes('bug')) emoji = '🔍';
                if (prompt.title.toLowerCase().includes('doc')) emoji = '📖';
                if (prompt.title.toLowerCase().includes('refactor')) emoji = '🛠️';
                if (prompt.title.toLowerCase().includes('explain')) emoji = '💡';
                
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
