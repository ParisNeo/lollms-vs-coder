import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { ChatPanel } from '../commands/chatPanel/chatPanel';
import { DiscussionItem, DiscussionGroupItem } from '../commands/discussionTreeProvider';
import { startDiscussionWithInitialPrompt } from '../utils/discussionUtils';
import { AgentManager } from '../agentManager';

export function registerChatCommands(context: vscode.ExtensionContext, services: LollmsServices, getActiveWorkspace: () => vscode.WorkspaceFolder | undefined) {
    
    // Explicitly register the refresh command to avoid "command not found" errors
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.refreshDiscussions', () => {
        if (services.treeProviders.discussion) {
            services.treeProviders.discussion.refresh();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.searchDiscussions', async () => {
        const panel = ChatPanel.currentPanel;
        if (panel) {
            panel._panel.webview.postMessage({ command: 'showDiscussionSearchModal' }); 
        } else {
            // Fallback for when no chat is open
            const query = await vscode.window.showInputBox({
                prompt: "Search discussions (Wildcards supported: * and ?)",
                placeHolder: "e.g. auth*, bug?"
            });
            if (query !== undefined) {
                services.treeProviders.discussion?.setFilter(query);
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.clearDiscussionSearch', () => {
        services.treeProviders.discussion?.setFilter(undefined);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.startChat', () => {
        if (!getActiveWorkspace()) {
            // No workspace: Start a temporary chat instead of showing error
            vscode.commands.executeCommand('lollms-vs-coder.newTempDiscussion');
            return;
        }
        vscode.commands.executeCommand('lollms-vs-coder.newDiscussion');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.newDiscussion', async (item?: DiscussionGroupItem) => {
        const groupId = item instanceof DiscussionGroupItem ? item.group.id : null;
        const discussion = services.discussionManager.createNewDiscussion(groupId);
        await services.discussionManager.saveDiscussion(discussion);
        const panel = ChatPanel.createOrShow(services.extensionUri, services.lollmsAPI, services.discussionManager, discussion.id, services.gitIntegration, services.skillsManager);
        
        // Use the setAgentManager which handles reconnection logic internally
        const agent = new AgentManager(
            panel, services.lollmsAPI, services.contextManager, services.gitIntegration, 
            services.discussionManager, services.extensionUri, services.codeGraphManager, services.skillsManager,
            services.rlmDb 
        );
        agent.setProcessManager(services.processManager);
        panel.setAgentManager(agent);

        panel.setProcessManager(services.processManager);
        panel.setContextManager(services.contextManager);
        panel.setPersonalityManager(services.personalityManager);
        panel.setHerdManager(services.herdManager); 
        
        await panel.loadDiscussion();
        services.treeProviders.discussion?.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.newTempDiscussion', async () => {
        const tempId = 'temp-' + Date.now().toString() + Math.random().toString(36).substring(2);
        
        const panel = ChatPanel.createOrShow(
            services.extensionUri, 
            services.lollmsAPI, 
            services.discussionManager, 
            tempId, 
            services.gitIntegration, 
            services.skillsManager
        );
        
        const agent = new AgentManager(
            panel, services.lollmsAPI, services.contextManager, services.gitIntegration, 
            services.discussionManager, services.extensionUri, services.codeGraphManager, services.skillsManager
        );
        agent.setProcessManager(services.processManager);
        panel.setAgentManager(agent);

        panel.setProcessManager(services.processManager);
        panel.setContextManager(services.contextManager);
        panel.setPersonalityManager(services.personalityManager);
        panel.setHerdManager(services.herdManager); 
        
        await panel.loadDiscussion();
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
            // Also cleanup any active agents
            if (ChatPanel.activeAgents.has(item.discussion.id)) {
                ChatPanel.activeAgents.delete(item.discussion.id);
            }
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
                vscode.window.showErrorMessage(`Title Generation Error: ${error.message}`);
            }
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.switchDiscussion', async (discussionId: string) => {
        // 1. Create or show panel (sets internal discussionId)
        const panel = ChatPanel.createOrShow(services.extensionUri, services.lollmsAPI, services.discussionManager, discussionId, services.gitIntegration, services.skillsManager);
        
        // 2. Inject dependencies BEFORE loading
        panel.setProcessManager(services.processManager);
        panel.setContextManager(services.contextManager);
        panel.setPersonalityManager(services.personalityManager);
        panel.setHerdManager(services.herdManager); 

        // 3. Connect/Create Agent
        if (ChatPanel.activeAgents.has(discussionId)) {
            const agent = ChatPanel.activeAgents.get(discussionId)!;
            panel.setAgentManager(agent);
        } else {
            const agent = new AgentManager(
                panel, services.lollmsAPI, services.contextManager, services.gitIntegration, 
                services.discussionManager, services.extensionUri, services.codeGraphManager, services.skillsManager,
                services.rlmDb 
            );
            agent.setProcessManager(services.processManager);
            panel.setAgentManager(agent);
        }

        // 4. Trigger the load
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

    // --- GROUP MANAGEMENT ---

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.createDiscussionGroup', async () => {
        const title = await vscode.window.showInputBox({ prompt: "Enter group name", placeHolder: "e.g. Research, Project X, Debugging" });
        if (!title) return;

        const groups = await services.discussionManager.getGroups();
        const newGroup = {
            id: 'group-' + Date.now().toString(),
            title: title,
            description: '',
            timestamp: Date.now()
        };

        groups.push(newGroup);
        await services.discussionManager.saveGroups(groups);
        services.treeProviders.discussion?.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.renameDiscussionGroup', async (item: DiscussionGroupItem) => {
        const newTitle = await vscode.window.showInputBox({ prompt: "Enter new group name", value: item.group.title });
        if (!newTitle) return;

        const groups = await services.discussionManager.getGroups();
        const group = groups.find(g => g.id === item.group.id);
        if (group) {
            group.title = newTitle;
            await services.discussionManager.saveGroups(groups);
            services.treeProviders.discussion?.refresh();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.deleteDiscussionGroup', async (item: DiscussionGroupItem) => {
        const confirm = await vscode.window.showWarningMessage(
            `Delete group "${item.group.title}"? Discussions inside will be moved to the root list.`,
            { modal: true }, "Delete"
        );
        if (confirm === "Delete") {
            await services.discussionManager.deleteGroup(item.group.id);
            services.treeProviders.discussion?.refresh();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.moveDiscussionToGroup', async (item: DiscussionItem) => {
        const groups = await services.discussionManager.getGroups();
        
        const options = [
            { label: "$(archive) (No Group)", id: null },
            ...groups.map(g => ({ label: `$(folder) ${g.title}`, id: g.id }))
        ];

        const selected = await vscode.window.showQuickPick(options, { placeHolder: "Select destination group" });
        if (selected !== undefined) {
            const discussion = await services.discussionManager.getDiscussion(item.discussion.id);
            if (discussion) {
                discussion.groupId = selected.id;
                await services.discussionManager.saveDiscussion(discussion);
                services.treeProviders.discussion?.refresh();
            }
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
