import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { Prompt } from '../promptManager';
import { buildCodeActionPrompt } from '../utils/promptUtils';
import { ChatPanel } from '../commands/chatPanel/chatPanel';
import { startDiscussionWithInitialPrompt } from '../utils/discussionUtils';
import { CustomActionModal } from '../commands/customActionModal';
import { stripThinkingTags } from '../utils';

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
                await startDiscussionWithInitialPrompt(services, prompts.userPrompt, activeFolder);
            }
        } else {
            // Surgical code modification via side-by-side Diff
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Lollms: Applying ${prompt.title}...`,
                cancellable: true
            }, async (progress, token) => {
                const abortController = new AbortController();
                token.onCancellationRequested(() => abortController.abort());

                try {
                    const response = await services.lollmsAPI.sendChat([
                        { role: 'system', content: prompts.systemPrompt },
                        { role: 'user', content: prompts.userPrompt }
                    ], null, abortController.signal);

                    // --- CLEANUP LOGIC ---
                    let cleanText = stripThinkingTags(response).trim();

                    // Extract content from markdown fences if the AI included them
                    const codeBlockMatch = cleanText.match(/```(?:\w+)?[\r\n]+([\s\S]*?)[\r\n]+```/);
                    if (codeBlockMatch) {
                        cleanText = codeBlockMatch[1];
                    } else {
                        // Fallback: strip any remaining single fences if at start/end
                        cleanText = cleanText.replace(/^`{3,}.*[\r\n]+/, '').replace(/[\r\n]+`{3,}$/, '');
                    }

                    // --- ROBUST RELATIVE INDENTATION NORMALIZER ---
                    const originalFirstLine = editor.document.lineAt(editor.selection.start.line);
                    const targetIndent = originalFirstLine.text.match(/^\s*/)?.[0] || "";
                    const aiLines = cleanText.split(/\r?\n/).filter((l, i, arr) => 
                        !(i === 0 && l.trim() === "") && !(i === arr.length - 1 && l.trim() === "")
                    );

                    if (aiLines.length > 0) {
                        // 1. Determine common prefix to strip from AI output
                        const nonPaddedLines = aiLines.filter(l => l.trim().length > 0);
                        const aiMinIndentLen = Math.min(...nonPaddedLines.map(l => l.match(/^\s*/)?.[0].length || 0));
                        
                        const eol = editor.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
                        const startInColumnZero = editor.selection.start.character === 0 || targetIndent.length === 0;

                        cleanText = aiLines.map((line, idx) => {
                            if (line.trim().length === 0) return "";
                            
                            // Strip AI's arbitrary common indentation
                            const stripped = line.substring(aiMinIndentLen);
                            
                            // If selection starts mid-line, the first line shouldn't be re-indented 
                            // as the 'before' text already contains the leading space.
                            if (idx === 0 && !startInColumnZero) return stripped;
                            
                            // Re-apply original file indentation
                            return targetIndent + stripped;
                        }).join(eol);
                    }

                    // --- DOCUMENT RECONSTRUCTION ---
                    const originalDocText = editor.document.getText();
                    const selectionStartOffset = editor.document.offsetAt(editor.selection.start);
                    const selectionEndOffset = editor.document.offsetAt(editor.selection.end);
                    
                    const before = originalDocText.substring(0, selectionStartOffset);
                    const after = originalDocText.substring(selectionEndOffset);
                    const newDocumentContent = before + cleanText + after;

                    // Open Side-by-Side Diff View. 
                    // Saving the temporary file will apply the changes back to the original document.
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
