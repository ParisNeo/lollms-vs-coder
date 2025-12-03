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
import { PromptItem, PromptGroupItem, ProcessItem } from './commands/treeItems';
import { HelpPanel } from './commands/helpPanel';
import { PromptBuilderPanel, parsePlaceholders } from './commands/promptBuilderPanel';
import { LollmsCodeActionProvider } from './commands/codeActions';
import { LollmsInlineCompletionProvider } from './commands/inlineSuggestions';
import { AgentManager } from './agentManager';
import { InfoPanel } from './commands/infoPanel';
import { CustomActionModal } from './commands/customActionModal';
import * as https from 'https';
import { ProcessManager } from './processManager';
import { ProcessTreeProvider } from './commands/processTreeProvider';
import { exec } from 'child_process';
import { promisify } from 'util';
import { LollmsNotebookCellActionProvider } from './notebookTools';
import { CodeExplorerPanel } from './commands/codeExplorerView';
import { CodeExplorerTreeProvider } from './commands/codeExplorerTreeProvider';
import { SkillsTreeProvider } from './commands/skillsTreeProvider';
import { SkillsManager } from './skillsManager';
import { CodeGraphManager } from './codeGraphManager';
import { ActionsTreeProvider } from './commands/actionsTreeProvider';
import { DebugCodeLensProvider } from './commands/debugCodeLensProvider';
import { CommitInspectorPanel } from './commands/commitInspectorPanel';
import { Logger } from './logger';

const execAsync = promisify(exec);


interface GitExtension { getAPI(version: 1): API; }
interface API { repositories: Repository[]; }
interface Repository { inputBox: { value: string }; rootUri: vscode.Uri; }

let lollmsExecutionTerminal: vscode.Terminal | null = null;
let pythonExtApi: any = null; 

// Simple manager to hold the state of the last captured debug error
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

