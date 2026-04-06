import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { ChatMessage } from '../lollmsAPI';
import { ChatPanel } from '../commands/chatPanel/chatPanel';
import { AgentManager } from '../agentManager';

export async function startDiscussionWithInitialPrompt(
    services: LollmsServices, 
    prompt: string, 
    activeWorkspaceFolder: vscode.WorkspaceFolder | undefined,
    autoExecute: boolean = true
) {
    if (!services.discussionManager) return;

    const discussion = services.discussionManager.createNewDiscussion();
    await services.discussionManager.saveDiscussion(discussion);
    services.treeProviders.discussion?.refresh();

    const panel = ChatPanel.createOrShow(
        services.extensionUri, 
        services.lollmsAPI, 
        services.discussionManager, 
        discussion.id, 
        services.gitIntegration,
        services.skillsManager
    );
    
    // Check if agent exists first
    if (ChatPanel.activeAgents.has(discussion.id)) {
        // Reconnect existing agent
        const agent = ChatPanel.activeAgents.get(discussion.id)!;
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

    panel.setProcessManager(services.processManager);
    panel.setContextManager(services.contextManager);
    panel.setPersonalityManager(services.personalityManager);
    panel.setHerdManager(services.herdManager);

    await panel.loadDiscussion();

    // Handle "Paste as Message" without execution
    // Priority: Last used Discussion Capability -> Global Config -> Default 'user'
    const lastCaps = services.discussionManager.getLastCapabilities();
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    
    const role = lastCaps.clipboardInsertRole || config.get<string>('clipboardInsertRole') || 'user'; 

    // Fetch identity metadata for the assistant role to ensure the UI renders correctly
    let personalityName = undefined;
    let model = undefined;

    if (role === 'assistant') {
        const currentP = services.personalityManager.getPersonality(discussion.personalityId || 'default_coder');
        personalityName = currentP?.name || 'Lollms';
        model = discussion.model || services.lollmsAPI.getModelName();
    }

    // When pasting as assistant message, we need to add an empty user message first
    // to create the proper conversation flow for title generation
    if (role === 'assistant') {
        const userMsgId = 'user_' + Date.now().toString() + Math.random().toString(36).substring(2);
        const userMessage: ChatMessage = {
            id: userMsgId,
            role: 'user',
            content: '',
            timestamp: Date.now(),
            personalityName: personalityName,
            model: model
        };
        await panel.addMessageToDiscussion(userMessage);

        const aiMsgId = 'assistant_' + Date.now().toString() + Math.random().toString(36).substring(2);
        const aiMessage: ChatMessage = {
            id: aiMsgId,
            role: 'assistant',
            content: prompt,
            timestamp: Date.now(),
            personalityName: personalityName,
            model: model
        };
        // Add to UI and CRITICAL: Wait for the save operation to finish
        await panel.addMessageToDiscussion(aiMessage);
    } else {
        const message: ChatMessage = {
            id: role + '_' + Date.now().toString() + Math.random().toString(36).substring(2),
            role: role as 'user' | 'assistant',
            content: prompt,
            timestamp: Date.now(),
            personalityName: personalityName,
            model: model
        };
        // Add to UI and CRITICAL: Wait for the save operation to finish
        await panel.addMessageToDiscussion(message);
    }

    // If auto-title is enabled, generate title based on the draft content
    if (config.get<boolean>('autoGenerateTitle')) {
            // Create a temporary mock discussion to pass to the title generator
            // Use empty string for user content since we added an empty user message
            const mockDiscussion = {
            ...discussion,
            messages: [{ role: 'user', content: role === 'assistant' ? '' : prompt } as ChatMessage]
            };
            
            // We use the existing manager to generate the title
            const newTitle = await services.discussionManager.generateDiscussionTitle(mockDiscussion);
            if (newTitle) {
                discussion.title = newTitle;
                await services.discussionManager.saveDiscussion(discussion);
                services.treeProviders.discussion?.refresh();
                
                // Update the panel title if it's currently open
                if (ChatPanel.currentPanel && ChatPanel.currentPanel === panel) {
                    panel._panel.title = newTitle;
                }
            }
    }
}
