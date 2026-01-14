import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { ChatPanel } from '../commands/chatPanel/chatPanel';
import { DiscussionItem, DiscussionGroupItem } from '../commands/discussionTreeProvider';
import { startDiscussionWithInitialPrompt } from '../utils/discussionUtils';

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
        const panel = ChatPanel.createOrShow(services.extensionUri, services.lollmsAPI, services.discussionManager, discussion.id, services.skillsManager);
        
        // Inject dependencies into panel
        panel.agentManager = new (require('../agentManager').AgentManager)(
            panel, services.lollmsAPI, services.contextManager, services.gitIntegration, 
            services.discussionManager, services.extensionUri, services.codeGraphManager, services.skillsManager
        );
        panel.setProcessManager(services.processManager);
        panel.agentManager.setProcessManager(services.processManager);
        panel.setContextManager(services.contextManager);
        panel.setPersonalityManager(services.personalityManager);
        panel.setHerdManager(services.herdManager); // Added injection
        
        await panel.loadDiscussion();
        services.treeProviders.discussion?.refresh();
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
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.switchDiscussion', async (discussionId: string) => {
        const panel = ChatPanel.createOrShow(services.extensionUri, services.lollmsAPI, services.discussionManager, discussionId, services.skillsManager);
        panel.agentManager = new (require('../agentManager').AgentManager)(
            panel, services.lollmsAPI, services.contextManager, services.gitIntegration, 
            services.discussionManager, services.extensionUri, services.codeGraphManager, services.skillsManager
        );
        panel.setProcessManager(services.processManager);
        panel.agentManager.setProcessManager(services.processManager);
        panel.setContextManager(services.contextManager);
        panel.setPersonalityManager(services.personalityManager);
        panel.setHerdManager(services.herdManager); // Added injection
        await panel.loadDiscussion();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.quickEdit', () => {
        services.quickEditManager.triggerQuickEdit();
    }));
}
