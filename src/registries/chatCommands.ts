import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { ChatPanel } from '../commands/chatPanel/chatPanel';
import { DiscussionItem, DiscussionGroupItem } from '../commands/discussionTreeProvider';
import { startDiscussionWithInitialPrompt } from '../utils/discussionUtils';
import { AgentManager } from '../agentManager';

export function registerChatCommands(context: vscode.ExtensionContext, services: LollmsServices, getActiveWorkspace: () => vscode.WorkspaceFolder | undefined) {
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.startChat', () => {
        if (!getActiveWorkspace()) {
            vscode.window.showInformationMessage(vscode.l10n.t("info.openFolderToUseChat"));
            return;
        }
        vscode.commands.executeCommand('lollms-vs-coder.newDiscussion');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.newDiscussion', async (item?: DiscussionGroupItem) => {
        const groupId = item instanceof DiscussionGroupItem ? item.group.id : null;
        const discussion = services.discussionManager.createNewDiscussion(groupId);
        await services.discussionManager.saveDiscussion(discussion);
        const panel = ChatPanel.createOrShow(services.extensionUri, services.lollmsAPI, services.discussionManager, discussion.id, services.gitIntegration, services.skillsManager);
        
        panel.agentManager = new AgentManager(
            panel, services.lollmsAPI, services.contextManager, services.gitIntegration, 
            services.discussionManager, services.extensionUri, services.codeGraphManager, services.skillsManager,
            services.rlmDb // Passed from services
        );
        panel.setProcessManager(services.processManager);
        panel.agentManager.setProcessManager(services.processManager);
        panel.setContextManager(services.contextManager);
        panel.setPersonalityManager(services.personalityManager);
        panel.setHerdManager(services.herdManager); 
        
        await panel.loadDiscussion();
        services.treeProviders.discussion?.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.newTempDiscussion', async () => {
        // Generate a temporary ID. The ChatPanel and DiscussionManager logic 
        // uses the 'temp-' prefix to avoid auto-saving to disk.
        const tempId = 'temp-' + Date.now().toString() + Math.random().toString(36).substring(2);
        
        const panel = ChatPanel.createOrShow(
            services.extensionUri, 
            services.lollmsAPI, 
            services.discussionManager, 
            tempId, 
            services.gitIntegration, 
            services.skillsManager
        );
        
        panel.agentManager = new (require('../agentManager').AgentManager)(
            panel, services.lollmsAPI, services.contextManager, services.gitIntegration, 
            services.discussionManager, services.extensionUri, services.codeGraphManager, services.skillsManager
        );
        panel.setProcessManager(services.processManager);
        panel.agentManager.setProcessManager(services.processManager);
        panel.setContextManager(services.contextManager);
        panel.setPersonalityManager(services.personalityManager);
        panel.setHerdManager(services.herdManager); 
        
        await panel.loadDiscussion();
        // Note: We don't refresh the tree because temp discussions don't appear in the sidebar
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.newDiscussionFromClipboard', async () => {
        const clipboardText = await vscode.env.clipboard.readText();
        if (!clipboardText) {
            vscode.window.showWarningMessage('Clipboard is empty.');
            return;
        }
        await startDiscussionWithInitialPrompt(services, clipboardText, getActiveWorkspace(), false);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.deleteDiscussion', async (item: DiscussionItem) => {
        const deleteButton = { title: vscode.l10n.t('command.delete.title'), id: 'delete' };
        const confirm = await vscode.window.showWarningMessage(vscode.l10n.t('prompt.confirmDelete', item.discussion.title), { modal: true }, deleteButton);
        if (confirm?.id === 'delete') {
            const panel = ChatPanel.panels.get(item.discussion.id);
            panel?.dispose(); 
            await services.discussionManager.deleteDiscussion(item.discussion.id);
            services.treeProviders.discussion?.refresh();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.renameDiscussion', async (item: DiscussionItem) => {
        const newTitle = await vscode.window.showInputBox({
            prompt: vscode.l10n.t('prompt.enterNewDiscussionTitle'),
            value: item.discussion.title
        });

        if (newTitle !== undefined && newTitle.trim()) {
            item.discussion.title = newTitle.trim();
            await services.discussionManager.saveDiscussion(item.discussion);
            
            // Update open panel title if it exists
            const panel = ChatPanel.panels.get(item.discussion.id);
            if (panel) {
                panel._panel.title = item.discussion.title;
            }
            
            services.treeProviders.discussion?.refresh();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.generateDiscussionTitle', async (item: DiscussionItem) => {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t('progress.generatingDiscussionTitle'),
            cancellable: false
        }, async () => {
            try {
                const newTitle = await services.discussionManager.generateDiscussionTitle(item.discussion);
                if (newTitle) {
                    item.discussion.title = newTitle;
                    await services.discussionManager.saveDiscussion(item.discussion);
                    
                    const panel = ChatPanel.panels.get(item.discussion.id);
                    if (panel) {
                        panel._panel.title = item.discussion.title;
                    }
                    
                    services.treeProviders.discussion?.refresh();
                } else {
                    vscode.window.showErrorMessage("Failed to generate a title: The AI returned an empty response.");
                }
            } catch (error: any) {
                // Show actual API error to user (e.g. Connection refused, model not found)
                vscode.window.showErrorMessage(`Title Generation Error: ${error.message}`);
            }
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.switchDiscussion', async (discussionId: string) => {
        const panel = ChatPanel.createOrShow(services.extensionUri, services.lollmsAPI, services.discussionManager, discussionId, services.gitIntegration, services.skillsManager);
        panel.agentManager = new AgentManager(
            panel, services.lollmsAPI, services.contextManager, services.gitIntegration, 
            services.discussionManager, services.extensionUri, services.codeGraphManager, services.skillsManager,
            services.rlmDb // Passed from services
        );
        panel.setProcessManager(services.processManager);
        panel.agentManager.setProcessManager(services.processManager);
        panel.setContextManager(services.contextManager);
        panel.setPersonalityManager(services.personalityManager);
        panel.setHerdManager(services.herdManager); 
        await panel.loadDiscussion();
    }));


    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.quickEdit', () => {
        services.quickEditManager.triggerQuickEdit();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.cleanEmptyDiscussions', async () => {
        const yes = vscode.l10n.t('label.yes') || "Yes";
        const prompt = vscode.l10n.t('prompt.confirmCleanEmptyDiscussions') || "Are you sure you want to delete all empty discussions?";
        
        const selection = await vscode.window.showWarningMessage(prompt, { modal: true }, yes);
        
        if (selection === yes) {
            const count = await services.discussionManager.cleanEmptyDiscussions();
            const message = vscode.l10n.t('info.cleanedEmptyDiscussions', count) || `Cleaned ${count} empty discussions.`;
            vscode.window.showInformationMessage(message);
            services.treeProviders.discussion?.refresh();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.runScript', async (code: string, language: string) => {
        const panel = ChatPanel.currentPanel;
        const workspaceFolder = getActiveWorkspace();

        if (!panel) {
            vscode.window.showErrorMessage("No active Lollms chat panel found to display execution output.");
            return;
        }

        if (!workspaceFolder) {
            vscode.window.showErrorMessage("No active workspace folder. Please open a folder to execute scripts.");
            return;
        }

        try {
            await services.scriptRunner.runScript(code, language, panel, workspaceFolder);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to run script: ${error.message}`);
        }
    }));
}
