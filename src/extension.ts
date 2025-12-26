import * as vscode from 'vscode';
import * as path from 'path';
import { LollmsAPI, LollmsConfig, ChatMessage } from './lollmsAPI';
import { ChatPanel } from './commands/chatPanel/chatPanel';
import { SettingsPanel } from './commands/configView';
import { ContextManager } from './contextManager';
import { GitIntegration } from './gitIntegration';
import { applyDiff, getProcessedSystemPrompt, stripThinkingTags } from './utils';
import { ContextStateProvider, ContextState, ContextItem } from './commands/contextStateProvider';
import { FileDecorationProvider } from './commands/fileDecorationProvider';
import { DiscussionManager, Discussion } from './discussionManager';
import { DiscussionTreeProvider, DiscussionItem, DiscussionGroupItem } from './commands/discussionTreeProvider';
import { ScriptRunner } from './scriptRunner';
import { PromptManager, Prompt } from './promptManager';
import { ChatPromptTreeProvider } from './commands/chatPromptTreeProvider';
import { CodeActionTreeProvider } from './commands/codeActionTreeProvider';
import { PromptItem, PromptGroupItem, ProcessItem, PersonalityItem } from './commands/treeItems';
import { HelpPanel } from './commands/helpPanel';
import { PromptBuilderPanel, parsePlaceholders } from './commands/promptBuilderPanel';
import { LollmsCodeActionProvider } from './commands/codeActions';
import { LollmsInlineCompletionProvider } from './commands/inlineSuggestions';
import { AgentManager } from './agentManager';
import { InfoPanel } from './commands/infoPanel';
import { CustomActionModal } from './commands/customActionModal';
import { ProcessManager } from './processManager';
import { exec } from 'child_process';
import { promisify } from 'util';
import { LollmsNotebookCellActionProvider, NotebookManager } from './notebookTools';
import { CodeExplorerPanel } from './commands/codeExplorerView';
import { CodeExplorerTreeProvider } from './commands/codeExplorerTreeProvider';
import { SkillsTreeProvider } from './commands/skillsTreeProvider';
import { SkillsManager } from './skillsManager';
import { CodeGraphManager } from './codeGraphManager';
import { ActionsTreeProvider } from './commands/actionsTreeProvider';
import { DebugCodeLensProvider } from './commands/debugCodeLensProvider';
import { CommitInspectorPanel } from './commands/commitInspectorPanel';
import { Logger } from './logger';
import { PersonalityManager } from './personalityManager';
import { PersonalitiesTreeProvider } from './commands/personalitiesTreeProvider';
import { EducativeNotebookModal } from './commands/educativeNotebookModal';
import { QuickEditManager } from './quickEditManager';
import { InlineDiffProvider } from './commands/inlineDiffProvider';
import { MemoryManager } from './memoryManager';
import { PersonalityBuilderPanel } from './commands/personalityBuilderPanel';

const execAsync = promisify(exec);

interface GitExtension { getAPI(version: 1): API; }
interface API { repositories: Repository[]; }
interface Repository { inputBox: { value: string }; rootUri: vscode.Uri; }

let lollmsExecutionTerminal: vscode.Terminal | null = null;
let pythonExtApi: any = null; 

const debugErrorManager = {
    _onDidChange: new vscode.EventEmitter<void>(),
    get onDidChange(): vscode.Event<void> { return this._onDidChange.event; },
    lastError: null as { message: string, stack?: string, filePath?: vscode.Uri, line?: number } | null,
    
    setError(message: string, stack?: string, filePath?: vscode.Uri, line?: number) {
        this.lastError = { message, stack, filePath, line };
        vscode.commands.executeCommand('setContext', 'lollms:hasDebugError', true);
        this._onDidChange.fire();
        Logger.info(`Debug error captured: ${message}`, { stack, filePath, line });
    },

    clearError() {
        if (this.lastError === null) return;
        this.lastError = null;
        vscode.commands.executeCommand('setContext', 'lollms:hasDebugError', false);
        this._onDidChange.fire();
    }
};

/**
 * Helper to normalize search text to match the document's EOL convention.
 */
function normalizeToDocument(searchString: string, document: vscode.TextDocument): string {
    const docEol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    // First normalize to \n, then to document EOL
    return searchString.replace(/\r\n/g, '\n').replace(/\n/g, docEol);
}

