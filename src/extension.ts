import * as vscode from 'vscode';
import * as path from 'path';
import { LollmsAPI } from './lollmsAPI';
import { ChatPanel } from './commands/chatPanel';
import { SettingsPanel } from './commands/configView';
import { ContextManager } from './contextManager';
import { GitIntegration } from './gitIntegration';
import { applyDiff, getProcessedGlobalSystemPrompt } from './utils';
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
import { AgentManager } from './agentManager';
import { InlineDiffProvider } from './commands/inlineDiffProvider';
import { InfoPanel } from './commands/infoPanel';
import { CustomActionModal } from './commands/customActionModal';
import * as https from 'https';

interface GitExtension { getAPI(version: 1): API; }
interface API { repositories: Repository[]; }
interface Repository { inputBox: { value: string }; }
async function buildCodeActionPrompt(
    promptTemplate: string, 
    editor: vscode.TextEditor, 
    extensionUri: vscode.Uri,
    contextManager: ContextManager
): Promise<{ systemPrompt: string, userPrompt: string } | null> {
    
    const selection = editor.selection;
    const document = editor.document;

    const placeholders = parsePlaceholders(promptTemplate);
    let processedTemplate = promptTemplate;
    if (placeholders.length > 0) {
        const formData = await PromptBuilderPanel.createOrShow(extensionUri, placeholders);
        if (formData === null) return null;
        placeholders.forEach(p => {
            const value = formData[p.name] ?? '';
            processedTemplate = processedTemplate.replace(p.fullMatch, String(value));
        });
    }

    const userInstruction = processedTemplate.replace('{{SELECTED_CODE}}', '').trim();
    const selectedText = document.getText(selection);
    const fileName = path.basename(document.fileName);
    const languageId = document.languageId;
    const startLine = Math.max(0, selection.start.line - 10);
    const endLine = Math.min(document.lineCount - 1, selection.end.line + 10);
    const beforeRange = new vscode.Range(new vscode.Position(startLine, 0), selection.start);
    const afterRange = new vscode.Range(selection.end, new vscode.Position(endLine, document.lineAt(endLine).text.length));
    const codeBefore = document.getText(beforeRange);
    const codeAfter = document.getText(afterRange);
    
    let userPrompt = `I am working on the file \`${fileName}\` which is a \`${languageId}\` file.\n\n`;

    if (codeBefore.trim()) {
        userPrompt += `==== CONTEXT BEFORE (DO NOT INCLUDE IN OUTPUT) ====\n\`\`\`${languageId}\n${codeBefore}\n\`\`\`\n\n`;
    }

    userPrompt += `==== SELECTED CODE TO MODIFY (MODIFY THIS ONLY) ====\n\`\`\`${languageId}\n${selectedText}\n\`\`\`\n\n`;

    if (codeAfter.trim()) {
        userPrompt += `==== CONTEXT AFTER (DO NOT INCLUDE IN OUTPUT) ====\n\`\`\`${languageId}\n${codeAfter}\n\`\`\`\n\n`;
    }

    userPrompt += `INSTRUCTION: **${userInstruction}**\n\n`;
    userPrompt += `⚠️ CRITICAL: Your response must contain ONLY the modified selected code block. Do not include any BEFORE or AFTER context code in your response.`;
    
    const globalPrompt = getProcessedGlobalSystemPrompt();
    let systemPrompt = `You are a surgical code modification tool. You must modify ONLY the selected code block and return ONLY that modified block.

## STRICT OUTPUT RULES
- Return ONLY the modified selected code in a single markdown code block
- NEVER include BEFORE context code in your response
- NEVER include AFTER context code in your response
- NEVER add explanations, comments, or text outside the code block
- The first line of your response must be the opening code fence: \`\`\`${languageId}
- The last line of your response must be the closing code fence: \`\`\`

## INPUT UNDERSTANDING
You receive three sections:
1. **CONTEXT BEFORE**: Reference only - helps you understand the code structure
2. **SELECTED CODE**: The ONLY code you should modify and return
3. **CONTEXT AFTER**: Reference only - helps ensure compatibility

## MODIFICATION REQUIREMENTS
- Apply the instruction precisely to the selected code only
- Preserve original indentation and formatting style
- Maintain compatibility with the surrounding context
- Keep all variable names, imports, and structure unless instructed otherwise
- Ensure the modified code is syntactically correct

## FORBIDDEN ACTIONS
- Do NOT return any BEFORE context code
- Do NOT return any AFTER context code  
- Do NOT add explanatory text
- Do NOT use placeholder comments like "// rest of code"
- Do NOT include line numbers or file headers

Your entire response must be executable code that can directly replace the selected text.


User preferences: ${globalPrompt}
`;
    
    return { systemPrompt, userPrompt };
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Lollms VS Coder is now active!');

    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    let lollmsAPI = new LollmsAPI({
        apiUrl: config.get<string>('apiUrl') || 'http://localhost:9642',
        apiKey: config.get<string>('apiKey')?.trim() || '',
        modelName: config.get<string>('modelName') || 'ollama/mistral',
        disableSslVerification: config.get<boolean>('disableSslVerification') || false
    });

    const contextManager = new ContextManager(context);
    const scriptRunner = new ScriptRunner();
    const promptManager = new PromptManager(context.globalStorageUri);
    const gitIntegration = new GitIntegration(lollmsAPI);

    const chatPromptTreeProvider = new ChatPromptTreeProvider(promptManager);
    context.subscriptions.push(vscode.window.registerTreeDataProvider('lollmsChatPromptsView', chatPromptTreeProvider));
    const codeActionTreeProvider = new CodeActionTreeProvider(promptManager);
    context.subscriptions.push(vscode.window.registerTreeDataProvider('lollmsCodeActionsView', codeActionTreeProvider));

    const inlineDiffProvider = new InlineDiffProvider();
    context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, inlineDiffProvider));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.acceptDiff', () => inlineDiffProvider.accept()));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.rejectDiff', () => inlineDiffProvider.reject()));

    const codeActionProvider = new CodeActionProvider();
    context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file', language: '*' }, codeActionProvider));
    
    if (config.get<boolean>('enableInlineSuggestions')) {
        const inlineProvider = new LollmsInlineCompletionProvider(lollmsAPI);
        context.subscriptions.push(
            vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, inlineProvider)
        );
    }
    
    let discussionView: vscode.TreeView<vscode.TreeItem> | undefined;
    let discussionCommands: vscode.Disposable[] = [];

    function registerDiscussionViewProvider() {
        discussionCommands.forEach(cmd => cmd.dispose());
        discussionCommands = [];
        if (discussionView) {
            discussionView.dispose();
        }

        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            const workspaceRoot = vscode.workspace.workspaceFolders[0].uri;
            const discussionManager = new DiscussionManager(workspaceRoot, lollmsAPI);
            const discussionTreeProvider = new DiscussionTreeProvider(discussionManager);
            discussionView = vscode.window.createTreeView('lollmsDiscussionsView', { treeDataProvider: discussionTreeProvider });

            const setupChatPanel = (panel: ChatPanel) => {
                if (!panel.agentManager) {
                    panel.agentManager = new AgentManager(panel, lollmsAPI, contextManager, gitIntegration, context.extensionUri);
                }
                panel.setContextManager(contextManager);
            };

            discussionCommands.push(vscode.commands.registerCommand('lollms-vs-coder.newDiscussion', async (item?: DiscussionGroupItem) => {
                const groupId = item instanceof DiscussionGroupItem ? item.group.id : null;
                const panel = ChatPanel.createOrShow(context.extensionUri, lollmsAPI, discussionManager);
                setupChatPanel(panel);
                await panel.startNewDiscussion(groupId);
                discussionTreeProvider.refresh();
            }));

            discussionCommands.push(vscode.commands.registerCommand('lollms-vs-coder.switchDiscussion', async (discussionId: string) => {
                const panel = ChatPanel.createOrShow(context.extensionUri, lollmsAPI, discussionManager);
                setupChatPanel(panel);
                await panel.loadDiscussion(discussionId);
            }));
            
            discussionCommands.push(vscode.commands.registerCommand('lollms-vs-coder.deleteDiscussion', async (item: DiscussionItem) => {
                const deleteButton = { title: vscode.l10n.t('command.delete.title'), id: 'delete' };
                const confirm = await vscode.window.showWarningMessage(
                    vscode.l10n.t('prompt.confirmDelete', item.discussion.title), 
                    { modal: true }, 
                    deleteButton
                );
            
                if (confirm?.id === 'delete') {
                    await discussionManager.deleteDiscussion(item.discussion.id);
                    discussionTreeProvider.refresh();
                    if (ChatPanel.currentPanel && ChatPanel.currentPanel.getCurrentDiscussionId() === item.discussion.id) {
                        ChatPanel.currentPanel.dispose();
                    }
                }
            }));

            discussionCommands.push(vscode.commands.registerCommand('lollms-vs-coder.renameDiscussion', async (item: DiscussionItem) => {
                const newTitle = await vscode.window.showInputBox({ prompt: vscode.l10n.t("prompt.enterNewDiscussionTitle"), value: item.discussion.title });
                if (newTitle && newTitle !== item.discussion.title) {
                    item.discussion.title = newTitle;
                    await discussionManager.saveDiscussion(item.discussion);
                    discussionTreeProvider.refresh();
                }
            }));

            discussionCommands.push(vscode.commands.registerCommand('lollms-vs-coder.generateDiscussionTitle', async (item: DiscussionItem) => {
                const title = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("progress.generatingDiscussionTitle"), cancellable: false }, async () => await discussionManager.generateDiscussionTitle(item.discussion));
                if (title) {
                    item.discussion.title = title;
                    await discussionManager.saveDiscussion(item.discussion);
                    discussionTreeProvider.refresh();
                }
            }));

            discussionCommands.push(vscode.commands.registerCommand('lollms-vs-coder.createDiscussionGroup', async () => {
                const title = await vscode.window.showInputBox({ prompt: vscode.l10n.t("prompt.enterGroupTitle") });
                if (!title) return;
                const description = await vscode.window.showInputBox({ prompt: vscode.l10n.t("prompt.enterGroupDescription") });
                const groups = await discussionManager.getGroups();
                groups.push({ id: Date.now().toString(), title, description: description || '', timestamp: Date.now() });
                await discussionManager.saveGroups(groups);
                discussionTreeProvider.refresh();
            }));

            discussionCommands.push(vscode.commands.registerCommand('lollms-vs-coder.renameDiscussionGroup', async (item: DiscussionGroupItem) => {
                const newTitle = await vscode.window.showInputBox({ prompt: vscode.l10n.t("prompt.enterNewTitle"), value: item.group.title });
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

            discussionCommands.push(vscode.commands.registerCommand('lollms-vs-coder.deleteDiscussionGroup', async (item: DiscussionGroupItem) => {
                const deleteButton = { title: vscode.l10n.t('command.delete.title'), id: 'delete' };
                const confirm = await vscode.window.showWarningMessage(
                    vscode.l10n.t('prompt.confirmDeleteGroup', item.group.title), 
                    { modal: true }, 
                    deleteButton
                );
            
                if (confirm?.id === 'delete') {
                    await discussionManager.deleteGroup(item.group.id);
                    discussionTreeProvider.refresh();
                }
            }));

            discussionCommands.push(vscode.commands.registerCommand('lollms-vs-coder.moveDiscussionToGroup', async (item: DiscussionItem) => {
                const groups = await discussionManager.getGroups();
                const items = [{ id: null, label: vscode.l10n.t("label.noGroup") }, ...groups.map(g => ({ id: g.id, label: g.title, description: g.description }))];
                const selected = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t("prompt.selectGroupForMove") });
                if (selected) {
                    const discussion = await discussionManager.getDiscussion(item.discussion.id);
                    if (discussion) {
                        discussion.groupId = selected.id;
                        await discussionManager.saveDiscussion(discussion);
                        discussionTreeProvider.refresh();
                    }
                }
            }));

            discussionCommands.push(vscode.commands.registerCommand('lollms-vs-coder.refreshDiscussions', () => discussionTreeProvider.refresh()));
            
            discussionCommands.push(vscode.commands.registerCommand('lollms-vs-coder.startChat', () => vscode.commands.executeCommand('lollms-vs-coder.newDiscussion')));
        } else {
             discussionCommands.push(vscode.commands.registerCommand('lollms-vs-coder.startChat', () => {
                vscode.window.showInformationMessage(vscode.l10n.t("info.openFolderToUseChat"));
            }));
        }
        context.subscriptions.push(...discussionCommands);
    }
    
    let fileTreeView: vscode.TreeView<FileItem> | undefined;
    let fileTreeCommands: vscode.Disposable[] = [];

    function registerFileTreeProvider() {
        fileTreeCommands.forEach(cmd => cmd.dispose());
        fileTreeCommands = [];
        if (fileTreeView) {
            fileTreeView.dispose();
        }

        contextManager.reinitializeFileTreeProvider();
        const fileTreeProvider = contextManager.getFileTreeProvider();

        if (fileTreeProvider) {
            fileTreeView = vscode.window.createTreeView('lollmsSettings.fileTreeView', { treeDataProvider: fileTreeProvider, showCollapseAll: true });
            
            fileTreeCommands.push(vscode.commands.registerCommand('lollms-vs-coder.cycleFileState', (item: FileItem) => fileTreeProvider.cycleFileState(item)));
            fileTreeCommands.push(vscode.commands.registerCommand('lollms-vs-coder.addFolderToContext', (item: FileItem) => fileTreeProvider.addFolderToContext(item)));
            fileTreeCommands.push(vscode.commands.registerCommand('lollms-vs-coder.removeFolderFromContext', (item: FileItem) => fileTreeProvider.removeFolderFromContext(item)));
            fileTreeCommands.push(vscode.commands.registerCommand('lollms-vs-coder.refreshTree', () => fileTreeProvider.refresh()));
            
            context.subscriptions.push(...fileTreeCommands);
        }
    }
    
    registerFileTreeProvider();
    registerDiscussionViewProvider();
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        registerFileTreeProvider();
        registerDiscussionViewProvider();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.triggerCodeAction', async (prompt?: Prompt) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) {
            vscode.window.showInformationMessage(vscode.l10n.t("info.selectCodeForAction"));
            return;
        }
    
        let targetPrompt: Prompt | undefined = prompt;
        if (!targetPrompt) {
            const codePrompts = await promptManager.getCodeActionPrompts();
            const items = codePrompts.map(p => ({ label: p.title, description: p.content, prompt: p }));
            const selection = await vscode.window.showQuickPick(
                [...items, { label: vscode.l10n.t("label.customPrompt"), description: vscode.l10n.t("description.customPrompt"), prompt: undefined as any }],
                { placeHolder: vscode.l10n.t("prompt.selectCodeAction") }
            );

            if (!selection) return;
    
            if (!selection.prompt) {
                const customActionData = await CustomActionModal.createOrShow(context.extensionUri);
                if (!customActionData) return;
    
                if (customActionData.save && customActionData.title) {
                    const data = await promptManager.getData();
                    const newPrompt: Prompt = {
                        id: Date.now().toString(),
                        groupId: null,
                        title: customActionData.title,
                        content: `${customActionData.prompt}\n{{SELECTED_CODE}}`,
                        type: 'code_action',
                        action_type: customActionData.actionType
                    };
                    data.prompts.push(newPrompt);
                    await promptManager.saveData(data);
                    chatPromptTreeProvider.refresh();
                    codeActionTreeProvider.refresh();
                    vscode.window.showInformationMessage(vscode.l10n.t('info.promptSaved', customActionData.title));
                }
                
                targetPrompt = {
                    id: 'custom',
                    title: customActionData.save ? customActionData.title : vscode.l10n.t('title.customAction'),
                    content: `${customActionData.prompt}\n{{SELECTED_CODE}}`,
                    type: 'code_action',
                    action_type: customActionData.actionType,
                    groupId: null
                };
            } else {
                targetPrompt = selection.prompt;
            }
        }
    
        if (!targetPrompt) { return; }

        const promptData = await buildCodeActionPrompt(targetPrompt.content, editor, context.extensionUri, contextManager);
        if (promptData === null) return;
        const { systemPrompt, userPrompt } = promptData;
    
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t('progress.applyingAction', targetPrompt.title),
            cancellable: true
        }, async (progress, token) => {
            const responseText = await lollmsAPI.sendChat([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ]);
            
            if (token.isCancellationRequested) { return; }

            if (targetPrompt?.action_type === 'information') {
                InfoPanel.createOrShow(context.extensionUri, targetPrompt.title, responseText);
            } else {
                const codeBlockRegex = /```(?:[\w-]*)\n([\s\S]+?)\n```/s;
                const match = responseText.match(codeBlockRegex);

                if (!match || !match[1]) {
                    vscode.window.showErrorMessage(vscode.l10n.t("error.invalidCodeBlock"));
                    return;
                }
    
                const modifiedCode = match[1];
                inlineDiffProvider.showDiff(editor, editor.selection, modifiedCode);
            }
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.saveInfoToFile', async (content: string) => {
        try {
            const fileUri = await vscode.window.showSaveDialog({
                title: vscode.l10n.t('title.saveInformation'),
                filters: { [vscode.l10n.t('filter.markdownFiles')]: ['md'], [vscode.l10n.t('filter.textFiles')]: ['txt'] }
            });
            if (fileUri) {
                await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));
                vscode.window.showInformationMessage(vscode.l10n.t('info.infoSaved', path.basename(fileUri.fsPath)));
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(vscode.l10n.t('error.failedToSaveFile', error.message));
        }
    }));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.createPrompt', async (item?: PromptGroupItem) => {
        const title = await vscode.window.showInputBox({ prompt: vscode.l10n.t('prompt.enterPromptTitle') });
        if (!title) return;
        const content = await vscode.window.showInputBox({ prompt: vscode.l10n.t('prompt.enterPromptContent'), value: '{{SELECTED_CODE}}' });
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
                    { label: vscode.l10n.t('label.modifyCode'), description: vscode.l10n.t('description.modifyCode'), type: 'generation' as const },
                    { label: vscode.l10n.t('label.askQuestion'), description: vscode.l10n.t('description.askQuestion'), type: 'information' as const }
                ],
                { placeHolder: vscode.l10n.t('prompt.selectCodeActionType') }
            );

            if (!actionType) return;
            newPrompt.action_type = actionType.type;
        }

        data.prompts.push(newPrompt);
        await promptManager.saveData(data);
        chatPromptTreeProvider.refresh();
        codeActionTreeProvider.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.editPrompt', async (item: PromptItem) => {
        if (item.prompt.is_default) {
            vscode.window.showInformationMessage(vscode.l10n.t("info.defaultPromptNoEdit"));
            return;
        }
        const newTitle = await vscode.window.showInputBox({ prompt: vscode.l10n.t('prompt.enterNewTitle'), value: item.prompt.title });
        if (newTitle === undefined) return;
        const newContent = await vscode.window.showInputBox({ prompt: vscode.l10n.t('prompt.enterNewContent'), value: item.prompt.content });
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
                        { label: vscode.l10n.t('label.modifyCode'), description: vscode.l10n.t('description.modifyCode'), type: 'generation' as const },
                        { label: vscode.l10n.t('label.askQuestion'), description: vscode.l10n.t('description.askQuestion'), type: 'information' as const }
                    ],
                    { placeHolder: vscode.l10n.t('prompt.selectCodeActionType') }
                );
    
                if (!actionType) return;
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
            vscode.window.showInformationMessage(vscode.l10n.t("info.defaultPromptNoDelete"));
            return;
        }
        const deleteButton = { title: vscode.l10n.t('command.delete.title'), id: 'delete' };
        const confirm = await vscode.window.showWarningMessage(
            vscode.l10n.t('prompt.confirmDeletePrompt', item.prompt.title), 
            { modal: true }, 
            deleteButton
        );
    
        if (confirm?.id === 'delete') {
            const data = await promptManager.getData();
            data.prompts = data.prompts.filter(p => p.id !== item.id);
            await promptManager.saveData(data);
            chatPromptTreeProvider.refresh();
            codeActionTreeProvider.refresh();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.saveMessageAsPrompt', async (content: string) => {
        const title = await vscode.window.showInputBox({ prompt: vscode.l10n.t('prompt.enterPromptTitleForSave') });
        if (!title) return;

        const data = await promptManager.getData();
        const newPrompt: Prompt = {
            id: Date.now().toString(),
            groupId: null,
            title,
            content,
            type: 'chat'
        };

        data.prompts.push(newPrompt);
        await promptManager.saveData(data);
        chatPromptTreeProvider.refresh();
        codeActionTreeProvider.refresh();
        vscode.window.showInformationMessage(vscode.l10n.t('info.promptSaved', title));
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.createPromptGroup', async () => {
        const title = await vscode.window.showInputBox({ prompt: vscode.l10n.t("prompt.enterPromptGroupTitle") });
        if (!title) return;
        const data = await promptManager.getData();
        data.groups.push({ id: Date.now().toString(), title });
        await promptManager.saveData(data);
        chatPromptTreeProvider.refresh();
        codeActionTreeProvider.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.renamePromptGroup', async (item: PromptGroupItem) => {
        const newTitle = await vscode.window.showInputBox({ prompt: vscode.l10n.t("prompt.enterNewTitle"), value: item.group.title });
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
        const deleteButton = { title: vscode.l10n.t('command.delete.title'), id: 'delete' };
        const confirm = await vscode.window.showWarningMessage(
            vscode.l10n.t('prompt.confirmDeleteGroup', item.group.title), 
            { modal: true }, 
            deleteButton
        );
    
        if (confirm?.id === 'delete') {
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
            { id: null, label: vscode.l10n.t("label.noGroup") },
            ...data.groups.map(g => ({ id: g.id, label: g.title }))
        ];
        const selected = await vscode.window.showQuickPick(quickPickItems, { placeHolder: vscode.l10n.t("prompt.selectGroup") });
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
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.runScript', (code: string, language: string) => {
        if (ChatPanel.currentPanel) { scriptRunner.runScript(code, language, ChatPanel.currentPanel); }
        else { vscode.window.showErrorMessage(vscode.l10n.t("error.noActiveChatPanel")); }
    }));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showConfigView', () => SettingsPanel.createOrShow(context.extensionUri)));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showHelp', () => HelpPanel.createOrShow(context.extensionUri)));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.exportContextContent', async () => {
        try {
            const content = await contextManager.getContextContent();
            await vscode.env.clipboard.writeText(content.text);
            vscode.window.showInformationMessage(vscode.l10n.t('info.contextCopied'));
        } catch (error: any) { vscode.window.showErrorMessage(vscode.l10n.t('error.failedToExportContext', error.message)); }
    }));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollmsSettings.fetchModels', async (apiUrl, apiKey, disableSslVerification) => {
        const fetch = require('node-fetch');
        try {
            const agent = new https.Agent({ rejectUnauthorized: !disableSslVerification });
            const url = apiUrl.replace(/\/+$/, '') + '/v1/models';
            const isHttps = url.startsWith('https');

            const options: any = {
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
            };

            if (isHttps) {
                options.agent = agent;
            }
            
            const response = await fetch(url, options);
            if (!response.ok) { throw new Error(`HTTP Error ${response.status}: ${response.statusText}`); }
            return (await response.json()).data || [];
        } catch (err) { console.error('Error fetching models in extension:', err); return []; }
    }));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.generateCommitMessage', async () => {
        if (!(await gitIntegration.isGitRepo())) { vscode.window.showErrorMessage(vscode.l10n.t('error.notGitRepository')); return; }
        const message = await gitIntegration.generateCommitMessage();
        if (message) {
            const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
            if (!gitExtension) { vscode.window.showErrorMessage(vscode.l10n.t('error.gitExtensionNotFound')); return; }
            const gitAPI = gitExtension.exports.getAPI(1);
            if (gitAPI.repositories.length > 0) {
                gitAPI.repositories[0].inputBox.value = message;
                vscode.commands.executeCommand('workbench.view.scm');
            }
        }
    }));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.commitWithAIMessage', async () => {
        if (!(await gitIntegration.isGitRepo())) { vscode.window.showErrorMessage(vscode.l10n.t('error.notGitRepository')); return; }
        const message = await gitIntegration.generateCommitMessage();
        if (message) {
            const confirmed = await vscode.window.showQuickPick([vscode.l10n.t('label.yes'), vscode.l10n.t('label.no')], { placeHolder: vscode.l10n.t('prompt.confirmCommit', message) });
            if (confirmed === vscode.l10n.t('label.yes')) { await gitIntegration.commitWithMessage(message); }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.applyFileContent', async (filePath: string, content: string) => {
        if (!vscode.workspace.workspaceFolders) {
            vscode.window.showErrorMessage(vscode.l10n.t('error.openWorkspaceToApplyChanges'));
            return;
        }
        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri;
        const fileUri = vscode.Uri.joinPath(workspaceRoot, filePath);
    
        try {
            let fileExists = false;
            try {
                await vscode.workspace.fs.stat(fileUri);
                fileExists = true;
            } catch {
                // File doesn't exist, which is fine.
            }
    
            if (fileExists) {
                const overwriteButton = { title: vscode.l10n.t('label.overwrite'), id: 'overwrite' };
                const confirm = await vscode.window.showWarningMessage(
                    vscode.l10n.t("prompt.confirmOverwrite", filePath),
                    { modal: true },
                    overwriteButton
                );
            
                if (confirm?.id !== 'overwrite') {
                    vscode.window.showInformationMessage(vscode.l10n.t('info.applyOperationCancelled'));
                    return;
                }
            }
    
            const dirUri = vscode.Uri.joinPath(fileUri, '..');
            await vscode.workspace.fs.createDirectory(dirUri);
    
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));
            vscode.window.showInformationMessage(vscode.l10n.t('info.applySuccess', filePath));
    
            await vscode.window.showTextDocument(fileUri);
    
        } catch (error: any) {
            vscode.window.showErrorMessage(vscode.l10n.t('error.failedToApplyFileContent', error.message));
        }
    }));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.applyPatchContent', async (filePath: string, patchContent: string) => {
        try {
            let finalPatch = patchContent;
            if (!patchContent.trim().startsWith('--- a/')) {
                finalPatch = `--- a/${filePath}\n+++ b/${filePath}\n${patchContent}`;
            }
    
            await applyDiff(finalPatch);
            vscode.window.showInformationMessage(vscode.l10n.t('info.patchApplySuccess', filePath));
    
            if (vscode.workspace.workspaceFolders) {
                 const fileUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, filePath);
                 await vscode.window.showTextDocument(fileUri);
            }
    
        } catch (error: any) {
            vscode.window.showErrorMessage(vscode.l10n.t('error.failedToApplyPatch', error.message));
        }
    }));

    const saveCodeCommand = vscode.commands.registerCommand('lollms-vs-coder.saveCodeToFile', async (code: string, language?: string) => {
        const languageToFileFilter = (lang?: string): { [name: string]: string[] } => {
            if (!lang) return { [vscode.l10n.t('filter.allFiles')]: ['*'] };
            const langLower = lang.toLowerCase();
            const fileTypes: { [key: string]: string } = {
                'python': 'filter.pythonFiles',
                'javascript': 'filter.javascriptFiles',
                'typescript': 'filter.typescriptFiles',
                'html': 'filter.htmlFiles',
                'css': 'filter.cssFiles',
                'json': 'filter.jsonFiles',
                'markdown': 'filter.markdownFiles',
                'shell': 'filter.shellScripts',
                'bash': 'filter.shellScripts',
                'sh': 'filter.shellScripts'
            };
            const fileExtensions: { [key: string]: string[] } = {
                'python': ['py'],
                'javascript': ['js'],
                'typescript': ['ts'],
                'html': ['html'],
                'css': ['css'],
                'json': ['json'],
                'markdown': ['md'],
                'shell': ['sh'],
                'bash': ['sh'],
                'sh': ['sh']
            };

            if (fileTypes[langLower]) {
                const filter: { [name: string]: string[] } = {};
                filter[vscode.l10n.t(fileTypes[langLower])] = fileExtensions[langLower];
                return filter;
            }
            
            const defaultFilter: { [name: string]: string[] } = {};
            defaultFilter[vscode.l10n.t('filter.languageFiles', lang.toUpperCase())] = [lang];
            defaultFilter[vscode.l10n.t('filter.allFiles')] = ['*'];
            return defaultFilter;
        };

        try {
            const fileUri = await vscode.window.showSaveDialog({
                title: vscode.l10n.t('title.saveCodeSnippet'),
                filters: languageToFileFilter(language)
            });

            if (fileUri) {
                await vscode.workspace.fs.writeFile(fileUri, Buffer.from(code, 'utf8'));
                vscode.window.showInformationMessage(vscode.l10n.t('info.codeSaved', path.basename(fileUri.fsPath)));
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(vscode.l10n.t('error.failedToSaveFile', error.message));
        }
    });
    
    const applyDiffCommand = vscode.commands.registerCommand('lollms-vs-coder.applyDiff', async (diffContent: string) => {
        try { await applyDiff(diffContent); vscode.window.showInformationMessage(vscode.l10n.t('info.diffApplied')); } 
        catch (error: any) { vscode.window.showErrorMessage(vscode.l10n.t('error.failedToApplyDiff', error.message)); }
    });
    context.subscriptions.push(saveCodeCommand, applyDiffCommand);

    const chatStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    chatStatusBar.text = '$(comment-discussion) Lollms Chat';
    chatStatusBar.command = 'lollms-vs-coder.startChat';
    chatStatusBar.tooltip = vscode.l10n.t('tooltip.startNewDiscussion');
    chatStatusBar.show();
    context.subscriptions.push(chatStatusBar);

    const modelStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    modelStatusBarItem.command = 'lollms-vs-coder.selectModel';
    modelStatusBarItem.tooltip = vscode.l10n.t('tooltip.selectModel');
    
    function updateModelStatus() {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const modelName = config.get('modelName') as string || vscode.l10n.t('label.notSet');
        modelStatusBarItem.text = `$(chip) ${modelName}`;
        modelStatusBarItem.show();
    }
    updateModelStatus();
    context.subscriptions.push(modelStatusBarItem);
    
    context.subscriptions.push(vscode.commands.registerCommand('lollmsApi.recreateClient', async () => {
        const newConfig = vscode.workspace.getConfiguration('lollmsVsCoder');
        lollmsAPI = new LollmsAPI({ 
            apiKey: newConfig.get<string>('apiKey')?.trim() || '',
            apiUrl: newConfig.get<string>('apiUrl') || 'http://localhost:9642',
            modelName: newConfig.get<string>('modelName') || 'ollama/mistral',
            disableSslVerification: newConfig.get<boolean>('disableSslVerification') || false
        });
        updateModelStatus();
        vscode.window.showInformationMessage(vscode.l10n.t('info.apiReconfigured'));
    }));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.selectModel', async () => {
        try {
            const models = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t("progress.fetchingModels"),
                cancellable: false
            }, () => lollmsAPI.getModels());

            if (!models || models.length === 0) {
                vscode.window.showWarningMessage(vscode.l10n.t("info.noModelsFound"));
                return;
            }

            const modelItems = models.map(m => ({ label: m.id }));
            const selectedModel = await vscode.window.showQuickPick(modelItems, {
                placeHolder: vscode.l10n.t("prompt.selectModel")
            });

            if (selectedModel) {
                const config = vscode.workspace.getConfiguration('lollmsVsCoder');
                await config.update('modelName', selectedModel.label, vscode.ConfigurationTarget.Global);
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(vscode.l10n.t('error.failedToFetchModels', error.message));
        }
    }));    

    vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('lollmsVsCoder.modelName') || e.affectsConfiguration('lollmsVsCoder.apiUrl')) {
            vscode.commands.executeCommand('lollmsApi.recreateClient');
        }
    });

    console.log('Extension activation complete.');
}