class LollmsDebugAdapterTrackerFactory implements vscode.DebugAdapterTrackerFactory {
    createDebugAdapterTracker(session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterTracker> {
        return {
            onWillStartSession: () => {
                debugErrorManager.clearError();
            },
            onWillStopSession: () => {
                debugErrorManager.clearError();
            },
            onDidSendMessage: (message) => {
                if (message.type === 'event' && message.event === 'stopped' && message.body.reason === 'exception') {
                    const exceptionText = message.body.text || 'An unknown exception occurred.';
                    const description = message.body.description || '';
                    let fullMessage = exceptionText;
                    if (description && !fullMessage.includes(description)) {
                        fullMessage += `\n${description}`;
                    }

                    const threadId = message.body.threadId;
                    if (threadId) {
                        session.customRequest('stackTrace', { threadId: threadId, startFrame: 0, levels: 20 }).then(async (reply) => {
                            let stackTrace = '';
                            let errorFileUri: vscode.Uri | undefined;
                            let errorLine: number | undefined;

                            if (reply && reply.stackFrames && reply.stackFrames.length > 0) {
                                stackTrace = reply.stackFrames.map((frame: any) => {
                                    const sourcePath = frame.source ? (frame.source.path || frame.source.name) : 'unknown_source';
                                    return `  at ${frame.name} (${sourcePath}:${frame.line})`;
                                }).join('\n');
                                
                                for (const frame of reply.stackFrames) {
                                    if (frame.source && frame.source.path && !frame.source.path.includes('node_modules') && !frame.source.path.startsWith('<')) {
                                        const frameUri = vscode.Uri.file(frame.source.path);
                                        if (vscode.workspace.getWorkspaceFolder(frameUri)) {
                                            errorFileUri = frameUri;
                                            errorLine = frame.line;
                                            
                                            if (errorLine !== undefined) {
                                                try {
                                                    const doc = await vscode.workspace.openTextDocument(errorFileUri);
                                                    await vscode.window.showTextDocument(doc, {
                                                        selection: new vscode.Range(errorLine - 1, 0, errorLine - 1, 0),
                                                        preserveFocus: false,
                                                        preview: true
                                                    });
                                                } catch (e) {
                                                    Logger.error("Lollms: Could not open document from stack trace.", e);
                                                }
                                            }
                                            break; 
                                        }
                                    }
                                }
                            }
                            debugErrorManager.setError(fullMessage, stackTrace, errorFileUri, errorLine);

                            // Show an information message with a button
                            const fixButton = 'Fix with Lollms';
                            const sendToDiscussionButton = 'Send to Discussion';
                            vscode.window.showInformationMessage(`Lollms captured a debug error: ${exceptionText}`, fixButton, sendToDiscussionButton).then(selection => {
                                if (selection === fixButton) {
                                    vscode.commands.executeCommand('lollms-vs-coder.debugErrorWithAI');
                                } else if (selection === sendToDiscussionButton) {
                                    vscode.commands.executeCommand('lollms-vs-coder.debugErrorSendToDiscussion');
                                }
                            });
                        }, () => {
                            debugErrorManager.setError(fullMessage);
                        });
                    } else {
                        debugErrorManager.setError(fullMessage);
                    }
                } else if (message.type === 'event' && message.event === 'output' && message.body.category === 'stderr') {
                    const output = message.body.output;
                    if (output.match(/error|exception|traceback/i) && !debugErrorManager.lastError) {
                        debugErrorManager.setError(output);
                    }
                }
            }
        };
    }
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

async function buildDebugErrorPrompt(
    errorDetails: { message: string, stack?: string, filePath?: vscode.Uri, line?: number } | null, 
    contextManager: ContextManager, 
    contextStateProvider: ContextStateProvider | undefined
): Promise<string> {
    if (!errorDetails) {
        return "No debug error has been captured.";
    }

    let prompt = `I'm encountering an error while debugging my project. Can you help me fix it?\n\n**Error Message:**\n\`\`\`\n${errorDetails.message}\n\`\`\`\n\n**Full Stack Trace:**\n\`\`\`\n${errorDetails.stack || 'No stack trace available.'}\n\`\`\``;

    if (errorDetails.filePath && errorDetails.line) {
        const fileUri = errorDetails.filePath;
        const relativePath = vscode.workspace.asRelativePath(fileUri, false);
        prompt += `\n\nThe error seems to originate in the file \`${relativePath}\` at line ${errorDetails.line}.`;

        try {
            const document = await vscode.workspace.openTextDocument(fileUri);
            const errorLineContent = document.lineAt(errorDetails.line - 1).text;
            prompt += `\n\n**Here is the line of code that is causing the error:**\n\`\`\`\n${errorLineContent.trim()}\n\`\`\``;
        } catch (e) {
            Logger.error("Lollms: Could not read the specific error line from the document.", e);
        }

        let fileIsInContext = false;
        if (contextStateProvider) {
            const fileState = contextStateProvider.getStateForUri(fileUri);
            if (fileState === 'included') {
                fileIsInContext = true;
            }
        }

        if (fileIsInContext) {
            prompt += `\n\nThe file \`${relativePath}\` is already included in your context. Please analyze the error and provide a fix.`;
        } else {
            try {
                const fileContent = await vscode.workspace.fs.readFile(fileUri);
                const contentString = Buffer.from(fileContent).toString('utf8');
                const document = await vscode.workspace.openTextDocument(fileUri);
                const languageId = document.languageId;

                prompt += `\n\n**Here is the full content of \`${relativePath}\` for your analysis:**\n\`\`\`${languageId}\n${contentString}\n\`\`\`\n\nPlease analyze the error and the file content, then provide a fix.`;
            } catch (e) {
                Logger.error("Failed to read file from stack trace for debug prompt:", e);
                prompt += `\n\nI was unable to read the content of the file. Please provide a general analysis based on the error and stack trace.`;
            }
        }
    } else {
         const contextContent = await contextManager.getContextContent();
         prompt += `\n\nHere is the current project context which might be relevant:\n${contextContent.text}\n\nPlease analyze the error and provide a fix.`;
    }

    return prompt;
}


export async function activate(context: vscode.ExtensionContext) {
    Logger.initialize(context);
    Logger.info('Lollms VS Coder is now active!');

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
        sslCertPath: config.get<string>('sslCertPath') || ''
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

    const contextManager = new ContextManager(context, lollmsAPI);
    const scriptRunner = new ScriptRunner(pythonExtApi);
    const promptManager = new PromptManager(context.globalStorageUri);
    const gitIntegration = new GitIntegration(lollmsAPI);
    const processManager = new ProcessManager();
    const skillsManager = new SkillsManager();
    const codeGraphManager = new CodeGraphManager();

    const actionsTreeProvider = new ActionsTreeProvider();
    context.subscriptions.push(vscode.window.registerTreeDataProvider('lollmsActionsView', actionsTreeProvider));
    
    let processTreeProvider: ProcessTreeProvider | undefined;

    const chatPromptTreeProvider = new ChatPromptTreeProvider(promptManager);
    context.subscriptions.push(vscode.window.registerTreeDataProvider('lollmsChatPromptsView', chatPromptTreeProvider));
    const codeActionTreeProvider = new CodeActionTreeProvider(promptManager);
    context.subscriptions.push(vscode.window.registerTreeDataProvider('lollmsCodeActionsView', codeActionTreeProvider));
    const codeExplorerTreeProvider = new CodeExplorerTreeProvider(codeGraphManager);
    context.subscriptions.push(vscode.window.registerTreeDataProvider('lollmsCodeExplorerView', codeExplorerTreeProvider));
    const skillsTreeProvider = new SkillsTreeProvider(skillsManager);
    context.subscriptions.push(vscode.window.registerTreeDataProvider('lollmsSkillsView', skillsTreeProvider));

    const debugCodeLensProvider = new DebugCodeLensProvider(debugErrorManager);
    context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, debugCodeLensProvider));
    
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
            // Inject codeGraphManager into AgentManager
            panel.agentManager = new AgentManager(panel, lollmsAPI, contextManager, gitIntegration, discussionManager!, context.extensionUri, codeGraphManager);
        }
        panel.setProcessManager(processManager);
        panel.agentManager.setProcessManager(processManager);
        panel.setContextManager(contextManager);
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
        
        // Pass workspace to CodeGraphManager
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

        // Close all existing chat panels when switching workspace to avoid context confusion
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
        
        discussionManager = new DiscussionManager(lollmsAPI, processManager);
        discussionTreeProvider = new DiscussionTreeProvider(discussionManager, context.extensionUri);
        discussionView = vscode.window.createTreeView('lollmsDiscussionsView', { treeDataProvider: discussionTreeProvider });
        
        processTreeProvider = new ProcessTreeProvider(processManager);
        context.subscriptions.push(vscode.window.registerTreeDataProvider('lollmsProcessView', processTreeProvider));
        
        context.subscriptions.push(processManager.onDidProcessChange(() => {
            processTreeProvider?.refresh();
            ChatPanel.panels.forEach(panel => {
                panel.updateGeneratingState();
            });
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
            // New Discussion
            targetDiscussion = discussionManager.createNewDiscussion();
            await discussionManager.saveDiscussion(targetDiscussion);
            discussionTreeProvider?.refresh();
            targetPanel = ChatPanel.createOrShow(context.extensionUri, lollmsAPI, discussionManager, targetDiscussion.id, skillsManager);
            setupChatPanel(targetPanel);
            await targetPanel.loadDiscussion();
            revealDiscussion(targetDiscussion);
        } else {
            // Last Discussion
            const allDiscussions = await discussionManager.getAllDiscussions();
            const lastDiscussion = allDiscussions[0];
            if (!lastDiscussion) {
                vscode.window.showInformationMessage("No previous discussion found. Starting a new one.");
                return sendSelection(true); // Fallback to creating new
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

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showLog', () => {
        // Updated to show the global logger
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

        const title = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("progress.generatingDiscussionTitle"), cancellable: false }, async () => await discussionManager!.generateDiscussionTitle(discussion));
        if (title) {
            discussion.title = title;
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
            panel?.dispose(); // Close the panel if it's open
            
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

                progress.report({ message: `Analyzing ${discussion.id}...`, increment: 0 }); // Don't increment yet

                // Check if discussion has messages
                if (discussion.messages.length > 0) {
                    const newTitle = await discussionManager!.generateDiscussionTitle(discussion);
                    if (newTitle) {
                        discussion.title = newTitle;
                        await discussionManager!.saveDiscussion(discussion);
                    }
                }
                
                progress.report({ message: `Untitled: ${discussion.title}`, increment: increment });
                // We could refresh incrementally but better to do it at the end to avoid flickering
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
            // Called from webview button
            ChatPanel.currentPanel.handleInspectCode(args);
        } else {
            // Called from command palette or somewhere else
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
            const systemPrompt = getProcessedSystemPrompt('chat');
    
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
        let useContext = true; // Default to true

        if (promptOrArg && (promptOrArg as { isCustom: true }).isCustom === true) {
            const customActionData = await CustomActionModal.createOrShow(context.extensionUri);
            if (!customActionData) return; // User cancelled
            
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
    
            if (!selection.prompt) { // User chose "Custom Prompt..."
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
                // For existing saved prompts, we default to using context as requested
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
        // Only load, don't force rebuild unless empty
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

    // NEW COMMANDS
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
        panel.sendMessage(userMessage); // This triggers the API call
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

                // Re-initialize the provider to make it reload the state from workspaceState
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
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showConfigView', () => SettingsPanel.createOrShow(context.extensionUri, lollmsAPI, processManager)));
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
            // Apply full file updates
            if (updates) {
                for (const update of updates) {
                    const { filePath, content } = update;
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
            // Apply patches
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
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.applyPatchContent', async (filePath: string, patchContent: string) => {
        if (!activeWorkspaceFolder){
            vscode.window.showErrorMessage('No active workspace folder.');
            return;
        }
        const currentWorkspaceFolder = activeWorkspaceFolder;
        try {
            const fileUri = vscode.Uri.joinPath(currentWorkspaceFolder.uri, filePath);
            let originalContent = '';
            try {
                const fileContentBytes = await vscode.workspace.fs.readFile(fileUri);
                originalContent = Buffer.from(fileContentBytes).toString('utf8');
            } catch (error) {
                vscode.window.showErrorMessage(`Cannot apply patch: file ${filePath} not found.`);
                return;
            }
            originalContentProvider.set(fileUri, originalContent);

            let finalPatch = patchContent;
            if (!patchContent.trim().startsWith('--- a/')) {
                finalPatch = `--- a/${filePath}\n+++ b/${filePath}\n${patchContent}`;
            }
    
            await applyDiff(finalPatch);
            vscode.window.showInformationMessage(vscode.l10n.t('info.patchApplySuccess', filePath));

            const originalUriForDiff = fileUri.with({ scheme: 'lollms-original' });
            const title = `${path.basename(fileUri.path)} (Original) ↔ ${path.basename(fileUri.path)} (Patched)`;
            await vscode.commands.executeCommand('vscode.diff', originalUriForDiff, fileUri, title);
    
        } catch (error: any) {
            vscode.window.showErrorMessage(vscode.l10n.t('error.failedToApplyPatch', error.message));
        }
    }));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.renameFile', async (originalPath: string, newPath: string) => {
        if (!activeWorkspaceFolder) {
            vscode.window.showErrorMessage('No active workspace folder.');
            return;
        }
        const currentWorkspaceFolder = activeWorkspaceFolder;
        const originalUri = vscode.Uri.joinPath(currentWorkspaceFolder.uri, originalPath);
        const newUri = vscode.Uri.joinPath(currentWorkspaceFolder.uri, newPath);
    
        try {
            await vscode.workspace.fs.rename(originalUri, newUri, { overwrite: true });
            vscode.window.showInformationMessage(`Successfully renamed/moved '${originalPath}' to '${newPath}'.`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to rename file: ${error.message}`);
        }
    }));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.deleteFile', async (filePathsStr: string) => {
        if (!activeWorkspaceFolder) {
            vscode.window.showErrorMessage('No active workspace folder.');
            return;
        }
        const currentWorkspaceFolder = activeWorkspaceFolder;
        
        const filesToDelete = filePathsStr.split('\n').map(f => f.trim()).filter(f => f);
        if (filesToDelete.length === 0) {
            vscode.window.showWarningMessage("No valid file paths found to delete.");
            return;
        }
    
        const fileListForPrompt = filesToDelete.length > 5 
            ? filesToDelete.slice(0, 5).join('\n') + `\n...and ${filesToDelete.length - 5} more files.`
            : filesToDelete.join('\n');
        
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to delete ${filesToDelete.length} file(s)?\n\n${fileListForPrompt}\n\nThis will move the file(s) to the Trash.`,
            { modal: true },
            'Delete'
        );
    
        if (confirm === 'Delete') {
            let successCount = 0;
            let errorCount = 0;
            let lastError = '';
    
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Deleting ${filesToDelete.length} file(s)...`,
                cancellable: false
            }, async (progress) => {
                for (const filePath of filesToDelete) {
                    progress.report({ message: `Deleting ${filePath}` });
                    const fileUri = vscode.Uri.joinPath(currentWorkspaceFolder.uri, filePath);
                    try {
                        await vscode.workspace.fs.delete(fileUri, { useTrash: true });
                        successCount++;
                    } catch (error: any) {
                        errorCount++;
                        lastError = error.message;
                        console.error(`Failed to delete file ${filePath}:`, error);
                    }
                }
            });
    
            if (errorCount > 0) {
                vscode.window.showErrorMessage(`Failed to delete ${errorCount} file(s). Last error: ${lastError}`);
            }
            if (successCount > 0) {
                vscode.window.showInformationMessage(`Successfully deleted ${successCount} file(s).`);
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.addFilesToContext', async (files: string[]) => {
        if (contextStateProvider && files && files.length > 0) {
            await contextStateProvider.addFilesToContext(files);
            vscode.window.showInformationMessage(`Added ${files.length} file(s) to the AI context.`);
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
            disableSslVerification: newConfigValues.get<boolean>('disableSslVerification') || false,
            sslCertPath: newConfigValues.get<string>('sslCertPath') || ''
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
            e.affectsConfiguration('lollmsVsCoder.disableSslVerification') ||
            e.affectsConfiguration('lollmsVsCoder.sslCertPath')) {
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
        const currentWorkspaceFolder = activeWorkspaceFolder;

        const launchJsonPath = vscode.Uri.joinPath(currentWorkspaceFolder.uri, '.vscode', 'launch.json');
        let launchConfig: any;
        try {
            const fileContent = await vscode.workspace.fs.readFile(launchJsonPath);
            launchConfig = JSON.parse(fileContent.toString());
        } catch (error) {
            try { await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(currentWorkspaceFolder.uri, '.vscode')); } catch (e) {}
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
            defaultUri: currentWorkspaceFolder.uri
        });

        if (fileUris && fileUris[0]) {
            const relativePath = path.relative(currentWorkspaceFolder.uri.fsPath, fileUris[0].fsPath).replace(/\\/g, '/');
            mainConfig.program = `\${workspaceFolder}/${relativePath}`;
            
            const ext = path.extname(relativePath).toLowerCase();
            if (ext === '.py') { mainConfig.type = 'python'; }
            if (ext === '.js' || ext === '.ts') { mainConfig.type = 'node'; }

            await vscode.workspace.fs.writeFile(launchJsonPath, Buffer.from(JSON.stringify(launchConfig, null, 4), 'utf8'));
            vscode.window.showInformationMessage(`Set '${relativePath}' as the execution entry point for '${currentWorkspaceFolder.name}'.`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.executeProject', async (panel?: ChatPanel) => {
        const activeChatPanel = panel || ChatPanel.currentPanel;
        if (!activeChatPanel) {
            vscode.window.showErrorMessage("Please open a Lollms chat panel to see the execution results.");
            return;
        }
    
        if (!activeWorkspaceFolder) {
            vscode.window.showErrorMessage("Please open a project folder to execute.");
            activeChatPanel.addMessageToDiscussion({ role: 'system', content: 'Execution failed: No workspace folder open.' });
            return;
        }
        const workspaceFolder = activeWorkspaceFolder;
        
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

    context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory('*', new LollmsDebugAdapterTrackerFactory()));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.debugErrorWithAI', async () => {
        if (!debugErrorManager.lastError) {
            vscode.window.showInformationMessage("Lollms: No debug error has been captured.");
            return;
        }
    
        if (!discussionManager || !activeWorkspaceFolder) {
            vscode.window.showErrorMessage("Lollms: Cannot start a discussion, a workspace must be active.");
            return;
        }
    
        const prompt = await buildDebugErrorPrompt(debugErrorManager.lastError, contextManager, contextStateProvider);
        await startDiscussionWithInitialPrompt(prompt);
        debugErrorManager.clearError();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.debugErrorSendToDiscussion', async () => {
        if (!debugErrorManager.lastError) {
            vscode.window.showInformationMessage("Lollms: No debug error has been captured.");
            return;
        }

        const prompt = await buildDebugErrorPrompt(debugErrorManager.lastError, contextManager, contextStateProvider);

        const currentPanel = ChatPanel.currentPanel;
        if (currentPanel) {
            const userMessage: ChatMessage = {
                id: 'user_' + Date.now().toString() + Math.random().toString(36).substring(2),
                role: 'user',
                content: prompt
            };
            await currentPanel.sendMessage(userMessage);
        } else {
            await startDiscussionWithInitialPrompt(prompt);
        }

        debugErrorManager.clearError();
    }));
        

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setContextDefinitionsOnly', (primaryUri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
        handleSetState('definitions-only', primaryUri, selectedUris);
    }));
        
    console.log('Extension activation complete.');
}

export function deactivate(): void {
    if (lollmsExecutionTerminal) {
        lollmsExecutionTerminal.dispose();
    }
}
