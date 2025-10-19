import * as vscode from 'vscode';
import * as path from 'path';
import { LollmsAPI, LollmsConfig, ChatMessage } from './lollmsAPI';
import { ChatPanel } from './commands/chatPanel';
import { SettingsPanel } from './commands/configView';
import { ContextManager } from './contextManager';
import { GitIntegration } from './gitIntegration';
import { applyDiff, getProcessedSystemPrompt, stripThinkingTags } from './utils';
import { ContextStateProvider } from './commands/contextStateProvider';
import { FileDecorationProvider } from './commands/fileDecorationProvider';
import { DiscussionManager, Discussion } from './discussionManager';
import { DiscussionTreeProvider, DiscussionItem, DiscussionGroupItem } from './commands/discussionTreeProvider';
import { ScriptRunner } from './scriptRunner';
import { PromptManager, Prompt } from './promptManager';
import { ChatPromptTreeProvider } from './commands/chatPromptTreeProvider';
import { CodeActionTreeProvider } from './commands/codeActionTreeProvider';
import { PromptItem, PromptGroupItem, ProcessItem } from './commands/treeItems';
import { HelpPanel } from './commands/helpPanel';
import { PromptBuilderPanel, parsePlaceholders } from './commands/promptBuilderPanel';
import { LollmsCodeActionProvider } from './commands/codeActions';
import { LollmsInlineCompletionProvider } from './commands/inlineSuggestions';
import { AgentManager } from './agentManager';
import { InlineDiffProvider } from './commands/inlineDiffProvider';
import { InfoPanel } from './commands/infoPanel';
import { CustomActionModal } from './commands/customActionModal';
import * as https from 'https';
import { ProcessManager } from './processManager';
import { ProcessTreeProvider } from './commands/processTreeProvider';
import { exec } from 'child_process';
import { promisify } from 'util';
import { LollmsNotebookCellActionProvider } from './notebookTools';

const execAsync = promisify(exec);


interface GitExtension { getAPI(version: 1): API; }
interface API { repositories: Repository[]; }
interface Repository { inputBox: { value: string }; rootUri: vscode.Uri; }

let lollmsExecutionTerminal: vscode.Terminal | null = null;
let pythonExtApi: any = null; 

async function buildCodeActionPrompt(
    promptTemplate: string, 
    actionType: 'generation' | 'information' | undefined,
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
    
    let userPrompt = `I am working on the file \`${fileName}\` which is a \`${languageId}\` file.\n\nHere is the code selection:\n\`\`\`${languageId}\n${selectedText}\n\`\`\`\n\nINSTRUCTION: **${userInstruction}**`;

    const agentPersonaPrompt = getProcessedSystemPrompt('agent');
    let systemPrompt = '';

    if (actionType === 'information') {
        userPrompt += `\n\nPlease provide a detailed answer in Markdown format.`;
        systemPrompt = `You are an expert code analyst. Your task is to answer questions and provide explanations about a given code snippet.
- Analyze the user's instruction and the provided code.
- Respond with a clear, well-formatted Markdown explanation.
- If you include code examples, use appropriate markdown code blocks.

User preferences: ${agentPersonaPrompt}`;
    } else { // Default to 'generation'
        const startLine = Math.max(0, selection.start.line - 10);
        const endLine = Math.min(document.lineCount - 1, selection.end.line + 10);
        const beforeRange = new vscode.Range(new vscode.Position(startLine, 0), selection.start);
        const afterRange = new vscode.Range(selection.end, new vscode.Position(endLine, document.lineAt(endLine).text.length));
        const codeBefore = document.getText(beforeRange);
        const codeAfter = document.getText(afterRange);
        
        userPrompt = `I am working on the file \`${fileName}\` which is a \`${languageId}\` file.\n\n`;

        if (codeBefore.trim()) {
            userPrompt += `==== CONTEXT BEFORE (DO NOT INCLUDE IN OUTPUT) ====\n\`\`\`${languageId}\n${codeBefore}\n\`\`\`\n\n`;
        }
        userPrompt += `==== SELECTED CODE TO MODIFY (MODIFY THIS ONLY) ====\n\`\`\`${languageId}\n${selectedText}\n\`\`\`\n\n`;
        if (codeAfter.trim()) {
            userPrompt += `==== CONTEXT AFTER (DO NOT INCLUDE IN OUTPUT) ====\n\`\`\`${languageId}\n${codeAfter}\n\`\`\`\n\n`;
        }

        userPrompt += `INSTRUCTION: **${userInstruction}**\n\n`;
        userPrompt += `⚠️ CRITICAL: Your response must contain ONLY the modified selected code block. Do not include any BEFORE or AFTER context code in your response.`;

        systemPrompt = `You are a surgical code modification tool. You must modify ONLY the selected code block and return ONLY that modified block.

## STRICT OUTPUT RULES
- Return ONLY the modified selected code in a single markdown code block
- NEVER include BEFORE context code in your response
- NEVER include AFTER context code in your response
- NEVER add explanations, comments, or text outside the code block
- The first line of your response must be the opening code fence: \`\`\`${languageId}
- The last line of your response must be the closing code fence: \`\`\`
- Do NOT use placeholder comments like "// rest of code"

Your entire response must be executable code that can directly replace the selected text.

User preferences: ${agentPersonaPrompt}`;
    }
    
    return { systemPrompt, userPrompt };
}


