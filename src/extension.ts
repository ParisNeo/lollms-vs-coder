import * as vscode from 'vscode';
import * as path from 'path';
import { LollmsAPI } from './lollmsAPI';
import { ChatPanel } from './commands/chatPanel';
import { SettingsPanel } from './commands/configView';
import { ContextManager } from './contextManager';
import { GitIntegration } from './gitIntegration';
import { applyDiff } from './utils';
import { FileItem } from './commands/fileTreeProvider';
import { DiscussionManager } from './discussionManager';
import { DiscussionTreeProvider, DiscussionItem, DiscussionGroupItem } from './commands/discussionTreeProvider';
import { ScriptRunner } from './scriptRunner';
import { PromptManager, Prompt } from './promptManager';
import { ChatPromptTreeProvider } from './commands/chatPromptTreeProvider';
import { CodeActionTreeProvider } from './commands/codeActionTreeProvider';
import { PromptItem, PromptGroupItem } from './commands/treeItems';
import { HelpPanel } from './commands/helpPanel';
import { PromptBuilderPanel, parsePlaceholders } from './commands/promptBuilderPanel';
import { CodeActionProvider } from './commands/codeActions';
import { LollmsInlineCompletionProvider } from './commands/inlineSuggestions';

interface GitExtension { getAPI(version: 1): API; }
interface API { repositories: Repository[]; }
interface Repository { inputBox: { value: string }; }

