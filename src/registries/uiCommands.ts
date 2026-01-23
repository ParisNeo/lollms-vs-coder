import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { SettingsPanel } from '../commands/configView';
import { HelpPanel } from '../commands/helpPanel';
import { Logger } from '../logger';
import { registerSelectModelCommand } from '../commands/selectModel';

export function registerUICommands(context: vscode.ExtensionContext, services: LollmsServices) {
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showConfigView', () => 
        SettingsPanel.createOrShow(services.extensionUri, services.lollmsAPI, services.processManager, services.personalityManager)));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showHelp', () => 
        HelpPanel.createOrShow(services.extensionUri)));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showLog', () => 
        Logger.show()));

    // FIX: Register missing command 'lollms-vs-coder.showRunningProcesses'
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showRunningProcesses', () => {
        // Reveal the processes view in the sidebar
        vscode.commands.executeCommand('lollmsProcessesView.focus');
    }));

    // Register the missing "selectModel" command
    registerSelectModelCommand(context, services);
}
