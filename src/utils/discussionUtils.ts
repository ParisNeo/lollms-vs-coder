import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { ChatMessage } from '../lollmsAPI';
import { ChatPanel } from '../commands/chatPanel/chatPanel';
import { AgentManager } from '../agentManager';

export async function startDiscussionWithInitialPrompt(
    services: LollmsServices, 
    prompt: string, 
    activeWorkspaceFolder: vscode.WorkspaceFolder | undefined,
    autoExecute: boolean = true,
    roleOverride?: 'user' | 'assistant'
) {
    if (!services.discussionManager) return;

    const discussion = services.discussionManager.createNewDiscussion();
    await services.discussionManager.saveDiscussion(discussion);
    services.treeProviders.discussion?.refresh();

    const panel = ChatPanel.createOrShow(services, discussion.id);

    // Check if agent exists first
    if (ChatPanel.activeAgents.has(discussion.id)) {
        // Reconnect existing agent
        const agent = ChatPanel.activeAgents.get(discussion.id)!;
        panel.setAgentManager(agent);
    } else {
        const agent = new AgentManager(
            panel, services.lollmsAPI, services.contextManager, services.gitIntegration, 
            services.discussionManager, services.extensionUri, services.codeGraphManager, services.skillsManager,
            services.toolManager,
            services.rlmDb 
        );
        agent.setProcessManager(services.processManager);
        panel.setAgentManager(agent);
    }

    panel.setProcessManager(services.processManager);
    panel.setContextManager(services.contextManager);
    panel.setPersonalityManager(services.personalityManager);
    panel.setHerdManager(services.herdManager);

    await panel.loadDiscussion();

    const lastCaps = services.discussionManager.getLastCapabilities();
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    const role = roleOverride || lastCaps.clipboardInsertRole || config.get<string>('clipboardInsertRole') || 'user'; 

    let personalityName = undefined;
    let model = undefined;

    if (role === 'assistant') {
        const currentP = services.personalityManager.getPersonality(discussion.personalityId || 'default_coder');
        personalityName = currentP?.name || 'Lollms';
        model = discussion.model || services.lollmsAPI.getModelName();
        
        // Add an empty user context message so the conversation structure is valid
        await panel.addMessageToDiscussion({
            id: 'user_' + Date.now(),
            role: 'user',
            content: 'Imported code for context:',
            timestamp: Date.now()
        });
    }

    const initialMessage: ChatMessage = {
        id: 'msg_' + Date.now() + Math.random().toString(36).substring(2),
        role: role as 'user' | 'assistant',
        content: prompt,
        timestamp: Date.now(),
        personalityName: personalityName,
        model: model
    };

    if (autoExecute) {
        panel._panel.reveal();
        // Run the main generation asynchronously to free up the extension host thread instantly
        setTimeout(async () => {
            await panel.sendMessage(initialMessage);

            // Generate the discussion title on the background thread after the message has started/completed
            if (config.get<boolean>('autoGenerateTitle')) {
                try {
                    const newTitle = await services.discussionManager.generateDiscussionTitle({
                        ...discussion,
                        messages: [{ role: 'user', content: role === 'assistant' ? '' : prompt } as ChatMessage]
                    });
                    if (newTitle) {
                        discussion.title = newTitle;
                        await services.discussionManager.saveDiscussion(discussion);
                        services.treeProviders.discussion?.refresh();
                        if (ChatPanel.currentPanel === panel) { panel._panel.title = newTitle; }
                    }
                } catch (e) {
                    console.warn("Background title generation failed:", e);
                }
            }
        }, 10);
    } else {
        await panel.addMessageToDiscussion(initialMessage);

        // Asynchronously generate title for silent insertions as well
        if (config.get<boolean>('autoGenerateTitle')) {
            setTimeout(async () => {
                const newTitle = await services.discussionManager.generateDiscussionTitle({
                    ...discussion,
                    messages: [{ role: 'user', content: role === 'assistant' ? '' : prompt } as ChatMessage]
                });
                if (newTitle) {
                    discussion.title = newTitle;
                    await services.discussionManager.saveDiscussion(discussion);
                    services.treeProviders.discussion?.refresh();
                    if (ChatPanel.currentPanel === panel) { panel._panel.title = newTitle; }
                }
            }, 100);
        }
    }
}