async function buildCodeActionPrompt(
    promptTemplate: string, 
    actionType: 'generation' | 'information' | undefined,
    editor: vscode.TextEditor, 
    extensionUri: vscode.Uri,
    contextManager: ContextManager,
    useContext: boolean = false
): Promise<{ systemPrompt: string, userPrompt: string } | null> {
    const selection = editor.selection;
    const document = editor.document;

    let processedTemplate = promptTemplate;
    const placeholders = parsePlaceholders(processedTemplate);
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
    
    let contextText = '';
    if (useContext) {
        const contextResult = await contextManager.getContextContent();
        if (contextResult && contextResult.text && !contextResult.text.includes("**No workspace folder is currently open.**")) {
            contextText = `\n\n==== PROJECT CONTEXT ====\n${contextResult.text}\n=========================\n`;
        }
    }

    let userPrompt = `I am working on the file \`${fileName}\` which is a \`${languageId}\` file.\n\nHere is the code selection:\n\`\`\`${languageId}\n${selectedText}\n\`\`\`\n\nINSTRUCTION: **${userInstruction}**${contextText}`;

    const agentPersonaPrompt = await getProcessedSystemPrompt('agent');
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

        userPrompt += `INSTRUCTION: **${userInstruction}**\n${contextText}\n\n`;
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
    Logger.initialize(context);
    Logger.info('Lollms VS Coder is now active!');

    // DECLARE THE VARIABLE HERE
    let activeWorkspaceFolder: vscode.WorkspaceFolder | undefined;

    const pythonExt = vscode.extensions.getExtension('ms-python.python');
    if (pythonExt) {
        if (!pythonExt.isActive) {
            await pythonExt.activate();
        }
        pythonExtApi = pythonExt.exports;
    } else {
        Logger.warn("The Microsoft Python extension is not installed. Python execution will use the generic 'python' command.");
    }

    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    let lollmsAPI = new LollmsAPI({
        apiUrl: config.get<string>('apiUrl') || 'http://localhost:9642',
        apiKey: config.get<string>('apiKey')?.trim() || '',
        modelName: config.get<string>('modelName') || 'ollama/mistral',
        disableSslVerification: config.get<boolean>('disableSslVerification') || false,
        sslCertPath: config.get<string>('sslCertPath') || '',
        backendType: config.get<'lollms' | 'openai' | 'ollama'>('backendType') || 'lollms',
        useLollmsExtensions: config.get<boolean>('useLollmsExtensions') ?? true
    }, context.globalState);

    const originalContentProvider = new (class implements vscode.TextDocumentContentProvider {
        private originalContent = new Map<string, string>();
        private onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
        readonly onDidChange = this.onDidChangeEmitter.event;

        provideTextDocumentContent(uri: vscode.Uri): string {
            return this.originalContent.get(uri.toString()) || '';
        }

        set(uri: vscode.Uri, content: string) {
            const originalUri = uri.with({ scheme: 'lollms-original' });
            this.originalContent.set(originalUri.toString(), content);
            this.onDidChangeEmitter.fire(originalUri);
        }

        delete(uri: vscode.Uri) {
            const originalUri = uri.with({ scheme: 'lollms-original' });
            this.originalContent.delete(originalUri.toString());
            this.onDidChangeEmitter.fire(originalUri);
        }
    })();
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('lollms-original', originalContentProvider));

    const memoryManager = new MemoryManager(context.globalStorageUri);
    const contextManager = new ContextManager(context, lollmsAPI);
    const scriptRunner = new ScriptRunner(pythonExtApi);
    const promptManager = new PromptManager(context.globalStorageUri);
    const personalityManager = new PersonalityManager(context.globalStorageUri);
    const gitIntegration = new GitIntegration(lollmsAPI);
    const processManager = new ProcessManager();
    const skillsManager = new SkillsManager();
    const codeGraphManager = new CodeGraphManager();
    const notebookManager = new NotebookManager(lollmsAPI);

    const actionsTreeProvider = new ActionsTreeProvider();
    context.subscriptions.push(vscode.window.registerTreeDataProvider('lollmsActionsView', actionsTreeProvider));
    
    const chatPromptTreeProvider = new ChatPromptTreeProvider(promptManager);
    context.subscriptions.push(vscode.window.registerTreeDataProvider('lollmsChatPromptsView', chatPromptTreeProvider));
    const codeActionTreeProvider = new CodeActionTreeProvider(promptManager);
    context.subscriptions.push(vscode.window.registerTreeDataProvider('lollmsCodeActionsView', codeActionTreeProvider));
    const codeExplorerTreeProvider = new CodeExplorerTreeProvider(codeGraphManager);
    context.subscriptions.push(vscode.window.registerTreeDataProvider('lollmsCodeExplorerView', codeExplorerTreeProvider));
    const skillsTreeProvider = new SkillsTreeProvider(skillsManager);
    context.subscriptions.push(vscode.window.registerTreeDataProvider('lollmsSkillsView', skillsTreeProvider));
    const personalitiesTreeProvider = new PersonalitiesTreeProvider(personalityManager);
    context.subscriptions.push(vscode.window.registerTreeDataProvider('lollmsPersonalitiesView', personalitiesTreeProvider));

    const debugCodeLensProvider = new DebugCodeLensProvider(debugErrorManager);
    context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, debugCodeLensProvider));
    
    const inlineDiffProvider = new InlineDiffProvider(lollmsAPI);
    context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, inlineDiffProvider));
    context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'untitled' }, inlineDiffProvider));
    context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'vscode-notebook-cell' }, inlineDiffProvider));

    const notebookProvider = new LollmsNotebookCellActionProvider();
    context.subscriptions.push(
        vscode.notebooks.registerNotebookCellStatusBarItemProvider('jupyter-notebook', notebookProvider)
    );

    const quickEditManager = new QuickEditManager(lollmsAPI, inlineDiffProvider, contextManager, memoryManager);

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.quickEdit', () => {
        quickEditManager.triggerQuickEdit();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.acceptDiff', (sessionId: string) => {
        inlineDiffProvider.accept(sessionId);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.rejectDiff', (sessionId: string) => {
        inlineDiffProvider.reject(sessionId);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.refineDiff', (sessionId: string) => {
        inlineDiffProvider.refine(sessionId);
    }));

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
            panel.agentManager = new AgentManager(panel, lollmsAPI, contextManager, gitIntegration, discussionManager!, context.extensionUri, codeGraphManager, skillsManager);
        }
        panel.setProcessManager(processManager);
        panel.agentManager.setProcessManager(processManager);
        panel.setContextManager(contextManager);
        panel.setPersonalityManager(personalityManager);
    };

    const revealDiscussion = (discussion: Discussion) => {
        if (discussionView && !discussion.id.startsWith('temp-')) {
            setTimeout(async () => {
                try {
                    const item = new DiscussionItem(discussion, context.extensionUri);
                    await discussionView?.reveal(item, { select: true, focus: false, expand: true });
                } catch (e) {
                    // Ignore
                }
            }, 300);
        }
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
        
        await skillsManager.switchWorkspace(folder.uri);
        skillsTreeProvider.refresh();
        
        codeGraphManager.setWorkspaceRoot(folder.uri);
        codeExplorerTreeProvider.refresh();
        
        if (contextStateProvider) {
            await contextStateProvider.switchWorkspace(folder.uri.fsPath);
        } else {
            contextStateProvider = new ContextStateProvider(folder.uri.fsPath, context);
            contextManager.setContextStateProvider(contextStateProvider);
            codeGraphManager.setContextStateProvider(contextStateProvider);
            fileDecorationProvider.updateStateProvider(contextStateProvider);
        }

        ChatPanel.panels.forEach(panel => panel.dispose());
        vscode.window.showInformationMessage(`Lollms workspace switched to '${folder.name}'. All chat panels have been closed.`);
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
            codeGraphManager.setContextStateProvider(undefined);
            fileDecorationProvider.updateStateProvider(undefined);
            return;
        }

        vscode.commands.executeCommand('setContext', 'lollms:hasWorkspace', true);
        
        const initialWorkspace = activeWorkspaceFolder 
            ? (workspaceFolders.find(f => f.uri.toString() === activeWorkspaceFolder!.uri.toString()) || workspaceFolders[0])
            : workspaceFolders[0];
        
        discussionManager = new DiscussionManager(lollmsAPI, processManager, context);
        discussionTreeProvider = new DiscussionTreeProvider(discussionManager, context.extensionUri);
        discussionView = vscode.window.createTreeView('lollmsDiscussionsView', { treeDataProvider: discussionTreeProvider });
        
        const processesStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 97);
        processesStatusBarItem.command = 'lollms-vs-coder.showRunningProcesses';
        context.subscriptions.push(processesStatusBarItem);

        const updateProcessStatus = () => {
            const processes = processManager.getAll();
            if (processes.length > 0) {
                processesStatusBarItem.text = `$(sync~spin) Lollms: ${processes.length} Running`;
                processesStatusBarItem.show();
            } else {
                processesStatusBarItem.hide();
            }
            ChatPanel.panels.forEach(panel => {
                panel.updateGeneratingState();
            });
        };

        context.subscriptions.push(processManager.onDidProcessChange(updateProcessStatus));
        
        context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showRunningProcesses', async () => {
            const processes = processManager.getAll();
            if (processes.length === 0) {
                vscode.window.showInformationMessage('No running Lollms processes.');
                return;
            }
            
            const items = processes.map(p => ({
                label: p.description,
                description: `ID: ${p.id}`,
                detail: `Discussion: ${p.discussionId}`,
                processId: p.id,
                discussionId: p.discussionId
            }));
            
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a running process to manage',
            });
            
            if (selected) {
                const action = await vscode.window.showQuickPick(['Go to Discussion', 'Cancel Process'], {
                    placeHolder: `Action for: ${selected.label}`
                });
                
                if (action === 'Go to Discussion') {
                    vscode.commands.executeCommand('lollms-vs-coder.switchDiscussion', selected.discussionId);
                } else if (action === 'Cancel Process') {
                    processManager.cancel(selected.processId);
                }
            }
        }));

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

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.gitCommit', async (message: string) => {
        if (!activeWorkspaceFolder) {
            vscode.window.showErrorMessage("No active workspace.");
            return;
        }
        await gitIntegration.stageAllAndCommit(message, activeWorkspaceFolder);
    }));

    // Register the missing command for adding files to context
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.addFilesToContext', async (files: string[]) => {
        if (contextStateProvider) {
            await contextStateProvider.addFilesToContext(files);
        } else {
            vscode.window.showErrorMessage("Please open a workspace folder to add files to context.");
        }
    }));

    const sendSelection = async (createNew: boolean) => {
        if (!activeWorkspaceFolder || !discussionManager) {
            vscode.window.showInformationMessage(vscode.l10n.t("info.openFolderToUseChat"));
            return;
        }

        const selectedText = await vscode.env.clipboard.readText();
        if (!selectedText.trim()) {
            vscode.window.showWarningMessage("No text selected in terminal (must be copied to clipboard first).");
            return;
        }

        let targetDiscussion: Discussion | null = null;
        let targetPanel: ChatPanel | undefined;

        if (createNew) {
            targetDiscussion = discussionManager.createNewDiscussion();
            await discussionManager.saveDiscussion(targetDiscussion);
            discussionTreeProvider?.refresh();
            targetPanel = ChatPanel.createOrShow(context.extensionUri, lollmsAPI, discussionManager, targetDiscussion.id, skillsManager);
            setupChatPanel(targetPanel);
            await targetPanel.loadDiscussion();
            revealDiscussion(targetDiscussion);
        } else {
            const allDiscussions = await discussionManager.getAllDiscussions();
            const lastDiscussion = allDiscussions[0];
            if (!lastDiscussion) {
                vscode.window.showInformationMessage("No previous discussion found. Starting a new one.");
                return sendSelection(true); 
            }
            targetDiscussion = lastDiscussion;
            targetPanel = ChatPanel.createOrShow(context.extensionUri, lollmsAPI, discussionManager, targetDiscussion.id, skillsManager);
            setupChatPanel(targetPanel);
            await targetPanel.loadDiscussion();
        }

        if (targetDiscussion && targetPanel) {
            const userMessageContent = `The user selected the following text from their terminal:
\`\`\`
${selectedText}
\`\`\`
Please analyze this output (e.g., error log, script output, or configuration text) and assist the user based on the context.`;
            
            const userMessage: ChatMessage = {
                id: 'user_' + Date.now().toString() + Math.random().toString(36).substring(2),
                role: 'user',
                content: userMessageContent
            };
            
            targetPanel.sendMessage(userMessage);
        }
    };

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.sendSelectionToNewDiscussion', async () => {
        await sendSelection(true);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.sendSelectionToLastDiscussion', async () => {
        await sendSelection(false);
    }));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.startChat', () => {
        if (!activeWorkspaceFolder || !discussionManager) {
            vscode.window.showInformationMessage(vscode.l10n.t("info.openFolderToUseChat"));
            return;
        }
        vscode.commands.executeCommand('lollms-vs-coder.newDiscussion');
    }));

    const saveCodeCommand = vscode.commands.registerCommand('lollms-vs-coder.saveCodeToFile', async (content: string, language: string) => {
        const fileExtension = language === 'python' ? 'py' : language === 'javascript' ? 'js' : language === 'typescript' ? 'ts' : language;
        const uri = await vscode.window.showSaveDialog({
            filters: {
                [language]: [fileExtension]
            }
        });
        if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(content));
            vscode.window.showInformationMessage('Code saved successfully.');
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

    const quickEditStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
    quickEditStatusBar.text = '$(sparkle) lollms';
    quickEditStatusBar.command = 'lollms-vs-coder.quickEdit';
    quickEditStatusBar.tooltip = 'Open Lollms Companion (Quick Edit/Ask) - Ctrl+Shift+L';
    quickEditStatusBar.show();
    context.subscriptions.push(quickEditStatusBar);

    const companionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
    companionStatusBarItem.command = 'lollms-vs-coder.checkConnection';
    companionStatusBarItem.text = '$(sync~spin) Lollms: Checking...';
    companionStatusBarItem.tooltip = 'Click to re-check connection to Lollms Server';
    companionStatusBarItem.show();
    context.subscriptions.push(companionStatusBarItem);

    const checkConnection = async () => {
        companionStatusBarItem.text = '$(sync~spin) Lollms: Checking...';
        try {
            await lollmsAPI.getModels(true);
            companionStatusBarItem.text = '$(pulse) Lollms: Online';
            companionStatusBarItem.backgroundColor = undefined; 
            companionStatusBarItem.tooltip = 'Lollms Server is Online. Click to re-check.';
        } catch (error) {
            companionStatusBarItem.text = '$(circle-slash) Lollms: Offline';
            companionStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            companionStatusBarItem.tooltip = 'Lollms Server is Offline. Click to retry connection.';
        }
    };
    checkConnection();
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.checkConnection', async () => await checkConnection()));

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
            disableSslVerification: newConfigValues.get<boolean>('disableSslVerification') || false,
            sslCertPath: newConfigValues.get<string>('sslCertPath') || '',
            backendType: newConfigValues.get<'lollms' | 'openai' | 'ollama'>('backendType') || 'lollms',
            useLollmsExtensions: newConfigValues.get<boolean>('useLollmsExtensions') ?? true
        };
        lollmsAPI.updateConfig(newConfig);
        updateModelStatus();
        await checkConnection();
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
            e.affectsConfiguration('lollmsVsCoder.disableSslVerification') ||
            e.affectsConfiguration('lollmsVsCoder.sslCertPath') ||
            e.affectsConfiguration('lollmsVsCoder.backendType') ||
            e.affectsConfiguration('lollmsVsCoder.useLollmsExtensions')) {
            vscode.commands.executeCommand('lollmsApi.recreateClient');
        }
    }));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.cancelProcess', (item: ProcessItem) => {
        processManager.cancel(item.process.id);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showLog', () => {
        Logger.show();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.newDiscussion', async (item?: DiscussionGroupItem) => {
        if (!discussionManager) return;
        const groupId = item instanceof DiscussionGroupItem ? item.group.id : null;
        const discussion = discussionManager.createNewDiscussion(groupId);
        await discussionManager.saveDiscussion(discussion);
        
        const panel = ChatPanel.createOrShow(context.extensionUri, lollmsAPI, discussionManager, discussion.id, skillsManager);
        setupChatPanel(panel);
        await panel.loadDiscussion();
        discussionTreeProvider?.refresh();
        revealDiscussion(discussion);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.newDiscussionFromClipboard', async () => {
        if (!discussionManager) {
            vscode.window.showInformationMessage(vscode.l10n.t("info.openFolderToUseChat"));
            return;
        }

        const clipboardContent = await vscode.env.clipboard.readText();
        if (!clipboardContent.trim()) {
            vscode.window.showInformationMessage("Clipboard is empty.");
            return;
        }

        const discussion = discussionManager.createNewDiscussion();

        const userMessage: ChatMessage = {
            id: 'user_' + Date.now().toString() + Math.random().toString(36).substring(2),
            role: 'user',
            content: clipboardContent
        };
        discussion.messages.push(userMessage);

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const autoTitle = config.get<boolean>('autoGenerateTitle');

        if (autoTitle) {
            const title = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("progress.generatingDiscussionTitle"), cancellable: false }, async () => await discussionManager!.generateDiscussionTitle(discussion));
            if (title) {
                discussion.title = title;
            } else {
                discussion.title = "From Clipboard";
            }
        } else {
            discussion.title = "From Clipboard";
        }

        await discussionManager.saveDiscussion(discussion);
        
        const panel = ChatPanel.createOrShow(context.extensionUri, lollmsAPI, discussionManager, discussion.id, skillsManager);
        setupChatPanel(panel);
        await panel.loadDiscussion();
        
        discussionTreeProvider?.refresh();
        revealDiscussion(discussion);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.newTempDiscussion', async () => {
        if (!discussionManager) {
            vscode.window.showInformationMessage(vscode.l10n.t("info.openFolderToUseChat"));
            return;
        }
        const tempId = 'temp-' + Date.now().toString() + Math.random().toString(36).substring(2);
        const panel = ChatPanel.createOrShow(context.extensionUri, lollmsAPI, discussionManager, tempId, skillsManager);
        setupChatPanel(panel);
        await panel.loadDiscussion();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.switchDiscussion', async (discussionId: string) => {
        if (!discussionManager) return;
        const panel = ChatPanel.createOrShow(context.extensionUri, lollmsAPI, discussionManager, discussionId, skillsManager);
        setupChatPanel(panel);
        await panel.loadDiscussion();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.selectPythonInterpreter', () => {
        vscode.commands.executeCommand('python.setInterpreter');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms.runAgentCommand', (objective: string, discussion: Discussion, modelOverride?: string) => {
        const panel = ChatPanel.panels.get(discussion.id);
        if (panel?.agentManager && activeWorkspaceFolder) {
            const modelToUse = modelOverride || discussion.model;
            panel.agentManager.run(objective, discussion, activeWorkspaceFolder, modelToUse);
        } else if (!activeWorkspaceFolder) {
            vscode.window.showErrorMessage("Cannot run Agent: No active Lollms workspace.");
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.deleteDiscussion', async (item: DiscussionItem) => {
        if (!discussionManager) return;
        const deleteButton = { title: vscode.l10n.t('command.delete.title'), id: 'delete' };
        const confirm = await vscode.window.showWarningMessage(vscode.l10n.t('prompt.confirmDelete', item.discussion.title), { modal: true }, deleteButton);
        if (confirm?.id === 'delete') {
            const panel = ChatPanel.panels.get(item.discussion.id);
            panel?.dispose(); 
            
            await discussionManager.deleteDiscussion(item.discussion.id);
            discussionTreeProvider?.refresh();
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

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.titleAllDiscussions', async () => {
        if (!discussionManager) return;

        const allDiscussions = await discussionManager.getAllDiscussions();
        // Filter for generic titles
        const untitledDiscussions = allDiscussions.filter(d => 
            d.title === 'New Discussion' || 
            d.title === 'Untitled Discussion' || 
            d.title === 'From Clipboard'
        );

        if (untitledDiscussions.length === 0) {
            vscode.window.showInformationMessage("No untitled discussions found.");
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Generate titles for ${untitledDiscussions.length} untitled discussions?`,
            { modal: true },
            "Yes"
        );

        if (confirm !== "Yes") return;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Lollms: Titling discussions...",
            cancellable: true
        }, async (progress, token) => {
            const increment = 100 / untitledDiscussions.length;
            
            for (const discussion of untitledDiscussions) {
                if (token.isCancellationRequested) break;

                progress.report({ message: `Analyzing ${discussion.id}...`, increment: 0 }); 

                if (discussion.messages.length > 0) {
                    const newTitle = await discussionManager!.generateDiscussionTitle(discussion);
                    if (newTitle) {
                        discussion.title = newTitle;
                        await discussionManager!.saveDiscussion(discussion);
                    }
                }
                
                progress.report({ message: `Untitled: ${discussion.title}`, increment: increment });
            }
            discussionTreeProvider?.refresh();
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.cleanEmptyDiscussions', async () => {
        if (!discussionManager) return;
        const confirm = await vscode.window.showWarningMessage(
            vscode.l10n.t('prompt.confirmCleanEmptyDiscussions'),
            { modal: true },
            vscode.l10n.t('label.yes')
        );

        if (confirm === vscode.l10n.t('label.yes')) {
            const count = await discussionManager.cleanEmptyDiscussions();
            discussionTreeProvider?.refresh();
            vscode.window.showInformationMessage(vscode.l10n.t('info.cleanedEmptyDiscussions', count));
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
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.inspectCode', async (args?: { code: string, language: string }) => {
        if (!ChatPanel.currentPanel) {
            vscode.window.showErrorMessage("Please open a Lollms chat panel to show inspection results.");
            return;
        }
    
        if (args && args.code) {
            ChatPanel.currentPanel.handleInspectCode(args);
        } else {
            const editor = vscode.window.activeTextEditor;
            if (editor && !editor.selection.isEmpty) {
                const code = editor.document.getText(editor.selection);
                const language = editor.document.languageId;
                ChatPanel.currentPanel.handleInspectCode({ code, language });
            } else {
                vscode.window.showInformationMessage("Please select some code to inspect.");
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.inspectFile', async (fileUri: vscode.Uri) => {
        if (!fileUri) {
            if (vscode.window.activeTextEditor) {
                fileUri = vscode.window.activeTextEditor.document.uri;
            } else {
                vscode.window.showInformationMessage("Please select a file to inspect from the explorer or open it in the editor.");
                return;
            }
        }
    
        if (!discussionManager) {
            vscode.window.showErrorMessage("Cannot start a discussion, a workspace must be active.");
            return;
        }
    
        try {
            const fileContentBytes = await vscode.workspace.fs.readFile(fileUri);
            const fileContent = Buffer.from(fileContentBytes).toString('utf8');
            let languageId = '';
            try {
                const document = await vscode.workspace.openTextDocument(fileUri);
                languageId = document.languageId;
            } catch (e) {
                const ext = path.extname(fileUri.fsPath).substring(1);
                languageId = ext || 'plaintext';
            }
            
            const relativePath = vscode.workspace.asRelativePath(fileUri, false);
    
            const discussion = discussionManager.createNewDiscussion();
            await discussionManager.saveDiscussion(discussion);
            discussionTreeProvider?.refresh();
    
            const panel = ChatPanel.createOrShow(context.extensionUri, lollmsAPI, discussionManager, discussion.id, skillsManager);
            setupChatPanel(panel);
            await panel.loadDiscussion();
            revealDiscussion(discussion);
    
            const config = vscode.workspace.getConfiguration('lollmsVsCoder');
            const inspectorModel = config.get<string>('inspectorModelName') || discussion.model || lollmsAPI.getModelName();
            const systemPrompt = await getProcessedSystemPrompt('chat');
    
            const inspectionPrompt = `Your task is to act as a senior code inspector. Analyze the following ${languageId} file (\`${relativePath}\`) for errors, bugs, vulnerabilities, and malicious content.

If you find any issues, you MUST provide a corrected version of the entire file using the 'File: ${relativePath}' syntax.

After the file block, provide a brief summary of the changes you made in a markdown list.

If the code is perfect and has no issues, simply respond with "The code looks good, no issues found."

Here is the file content:
\`\`\`${languageId}
${fileContent}
\`\`\`
`;
            await panel.sendIsolatedMessage(systemPrompt, inspectionPrompt, inspectorModel);
    
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to inspect file: ${error.message}`);
        }
    }));
        
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.triggerCodeAction', async (promptOrArg?: Prompt | { isCustom: true }) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) {
            vscode.window.showInformationMessage(vscode.l10n.t("info.selectCodeForAction"));
            return;
        }
    
        let targetPrompt: Prompt | undefined;
        let useContext = true; 

        if (promptOrArg && (promptOrArg as { isCustom: true }).isCustom === true) {
            const customActionData = await CustomActionModal.createOrShow(context.extensionUri);
            if (!customActionData) return; 
            
            useContext = customActionData.useContext;
            const fullContent = `${customActionData.prompt}\n{{SELECTED_CODE}}`;

            if (customActionData.save && customActionData.title) {
                const data = await promptManager.getData();
                const newPrompt: Prompt = {
                    id: Date.now().toString() + Math.random().toString(36).substring(2),
                    groupId: null,
                    title: customActionData.title,
                    content: fullContent,
                    type: 'code_action',
                    action_type: customActionData.actionType
                };
                data.prompts.push(newPrompt);
                await promptManager.saveData(data);
                codeActionTreeProvider.refresh();
                vscode.window.showInformationMessage(vscode.l10n.t('info.promptSaved', customActionData.title));
            }
            
            targetPrompt = {
                id: 'custom',
                title: customActionData.title || vscode.l10n.t('title.customAction'),
                content: fullContent,
                type: 'code_action',
                action_type: customActionData.actionType,
                groupId: null
            };
        } else if (promptOrArg) {
            targetPrompt = promptOrArg as Prompt;
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
                
                useContext = customActionData.useContext;
                const fullContent = `${customActionData.prompt}\n{{SELECTED_CODE}}`;

                if (customActionData.save && customActionData.title) {
                    const data = await promptManager.getData();
                    const newPrompt: Prompt = {
                        id: Date.now().toString() + Math.random().toString(36).substring(2),
                        groupId: null,
                        title: customActionData.title,
                        content: fullContent,
                        type: 'code_action',
                        action_type: customActionData.actionType
                    };
                    data.prompts.push(newPrompt);
                    await promptManager.saveData(data);
                    codeActionTreeProvider.refresh();
                    vscode.window.showInformationMessage(vscode.l10n.t('info.promptSaved', customActionData.title));
                }
                
                targetPrompt = {
                    id: 'custom',
                    title: customActionData.title || vscode.l10n.t('title.customAction'),
                    content: fullContent,
                    type: 'code_action',
                    action_type: customActionData.actionType,
                    groupId: null
                };
            } else {
                targetPrompt = selection.prompt;
                useContext = true; 
            }
        }
    
        if (!targetPrompt || typeof targetPrompt.content !== 'string') { return; }

        const promptData = await buildCodeActionPrompt(
            targetPrompt.content, 
            targetPrompt.action_type, 
            editor, 
            context.extensionUri, 
            contextManager,
            useContext
        );
        if (promptData === null) return;
        const { systemPrompt, userPrompt } = promptData;
    
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t('progress.applyingAction', targetPrompt.title),
            cancellable: true
        }, async (progress, token) => {
            const controller = new AbortController();
            token.onCancellationRequested(() => controller.abort());
            
            const responseText = await lollmsAPI.sendChat([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ], null, controller.signal);
            
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
                
                const document = editor.document;
                originalContentProvider.set(document.uri, document.getText());

                try {
                    const workspaceEdit = new vscode.WorkspaceEdit();
                    workspaceEdit.replace(document.uri, editor.selection, modifiedCode);
                    const success = await vscode.workspace.applyEdit(workspaceEdit);
                    
                    if (!success) {
                        vscode.window.showErrorMessage(vscode.l10n.t("error.failedToApplyFileContent", "Failed to apply changes via WorkspaceEdit."));
                        return;
                    }

                    const originalUri = document.uri.with({ scheme: 'lollms-original' });
                    const modifiedUri = document.uri;

                    const title = `${path.basename(document.fileName)} (Original) ↔ ${path.basename(document.fileName)} (AI Suggestion)`;
                    await vscode.commands.executeCommand('vscode.diff', originalUri, modifiedUri, title);
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to apply edits: ${e.message}`);
                }
            }
        });
    }));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.buildCodeGraph', async () => {
        await codeGraphManager.buildGraph();
        codeExplorerTreeProvider.refresh();
        vscode.window.showInformationMessage("Code graph rebuilt.");
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showCodeGraphPanel', async () => {
        const graph = codeGraphManager.getGraphData();
        if (graph.nodes.length === 0) {
             await codeGraphManager.loadGraph();
        }
        CodeExplorerPanel.createOrShow(context.extensionUri, codeGraphManager);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.inspectCommit', async () => {
        if (!activeWorkspaceFolder) {
            vscode.window.showErrorMessage("No active workspace to inspect git commits.");
            return;
        }
        if (!(await gitIntegration.isGitRepo(activeWorkspaceFolder))) {
            vscode.window.showErrorMessage(vscode.l10n.t('error.notGitRepository'));
            return;
        }
        CommitInspectorPanel.createOrShow(context.extensionUri, gitIntegration, lollmsAPI);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.addSkill', async () => {
        const name = await vscode.window.showInputBox({ prompt: "Enter a name for the new skill" });
        if (!name) return;
        const description = await vscode.window.showInputBox({ prompt: "Enter a brief description of the skill" });
        if (description === undefined) return;
        const content = await vscode.window.showInputBox({ prompt: "Enter the code or content for the skill", placeHolder: "Code snippet, shell command, or instructions..." });
        if (content === undefined) return;

        await skillsManager.addSkill({ name, description, content });
        skillsTreeProvider.refresh();
        vscode.window.showInformationMessage(`Skill '${name}' has been learned.`);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.importSkills', async () => {
        await skillsManager.importSkills();
        skillsTreeProvider.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.exportSkills', async () => {
        await skillsManager.exportSkills();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.learnSelectionAsSkill', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) {
            vscode.window.showInformationMessage('Please select a piece of code to learn as a skill.');
            return;
        }

        const content = editor.document.getText(editor.selection);
        const language = editor.document.languageId;
        const name = await vscode.window.showInputBox({ prompt: "Enter a name for this new skill", value: `New ${language} skill` });
        if (!name) return;
        const description = await vscode.window.showInputBox({ prompt: "Enter a brief description of what this code does" });
        if (description === undefined) return;

        await skillsManager.addSkill({ name, description, content, language });
        skillsTreeProvider.refresh();
        vscode.window.showInformationMessage(`Skill '${name}' has been learned.`);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.editMemory', () => {
        memoryManager.showMemoryEditor();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.createPersonality', async () => {
        PersonalityBuilderPanel.createOrShow(context.extensionUri, personalityManager, lollmsAPI);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.editPersonality', async (item: PersonalityItem) => {
        if (!item || !item.personality) return;
        PersonalityBuilderPanel.createOrShow(context.extensionUri, personalityManager, lollmsAPI, item.personality);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.deletePersonality', async (item: PersonalityItem) => {
        if (!item || !item.personality) return;
        if (item.personality.isDefault) {
            vscode.window.showInformationMessage("Cannot delete default personalities.");
            return;
        }
        await personalityManager.deletePersonality(item.personality.id);
    }));

    const handleSetState = (state: ContextState, primaryUri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
        if (!contextStateProvider) return;
        const urisToUpdate = selectedUris && selectedUris.length > 0 ? selectedUris : (primaryUri ? [primaryUri] : []);
        if (urisToUpdate.length > 0) {
            contextStateProvider.setStateForUris(urisToUpdate, state);
        }
    };

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.cycleFileState', async (item: ContextItem) => {
        if (contextStateProvider && item) {
            await contextStateProvider.setStateForUri(item.resourceUri, item.state === 'included' ? 'tree-only' : item.state === 'tree-only' ? 'fully-excluded' : 'included');
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setContextIncluded', (primaryUri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
        handleSetState('included', primaryUri, selectedUris);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setContextTreeOnly', (primaryUri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
        handleSetState('tree-only', primaryUri, selectedUris);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setContextExcluded', (primaryUri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
        handleSetState('fully-excluded', primaryUri, selectedUris);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setContextCollapsed', (primaryUri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
        handleSetState('collapsed', primaryUri, selectedUris);
    }));
    
    async function startDiscussionWithInitialPrompt(prompt: string) {
        if (!discussionManager) return;
    
        const discussion = discussionManager.createNewDiscussion();
        const userMessage: ChatMessage = {
            id: 'user_' + Date.now().toString() + Math.random().toString(36).substring(2),
            role: 'user',
            content: prompt
        };
        discussion.messages.push(userMessage);
        await discussionManager.saveDiscussion(discussion);
        discussionTreeProvider?.refresh();
    
        const panel = ChatPanel.createOrShow(context.extensionUri, lollmsAPI, discussionManager, discussion.id, skillsManager);
        setupChatPanel(panel);
        await panel.loadDiscussion();
        panel.sendMessage(userMessage); 
        revealDiscussion(discussion);
    }

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
                
                await startDiscussionWithInitialPrompt(objective);

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
        const currentWorkspaceFolder = activeWorkspaceFolder;

        try {
            const fileUri = await vscode.window.showSaveDialog({
                title: vscode.l10n.t('title.saveContextSelection'),
                filters: { [vscode.l10n.t('filter.lollmsContext')]: ['lollms-ctx'] },
                defaultUri: vscode.Uri.joinPath(currentWorkspaceFolder.uri, 'context-selection.lollms-ctx')
            });

            if (fileUri) {
                const stateKey = `context-state-${currentWorkspaceFolder.uri.fsPath}`;
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
        const currentWorkspaceFolder = activeWorkspaceFolder;

        try {
            const fileUris = await vscode.window.showOpenDialog({
                title: vscode.l10n.t('title.loadContextSelection'),
                filters: { [vscode.l10n.t('filter.lollmsContext')]: ['lollms-ctx', 'json'] },
                canSelectMany: false,
                defaultUri: currentWorkspaceFolder.uri
            });

            if (fileUris && fileUris[0]) {
                const fileUri = fileUris[0];
                const fileContent = await vscode.workspace.fs.readFile(fileUri);
                const loadedState = JSON.parse(fileContent.toString());
                
                const stateKey = `context-state-${currentWorkspaceFolder.uri.fsPath}`;
                await context.workspaceState.update(stateKey, loadedState);

                contextStateProvider = new ContextStateProvider(currentWorkspaceFolder.uri.fsPath, context);
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
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showConfigView', () => SettingsPanel.createOrShow(context.extensionUri, lollmsAPI, processManager, personalityManager)));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showHelp', () => HelpPanel.createOrShow(context.extensionUri)));

        
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.exportContextContent', async () => {
        try {
            const content = await contextManager.getContextContent();
            await vscode.env.clipboard.writeText(content.text);
            vscode.window.showInformationMessage(vscode.l10n.t('info.contextCopied'));
        } catch (error: any) { vscode.window.showErrorMessage(vscode.l10n.t('error.failedToExportContext', error.message)); }
    }));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.commitWithAIMessage', async () => {
        if (!activeWorkspaceFolder) { vscode.window.showErrorMessage("No active workspace for Git operations."); return; }
        const currentWorkspaceFolder = activeWorkspaceFolder;
        if (!(await gitIntegration.isGitRepo(currentWorkspaceFolder))) { vscode.window.showErrorMessage(vscode.l10n.t('error.notGitRepository')); return; }
        const message = await gitIntegration.generateCommitMessage(currentWorkspaceFolder);
        if (message) {
            const confirmed = await vscode.window.showQuickPick([vscode.l10n.t('label.yes'), vscode.l10n.t('label.no')], { placeHolder: vscode.l10n.t('prompt.confirmCommit', message) });
            if (confirmed === vscode.l10n.t('label.yes')) { await gitIntegration.commitWithMessage(message, currentWorkspaceFolder); }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.generateCommitMessage', async () => {
        if (!activeWorkspaceFolder) {
            vscode.window.showErrorMessage("No active workspace for Git operations.");
            return;
        }
        const currentWorkspaceFolder = activeWorkspaceFolder;
        if (!(await gitIntegration.isGitRepo(currentWorkspaceFolder))) {
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
        
        const repository = git.repositories.find(repo => repo.rootUri.fsPath === currentWorkspaceFolder.uri.fsPath);

        if (repository) {
            const message = await gitIntegration.generateCommitMessage(currentWorkspaceFolder);
            if (message) {
                repository.inputBox.value = message;
            }
        } else {
            vscode.window.showErrorMessage("Could not find a Git repository for the active workspace.");
        }
    }));

    // --- FIX: UPDATED INSERT CODE COMMAND ---
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.insertCode', async (filePath: string, content: string) => {
        if (!activeWorkspaceFolder) {
            vscode.window.showErrorMessage("No active workspace.");
            return;
        }
        
        // Revised Regex: Matches <<<< ... ==== ... (optional >>>> or ==== or end of string)
        const match = content.match(/<<<<([\s\S]*?)====([\s\S]*?)(?:>>>>|====|$)/);
        if (!match) {
             vscode.window.showErrorMessage("Invalid insertion block format.");
             return;
        }
        
        const contextCode = match[1].replace(/^\s*[\r\n]/, '').replace(/[\r\n]\s*$/, ''); 
        // Remove trailing "====" if matched loosely by [\s\S]*? at end
        let insertCode = match[2].replace(/^\s*[\r\n]/, '').replace(/[\r\n]\s*$/, '');
        insertCode = insertCode.replace(/====$/, '').trimEnd();
        
        if (!contextCode.trim()) {
             vscode.window.showErrorMessage("Insertion context is empty.");
             return;
        }

        // Deduplication: If the AI puts the context INSIDE the insertion block, strip it.
        // Example: Context="foo", Insert="foo\nbar" -> Insert="bar"
        if (insertCode.startsWith(contextCode)) {
            insertCode = insertCode.substring(contextCode.length).trimStart();
        }

        const fileUri = vscode.Uri.joinPath(activeWorkspaceFolder.uri, filePath);
        
        let document: vscode.TextDocument;
        try {
            document = await vscode.workspace.openTextDocument(fileUri);
        } catch (error) {
             // File not found logic: Create it
             try {
                 const parentUri = vscode.Uri.joinPath(fileUri, '..');
                 await vscode.workspace.fs.createDirectory(parentUri);
                 
                 const newContent = contextCode + '\n' + insertCode;
                 await vscode.workspace.fs.writeFile(fileUri, Buffer.from(newContent, 'utf8'));
                 vscode.window.showInformationMessage(`File '${filePath}' created (was missing).`);
                 
                 document = await vscode.workspace.openTextDocument(fileUri);
                 await vscode.window.showTextDocument(document);
                 return;
             } catch (createError: any) {
                 vscode.window.showErrorMessage(`Failed to create missing file '${filePath}': ${createError.message}`);
                 return;
             }
        }
        
        try {
            const text = document.getText();
            
            // Normalize search block to match document EOL
            const searchBlock = normalizeToDocument(contextCode, document);
            
            const index = text.indexOf(searchBlock);
            if (index === -1) {
                // Try looser search if strict EOL match fails (fallback)
                // Normalize document text to LF just for finding index
                const textLF = text.replace(/\r\n/g, '\n');
                const contextLF = contextCode.replace(/\r\n/g, '\n');
                const indexLF = textLF.indexOf(contextLF);
                
                if (indexLF === -1) {
                    vscode.window.showErrorMessage(`Could not locate context code in ${filePath}.`);
                    return;
                }
                
                // If found via LF, we need to map back to original index. 
                // This is complex. Better to ask user to check context or rely on strict matching.
                // For now, fail safe.
                vscode.window.showErrorMessage(`Could not locate context code (strict EOL match failed).`);
                return;
            }
            
            const position = document.positionAt(index + searchBlock.length);
            const insertText = (document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n') + insertCode;
            
            const fileContentBytes = await vscode.workspace.fs.readFile(fileUri);
            originalContentProvider.set(fileUri, fileContentBytes.toString());
            
            const edit = new vscode.WorkspaceEdit();
            edit.insert(fileUri, position, insertText);
            const success = await vscode.workspace.applyEdit(edit);
            
            if (!success) {
                vscode.window.showErrorMessage("Failed to apply insertion edit.");
                return;
            }
            
            vscode.window.showInformationMessage(`Code inserted into ${filePath}.`);
            const originalUriForDiff = fileUri.with({ scheme: 'lollms-original' });
            const title = `${path.basename(fileUri.path)} (Original) ↔ ${path.basename(fileUri.path)} (After Insertion)`;
            await vscode.commands.executeCommand('vscode.diff', originalUriForDiff, fileUri, title);
            
        } catch(e: any) {
            vscode.window.showErrorMessage(`Error accessing file: ${e.message}`);
        }
    }));

    // --- FIX: UPDATED REPLACE CODE COMMAND ---
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.replaceCode', async (filePath: string, content: string) => {
        if (!activeWorkspaceFolder) {
            vscode.window.showErrorMessage("No active workspace.");
            return;
        }
        
        const match = content.match(/<<<<([\s\S]*?)====([\s\S]*?)(?:>>>>|====|$)/);
        if (!match) {
             vscode.window.showErrorMessage("Invalid replacement block format.");
             return;
        }
        
        const originalCode = match[1].replace(/^\s*[\r\n]/, '').replace(/[\r\n]\s*$/, ''); 
        let replacementCode = match[2].replace(/^\s*[\r\n]/, '').replace(/[\r\n]\s*$/, '');
        replacementCode = replacementCode.replace(/====$/, '').trimEnd();
        
        if (!originalCode.trim()) {
             vscode.window.showErrorMessage("Original code context is empty.");
             return;
        }

        const fileUri = vscode.Uri.joinPath(activeWorkspaceFolder.uri, filePath);
        
        try {
            const document = await vscode.workspace.openTextDocument(fileUri);
            const text = document.getText();
            
            const searchBlock = normalizeToDocument(originalCode, document);
            
            const index = text.indexOf(searchBlock);
            if (index === -1) {
                vscode.window.showErrorMessage(`Could not locate code to replace in ${filePath}.`);
                return;
            }
            
            const startPos = document.positionAt(index);
            const endPos = document.positionAt(index + searchBlock.length);
            const range = new vscode.Range(startPos, endPos);
            
            const fileContentBytes = await vscode.workspace.fs.readFile(fileUri);
            originalContentProvider.set(fileUri, fileContentBytes.toString());
            
            const edit = new vscode.WorkspaceEdit();
            edit.replace(fileUri, range, replacementCode);
            const success = await vscode.workspace.applyEdit(edit);
            
            if (!success) {
                vscode.window.showErrorMessage("Failed to apply replacement edit.");
                return;
            }
            
            vscode.window.showInformationMessage(`Code replaced in ${filePath}.`);
            const originalUriForDiff = fileUri.with({ scheme: 'lollms-original' });
            const title = `${path.basename(fileUri.path)} (Original) ↔ ${path.basename(fileUri.path)} (After Replacement)`;
            await vscode.commands.executeCommand('vscode.diff', originalUriForDiff, fileUri, title);
            
        } catch(e: any) {
            vscode.window.showErrorMessage(`Error accessing file: ${e.message}`);
        }
    }));

    // --- FIX: UPDATED DELETE CODE COMMAND ---
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.deleteCodeBlock', async (filePath: string, content: string) => {
        if (!activeWorkspaceFolder) {
            vscode.window.showErrorMessage("No active workspace.");
            return;
        }
        
        const match = content.match(/<<<<([\s\S]*?)(?:>>>>|====|$)/);
        if (!match) {
             vscode.window.showErrorMessage("Invalid deletion block format.");
             return;
        }
        
        let codeToDelete = match[1].replace(/^\s*[\r\n]/, '').replace(/[\r\n]\s*$/, ''); 
        codeToDelete = codeToDelete.replace(/====$/, '').trimEnd();
        
        if (!codeToDelete.trim()) {
             vscode.window.showErrorMessage("Code to delete is empty.");
             return;
        }

        const fileUri = vscode.Uri.joinPath(activeWorkspaceFolder.uri, filePath);
        
        try {
            const document = await vscode.workspace.openTextDocument(fileUri);
            const text = document.getText();
            
            const searchBlock = normalizeToDocument(codeToDelete, document);
            
            const index = text.indexOf(searchBlock);
            if (index === -1) {
                vscode.window.showErrorMessage(`Could not locate code to delete in ${filePath}.`);
                return;
            }
            
            const startPos = document.positionAt(index);
            const endPos = document.positionAt(index + searchBlock.length);
            const range = new vscode.Range(startPos, endPos);
            
            const fileContentBytes = await vscode.workspace.fs.readFile(fileUri);
            originalContentProvider.set(fileUri, fileContentBytes.toString());
            
            const edit = new vscode.WorkspaceEdit();
            edit.delete(fileUri, range);
            const success = await vscode.workspace.applyEdit(edit);
            
            if (!success) {
                vscode.window.showErrorMessage("Failed to apply deletion edit.");
                return;
            }
            
            vscode.window.showInformationMessage(`Code deleted from ${filePath}.`);
            const originalUriForDiff = fileUri.with({ scheme: 'lollms-original' });
            const title = `${path.basename(fileUri.path)} (Original) ↔ ${path.basename(fileUri.path)} (After Deletion)`;
            await vscode.commands.executeCommand('vscode.diff', originalUriForDiff, fileUri, title);
            
        } catch(e: any) {
            vscode.window.showErrorMessage(`Error accessing file: ${e.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.applyAllChanges', async (changes: { updates: {filePath: string, content: string}[], patches: {filePath: string, content: string}[] }) => {
        if (!activeWorkspaceFolder) {
            vscode.window.showErrorMessage(vscode.l10n.t('error.openWorkspaceToApplyChanges'));
            return;
        }
        const currentWorkspaceFolder = activeWorkspaceFolder;
        const { updates, patches } = changes;
        if ((!updates || updates.length === 0) && (!patches || patches.length === 0)) {
            return;
        }
    
        let lastFileUri: vscode.Uri | undefined;
        let successCount = 0;
        let errorCount = 0;
    
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Lollms: Applying all file changes...",
            cancellable: false
        }, async (progress) => {
            if (updates) {
                for (const update of updates) {
                    const { filePath, content } = update;
                    
                    if (content.match(/^--- a\/.*\n\+\+\+ b\//m) || content.match(/^@@ -\d+,?\d* \+\d+,?\d* @@/m)) {
                         vscode.window.showWarningMessage(`Skipped ${filePath}: Content looked like a diff but was marked as full file.`);
                         errorCount++;
                         continue;
                    }

                    progress.report({ message: `Applying to ${filePath}` });
                    const fileUri = vscode.Uri.joinPath(currentWorkspaceFolder.uri, filePath);
                    try {
                        const parentUri = vscode.Uri.joinPath(fileUri, '..');
                        await vscode.workspace.fs.createDirectory(parentUri);
                        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));
                        successCount++;
                        lastFileUri = fileUri;
                    } catch (error: any) {
                        errorCount++;
                        vscode.window.showErrorMessage(vscode.l10n.t('error.failedToApplyMultiple', 'Failed to apply changes to {0}: {1}', filePath, error.message));
                    }
                }
            }
            if (patches) {
                 for (const patch of patches) {
                    const { filePath, content } = patch;
                    progress.report({ message: `Patching ${filePath}` });
                    try {
                        let finalPatch = content;
                        if (!content.trim().startsWith('--- a/')) {
                            finalPatch = `--- a/${filePath}\n+++ b/${filePath}\n${content}`;
                        }
                        await applyDiff(finalPatch);
                        successCount++;
                        lastFileUri = vscode.Uri.joinPath(currentWorkspaceFolder.uri, filePath);
                    } catch (error: any) {
                        errorCount++;
                        vscode.window.showErrorMessage(vscode.l10n.t('error.failedToApplyPatch', filePath, error.message));
                    }
                }
            }
        });
    
        if (successCount > 0) {
            vscode.window.showInformationMessage(vscode.l10n.t('info.applySuccessMultiple', '✅ Successfully applied changes to {0} files.', successCount));
        }
        
        if (lastFileUri) {
            await vscode.window.showTextDocument(lastFileUri);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.applyFileContent', async (filePath: string, content: string) => {
        if (!activeWorkspaceFolder) {
            vscode.window.showErrorMessage(vscode.l10n.t('error.openWorkspaceToApplyChanges'));
            return;
        }
        const currentWorkspaceFolder = activeWorkspaceFolder;
        
        if (content.match(/^--- a\/.*\n\+\+\+ b\//m) || content.match(/^@@ -\d+,?\d* \+\d+,?\d* @@/m)) {
            const choice = await vscode.window.showWarningMessage(
                "The content looks like a Diff/Patch but 'Apply to File' was clicked. This will overwrite the file with the diff text. Do you want to apply it as a patch instead?",
                "Apply as Patch",
                "Overwrite Anyway"
            );
            
            if (choice === "Apply as Patch") {
                vscode.commands.executeCommand('lollms-vs-coder.applyPatchContent', filePath, content);
                return;
            }
            if (choice !== "Overwrite Anyway") {
                return;
            }
        }

        const fileUri = vscode.Uri.joinPath(currentWorkspaceFolder.uri, filePath);
    
        let originalContent = '';
        let fileExists = true;
        try {
            const fileContentBytes = await vscode.workspace.fs.readFile(fileUri);
            originalContent = Buffer.from(fileContentBytes).toString('utf8');
        } catch (error) {
            fileExists = false;
        }
    
        originalContentProvider.set(fileUri, originalContent);
    
        try {
            const edit = new vscode.WorkspaceEdit();
            if (fileExists) {
                const document = await vscode.workspace.openTextDocument(fileUri);
                const lastLine = document.lineAt(document.lineCount - 1);
                const fullRange = new vscode.Range(new vscode.Position(0, 0), lastLine.range.end);
                edit.replace(fileUri, fullRange, content);
            } else {
                edit.createFile(fileUri);
                edit.insert(fileUri, new vscode.Position(0, 0), content);
            }
            const success = await vscode.workspace.applyEdit(edit);
    
            if (!success) {
                throw new Error('VS Code failed to apply the edit.');
            }
            
            vscode.window.showInformationMessage(vscode.l10n.t('info.applySuccess', '✅ Successfully applied changes to {0}', filePath));
            
            const originalUriForDiff = fileUri.with({ scheme: 'lollms-original' });
            const title = `${path.basename(fileUri.path)} (Original) ↔ ${path.basename(fileUri.path)} (AI Suggestion)`;
            await vscode.commands.executeCommand('vscode.diff', originalUriForDiff, fileUri, title);
    
        } catch (error: any) {
            vscode.window.showErrorMessage(vscode.l10n.t('error.failedToApplyFileContent', 'Failed to apply file content: {0}', error.message));
        }
    }));
    
    // NEW COMMAND: Generate Educative Notebook (Action)
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.generateEducativeNotebookFromAction', async () => {
        if (!activeWorkspaceFolder) {
            vscode.window.showErrorMessage("No active workspace found. Please open a folder.");
            return;
        }

        const data = await EducativeNotebookModal.createOrShow(context.extensionUri);
        if (!data) return;

        const { topic, includeTree } = data; // selectedTools might be less relevant if we just generate text/code, but we can include instructions to use libraries if needed.

        // Sanitize filename
        const safeTopic = topic.replace(/[^a-z0-9]/gi, '_').toLowerCase().substring(0, 50);
        const fileName = `${safeTopic}.ipynb`;
        const fileUri = vscode.Uri.joinPath(activeWorkspaceFolder.uri, fileName);

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Generating notebook: ${fileName}...`,
            cancellable: true
        }, async (progress, token) => {
            
            const systemPrompt = `You are a technical educator. Create a comprehensive, step-by-step Jupyter Notebook tutorial about "${topic}".
            
**Structure:**
1.  **Introduction**: Markdown cell explaining the concept.
2.  **Setup**: Code cell with necessary imports/installations (if needed).
3.  **Examples**: Alternating Markdown explanations and Python Code cells demonstrating the concept.
4.  **Conclusion**: Summary.

**FORMATTING RULES:**
- Output ONLY the raw content separated by the delimiter "### CELL_SPLIT ###".
- Precede each cell content with "TYPE: MARKDOWN" or "TYPE: CODE".
- Do not use markdown code fences (\`\`\`) to wrap the whole response.
- Example format:
TYPE: MARKDOWN
# Introduction
This is a tutorial...
### CELL_SPLIT ###
TYPE: CODE
import numpy as np
print("Hello")
### CELL_SPLIT ###
...
`;
            
            // Add context if requested
            let userContent = `Topic: ${topic}`;
            if (includeTree) {
                 // We might need contextManager here if we want to include tree, but for a general tutorial, maybe not critical unless it's "Explain THIS project".
                 // If the user wants to explain the project, we need the tree.
                 // contextManager is available in activation scope.
                 // let's try to get tree if requested.
                 const tree = await contextManager.getContextContent({ includeTree: true });
                 if(tree.text) {
                     userContent += `\n\nProject Context:\n${tree.text}`;
                 }
            }

            const response = await lollmsAPI.sendChat([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userContent }
            ], null, undefined); // undefined signal for now, could wire up token

            if (token.isCancellationRequested) return;

            const cleanResponse = stripThinkingTags(response);
            const parts = cleanResponse.split('### CELL_SPLIT ###');
            
            const edits: vscode.NotebookCellEdit[] = [];
            const newNotebookData = new vscode.NotebookData([]);
            
            // To create a new file, we don't edit existing. We create content.
            // But NotebookData is what we need to open.
            
            const cells: vscode.NotebookCellData[] = [];

            for (let part of parts) {
                part = part.trim();
                if (!part) continue;
                
                let kind = vscode.NotebookCellKind.Markup;
                let content = part;

                if (part.startsWith('CODE')) {
                    kind = vscode.NotebookCellKind.Code;
                    content = part.substring(4).trim();
                    // Clean content using our helper logic, but here we know it's a block
                    const blockMatch = content.match(/```(?:python)?\s*([\s\S]*?)```/i);
                    if (blockMatch) content = blockMatch[1].trim();
                } else if (part.startsWith('MARKDOWN')) {
                    kind = vscode.NotebookCellKind.Markup;
                    content = part.substring(8).trim();
                } else {
                    if (part.includes('def ') || part.includes('import ') || part.includes('print(')) {
                        kind = vscode.NotebookCellKind.Code;
                        content = part.replace(/^```python\n/, '').replace(/^```\n/, '').replace(/```$/, '').trim();
                    }
                }
                
                cells.push(new vscode.NotebookCellData(kind, content, kind === vscode.NotebookCellKind.Code ? 'python' : 'markdown'));
            }
            
            newNotebookData.cells = cells;
            const doc = await vscode.workspace.openNotebookDocument('jupyter-notebook', newNotebookData);
            await doc.save(); // This might fail if it's untitled and we didn't specify path?
            // Actually, openNotebookDocument creates untitled. We want to save to fileUri.
            
            // Alternative: Write raw JSON to file
            // But converting cell data to ipynb format manually is annoying.
            // Let's use workspace edit to create file.
            
            const workspaceEdit = new vscode.WorkspaceEdit();
            workspaceEdit.createFile(fileUri, { ignoreIfExists: false, overwrite: true });
            await vscode.workspace.applyEdit(workspaceEdit);
            
            // Now open it and insert cells
            const document = await vscode.workspace.openNotebookDocument(fileUri);
            const editor = await vscode.window.showNotebookDocument(document);
            
            const cellEdits = [new vscode.NotebookCellEdit(0, 0, cells)];
            const notebookEdit = new vscode.WorkspaceEdit();
            notebookEdit.set(document.uri, cellEdits);
            await vscode.workspace.applyEdit(notebookEdit);
            await document.save();
        });
    }));
    // Fix with Lollms Commands
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.debugErrorWithAI', async () => {
        const error = debugErrorManager.lastError;
        if (!error) {
            vscode.window.showInformationMessage("No debug error captured yet. Run your code and wait for an exception.");
            return;
        }

        // Fetch the full project context
        const contextResult = await contextManager.getContextContent();
        
        const prompt = `I encountered an exception while debugging my code. 

**Error Message:** 
${error.message}

**Location:** 
File: \`${error.filePath?.fsPath}\`
Line: ${error.line}

**Stack Trace:**
\`\`\`
${error.stack || 'No stack trace available'}
\`\`\`

**Project Context:**
${contextResult.text}

Please analyze the error and provide a fix. 
- You MUST provide the fix using the "File: path/to/file" or "Replace: path/to/file" format.
- Regenerate the full corrected file or a surgical replacement block as appropriate.
- Explain what caused the error before providing the code blocks.`;

        await startDiscussionWithInitialPrompt(prompt);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.debugErrorSendToDiscussion', async () => {
        const error = debugErrorManager.lastError;
        if (!error || !ChatPanel.currentPanel) return;
        ChatPanel.currentPanel.sendMessage({ role: 'user', content: `Debug Error Context:\nMessage: ${error.message}\nFile: ${error.filePath?.fsPath}\nLine: ${error.line}` });
    }));

    // Listener for debugger exceptions to populate the error manager and trigger context
    context.subscriptions.push(vscode.debug.onDidChangeActiveStackItem(async (e) => {
        if (!e || !e.session) return;
        
        const session = e.session;
        try {
            // Retrieve exception information from the debug session
            const exceptionInfo = await session.customRequest('exceptionInfo', { threadId: e.thread.id });
            if (exceptionInfo && (exceptionInfo.exceptionId || exceptionInfo.description)) {
                const message = exceptionInfo.description || exceptionInfo.exceptionId;
                const stack = exceptionInfo.details?.stackTrace;
                
                // Retrieve the top frame to identify the file and line
                const stackTrace = await session.customRequest('stackTrace', { threadId: e.thread.id, levels: 1 });
                const topFrame = stackTrace.stackFrames[0];
                const filePath = topFrame?.source?.path ? vscode.Uri.file(topFrame.source.path) : undefined;
                const line = topFrame?.line;

                debugErrorManager.setError(message, stack, filePath, line);
            }
        } catch (err) {
            // Some debug sessions might not support 'exceptionInfo'
        }
    }));
    
    // Clear error context when debugging session ends
    context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(() => {
        debugErrorManager.clearError();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.executeProject', async (discussionId: string) => {
        const panel = ChatPanel.panels.get(discussionId);
        if (!panel) return;
        try {
            await vscode.commands.executeCommand('workbench.action.debug.start');
        } catch (e: any) {
            panel.handleProjectExecutionResult(`Failed to start project: ${e.message}`, false);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setEntryPoint', async () => {
        const uris = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Select Entry Point' });
        if (uris && uris[0] && activeWorkspaceFolder) {
            const relPath = vscode.workspace.asRelativePath(uris[0], false);
            await vscode.commands.executeCommand('lollms-vs-coder.setLaunchEntrypoint', relPath);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setLaunchEntrypoint', async (filePath: string) => {
        if (!activeWorkspaceFolder) return;
        const launchJsonPath = vscode.Uri.joinPath(activeWorkspaceFolder.uri, '.vscode', 'launch.json');
        let config: any = { version: '0.2.0', configurations: [] };
        try {
            const bytes = await vscode.workspace.fs.readFile(launchJsonPath);
            config = JSON.parse(bytes.toString());
        } catch (e) {
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(activeWorkspaceFolder.uri, '.vscode'));
        }
        if (config.configurations.length === 0) {
            config.configurations.push({ name: "Launch Project", request: "launch", type: "node", program: "" });
        }
        config.configurations[0].program = `\${workspaceFolder}/${filePath}`;
        await vscode.workspace.fs.writeFile(launchJsonPath, Buffer.from(JSON.stringify(config, null, 4)));
        vscode.window.showInformationMessage(`Entry point set to: ${filePath}`);
    }));    

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.fixDiagnostic', async (document: vscode.TextDocument, diagnostic: vscode.Diagnostic) => {
        if (!discussionManager) {
            vscode.window.showErrorMessage("Lollms: Cannot start a discussion, a workspace must be active.");
            return;
        }

        const line = diagnostic.range.start.line;
        const startLine = Math.max(0, line - 10);
        const endLine = Math.min(document.lineCount - 1, line + 10);
        const range = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
        const codeContext = document.getText(range);
        const relativePath = vscode.workspace.asRelativePath(document.uri);

        const prompt = `I have an error in my code and I need you to fix it.

**File:** \`${relativePath}\`
**Error:** \`${diagnostic.message}\`
**Source:** ${diagnostic.source || 'Unknown'}
**Code Context:**
\`\`\`${document.languageId}
${codeContext}
\`\`\`

Please analyze the error and provide a corrected version of the code or instructions to fix it.`;

        await startDiscussionWithInitialPrompt(prompt);
    }));
        

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setContextDefinitionsOnly', (primaryUri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
        handleSetState('definitions-only', primaryUri, selectedUris);
    }));

    // Register notebook commands using notebookManager instance
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.promptToNotebookCell', (cell: vscode.NotebookCell) => notebookManager.promptToNotebookCell(cell)));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.enhanceNotebookCell', (cell: vscode.NotebookCell) => notebookManager.enhanceNotebookCell(cell)));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.generateNextNotebookCell', (cell: vscode.NotebookCell) => notebookManager.generateNextNotebookCell(cell)));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.explainNotebookCell', (cell: vscode.NotebookCell) => notebookManager.explainNotebookCell(cell)));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.visualizeNotebookCell', (cell: vscode.NotebookCell) => notebookManager.visualizeNotebookCell(cell)));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.analyzeNotebookCellOutput', (cell: vscode.NotebookCell) => notebookManager.analyzeNotebookCellOutput(cell)));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.fixNotebookCellError', (cell: vscode.NotebookCell) => notebookManager.fixNotebookCellError(cell)));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.generateEducativeNotebook', (cell: vscode.NotebookCell) => notebookManager.generateEducativeNotebook(cell)));
        
    console.log('Extension activation complete.');
}

export function deactivate(): void {
    if (lollmsExecutionTerminal) {
        lollmsExecutionTerminal.dispose();
    }
}
