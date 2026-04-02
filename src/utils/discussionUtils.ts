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

    if (autoExecute) {
        // --- IMAGE SUPPORT: Fetch images from project context ---
        const contextData = await services.contextManager.getContextContent({ 
            includeTree: false,
            modelName: discussion.model || services.lollmsAPI.getModelName()
        });

        let finalContent: any = prompt;
        
        // If we have images in the project context, convert to Multipart message
        if (contextData.images && contextData.images.length > 0) {
            const parts: any[] = [{ type: 'text', text: prompt }];
            contextData.images.forEach(img => {
                parts.push({ type: 'image_url', image_url: { url: img.data } });
            });
            finalContent = parts;
        }

        const userMessage: ChatMessage = {
            id: 'user_' + Date.now().toString() + Math.random().toString(36).substring(2),
            role: 'user',
            content: finalContent
        };
        
        await panel.sendMessage(userMessage); 
    } else {
        // Handle "Paste as Message" without execution
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const role = config.get<string>('clipboardInsertRole') || 'user'; 

        const message: ChatMessage = {
            id: role + '_' + Date.now().toString() + Math.random().toString(36).substring(2),
            role: role as 'user' | 'assistant',
            content: prompt,
            timestamp: Date.now()
        };

        // Add to UI and CRITICAL: Wait for the save operation to finish
        await panel.addMessageToDiscussion(message);

        // If auto-title is enabled, generate title based on the draft content
        if (config.get<boolean>('autoGenerateTitle')) {
             // Create a temporary mock discussion to pass to the title generator
             const mockDiscussion = {
                ...discussion,
                messages: [{ role: 'user', content: prompt } as ChatMessage]
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
}
