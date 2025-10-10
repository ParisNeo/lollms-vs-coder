import * as vscode from 'vscode';
import { PromptManager, Prompt } from '../promptManager';

export class LollmsCodeActionProvider implements vscode.CodeActionProvider {

    constructor(private promptManager: PromptManager) {}

    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.Refactor,
        vscode.CodeActionKind.Source
    ];

    public async provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): Promise<vscode.CodeAction[]> {
        // Only show actions when there is a selection
        if (range.isEmpty) {
            return [];
        }

        const codeActions: vscode.CodeAction[] = [];
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
        
        return codeActions;
    }
}