export async function activate(context: vscode.ExtensionContext) {
    console.log('Lollms VS Coder is now active!');

    let activeWorkspaceFolder: vscode.WorkspaceFolder | undefined;

    const pythonExt = vscode.extensions.getExtension('ms-python.python');
    if (pythonExt) {
        if (!pythonExt.isActive) {
            await pythonExt.activate();
        }
        pythonExtApi = pythonExt.exports;
    } else {
        vscode.window.showWarningMessage("The Microsoft Python extension is not installed. Python execution will use the generic 'python' command.");
    }

    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    let lollmsAPI = new LollmsAPI({
        apiUrl: config.get<string>('apiUrl') || 'http://localhost:9642',
        apiKey: config.get<string>('apiKey')?.trim() || '',
        modelName: config.get<string>('modelName') || 'ollama/mistral',
        disableSslVerification: config.get<boolean>('disableSslVerification') || false
    });

    const contextManager = new ContextManager(context, lollmsAPI);
    const scriptRunner = new ScriptRunner(pythonExtApi);
    const promptManager = new PromptManager(context.globalStorageUri);
    const gitIntegration = new GitIntegration(lollmsAPI);
    const processManager = new ProcessManager();

    const processTreeProvider = new ProcessTreeProvider(processManager);
    context.subscriptions.push(vscode.window.registerTreeDataProvider('lollmsProcessView', processTreeProvider));
    
    context.subscriptions.push(processManager.onDidProcessChange(() => {
        processTreeProvider.refresh();
        if (ChatPanel.currentPanel) {
            ChatPanel.currentPanel.updateGeneratingState();
        }
    }));

    const chatPromptTreeProvider = new ChatPromptTreeProvider(promptManager);
    context.subscriptions.push(vscode.window.registerTreeDataProvider('lollmsChatPromptsView', chatPromptTreeProvider));
    const codeActionTreeProvider = new CodeActionTreeProvider(promptManager);
    context.subscriptions.push(vscode.window.registerTreeDataProvider('lollmsCodeActionsView', codeActionTreeProvider));

    const inlineDiffProvider = new InlineDiffProvider();
    context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, inlineDiffProvider));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.acceptDiff', () => inlineDiffProvider.accept()));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.rejectDiff', () => inlineDiffProvider.reject()));

    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider('*', 
            new LollmsCodeActionProvider(promptManager), {
            providedCodeActionKinds: LollmsCodeActionProvider.providedCodeActionKinds
        })
    );
    
    if (config.get<boolean>('enableInlineSuggestions')) {
        const inlineProvider = new LollmsInlineCompletionProvider(lollmsAPI);
        context.subscriptions.push(
            vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, inlineProvider)
        );
    }
    
    let discussionManager: DiscussionManager | undefined;
    let discussionTreeProvider: DiscussionTreeProvider | undefined;
    let discussionView: vscode.TreeView<vscode.TreeItem> | undefined;

    let contextStateProvider: ContextStateProvider | undefined;
    const fileDecorationProvider = new FileDecorationProvider(undefined);
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(fileDecorationProvider));

    const activeWorkspaceStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    activeWorkspaceStatusBarItem.command = 'lollms-vs-coder.selectActiveWorkspace';
    context.subscriptions.push(activeWorkspaceStatusBarItem);
    
    const setupChatPanel = (panel: ChatPanel) => {
        if (!panel.agentManager) {
            panel.agentManager = new AgentManager(panel, lollmsAPI, contextManager, gitIntegration, discussionManager!, context.extensionUri);
        }
        panel.setProcessManager(processManager);
        panel.agentManager.setProcessManager(processManager);
        panel.setContextManager(contextManager);
    };

    async function switchActiveWorkspace(folder: vscode.WorkspaceFolder) {
        activeWorkspaceFolder = folder;

        if ((vscode.workspace.workspaceFolders?.length || 0) > 1) {
            activeWorkspaceStatusBarItem.text = `$(root-folder) Lollms: ${folder.name}`;
            activeWorkspaceStatusBarItem.tooltip = `Lollms is active in this workspace. Click to switch.`;
            activeWorkspaceStatusBarItem.show();
        } else {
            activeWorkspaceStatusBarItem.hide();
        }

        if (discussionManager) {
            await discussionManager.switchWorkspace(folder.uri);
            discussionTreeProvider?.refresh();
        }
        
        if (contextStateProvider) {
            await contextStateProvider.switchWorkspace(folder.uri.fsPath);
        } else {
            contextStateProvider = new ContextStateProvider(folder.uri.fsPath, context);
            contextManager.setContextStateProvider(contextStateProvider);
            fileDecorationProvider.updateStateProvider(contextStateProvider);
        }

        if(ChatPanel.currentPanel){
            ChatPanel.currentPanel.dispose();
            vscode.window.showInformationMessage(`Lollms workspace switched to '${folder.name}'. The chat panel has been closed to reflect the new context.`);
        }
    }

    function initializeAndRegisterProviders() {
        discussionView?.dispose();

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.commands.executeCommand('setContext', 'lollms:hasWorkspace', false);
            activeWorkspaceStatusBarItem.hide();
            activeWorkspaceFolder = undefined;
            discussionManager = undefined;
            contextStateProvider = undefined;
            contextManager.setContextStateProvider(undefined);
            fileDecorationProvider.updateStateProvider(undefined);
            return;
        }

        vscode.commands.executeCommand('setContext', 'lollms:hasWorkspace', true);
        
        const initialWorkspace = activeWorkspaceFolder 
            ? (workspaceFolders.find(f => f.uri.toString() === activeWorkspaceFolder!.uri.toString()) || workspaceFolders[0])
            : workspaceFolders[0];
        
        discussionManager = new DiscussionManager(lollmsAPI, processManager);
        discussionTreeProvider = new DiscussionTreeProvider(discussionManager);
        discussionView = vscode.window.createTreeView('lollmsDiscussionsView', { treeDataProvider: discussionTreeProvider });
        
        switchActiveWorkspace(initialWorkspace);
    }
    
    initializeAndRegisterProviders();

    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        initializeAndRegisterProviders();
    }));
    
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        const folders = vscode.workspace.workspaceFolders;
        if (!editor || !folders || folders.length <= 1) return;
        
        const editorWorkspace = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        if (editorWorkspace && editorWorkspace.uri.toString() !== activeWorkspaceFolder?.uri.toString()) {
            switchActiveWorkspace(editorWorkspace);
        }
    }));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.selectActiveWorkspace', async () => {
        const picked = await vscode.window.showWorkspaceFolderPick();
        if (picked && picked.uri.toString() !== activeWorkspaceFolder?.uri.toString()) {
            await switchActiveWorkspace(picked);
        }
    }));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.startChat', () => {
        if (!activeWorkspaceFolder || !discussionManager) {
            vscode.window.showInformationMessage(vscode.l10n.t("info.openFolderToUseChat"));
            return;
        }
        vscode.commands.executeCommand('lollms-vs-coder.newDiscussion');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.newDiscussion', async (item?: DiscussionGroupItem) => {
        if (!discussionManager) return;
        const groupId = item instanceof DiscussionGroupItem ? item.group.id : null;
        const panel = ChatPanel.createOrShow(context.extensionUri, lollmsAPI, discussionManager);
        setupChatPanel(panel);
        await panel.startNewDiscussion(groupId);
        discussionTreeProvider?.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.switchDiscussion', async (discussionId: string) => {
        if (!discussionManager) return;
        const panel = ChatPanel.createOrShow(context.extensionUri, lollmsAPI, discussionManager);
        setupChatPanel(panel);
        await panel.loadDiscussion(discussionId);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.selectPythonInterpreter', () => {
        vscode.commands.executeCommand('python.setInterpreter');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms.runAgentCommand', (objective: string, discussion: Discussion) => {
        if (ChatPanel.currentPanel?.agentManager && activeWorkspaceFolder) {
            ChatPanel.currentPanel.agentManager.run(objective, discussion, activeWorkspaceFolder);
        } else if (!activeWorkspaceFolder) {
            vscode.window.showErrorMessage("Cannot run Agent: No active Lollms workspace.");
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.deleteDiscussion', async (item: DiscussionItem) => {
        if (!discussionManager) return;
        const deleteButton = { title: vscode.l10n.t('command.delete.title'), id: 'delete' };
        const confirm = await vscode.window.showWarningMessage(vscode.l10n.t('prompt.confirmDelete', item.discussion.title), { modal: true }, deleteButton);
        if (confirm?.id === 'delete') {
            await discussionManager.deleteDiscussion(item.discussion.id);
            discussionTreeProvider?.refresh();
            if (ChatPanel.currentPanel && ChatPanel.currentPanel.getCurrentDiscussionId() === item.discussion.id) {
                ChatPanel.currentPanel.dispose();
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.renameDiscussion', async (item: DiscussionItem) => {
        if (!discussionManager) return;
        const newTitle = await vscode.window.showInputBox({ prompt: vscode.l10n.t("prompt.enterNewDiscussionTitle"), value: item.discussion.title });
        if (newTitle && newTitle !== item.discussion.title) {
            item.discussion.title = newTitle;
            await discussionManager.saveDiscussion(item.discussion);
            discussionTreeProvider?.refresh();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.generateDiscussionTitle', async (item: DiscussionItem) => {
        if (!discussionManager) return;
        const title = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("progress.generatingDiscussionTitle"), cancellable: false }, async () => await discussionManager!.generateDiscussionTitle(item.discussion));
        if (title) {
            item.discussion.title = title;
            await discussionManager.saveDiscussion(item.discussion);
            discussionTreeProvider?.refresh();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.createDiscussionGroup', async () => {
        if (!discussionManager) return;
        const title = await vscode.window.showInputBox({ prompt: vscode.l10n.t("prompt.enterGroupTitle") });
        if (!title) return;
        const description = await vscode.window.showInputBox({ prompt: vscode.l10n.t("prompt.enterGroupDescription") });
        const groups = await discussionManager.getGroups();
        groups.push({ id: Date.now().toString() + Math.random().toString(36).substring(2), title, description: description || '', timestamp: Date.now() });
        await discussionManager.saveGroups(groups);
        discussionTreeProvider?.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.renameDiscussionGroup', async (item: DiscussionGroupItem) => {
        if (!discussionManager) return;
        const newTitle = await vscode.window.showInputBox({ prompt: vscode.l10n.t("prompt.enterNewTitle"), value: item.group.title });
        if (newTitle && newTitle !== item.group.title) {
            const groups = await discussionManager.getGroups();
            const groupToUpdate = groups.find(g => g.id === item.group.id);
            if (groupToUpdate) {
                groupToUpdate.title = newTitle;
                await discussionManager.saveGroups(groups);
                discussionTreeProvider?.refresh();
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.deleteDiscussionGroup', async (item: DiscussionGroupItem) => {
        if (!discussionManager) return;
        const deleteButton = { title: vscode.l10n.t('command.delete.title'), id: 'delete' };
        const confirm = await vscode.window.showWarningMessage(vscode.l10n.t('prompt.confirmDeleteGroup', item.group.title), { modal: true }, deleteButton);
    
        if (confirm?.id === 'delete') {
            await discussionManager.deleteGroup(item.group.id);
            discussionTreeProvider?.refresh();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.moveDiscussionToGroup', async (item: DiscussionItem) => {
        if (!discussionManager) return;
        const groups = await discussionManager.getGroups();
        const items = [{ id: null, label: vscode.l10n.t("label.noGroup") }, ...groups.map(g => ({ id: g.id, label: g.title, description: g.description }))];
        const selected = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t("prompt.selectGroupForMove") });
        if (selected !== undefined) { 
            const discussion = await discussionManager.getDiscussion(item.discussion.id);
            if (discussion) {
                discussion.groupId = selected.id;
                await discussionManager.saveDiscussion(discussion);
                discussionTreeProvider?.refresh();
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.refreshDiscussions', () => discussionTreeProvider?.refresh()));
    
context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.triggerCodeAction', async (promptOrArg?: Prompt | { isCustom: true }) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) {
            vscode.window.showInformationMessage(vscode.l10n.t("info.selectCodeForAction"));
            return;
        }
    
        let targetPrompt: Prompt | undefined;

        // Case 1: The "Custom Action..." menu item was clicked directly.
        if (promptOrArg && (promptOrArg as { isCustom: true }).isCustom === true) {
            const customActionData = await CustomActionModal.createOrShow(context.extensionUri);
            if (!customActionData) return; // User cancelled
    
            if (customActionData.save && customActionData.title) {
                const data = await promptManager.getData();
                const newPrompt: Prompt = {
                    id: Date.now().toString() + Math.random().toString(36).substring(2),
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
        // Case 2: A specific, pre-defined prompt was passed as an argument.
        } else if (promptOrArg) {
            targetPrompt = promptOrArg as Prompt;
        // Case 3: The command was called without arguments (e.g., from Command Palette).
        } else {
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
                        id: Date.now().toString() + Math.random().toString(36).substring(2),
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

        // FIX: Add a guard against malformed prompt objects that might lack a 'content' property.
        if (typeof targetPrompt.content !== 'string') {
            vscode.window.showErrorMessage(`Lollms Action '${targetPrompt.title}' is missing its prompt content. Please check your prompts.json file.`);
            return;
        }

        const promptData = await buildCodeActionPrompt(targetPrompt.content, targetPrompt.action_type, editor, context.extensionUri, contextManager);
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
            ], null, token);
            
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
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setContextIncluded', (uri?: vscode.Uri) => {
        if (contextStateProvider && uri) {
            contextStateProvider.setStateForUri(uri, 'included');
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setContextTreeOnly', (uri?: vscode.Uri) => {
        if (contextStateProvider && uri) {
            contextStateProvider.setStateForUri(uri, 'tree-only');
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setContextExcluded', (uri?: vscode.Uri) => {
        if (contextStateProvider && uri) {
            contextStateProvider.setStateForUri(uri, 'fully-excluded');
        }
    }));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.autoSelectContextFiles', async () => {
        if (!contextStateProvider || !discussionManager) {
            vscode.window.showInformationMessage("Please open a workspace folder to use this feature.");
            return;
        }

        const objective = await vscode.window.showInputBox({
            prompt: vscode.l10n.t('prompt.enterObjectiveForSelection'),
            placeHolder: "e.g., 'Implement a new command to export discussions as markdown files'",
            ignoreFocusOut: true,
        });

        if (!objective || objective.trim() === '') {
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t('progress.aiSelectingFiles'),
            cancellable: false
        }, async (progress) => {
            const fileList = await contextManager.getAutoSelectionForContext(objective);

            if (fileList && fileList.length > 0) {
                await contextStateProvider!.addFilesToContext(fileList);
                vscode.window.showInformationMessage(vscode.l10n.t('info.aiSelectedFiles', fileList.length));
                
                const panel = ChatPanel.createOrShow(context.extensionUri, lollmsAPI, discussionManager!);
                setupChatPanel(panel);
                
                await panel.startDiscussionWithPrompt(objective);

            } else if (fileList) { 
                 vscode.window.showInformationMessage("The AI did not select any files for the given objective.");
            }
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.saveContextSelection', async () => {
        if (!contextStateProvider || !activeWorkspaceFolder) {
            vscode.window.showInformationMessage("Please open a workspace folder to save context selection.");
            return;
        }

        try {
            const fileUri = await vscode.window.showSaveDialog({
                title: vscode.l10n.t('title.saveContextSelection'),
                filters: { [vscode.l10n.t('filter.lollmsContext')]: ['lollms-ctx'] },
                defaultUri: vscode.Uri.joinPath(activeWorkspaceFolder.uri, 'context-selection.lollms-ctx')
            });

            if (fileUri) {
                const stateKey = `context-state-${activeWorkspaceFolder.uri.fsPath}`;
                const contextState = context.workspaceState.get(stateKey) || {};
                const content = Buffer.from(JSON.stringify(contextState, null, 2), 'utf8');
                await vscode.workspace.fs.writeFile(fileUri, content);
                vscode.window.showInformationMessage(vscode.l10n.t('info.contextSelectionSaved', path.basename(fileUri.fsPath)));
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(vscode.l10n.t('error.failedToSaveContext', error.message));
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.loadContextSelection', async () => {
        if (!contextStateProvider || !activeWorkspaceFolder) {
            vscode.window.showInformationMessage("Please open a workspace folder to load context selection.");
            return;
        }

        try {
            const fileUris = await vscode.window.showOpenDialog({
                title: vscode.l10n.t('title.loadContextSelection'),
                filters: { [vscode.l10n.t('filter.lollmsContext')]: ['lollms-ctx', 'json'] },
                canSelectMany: false,
                defaultUri: activeWorkspaceFolder.uri
            });

            if (fileUris && fileUris[0]) {
                const fileUri = fileUris[0];
                const fileContent = await vscode.workspace.fs.readFile(fileUri);
                const loadedState = JSON.parse(fileContent.toString());
                
                const stateKey = `context-state-${activeWorkspaceFolder.uri.fsPath}`;
                await context.workspaceState.update(stateKey, loadedState);

                // Re-initialize the provider to make it reload the state from workspaceState
                contextStateProvider = new ContextStateProvider(activeWorkspaceFolder.uri.fsPath, context);
                contextManager.setContextStateProvider(contextStateProvider);
                fileDecorationProvider.updateStateProvider(contextStateProvider);
                contextStateProvider.refresh();

                vscode.window.showInformationMessage(vscode.l10n.t('info.contextSelectionLoaded', path.basename(fileUri.fsPath)));
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(vscode.l10n.t('error.failedToLoadContext', error.message));
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.resetContextSelection', async () => {
        if (contextStateProvider) {
            const resetButton = { title: vscode.l10n.t('label.reset'), id: 'reset' };
            const confirm = await vscode.window.showWarningMessage(
                vscode.l10n.t('prompt.confirmResetContext'),
                { modal: true },
                resetButton
            );
            if (confirm?.id === 'reset') {
                await contextStateProvider.resetState();
                vscode.window.showInformationMessage(vscode.l10n.t('info.contextReset'));
            }
        }
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

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.runScript', async (code: string, language: string) => {
        if (ChatPanel.currentPanel && activeWorkspaceFolder) {
            await scriptRunner.runScript(code, language, ChatPanel.currentPanel, activeWorkspaceFolder);
        } else {
            vscode.window.showErrorMessage(vscode.l10n.t("error.noActiveChatPanel"));
        }
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
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.commitWithAIMessage', async () => {
        if (!activeWorkspaceFolder) { vscode.window.showErrorMessage("No active workspace for Git operations."); return; }
        if (!(await gitIntegration.isGitRepo(activeWorkspaceFolder))) { vscode.window.showErrorMessage(vscode.l10n.t('error.notGitRepository')); return; }
        const message = await gitIntegration.generateCommitMessage(activeWorkspaceFolder);
        if (message) {
            const confirmed = await vscode.window.showQuickPick([vscode.l10n.t('label.yes'), vscode.l10n.t('label.no')], { placeHolder: vscode.l10n.t('prompt.confirmCommit', message) });
            if (confirmed === vscode.l10n.t('label.yes')) { await gitIntegration.commitWithMessage(message, activeWorkspaceFolder); }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.generateCommitMessage', async () => {
        if (!activeWorkspaceFolder) {
            vscode.window.showErrorMessage("No active workspace for Git operations.");
            return;
        }
        if (!(await gitIntegration.isGitRepo(activeWorkspaceFolder))) {
            vscode.window.showErrorMessage(vscode.l10n.t('error.notGitRepository'));
            return;
        }

        const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
        if (!gitExtension) {
            vscode.window.showErrorMessage(vscode.l10n.t('error.gitExtensionNotFound'));
            return;
        }

        if (!gitExtension.isActive) {
            await gitExtension.activate();
        }

        const git = gitExtension.exports.getAPI(1);
        
        const repository = git.repositories.find(repo => repo.rootUri.fsPath === activeWorkspaceFolder.uri.fsPath);

        if (repository) {
            const message = await gitIntegration.generateCommitMessage(activeWorkspaceFolder);
            if (message) {
                repository.inputBox.value = message;
            }
        } else {
            vscode.window.showErrorMessage("Could not find a Git repository for the active workspace.");
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.applyFileContent', async (filePath: string, content: string) => {
        if (!activeWorkspaceFolder) {
            vscode.window.showErrorMessage(vscode.l10n.t('error.openWorkspaceToApplyChanges'));
            return;
        }
        const fileUri = vscode.Uri.joinPath(activeWorkspaceFolder.uri, filePath);
    
        try {
            const parentUri = vscode.Uri.joinPath(fileUri, '..');
            await vscode.workspace.fs.createDirectory(parentUri);
            
            let document: vscode.TextDocument;
            try {
                document = await vscode.workspace.openTextDocument(fileUri);
            } catch (error) {
                const edit = new vscode.WorkspaceEdit();
                edit.createFile(fileUri, { ignoreIfExists: true });
                await vscode.workspace.applyEdit(edit);
                document = await vscode.workspace.openTextDocument(fileUri);
            }

            const editor = await vscode.window.showTextDocument(document);

            const fullRange = new vscode.Range(
                document.positionAt(0),
                document.positionAt(document.getText().length)
            );

            await inlineDiffProvider.showDiff(editor, fullRange, content);

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

    // ================== Status Bar Items ==================
    
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
        const newConfigValues = vscode.workspace.getConfiguration('lollmsVsCoder');
        const newConfig: LollmsConfig = {
            apiKey: newConfigValues.get<string>('apiKey')?.trim() || '',
            apiUrl: newConfigValues.get<string>('apiUrl') || 'http://localhost:9642',
            modelName: newConfigValues.get<string>('modelName') || 'ollama/mistral',
            disableSslVerification: newConfigValues.get<boolean>('disableSslVerification') || false
        };
        lollmsAPI.updateConfig(newConfig);
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

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('lollmsVsCoder.modelName') || 
            e.affectsConfiguration('lollmsVsCoder.apiUrl') ||
            e.affectsConfiguration('lollmsVsCoder.apiKey') ||
            e.affectsConfiguration('lollmsVsCoder.disableSslVerification')) {
            vscode.commands.executeCommand('lollmsApi.recreateClient');
        }
    }));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.cancelProcess', (item: ProcessItem) => {
        processManager.cancel(item.process.id);
    }));

    // ================== Notebook and Execution Logic ==================
    context.subscriptions.push(vscode.notebooks.registerNotebookCellStatusBarItemProvider('jupyter-notebook', new LollmsNotebookCellActionProvider()));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.enhanceNotebookCell', async (cell: vscode.NotebookCell) => {
        if (!cell) return;
    
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Lollms: Enhancing cell...",
            cancellable: true
        }, async (progress, token) => {
            const prompts = await promptManager.getCodeActionPrompts();
            const refactorPrompt = prompts.find(p => p.id === 'default-refactor');
            if (!refactorPrompt) {
                vscode.window.showErrorMessage("Could not find the default refactor prompt.");
                return;
            }
    
            const cellContent = cell.document.getText();
            const languageId = cell.document.languageId;
            const systemPrompt = getProcessedSystemPrompt('agent'); // Using agent prompt for direct code tasks
            const userPrompt = `${refactorPrompt.content.replace('{{SELECTED_CODE}}', '')}\n\n\`\`\`${languageId}\n${cellContent}\n\`\`\``;
    
            const responseText = await lollmsAPI.sendChat([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ]);
    
            if (token.isCancellationRequested) return;
    
            const codeBlockRegex = /```(?:[\w-]*)\n([\s\S]+?)\n```/s;
            const match = responseText.match(codeBlockRegex);
            const newCode = match ? match[1] : stripThinkingTags(responseText);
    
            if (newCode) {
                const edit = new vscode.WorkspaceEdit();
                const notebookEdit = vscode.NotebookEdit.replaceCells(
                    new vscode.NotebookRange(cell.index, cell.index + 1),
                    [new vscode.NotebookCellData(cell.kind, newCode, cell.document.languageId)]
                );
                edit.set(cell.notebook.uri, [notebookEdit]);
                await vscode.workspace.applyEdit(edit);
            }
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.generateNextNotebookCell', async (cell: vscode.NotebookCell) => {
        if (!cell) return;
    
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Lollms: Generating next cell...",
            cancellable: true
        }, async (progress, token) => {
            const cellContent = cell.document.getText();
            const cellType = cell.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'code';
            const languageId = cell.document.languageId;
    
            const systemPrompt = getProcessedSystemPrompt('agent');
            const userPrompt = `Based on the content of the previous ${cellType} cell (language: ${languageId}), generate the next logical code cell. Only output the code itself in a single markdown block.\n\n**Previous Cell Content:**\n\`\`\`${languageId}\n${cellContent}\n\`\`\``;
    
            const responseText = await lollmsAPI.sendChat([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ]);
    
            if (token.isCancellationRequested) return;
    
            const codeBlockRegex = /```(?:[\w-]*)\n([\s\S]+?)\n```/s;
            const match = responseText.match(codeBlockRegex);
            const newCode = match ? match[1] : stripThinkingTags(responseText);
    
            if (newCode) {
                const edit = new vscode.WorkspaceEdit();
                const notebookEdit = vscode.NotebookEdit.insertCells(
                    cell.index + 1,
                    [new vscode.NotebookCellData(vscode.NotebookCellKind.Code, newCode, languageId)]
                );
                edit.set(cell.notebook.uri, [notebookEdit]);
                await vscode.workspace.applyEdit(edit);
            }
        });
    }));    

    context.subscriptions.push(vscode.window.onDidCloseTerminal(terminal => {
        if (lollmsExecutionTerminal && terminal === lollmsExecutionTerminal) {
            lollmsExecutionTerminal = null;
            if (ChatPanel.currentPanel) {
                ChatPanel.currentPanel.updateGeneratingState();
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.stopExecution', () => {
        if (lollmsExecutionTerminal) {
            lollmsExecutionTerminal.dispose();
            lollmsExecutionTerminal = null;
            if (ChatPanel.currentPanel) {
                const stopMessage: ChatMessage = {
                    role: 'system',
                    content: '🛑 Execution stopped by user.'
                };
                ChatPanel.currentPanel.addMessageToDiscussion(stopMessage);
                ChatPanel.currentPanel.updateGeneratingState();
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setEntryPoint', async () => {
        if (!activeWorkspaceFolder) {
            vscode.window.showErrorMessage("Please select an active Lollms workspace to set an entry point.");
            return;
        }

        const launchJsonPath = vscode.Uri.joinPath(activeWorkspaceFolder.uri, '.vscode', 'launch.json');
        let launchConfig: any;
        try {
            const fileContent = await vscode.workspace.fs.readFile(launchJsonPath);
            launchConfig = JSON.parse(fileContent.toString());
        } catch (error) {
            try { await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(activeWorkspaceFolder.uri, '.vscode')); } catch (e) {}
            launchConfig = { version: '0.2.0', configurations: [] };
        }

        if (!launchConfig.configurations || !Array.isArray(launchConfig.configurations)) {
            launchConfig.configurations = [];
        }

        if (launchConfig.configurations.length === 0) {
            launchConfig.configurations.push({ name: 'Lollms Default Run', request: 'launch', type: 'node', program: '' });
        }
        let mainConfig = launchConfig.configurations[0];

        const fileUris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Select as Execution Entry Point',
            title: 'Select the main file to run for the project',
            defaultUri: activeWorkspaceFolder.uri
        });

        if (fileUris && fileUris[0]) {
            const relativePath = path.relative(activeWorkspaceFolder.uri.fsPath, fileUris[0].fsPath).replace(/\\/g, '/');
            mainConfig.program = `\${workspaceFolder}/${relativePath}`;
            
            const ext = path.extname(relativePath).toLowerCase();
            if (ext === '.py') { mainConfig.type = 'python'; }
            if (ext === '.js' || ext === '.ts') { mainConfig.type = 'node'; }

            await vscode.workspace.fs.writeFile(launchJsonPath, Buffer.from(JSON.stringify(launchConfig, null, 4), 'utf8'));
            vscode.window.showInformationMessage(`Set '${relativePath}' as the execution entry point for '${activeWorkspaceFolder.name}'.`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.executeProject', async () => {
        if (!ChatPanel.currentPanel) {
            vscode.window.showErrorMessage("Please open a Lollms chat panel to see the execution results.");
            return;
        }
        const activeChatPanel = ChatPanel.currentPanel;
    
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage("Please open a project folder to execute.");
            activeChatPanel.addMessageToDiscussion({ role: 'system', content: 'Execution failed: No workspace folder open.' });
            return;
        }
        
        activeChatPanel.updateGeneratingState();
    
        const launchJsonPath = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'launch.json');
        let launchConfig: any;
        try {
            const fileContent = await vscode.workspace.fs.readFile(launchJsonPath);
            launchConfig = JSON.parse(fileContent.toString());
            if (!launchConfig.configurations || launchConfig.configurations.length === 0 || !launchConfig.configurations[0].program) {
                throw new Error("No valid entry point configured in launch.json.");
            }
        } catch (error: any) {
            vscode.window.showErrorMessage('No project entry point is configured. Please set one using the "Set Entry Point" (target icon) button.');
            activeChatPanel.handleProjectExecutionResult(`Failed to start: ${error.message}`, false);
            return;
        }
        
        let mainConfig = launchConfig.configurations[0];
        let programPath = mainConfig.program.replace('${workspaceFolder}', workspaceFolder.uri.fsPath);
    
        let command: string;
        if (mainConfig.type === 'python') {
            let pythonPath = 'python';
            if (pythonExtApi) {
                const environment = await pythonExtApi.environments.getActiveEnvironmentPath(workspaceFolder.uri);
                if (environment?.path) {
                    pythonPath = `"${environment.path}"`;
                }
            }
            command = `${pythonPath} -u "${programPath}"`;
        } else if (mainConfig.type === 'node') {
            command = `node "${programPath}"`;
        } else {
            const errorMsg = `Unsupported launch configuration type for direct execution: ${mainConfig.type}`;
            vscode.window.showErrorMessage(errorMsg);
            activeChatPanel.handleProjectExecutionResult(errorMsg, false);
            return;
        }
    
        await activeChatPanel.addMessageToDiscussion({ role: 'system', content: `🚀 Executing in background: \`${command}\`` });
    
        try {
            const { stdout, stderr } = await execAsync(command, { cwd: workspaceFolder.uri.fsPath });
            const fullOutput = `STDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`;
            activeChatPanel.handleProjectExecutionResult(fullOutput, true);
        } catch (error: any) {
            const fullOutput = `STDOUT:\n${error.stdout}\n\nSTDERR:\n${error.stderr}`;
            activeChatPanel.handleProjectExecutionResult(fullOutput, false);
        }
    }));    
    console.log('Extension activation complete.');
}

export function deactivate(): void {
    if (lollmsExecutionTerminal) {
        lollmsExecutionTerminal.dispose();
    }
}