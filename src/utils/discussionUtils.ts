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

    const lastCaps = services.discussionManager.getLastCapabilities();
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    const role = lastCaps.clipboardInsertRole || config.get<string>('clipboardInsertRole') || 'user'; 

    // Handle "Auto-Execute" (Trigger LLM immediately)
    if (autoExecute && role === 'user') {
        // Wait a tiny bit for the webview to initialize its DOM after loadDiscussion
        await new Promise(resolve => setTimeout(resolve, 200));
        
        await panel.sendMessage({
            role: 'user',
            content: prompt,
            timestamp: Date.now()
        });
        return;
    }

    // --- FALLBACK: MANUAL INSERTION (Paste as Reference Content) ---
    let personalityName = undefined;
    let model = undefined;

    if (role === 'assistant') {
        const currentP = services.personalityManager.getPersonality(discussion.personalityId || 'default_coder');
        personalityName = currentP?.name || 'Lollms';
        model = discussion.model || services.lollmsAPI.getModelName();
        
        // Add an empty user context message so the conversation structure is valid
        await panel.addMessageToDiscussion({
            role: 'user',
            content: '',
            timestamp: Date.now()
        });
    }

    await panel.addMessageToDiscussion({
        role: role as 'user' | 'assistant',
        content: prompt,
        timestamp: Date.now(),
        personalityName: personalityName,
        model: model
    });

    if (config.get<boolean>('autoGenerateTitle')) {
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
    }
}
