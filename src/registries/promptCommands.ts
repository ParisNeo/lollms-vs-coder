import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { Prompt } from '../promptManager';
import { buildCodeActionPrompt } from '../utils/promptUtils';
import { ChatPanel } from '../commands/chatPanel/chatPanel';
import { startDiscussionWithInitialPrompt } from '../utils/discussionUtils';
import { CustomActionModal } from '../commands/customActionModal';
import { stripThinkingTags, getProcessedSystemPrompt } from '../utils';
import { Logger } from '../logger'; // <--- AJOUTEZ CETTE LIGNE

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

        if (prompt.action_type === 'information') {
            const activeFolder = vscode.workspace.workspaceFolders?.[0];
            if (activeFolder) {
                await startDiscussionWithInitialPrompt(services, prompts.userPrompt, activeFolder, true, 'user');
            }
        } else {
            // Surgical code modification with Intelligent Orchestrator
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Lollms: Orchestrating ${prompt.title}...`,
                cancellable: true
            }, async (progress, token) => {
                const abortController = new AbortController();
                token.onCancellationRequested(() => abortController.abort());
                const signal = abortController.signal;

                try {
                    const history: ChatMessage[] = [
                        { role: 'system', content: await getProcessedSystemPrompt('surgical_agent') },
                        { role: 'user', content: prompts.userPrompt }
                    ];

                    let finalCode = "";
                    let stepCount = 0;
                    const MAX_STEPS = 5;

                    while (stepCount < MAX_STEPS && !finalCode) {
                        if (signal.aborted) break;
                        stepCount++;

                        const response = await services.lollmsAPI.sendChat(history, null, signal);
                        const cleanResponse = stripThinkingTags(response);

                        // Check if response contains a tool call
                        const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            try {
                                const action = JSON.parse(jsonMatch[0]);
                                
                                // INTENT SIGNALING
                                if (action.tool && action.tool !== 'done') {
                                    progress.report({ message: `🚀 Agent: Intelligent Expansion Mode (Tool: ${action.tool})` });
                                } else if (action.tool === 'done') {
                                    progress.report({ message: `✨ Agent: Finalizing update...` });
                                }

                                if (action.scratchpad) {
                                    Logger.info(`[SurgicalAgent] Scratchpad: ${action.scratchpad}`);
                                }

                                if (action.tool === 'read_files' && action.params?.paths) {
                                    const msg = `🔍 Reading: ${action.params.paths.join(', ')}`;
                                    progress.report({ message: `Agent: ${msg}` });
                                    Logger.info(`[SurgicalAgent] ${msg}`);
                                    const content = await services.contextManager.readSpecificFiles(action.params.paths);
                                    history.push({ role: 'assistant', content: response });
                                    history.push({ role: 'system', content: `FILE CONTENT:\n${content}` });
                                    continue;
                                }

                                if (action.tool === 'get_project_tree') {
                                    progress.report({ message: `🚀 Agent: Mapping project structure...` });
                                    const contextData = await services.contextManager.getContextContent({ includeTree: true });
                                    history.push({ role: 'assistant', content: response });
                                    history.push({ role: 'system', content: `FULL PROJECT STRUCTURE:\n${contextData.projectTree}` });
                                    continue;
                                }

                                if (action.tool === 'read_skills' && action.params?.skill_ids) {
                                    const allSkills = await services.skillsManager.getSkills();
                                    const selected = allSkills.filter(s => action.params.skill_ids.includes(s.id));
                                    const content = selected.map(s => `Skill: ${s.name}\n${s.content}`).join('\n\n');
                                    history.push({ role: 'assistant', content: response });
                                    history.push({ role: 'system', content: `SKILL DATA:\n${content}` });
                                    continue;
                                }

                                if (action.tool === 'done') {
                                    finalCode = action.params?.code || action.code;
                                    break;
                                }
                            } catch (e) {
                                // Not a valid tool call, treat as direct content
                                progress.report({ message: `✅ Agent: Direct Update Mode` });
                                finalCode = cleanResponse;
                            }
                        } else {
                            // No JSON/Tool found, treat as direct output
                            progress.report({ message: `✅ Agent: Direct Update Mode` });
                            finalCode = cleanResponse;
                        }
                    }

                    if (signal.aborted || !finalCode) return;

                    // Scan response for memory tags (e.g. AI wants to remember a specific refactor rule)
                    if (services.projectMemoryManager) {
                        await services.projectMemoryManager.processTags(lastResponse);
                    }

                    // --- CLEANUP LOGIC ---
                    let cleanText = finalCode.trim();
                    const originalDocText = editor.document.getText();
                    let newDocumentContent = originalDocText;

                    // 1. Check for SEARCH/REPLACE blocks (Preferred)
                    const aiderRegex = /^<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/gm;
                    const matches = [...cleanText.matchAll(aiderRegex)];

                    if (matches.length > 0) {
                        const { applySearchReplace } = require('../utils');
                        for (const match of matches) {
                            const searchBlock = match[1];
                            const replaceBlock = match[2];
                            const result = applySearchReplace(newDocumentContent, searchBlock, replaceBlock);
                            
                            if (result.success) {
                                newDocumentContent = result.result;
                            } else {
                                vscode.window.showWarningMessage(`Could not apply a change: ${result.error}`);
                            }
                        }
                    } else {
                        // 2. Fallback: Direct replacement of the selected range without fragile math
                        // Extract content from markdown fences if the AI included them
                        const codeBlockMatch = cleanText.match(/```(?:\w+)?[\r\n]+([\s\S]*?)[\r\n]+```/);
                        if (codeBlockMatch) {
                            cleanText = codeBlockMatch[1];
                        } else {
                            // Fallback: strip any remaining single fences if at start/end
                            cleanText = cleanText.replace(/^`{3,}.*[\r\n]+/, '').replace(/[\r\n]+`{3,}$/, '');
                        }

                        const selectionStartOffset = editor.document.offsetAt(editor.selection.start);
                        const selectionEndOffset = editor.document.offsetAt(editor.selection.end);
                        
                        const before = originalDocText.substring(0, selectionStartOffset);
                        const after = originalDocText.substring(selectionEndOffset);
                        newDocumentContent = before + cleanText + after;
                    }

                    // Open Side-by-Side Diff View. 
                    await services.diffManager.openDiff(editor.document.uri, newDocumentContent);

                } catch (e: any) {
                    if (e.name !== 'AbortError') {
                        vscode.window.showErrorMessage(`Action failed: ${e.message}`);
                    }
                }
            });
        }
    }));
}
