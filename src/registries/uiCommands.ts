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

    // --- TAB NAVIGATION LOGIC ---
    const setTab = (tabName: 'chat' | 'librarian' | 'lab') => {
        vscode.commands.executeCommand('setContext', 'lollms:activeTab', tabName);
        context.globalState.update('lollms.activeTab', tabName);
        // Refresh the header view to update "Active" indicators
        services.treeProviders.tabs?.refresh();
    };

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showChatTab', () => setTab('chat')));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showLibrarianTab', () => setTab('librarian')));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showLabTab', () => setTab('lab')));

    // Initialize default tab
    const savedTab = context.globalState.get<'chat' | 'librarian' | 'lab'>('lollms.activeTab', 'chat');
    vscode.commands.executeCommand('setContext', 'lollms:activeTab', savedTab);

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

    // Enhanced Selection Menu (Fallback/Hotkey support)
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showSelectionMenu', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) return;

        // Directly open the beautiful modal instead of showing the redundant list
        await vscode.commands.executeCommand('lollms-vs-coder.triggerCodeAction', { isCustom: true });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.manageProjectMemory', () => {
        const { ProjectMemoryPanel } = require('../commands/projectMemoryPanel');
        ProjectMemoryPanel.createOrShow(services.extensionUri, (services as any).projectMemoryManager);
    }));

    // Support clicking a memory item in the tree to open the manager
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.viewMemory', (item: any) => {
        const { ProjectMemoryPanel } = require('../commands/projectMemoryPanel');
        ProjectMemoryPanel.createOrShow(services.extensionUri, (services as any).projectMemoryManager);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.addProjectMemory', async () => {
        const title = await vscode.window.showInputBox({ prompt: "Memory Title", placeHolder: "e.g., Coding Standards" });
        if (!title) return;
        const id = 'mem_' + Date.now();
        await (services as any).projectMemoryManager.updateMemory('add', id, title, "Enter facts for the AI to remember here...");
        vscode.commands.executeCommand('lollms-vs-coder.manageProjectMemory');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.deleteProjectMemory', async (item: any) => {
        const confirm = await vscode.window.showWarningMessage(`Delete memory "${item.memory.title}"?`, { modal: true }, "Delete");
        if (confirm === "Delete") {
            await (services as any).projectMemoryManager.updateMemory('delete', item.memory.id);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.applyMemoryTag', async (params: { action: string, id: string, title: string, content: string }) => {
        if (services.projectMemoryManager) {
            await services.projectMemoryManager.updateMemory(
                params.action as any, 
                params.id, 
                params.title, 
                params.content
            );
            vscode.window.showInformationMessage(`Lollms: Fact "${params.id}" synced to Project Memory.`);
        }
    }));

    // Register the missing "selectModel" command
    registerSelectModelCommand(context, services);
}
