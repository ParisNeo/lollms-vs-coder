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

                    // --- RELATIVE INDENTATION NORMALIZER ---
                    // Detect original indentation of the line where the selection starts
                    const originalFirstLine = editor.document.lineAt(editor.selection.start.line);
                    const originalIndent = originalFirstLine.text.match(/^\s*/)?.[0] || "";
                    
                    const aiLines = cleanText.split(/\r?\n/);
                    
                    // Step 1: Filter out leading/trailing empty lines
                    let firstContentIdx = aiLines.findIndex(l => l.trim().length > 0);
                    let lastContentIdx = -1;
                    for (let i = aiLines.length - 1; i >= 0; i--) {
                        if (aiLines[i].trim().length > 0) {
                            lastContentIdx = i;
                            break;
                        }
                    }

                    if (firstContentIdx !== -1 && lastContentIdx !== -1) {
                        const trimmedAiLines = aiLines.slice(firstContentIdx, lastContentIdx + 1);
                        
                        // Step 2: Calculate the minimum common base indentation for all non-empty lines
                        let minAiIndent: string | null = null;
                        for (const line of trimmedAiLines) {
                            if (line.trim().length === 0) { continue; }
                            const currentIndent = line.match(/^\s*/)?.[0] || "";
                            if (minAiIndent === null || currentIndent.length < minAiIndent.length) {
                                minAiIndent = currentIndent;
                            }
                        }
                        const aiBaseIndent = minAiIndent || "";
                        
                        // Step 3: Strip the common base indentation to make the block "flat" relative to its first line content
                        const normalizedLines = trimmedAiLines.map((line, idx) => {
                            if (line.trim().length === 0) { return ""; }
                            
                            // For the very first line, we always trim all leading whitespace to ensure 
                            // it aligns perfectly with the selection start (whether mid-line or at column 0).
                            if (idx === 0) { return line.trimStart(); }

                            if (line.startsWith(aiBaseIndent)) {
                                return line.substring(aiBaseIndent.length);
                            }
                            return line.trimStart(); 
                        });

                        // Step 4: Map back to the user's editor indentation structure
                        const eol = editor.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
                        const startChar = editor.selection.start.character;
                        
                        const finalCode = normalizedLines
                            .map((line, index) => {
                                if (line.length === 0) { return ""; }

                                // If selection starts > 0, 'before' text already contains the leading whitespace for the line.
                                // We don't add originalIndent to the first line to avoid the "extra tab" bug.
                                if (index === 0 && startChar > 0) {
                                    return line;
                                }
                                // For all other cases, we re-apply the captured base indentation of the original selection.
                                return originalIndent + line;
                            })
                            .join(eol);
                        
                        cleanText = finalCode;
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
