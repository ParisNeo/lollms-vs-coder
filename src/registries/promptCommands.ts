import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { Prompt } from '../promptManager';
import { buildCodeActionPrompt } from '../utils/promptUtils';
import { ChatPanel } from '../commands/chatPanel/chatPanel';
import { startDiscussionWithInitialPrompt } from '../utils/discussionUtils';
import { CustomActionModal } from '../commands/customActionModal';
import { stripThinkingTags, getProcessedSystemPrompt } from '../utils';
import { Logger } from '../logger';

export function registerPromptCommands(context: vscode.ExtensionContext, services: LollmsServices) {
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.saveMessageAsPrompt', async (content: string) => {
        const title = await vscode.window.showInputBox({ prompt: 'Enter a title for this prompt' });
        if (!title) return;
        const newPrompt: Prompt = { id: Date.now().toString(), groupId: null, title: title, content: content, type: 'chat', is_default: false };
        const data = await services.promptManager.getData();
        data.prompts.push(newPrompt);
        await services.promptManager.saveData(data);
        services.treeProviders.chatPrompt?.refresh();
        vscode.window.showInformationMessage('Prompt saved successfully.');
    }));

    // Use a chat prompt from the sidebar
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.useChatPrompt', async (prompt: Prompt) => {
        const activeFolder = vscode.workspace.workspaceFolders?.[0];
        if (activeFolder) {
            await startDiscussionWithInitialPrompt(services, prompt.content, activeFolder);
        }
    }));

    // Trigger a code action prompt (Refactor, Explain, etc.)
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.triggerCodeAction', async (promptArg: Prompt | { isCustom: boolean }) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }

        let prompt: Prompt;
        let useContext = false;

        if ('isCustom' in promptArg && promptArg.isCustom) {
            const result = await CustomActionModal.createOrShow(services.extensionUri);
            if (!result) return;
            prompt = {
                id: 'custom',
                title: result.title || 'Custom Action',
                content: result.prompt,
                type: 'code_action',
                action_type: result.actionType,
                groupId: null
            };
            useContext = result.useContext;

            if (result.save) {
                const data = await services.promptManager.getData();
                data.prompts.push({ ...prompt, id: Date.now().toString(), is_default: false });
                await services.promptManager.saveData(data);
                services.treeProviders.codeAction?.refresh();
            }
        } else {
            prompt = promptArg as Prompt;
        }

        const prompts = await buildCodeActionPrompt(
            prompt.content,
            prompt.action_type,
            editor,
            services.extensionUri,
            services.contextManager,
            services.lollmsAPI, // Pass API for smart dependency detection
            useContext
        );

        if (!prompts) return;

        const activeFolder = vscode.workspace.workspaceFolders?.[0];
        if (!activeFolder) {
            vscode.window.showErrorMessage("Please open a workspace folder to use surgical actions.");
            return;
        }

        if (prompt.action_type === 'information') {
            await startDiscussionWithInitialPrompt(services, prompts.userPrompt, activeFolder, true, 'user');
        } else {
            // --- FIXED: AGENTIC SURGICAL HANDOVER ---
            const discussion = services.discussionManager.createNewDiscussion();
            discussion.title = `Surgical: ${prompt.title}`;

            if (discussion.capabilities) {
                discussion.capabilities.agentMode = true;
                discussion.capabilities.autoApply = false; 
                discussion.capabilities.autoFix = true;
                discussion.capabilities.verifierMode = true;
            }

            await services.discussionManager.saveDiscussion(discussion);

            const panel = ChatPanel.createOrShow(
                services.extensionUri, 
                services.lollmsAPI, 
                services.discussionManager, 
                discussion.id, 
                services.gitIntegration, 
                services.skillsManager
            );

            // 1. Reconnect dependencies immediately
            panel.setContextManager(services.contextManager);
            panel.setProcessManager(services.processManager);
            panel.setPersonalityManager(services.personalityManager);

            // 2. Initialize Agent
            const agent = new AgentManager(
                panel, services.lollmsAPI, services.contextManager, services.gitIntegration, 
                services.discussionManager, services.extensionUri, services.codeGraphManager, services.skillsManager,
                services.rlmDb
            );
            agent.projectMemoryManager = services.projectMemoryManager;
            agent.setProcessManager(services.processManager);

            // 3. Force UI sync and activate Agent
            panel.setAgentManager(agent);
            if (!agent.getIsActive()) agent.toggleAgentMode();

            await panel.loadDiscussion();

            // 4. TRIGGER AGENTIC EVENTS IMMEDIATELY
            // This ensures the "Generating" overlay appears in the chat panel
            await agent.handleUserMessage(prompts.userPrompt, discussion, activeFolder);
        }
    }));
}