async function handleCopilotConflict(context: vscode.ExtensionContext) {
    const copilotConflictResolved = context.globalState.get('lollms.copilotConflictResolved');
    if (copilotConflictResolved) return;

    const copilotExtension = vscode.extensions.getExtension('github.copilot');
    if (copilotExtension && copilotExtension.isActive) {
        const selection = await vscode.window.showWarningMessage(
            'Lollms VS Coder detected that GitHub Copilot is active. To prevent conflicts, we recommend disabling Copilot for this workspace.',
            { modal: true }, 'Disable Copilot in Workspace', 'Dismiss'
        );
        if (selection === 'Disable Copilot in Workspace') {
            await vscode.commands.executeCommand('workbench.extensions.action.disableWorkspace', 'github.copilot');
            vscode.window.showInformationMessage('GitHub Copilot has been disabled for this workspace.');
        }
        await context.globalState.update('lollms.copilotConflictResolved', true);
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Lollms VS Coder is now active!');
    handleCopilotConflict(context);

    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    let lollmsAPI = new LollmsAPI({
        apiUrl: `${config.get<string>('apiUrl') || 'http://localhost:9642'}/v1/chat/completions`,
        apiKey: config.get<string>('apiKey')?.trim() || '',
        modelName: config.get<string>('modelName') || 'ollama/mistral',
        disableSslVerification: config.get<boolean>('disableSslVerification') || false
    });

    const contextManager = new ContextManager(context);
    const scriptRunner = new ScriptRunner();
    const promptManager = new PromptManager(context.globalStorageUri);

    const chatPromptTreeProvider = new ChatPromptTreeProvider(promptManager);
    const codeActionTreeProvider = new CodeActionTreeProvider(promptManager);
    vscode.window.registerTreeDataProvider('lollmsChatPromptsView', chatPromptTreeProvider);
    vscode.window.registerTreeDataProvider('lollmsCodeActionsView', codeActionTreeProvider);

    const codeActionProvider = new CodeActionProvider();
    context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file', language: '*' }, codeActionProvider));
    
    const inlineProvider = new LollmsInlineCompletionProvider(lollmsAPI);
    if (config.get<boolean>('enableInlineSuggestions')) {
        context.subscriptions.push(
            vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, inlineProvider)
        );
    }

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.editPromptsFile', async () => {
        const promptsFilePath = promptManager.getPromptsFilePath();
        const document = await vscode.workspace.openTextDocument(promptsFilePath);
        await vscode.window.showTextDocument(document);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.triggerInlineSuggestion', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
    
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Window,
            title: "Lollms: Thinking...",
            cancellable: false
        }, async (progress) => {
            const suggestion = await inlineProvider.triggerSuggestion(editor.document, editor.selection.active);
            if (suggestion) {
                editor.edit(editBuilder => {
                    const position = editor.selection.active;
                    const lineEnd = editor.document.lineAt(position.line).range.end;
                    const rangeToReplace = new vscode.Range(position, lineEnd);
                    editBuilder.replace(rangeToReplace, suggestion);
                });
            } else {
                vscode.window.showInformationMessage("No suggestion found.");
            }
        });
    }));

    const usePromptLogic = async (content: string) => {
        const editor = vscode.window.activeTextEditor;
        const selectedText = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : '';
        const placeholders = parsePlaceholders(content);
        let finalContent = content;
    
        if (placeholders.length > 0) {
            const formData = await PromptBuilderPanel.createOrShow(context.extensionUri, placeholders);
            if (formData === null) return null;
            placeholders.forEach(p => {
                const value = formData[p.name] ?? '';
                finalContent = finalContent.replace(p.fullMatch, String(value));
            });
        }
    
        if (finalContent.includes('{{SELECTED_CODE}}')) {
            if (selectedText) {
                finalContent = finalContent.replace('{{SELECTED_CODE}}', `\n\`\`\`\n${selectedText}\n\`\`\``);
            } else {
                finalContent = finalContent.replace('{{SELECTED_CODE}}', '');
            }
        }
        return finalContent;
    };

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.refreshPrompts', () => {
        chatPromptTreeProvider.refresh();
        codeActionTreeProvider.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.useChatPrompt', async (prompt: Prompt) => {
        const finalContent = await usePromptLogic(prompt.content);
        if (finalContent !== null) {
            if (ChatPanel.currentPanel) {
                ChatPanel.currentPanel.setInputText(finalContent);
                ChatPanel.currentPanel['_panel'].reveal();
            } else {
                vscode.window.showInformationMessage("Please open a chat panel first to use a prompt.");
            }
        }
    }));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.triggerCodeAction', async (prompt?: Prompt) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) {
            vscode.window.showInformationMessage("Please select code to apply an action.");
            return;
        }
    
        let targetPrompt = prompt;
        if (!targetPrompt) {
            const codePrompts = await promptManager.getCodeActionPrompts();
            if (codePrompts.length === 0) {
                vscode.window.showErrorMessage("No Code Action prompts found. Create one by adding '{{SELECTED_CODE}}' to a prompt's content.");
                return;
            }
            const selection = await vscode.window.showQuickPick(
                codePrompts.map(p => ({ label: p.title, description: p.content, prompt: p })),
                { placeHolder: "Select a Lollms code action" }
            );
            if (!selection) return;
            targetPrompt = selection.prompt;
        }
    
        const finalContent = await usePromptLogic(targetPrompt.content);
        if (finalContent === null) return;
    
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Lollms: Applying "${targetPrompt.title}"...`,
            cancellable: false
        }, async (progress) => {
            const responseText = await lollmsAPI.sendChat([{ role: 'user', content: finalContent }]);
            
            if (targetPrompt?.action_type === 'information') {
                vscode.window.showInformationMessage(responseText, { modal: true });
            } else {
                const codeBlockRegex = /```(?:[\w-]*)\n([\s\S]+?)\n```/;
                const match = responseText.match(codeBlockRegex);
                const modifiedCode = match ? match[1] : responseText;

                const originalContent = editor.document.getText();
                const selectionRange = editor.selection;
                
                const contentBefore = editor.document.getText(new vscode.Range(new vscode.Position(0, 0), selectionRange.start));
                const contentAfter = editor.document.getText(new vscode.Range(selectionRange.end, new vscode.Position(editor.document.lineCount, 0)));
                
                const fullModifiedContent = contentBefore + modifiedCode + contentAfter;

                const tempDirUri = vscode.Uri.joinPath(context.extensionUri, 'temp');
                await vscode.workspace.fs.createDirectory(tempDirUri);
    
                const originalUri = editor.document.uri;
                const tempOriginalUri = vscode.Uri.joinPath(tempDirUri, `original_${path.basename(originalUri.fsPath)}`);
                await vscode.workspace.fs.writeFile(tempOriginalUri, Buffer.from(originalContent, 'utf8'));

                const modifiedUri = vscode.Uri.joinPath(tempDirUri, `modified_${path.basename(originalUri.fsPath)}`);
                await vscode.workspace.fs.writeFile(modifiedUri, Buffer.from(fullModifiedContent, 'utf8'));

                vscode.commands.executeCommand('vscode.diff', tempOriginalUri, modifiedUri, `Original ↔ AI Suggestion (${targetPrompt?.title})`);
            }
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.createPrompt', async (item?: PromptGroupItem) => {
        const title = await vscode.window.showInputBox({ prompt: 'Enter Prompt Title' });
        if (!title) return;
        const content = await vscode.window.showInputBox({ prompt: 'Enter Prompt Content', value: '{{SELECTED_CODE}}' });
        if (content === undefined) return;
        
        const data = await promptManager.getData();
        const newPrompt: Prompt = {
            id: Date.now().toString(),
            groupId: item instanceof PromptGroupItem ? item.group.id : null,
            title,
            content,
            type: content.includes('{{SELECTED_CODE}}') ? 'code_action' : 'chat'
        };

        if (newPrompt.type === 'code_action') {
            const actionType = await vscode.window.showQuickPick(
                [
                    { label: 'Modify Code', description: 'AI will suggest code changes (shows a diff)', type: 'generation' as const },
                    { label: 'Ask Question about Code', description: 'AI will answer a question (shows in a message box)', type: 'information' as const }
                ],
                { placeHolder: 'Select the type of code action' }
            );

            if (!actionType) return; // User cancelled
            newPrompt.action_type = actionType.type;
        }

        data.prompts.push(newPrompt);
        await promptManager.saveData(data);
        chatPromptTreeProvider.refresh();
        codeActionTreeProvider.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.editPrompt', async (item: PromptItem) => {
        if (item.prompt.is_default) {
            vscode.window.showInformationMessage("Default prompts cannot be edited.");
            return;
        }
        const newTitle = await vscode.window.showInputBox({ prompt: 'Enter New Title', value: item.prompt.title });
        if (newTitle === undefined) return;
        const newContent = await vscode.window.showInputBox({ prompt: 'Enter New Content', value: item.prompt.content });
        if (newContent === undefined) return;
        const data = await promptManager.getData();
        const promptToUpdate = data.prompts.find(p => p.id === item.id);
        if (promptToUpdate) {
            promptToUpdate.title = newTitle;
            promptToUpdate.content = newContent;
            promptToUpdate.type = newContent.includes('{{SELECTED_CODE}}') ? 'code_action' : 'chat';
            
            if (promptToUpdate.type === 'code_action') {
                const actionType = await vscode.window.showQuickPick(
                    [
                        { label: 'Modify Code', description: 'AI will suggest code changes (shows a diff)', type: 'generation' as const },
                        { label: 'Ask Question about Code', description: 'AI will answer a question (shows in a message box)', type: 'information' as const }
                    ],
                    { placeHolder: 'Select the type of code action' }
                );
    
                if (!actionType) return; // User cancelled
                promptToUpdate.action_type = actionType.type;
            } else {
                delete promptToUpdate.action_type;
            }

            await promptManager.saveData(data);
            chatPromptTreeProvider.refresh();
            codeActionTreeProvider.refresh();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.deletePrompt', async (item: PromptItem) => {
        if (item.prompt.is_default) {
            vscode.window.showInformationMessage("Default prompts cannot be deleted.");
            return;
        }
        const confirm = await vscode.window.showWarningMessage(`Delete prompt "${item.prompt.title}"?`, { modal: true }, 'Delete');
        if (confirm === 'Delete') {
            const data = await promptManager.getData();
            data.prompts = data.prompts.filter(p => p.id !== item.id);
            await promptManager.saveData(data);
            chatPromptTreeProvider.refresh();
            codeActionTreeProvider.refresh();
        }
    }));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.saveMessageAsPrompt', async (content: string) => {
        const title = await vscode.window.showInputBox({ prompt: 'Enter a title for your new prompt' });
        if (!title) return;

        const data = await promptManager.getData();
        const newPrompt: Prompt = {
            id: Date.now().toString(),
            groupId: null,
            title,
            content,
            type: content.includes('{{SELECTED_CODE}}') ? 'code_action' : 'chat'
        };

        if (newPrompt.type === 'code_action') {
            const actionType = await vscode.window.showQuickPick(
                [
                    { label: 'Modify Code', description: 'AI will suggest code changes (shows a diff)', type: 'generation' as const },
                    { label: 'Ask Question about Code', description: 'AI will answer a question (shows in a message box)', type: 'information' as const }
                ],
                { placeHolder: 'Select the type of code action' }
            );

            if (!actionType) return; // User cancelled
            newPrompt.action_type = actionType.type;
        }

        data.prompts.push(newPrompt);
        await promptManager.saveData(data);
        chatPromptTreeProvider.refresh();
        codeActionTreeProvider.refresh();
        vscode.window.showInformationMessage(`Prompt "${title}" saved!`);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.createPromptGroup', async () => {
        const title = await vscode.window.showInputBox({ prompt: "Enter prompt group title" });
        if (!title) return;
        const data = await promptManager.getData();
        data.groups.push({ id: Date.now().toString(), title });
        await promptManager.saveData(data);
        chatPromptTreeProvider.refresh();
        codeActionTreeProvider.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.renamePromptGroup', async (item: PromptGroupItem) => {
        const newTitle = await vscode.window.showInputBox({ prompt: "Enter new group title", value: item.group.title });
        if (newTitle && newTitle !== item.group.title) {
            const data = await promptManager.getData();
            const group = data.groups.find(g => g.id === item.group.id);
            if (group) {
                group.title = newTitle;
                await promptManager.saveData(data);
                chatPromptTreeProvider.refresh();
                codeActionTreeProvider.refresh();
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.deletePromptGroup', async (item: PromptGroupItem) => {
        const confirm = await vscode.window.showWarningMessage(`Delete group "${item.group.title}"? Prompts inside will become ungrouped.`, { modal: true }, 'Delete');
        if (confirm === 'Delete') {
            const data = await promptManager.getData();
            data.groups = data.groups.filter(g => g.id !== item.group.id);
            data.prompts.forEach(p => {
                if (p.groupId === item.group.id) p.groupId = null;
            });
            await promptManager.saveData(data);
            chatPromptTreeProvider.refresh();
            codeActionTreeProvider.refresh();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.movePromptToGroup', async (item: PromptItem) => {
        const data = await promptManager.getData();
        const quickPickItems = [
            { id: null, label: " (No Group)" },
            ...data.groups.map(g => ({ id: g.id, label: g.title }))
        ];
        const selected = await vscode.window.showQuickPick(quickPickItems, { placeHolder: "Select a group" });
        if (selected) {
            const prompt = data.prompts.find(p => p.id === item.prompt.id);
            if (prompt) {
                prompt.groupId = selected.id;
                await promptManager.saveData(data);
                chatPromptTreeProvider.refresh();
                codeActionTreeProvider.refresh();
            }
        }
    }));
    
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri;
        const discussionManager = new DiscussionManager(workspaceRoot, lollmsAPI);
        const discussionTreeProvider = new DiscussionTreeProvider(discussionManager);
        vscode.window.registerTreeDataProvider('lollmsDiscussionsView', discussionTreeProvider);
        context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.refreshDiscussions', () => discussionTreeProvider.refresh()));
        context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.newDiscussion', async (item?: DiscussionGroupItem) => {
            const groupId = item instanceof DiscussionGroupItem ? item.group.id : null;
            const panel = ChatPanel.createOrShow(context.extensionUri, lollmsAPI, discussionManager);
            panel.setContextManager(contextManager);
            await panel.startNewDiscussion(groupId);
            discussionTreeProvider.refresh();
        }));
        context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.switchDiscussion', async (discussionId: string) => {
            const panel = ChatPanel.createOrShow(context.extensionUri, lollmsAPI, discussionManager);
            panel.setContextManager(contextManager);
            await panel.loadDiscussion(discussionId);
        }));
        context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.deleteDiscussion', async (item: DiscussionItem) => {
            const confirm = await vscode.window.showWarningMessage(`Are you sure you want to delete "${item.discussion.title}"?`, { modal: true }, 'Delete');
            if (confirm === 'Delete') {
                await discussionManager.deleteDiscussion(item.discussion.id);
                discussionTreeProvider.refresh();
                if (ChatPanel.currentPanel && ChatPanel.currentPanel.getCurrentDiscussionId() === item.discussion.id) {
                    ChatPanel.currentPanel.dispose();
                }
            }
        }));
        context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.renameDiscussion', async (item: DiscussionItem) => {
            const newTitle = await vscode.window.showInputBox({ prompt: "Enter new discussion title", value: item.discussion.title });
            if (newTitle && newTitle !== item.discussion.title) {
                item.discussion.title = newTitle;
                await discussionManager.saveDiscussion(item.discussion);
                discussionTreeProvider.refresh();
            }
        }));
        context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.generateDiscussionTitle', async (item: DiscussionItem) => {
            const title = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Lollms: Generating discussion title...", cancellable: false }, async () => await discussionManager.generateDiscussionTitle(item.discussion));
            if (title) {
                item.discussion.title = title;
                await discussionManager.saveDiscussion(item.discussion);
                discussionTreeProvider.refresh();
            }
        }));
        context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.createDiscussionGroup', async () => {
            const title = await vscode.window.showInputBox({ prompt: "Enter group title" });
            if (!title) return;
            const description = await vscode.window.showInputBox({ prompt: "Enter group description (optional)" });
            const groups = await discussionManager.getGroups();
            groups.push({ id: Date.now().toString(), title, description: description || '', timestamp: Date.now() });
            await discussionManager.saveGroups(groups);
            discussionTreeProvider.refresh();
        }));
        context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.renameDiscussionGroup', async (item: DiscussionGroupItem) => {
            const newTitle = await vscode.window.showInputBox({ prompt: "Enter new group title", value: item.group.title });
            if (newTitle && newTitle !== item.group.title) {
                const groups = await discussionManager.getGroups();
                const groupToUpdate = groups.find(g => g.id === item.group.id);
                if (groupToUpdate) {
                    groupToUpdate.title = newTitle;
                    await discussionManager.saveGroups(groups);
                    discussionTreeProvider.refresh();
                }
            }
        }));
        context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.deleteDiscussionGroup', async (item: DiscussionGroupItem) => {
            const confirm = await vscode.window.showWarningMessage(`Delete group "${item.group.title}"? Discussions inside will become ungrouped.`, { modal: true }, 'Delete');
            if (confirm === 'Delete') {
                await discussionManager.deleteGroup(item.group.id);
                discussionTreeProvider.refresh();
            }
        }));
        context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.moveDiscussionToGroup', async (item: DiscussionItem) => {
            const groups = await discussionManager.getGroups();
            const items = [{ id: null, label: " (No Group)" }, ...groups.map(g => ({ id: g.id, label: g.title, description: g.description }))];
            const selected = await vscode.window.showQuickPick(items, { placeHolder: "Select a group to move the discussion to" });
            if (selected) {
                const discussion = await discussionManager.getDiscussion(item.discussion.id);
                if (discussion) {
                    discussion.groupId = selected.id;
                    await discussionManager.saveDiscussion(discussion);
                    discussionTreeProvider.refresh();
                }
            }
        }));
        context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.startChat', () => { vscode.commands.executeCommand('lollms-vs-coder.newDiscussion'); }));
    } else {
        context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.startChat', () => {
            vscode.window.showInformationMessage("Please open a folder in VS Code to use Lollms persistent chat.");
        }));
    }

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.runScript', (code: string, language: string) => {
        if (ChatPanel.currentPanel) { scriptRunner.runScript(code, language, ChatPanel.currentPanel); }
        else { vscode.window.showErrorMessage("No active Lollms chat panel to show script output."); }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showConfigView', () => { SettingsPanel.createOrShow(context.extensionUri); }));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showHelp', () => { HelpPanel.createOrShow(context.extensionUri); }));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.exportContextContent', async () => {
        try {
            const content = await contextManager.getContextContent();
            await vscode.env.clipboard.writeText(content.text);
            vscode.window.showInformationMessage('Lollms: Project context copied to clipboard.');
        } catch (error: any) { vscode.window.showErrorMessage(`Failed to export context: ${error.message}`); }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('lollmsSettings.fetchModels', async (apiUrl, apiKey) => {
        const fetch = require('node-fetch');
        try {
            const url = apiUrl.replace(/\/+$/, '') + '/v1/models';
            const response = await fetch(url, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
            if (!response.ok) { throw new Error(`HTTP Error ${response.status}: ${response.statusText}`); }
            return (await response.json()).data || [];
        } catch (err) { console.error('Error fetching models in extension:', err); return []; }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('lollmsApi.recreateClient', async (newConfig) => {
        lollmsAPI = new LollmsAPI({ 
            apiKey: newConfig.apiKey, 
            apiUrl: `${newConfig.apiUrl}/v1/chat/completions`, 
            modelName: newConfig.modelName,
            disableSslVerification: newConfig.disableSslVerification
        });
        vscode.window.showInformationMessage('LollmsAPI client reconfigured successfully.');
    }));

    const gitIntegration = new GitIntegration(lollmsAPI);
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.generateCommitMessage', async () => {
        if (!(await gitIntegration.isGitRepo())) { vscode.window.showErrorMessage('This workspace is not a git repository.'); return; }
        const message = await gitIntegration.generateCommitMessage();
        if (message) {
            const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
            if (!gitExtension) { vscode.window.showErrorMessage('VS Code Git extension not found.'); return; }
            const gitAPI = gitExtension.exports.getAPI(1);
            if (gitAPI.repositories.length > 0) {
                gitAPI.repositories[0].inputBox.value = message;
                vscode.commands.executeCommand('workbench.view.scm');
            }
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.commitWithAIMessage', async () => {
        if (!(await gitIntegration.isGitRepo())) { vscode.window.showErrorMessage('This workspace is not a git repository.'); return; }
        const message = await gitIntegration.generateCommitMessage();
        if (message) {
            const confirmed = await vscode.window.showQuickPick(['Yes', 'No'], { placeHolder: `Commit with message:\n\n${message}\n\nConfirm?` });
            if (confirmed === 'Yes') { await gitIntegration.commitWithMessage(message); }
        }
    }));

    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        const fileTreeProvider = contextManager.getFileTreeProvider();
        if (fileTreeProvider) {
            vscode.window.createTreeView('lollmsSettings.fileTreeView', { treeDataProvider: fileTreeProvider, showCollapseAll: true });
            context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.cycleFileState', (item: FileItem) => fileTreeProvider.cycleFileState(item)));
            context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.addFolderToContext', (item: FileItem) => fileTreeProvider.addFolderToContext(item)));
            context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.removeFolderFromContext', (item: FileItem) => fileTreeProvider.removeFolderFromContext(item)));
            context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.refreshTree', () => fileTreeProvider.refresh()));
        }
    }

    const saveCodeCommand = vscode.commands.registerCommand('lollms-vs-coder.saveCodeToFile', async (code: string, language?: string) => {
        const document = await vscode.workspace.openTextDocument({ content: code, language });
        await vscode.window.showTextDocument(document);
    });
    const applyDiffCommand = vscode.commands.registerCommand('lollms-vs-coder.applyDiff', async (diffContent: string) => {
        try { await applyDiff(diffContent); vscode.window.showInformationMessage('Diff applied successfully.'); } 
        catch (error: any) { vscode.window.showErrorMessage(`Failed to apply diff: ${error.message}`); }
    });
    context.subscriptions.push(saveCodeCommand, applyDiffCommand);

    const chatStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    chatStatusBar.text = '$(comment-discussion) Lollms Chat';
    chatStatusBar.command = 'lollms-vs-coder.startChat';
    chatStatusBar.tooltip = 'Start New Lollms Discussion';
    chatStatusBar.show();
    context.subscriptions.push(chatStatusBar);

    const autocompleteStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    autocompleteStatusBar.text = `$(sparkle) Lollms`;
    autocompleteStatusBar.command = 'lollms-vs-coder.triggerInlineSuggestion';
    autocompleteStatusBar.tooltip = 'Lollms: Autocomplete';
    autocompleteStatusBar.show();
    context.subscriptions.push(autocompleteStatusBar);
    
    console.log('Extension activation complete.');
}

export function deactivate() {}