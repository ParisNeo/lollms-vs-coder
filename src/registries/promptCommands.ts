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

        if (prompt.action_type === 'information') {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Lollms: Exploring codebase & preparing discussion...",
                cancellable: false
            }, async () => {
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
                    await startDiscussionWithInitialPrompt(services, prompts.userPrompt, activeFolder, true, 'user');
                }
            });
        } else {
            // --- SURGICAL FAST-PATH: INLINE DIFF ---
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Lollms: Exploring dependencies & generating patch...",
                cancellable: true
            }, async (progress, token) => {
                const abortController = new AbortController();
                token.onCancellationRequested(() => abortController.abort());

                try {
                    // Do the exploration phase INSIDE the progress block to prevent UI flickering
                    progress.report({ message: "Analyzing code graph..." });
                    const prompts = await buildCodeActionPrompt(
                        prompt.content,
                        prompt.action_type,
                        editor,
                        services.extensionUri,
                        services.contextManager,
                        services.lollmsAPI,
                        useContext,
                        abortController.signal
                    );

                    if (!prompts) return;
                    if (token.isCancellationRequested) return;

                    progress.report({ message: "Generating surgical patch..." });
                    const response = await services.lollmsAPI.sendChat([
                        { role: 'system', content: prompts.systemPrompt },
                        { role: 'user', content: prompts.userPrompt }
                    ], null, abortController.signal);

                    const cleanResponse = stripThinkingTags(response);

                    // Look for Aider Search/Replace or standard code blocks
                    const aiderMatch = cleanResponse.match(/<<<<<<< SEARCH[\s\S]*?=======[\s\S]*?>>>>>>> REPLACE/);
                    const codeBlockMatch = cleanResponse.match(/```(?:\w+)?[\r\n]+([\s\S]*?)[\r\n]+```/);

                    let updatedCode = "";

                    if (aiderMatch) {
                        // Apply Aider logic to selection only
                        const searchPart = aiderMatch[0].split('=======')[0].replace('<<<<<<< SEARCH', '').trim();
                        const replacePart = aiderMatch[0].split('=======')[1].split('>>>>>>> REPLACE')[0].trim();

                        const currentSelection = editor.document.getText(editor.selection);
                        const result = applySearchReplace(currentSelection, searchPart, replacePart);
                        if (result.success) {
                            updatedCode = result.result;
                        }
                    } else if (codeBlockMatch) {
                        updatedCode = codeBlockMatch[1].trim();
                    }

                    if (updatedCode) {
                        await services.inlineDiffProvider.startSession(
                            editor,
                            editor.selection,
                            updatedCode,
                            [], // Empty history for now
                            cleanResponse
                        );
                    } else {
                        throw new Error("No code update was detected in the AI response.");
                    }

                } catch (e: any) {
                    if (e.name !== 'AbortError') {
                        vscode.window.showErrorMessage(`Surgical update failed: ${e.message}`);
                    }
                }
            });
        }
    }));
}
