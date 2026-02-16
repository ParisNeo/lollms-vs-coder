import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { SettingsPanel } from '../commands/configView';
import { HelpPanel } from '../commands/helpPanel';
import { Logger } from '../logger';
import { registerSelectModelCommand } from '../commands/selectModel';
import { ProcessItem } from '../commands/treeItems';

export function registerUICommands(context: vscode.ExtensionContext, services: LollmsServices) {
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showConfigView', () => 
        SettingsPanel.createOrShow(services.extensionUri, services.lollmsAPI, services.processManager, services.personalityManager)));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showHelp', () => 
        HelpPanel.createOrShow(services.extensionUri)));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showLog', () => 
        Logger.show()));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showRunningProcesses', () => {
        // Reveal the processes view in the sidebar
        vscode.commands.executeCommand('lollmsProcessesView.focus');
    }));

    // NEW: Cancel Process Command
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.cancelProcess', async (item: ProcessItem) => {
        if (item && item.process) {
            await services.processManager.cancel(item.process.id);
            vscode.window.showInformationMessage(`Cancelled: ${item.process.description}`);
        } else {
            Logger.warn("cancelProcess command called without valid item");
        }
    }));

    // Selection Menu triggered by CodeLens or context menu
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showSelectionMenu', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) return;

        const prompts = await services.promptManager.getCodeActionPrompts();
        const items: vscode.QuickPickItem[] = [
            {
                label: "$(edit) Modify with AI...",
                description: "Ask Lollms to modify this specific selection based on your instruction",
                alwaysShow: true
            },
            {
                label: "$(comment-discussion) Ask / Open Companion",
                description: "Open the floating companion panel with this selection context",
                alwaysShow: true
            },
            { label: "", kind: vscode.QuickPickItemKind.Separator },
            ...prompts.map(p => ({
                label: `\$(sparkle) ${p.title}`,
                description: p.description,
                detail: p.id
            }))
        ];

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: "What would you like Lollms to do with this selection?"
        });

        if (!selected) return;

        if (selected.label === "$(edit) Modify with AI...") {
            const instruction = await vscode.window.showInputBox({
                prompt: "What should Lollms do to this code?",
                placeHolder: "e.g. Add error handling, convert to async, etc."
            });
            
            if (instruction) {
                // Surgical prompt to minimize extra text/formatting
                const surgicalPrompt = `Task: ${instruction}\nModify the following code. Return ONLY the new code without any explanations or markdown code fences.\n\nCode:\n{{SELECTED_CODE}}`;
                
                await vscode.commands.executeCommand('lollms-vs-coder.triggerCodeAction', {
                    id: 'adhoc-selection-modify',
                    title: 'Modify Selection',
                    content: surgicalPrompt,
                    type: 'code_action',
                    action_type: 'generation'
                });
            }
        } else if (selected.label === "$(comment-discussion) Ask / Open Companion") {
            await vscode.commands.executeCommand('lollms-vs-coder.quickEdit');
        } else {
            const prompt = prompts.find(p => p.id === selected.detail);
            if (prompt) {
                await vscode.commands.executeCommand('lollms-vs-coder.triggerCodeAction', prompt);
            }
        }
    }));

    // Register the missing "selectModel" command
    registerSelectModelCommand(context, services);
}
