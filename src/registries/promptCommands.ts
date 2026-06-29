import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { Prompt } from '../promptManager';
import { buildCodeActionPrompt } from '../utils/promptUtils';
import { ChatPanel } from '../commands/chatPanel/chatPanel';
import { startDiscussionWithInitialPrompt } from '../utils/discussionUtils';
import { CustomActionModal } from '../commands/customActionModal';
import { stripThinkingTags, getProcessedSystemPrompt, applySearchReplace } from '../utils';
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

        const activeFolder = vscode.workspace.workspaceFolders?.[0];
        if (!activeFolder) {
            vscode.window.showErrorMessage("Please open a workspace folder to use surgical actions.");
            return;
        }

        // --- DYNAMIC SURGICAL COMPOSER FLOW ---
        // For both generation and information tasks, we spin up an optimized
        // Dynamic Discussion with a lean context (active file only) and Auto-Apply on.
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Lollms: Initializing Dynamic Surgical Workspace...",
            cancellable: false
        }, async () => {
            const provider = services.contextManager.getContextStateProvider();
            const originalIncludedFiles = provider ? provider.getIncludedFiles().map(f => f.path) : [];

            // 1. Soft-reset active selections & isolate exclusively to the active file
            if (provider) {
                await provider.softReset();
                const activeRelPath = vscode.workspace.asRelativePath(editor.document.uri);
                await provider.addFilesToContext([activeRelPath]);
            }

            const prompts = await buildCodeActionPrompt(
                prompt.content,
                prompt.action_type,
                editor,
                services.extensionUri,
                services.contextManager,
                services.lollmsAPI,
                useContext
            );

            if (prompts) {
                const discussion = services.discussionManager.createNewDiscussion();
                discussion.title = `Surgical Fix: ${prompt.title}`;

                // 2. Enforce Dynamic Mode + Auto-Apply + Full Tool Access
                discussion.capabilities = {
                    ...discussion.capabilities,
                    ...services.discussionManager.getLastCapabilities(),
                    dynamicMode: true,
                    autoApply: true,
                    autoFix: true,
                    sparqlEnabled: true,
                    grepEnabled: true,
                    disableProjectContext: false
                };

                await services.discussionManager.saveDiscussion(discussion);
                const panel = ChatPanel.createOrShow(services, discussion.id);

                // 3. Connect the Agent manager and load state
                const agent = new AgentManager(
                    panel, services.lollmsAPI, services.contextManager, services.gitIntegration, 
                    services.discussionManager, services.extensionUri, services.codeGraphManager, services.skillsManager,
                    services.toolManager,
                    services.rlmDb
                );
                agent.projectMemoryManager = services.projectMemoryManager;
                agent.personalityManager = services.personalityManager;
                agent.setProcessManager(services.processManager);
                panel.setAgentManager(agent);

                panel.setProcessManager(services.processManager);
                panel.setContextManager(services.contextManager);
                panel.setPersonalityManager(services.personalityManager);
                panel.setHerdManager(services.herdManager);

                await panel.loadDiscussion();
                services.treeProviders.discussion?.refresh();

                // 4. Dispatch the instruction immediately
                const initialMessage: ChatMessage = {
                    id: 'msg_' + Date.now() + Math.random().toString(36).substring(2),
                    role: 'user',
                    content: prompts.userPrompt,
                    timestamp: Date.now()
                };

                panel._panel.reveal();
                await panel.sendMessage(initialMessage);

                // 5. Restore original context selection so the user's workspace sidebar remains untouched
                if (provider && originalIncludedFiles.length > 0) {
                    await provider.softReset();
                    await provider.addFilesToContext(originalIncludedFiles);
                }
            }
        });
    }));
}
