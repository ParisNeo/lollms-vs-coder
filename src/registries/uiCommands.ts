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

    // Register the missing "selectModel" command
    registerSelectModelCommand(context, services);
}
