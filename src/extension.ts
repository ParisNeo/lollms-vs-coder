import * as vscode from 'vscode';
import { LollmsAPI, LollmsConfig } from './lollmsAPI';
import { ContextManager } from './contextManager';
import { GitIntegration } from './gitIntegration';
import { ContextStateProvider } from './commands/contextStateProvider';
import { FileDecorationProvider } from './commands/fileDecorationProvider';
import { DiscussionManager } from './discussionManager';
import { ScriptRunner } from './scriptRunner';
import { PromptManager } from './promptManager';
import { AgentManager } from './agentManager';
import { ProcessManager } from './processManager';
import { LollmsNotebookCellActionProvider, NotebookManager } from './notebookTools';
import { LollmsCodeActionProvider } from './commands/codeActions';
import { SkillsManager } from './skillsManager';
import { CodeGraphManager } from './codeGraphManager';
import { DebugCodeLensProvider } from './commands/debugCodeLensProvider';
import { Logger } from './logger';
import { PersonalityManager } from './personalityManager';
import { QuickEditManager } from './quickEditManager';
import { InlineDiffProvider } from './commands/inlineDiffProvider';
import { MemoryManager } from './memoryManager';
import { WorkflowManager } from './workflow/workflowManager';
import { LollmsStatusBar } from './ui/statusBar';
import { registerViews } from './registries/viewRegistry';
import { registerCommands } from './registries/commandRegistry';
import { setPythonApi, debugErrorManager, disposeTerminal } from './extensionState';
import { LollmsServices } from './lollmsContext';
import { ChatPanel } from './commands/chatPanel/chatPanel';
import { DiscussionItem } from './commands/discussionTreeProvider';
import { DiffManager } from './diffManager';
import { DiffCodeLensProvider } from './commands/diffCodeLensProvider';
import { HerdManager } from './herdManager';
import { LollmsDebugAdapterTrackerFactory } from './debugAdapterTracker';
import { CodeExplorerPanel } from './commands/codeExplorerView';
import { SelectionCodeLensProvider } from './commands/selectionCodeLensProvider';
import { SelectionDecorator, SelectionHoverProvider } from './ui/selectionDecorator';

// RLM Database Imports
import { RLMDatabaseManager } from './rlmDatabaseManager';
import { RLMDatabaseTreeProvider } from './commands/rlmDatabaseTreeProvider';
import { InfoPanel } from './commands/infoPanel';

export async function activate(context: vscode.ExtensionContext) {
    Logger.initialize(context);
    Logger.info('Lollms VS Coder is now active!');

    let activeWorkspaceFolder: vscode.WorkspaceFolder | undefined;
    const getActiveWorkspace = () => activeWorkspaceFolder;

    // Python Extension API
    const pythonExt = vscode.extensions.getExtension('ms-python.python');
    let pythonExtApi = null;
    if (pythonExt) {
        if (!pythonExt.isActive) await pythonExt.activate();
        pythonExtApi = pythonExt.exports;
        setPythonApi(pythonExtApi);
    }

    // Config & API
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    const lollmsAPI = new LollmsAPI({
        apiUrl: config.get<string>('apiUrl') || 'http://localhost:9642',
        apiKey: config.get<string>('apiKey')?.trim() || '',
        modelName: config.get<string>('modelName') || 'ollama/mistral',
        disableSslVerification: config.get<boolean>('disableSslVerification') || false,
        sslCertPath: config.get<string>('sslCertPath') || '',
        backendType: config.get<'lollms' | 'openai' | 'ollama'>('backendType') || 'lollms',
        useLollmsExtensions: config.get<boolean>('useLollmsExtensions') ?? true
    }, context.globalState);

    // Initialize Managers
    const memoryManager = new MemoryManager(context.globalStorageUri);
    const contextManager = new ContextManager(context, lollmsAPI);
    // Pass global storage URI
    const skillsManager = new SkillsManager(context.globalStorageUri); 
    const scriptRunner = new ScriptRunner(pythonExtApi);
    const promptManager = new PromptManager(context.globalStorageUri);
    const personalityManager = new PersonalityManager(context.globalStorageUri);
    const workflowManager = new WorkflowManager(context.globalStorageUri);
    const gitIntegration = new GitIntegration(lollmsAPI);
    const processManager = new ProcessManager();
    const codeGraphManager = new CodeGraphManager();
    const notebookManager = new NotebookManager(lollmsAPI);
    const inlineDiffProvider = new InlineDiffProvider(lollmsAPI);
    const quickEditManager = new QuickEditManager(lollmsAPI, inlineDiffProvider, contextManager, memoryManager);
    const diffManager = new DiffManager();
    const herdManager = new HerdManager(lollmsAPI, contextManager, personalityManager);
    
    // Initialize RLM Database Manager
    const rlmDb = new RLMDatabaseManager(context);
    const rlmProvider = new RLMDatabaseTreeProvider(rlmDb);
    vscode.window.registerTreeDataProvider('lollmsRLMView', rlmProvider);

    contextManager.setSkillsManager(skillsManager);
    contextManager.setCodeGraphManager(codeGraphManager);

    // SETUP DIFF MANAGER
    diffManager.setup(context);
    
    // Discussion Manager requires process manager
    const discussionManager = new DiscussionManager(lollmsAPI, processManager, context);

    // Services Container - Added rlmDb here so commands can access it
    const services: LollmsServices = {
        extensionUri: context.extensionUri,
        lollmsAPI, contextManager, discussionManager, processManager, promptManager,
        personalityManager, skillsManager, codeGraphManager, notebookManager,
        gitIntegration, scriptRunner, quickEditManager, workflowManager,
        inlineDiffProvider, diffManager, herdManager,
        rlmDb, // Injected RLM Database
        treeProviders: {}
    };

    // Register Views
    registerViews(context, services);

    // Register Commands
    registerCommands(context, services, getActiveWorkspace);

    // Register Workspace Switcher Command
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.selectActiveWorkspace', async () => {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length <= 1) { return; }
        const selected = await vscode.window.showQuickPick(
            folders.map(f => ({ label: f.name, folder: f })),
            { placeHolder: 'Select active Lollms workspace' }
        );
        if (selected) {
            switchActiveWorkspace(selected.folder);
        }
    }));

    let recreateClientDisposable = vscode.commands.registerCommand('lollmsApi.recreateClient', async () => {
        console.log('[INFO] Recreating Lollms API Client...');
        try {
            const config = vscode.workspace.getConfiguration('lollmsVsCoder');
            lollmsAPI.updateConfig({
                apiUrl: config.get<string>('apiUrl') || 'http://localhost:9642',
                apiKey: config.get<string>('apiKey')?.trim() || '',
                modelName: config.get<string>('modelName') || 'ollama/mistral',
                disableSslVerification: config.get<boolean>('disableSslVerification') || false,
                sslCertPath: config.get<string>('sslCertPath') || '',
                backendType: config.get<'lollms' | 'openai' | 'ollama'>('backendType') || 'lollms',
                useLollmsExtensions: config.get<boolean>('useLollmsExtensions') ?? true
            });
            vscode.window.showInformationMessage('Lollms client successfully re-initialized.');
        } catch (error) {
            console.error('[ERROR] Failed to recreate Lollms client:', error);
            vscode.window.showErrorMessage('Failed to re-initialize Lollms client.');
        }
    });
    context.subscriptions.push(recreateClientDisposable);

    // Code Graph Panel Command
    const showCodeGraphPanelCommand = vscode.commands.registerCommand('lollms-vs-coder.showCodeGraphPanel', () => {
        if (services.codeGraphManager) {
            CodeExplorerPanel.createOrShow(context.extensionUri, services.codeGraphManager);
        } else {
            vscode.window.showErrorMessage('Code Graph Manager not initialized.');
        }
    });
    context.subscriptions.push(showCodeGraphPanelCommand);    

    // View Knowledge Command (for RLM entries)
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.viewKnowledge', (title, content) => {
        InfoPanel.createOrShow(context.extensionUri, `Knowledge: ${title}`, content);
    }));

    // Register Providers
    try {
        const caProvider = new LollmsCodeActionProvider(promptManager);
        context.subscriptions.push(
            vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, caProvider, {
                providedCodeActionKinds: LollmsCodeActionProvider.providedCodeActionKinds
            })
        );
    } catch (e) {
        Logger.error("Failed to register CodeActionProvider", e);
    }

    context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, new DebugCodeLensProvider(debugErrorManager)));
    context.subscriptions.push(vscode.languages.registerCodeLensProvider({ pattern: '**' }, inlineDiffProvider));
    context.subscriptions.push(vscode.notebooks.registerNotebookCellStatusBarItemProvider('jupyter-notebook', new LollmsNotebookCellActionProvider()));
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(DiffManager.SCHEME, diffManager));

    context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory('*', new LollmsDebugAdapterTrackerFactory()));

    if (config.get<boolean>('enableInlineSuggestions')) {
        context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, new (require('./commands/inlineSuggestions').LollmsInlineCompletionProvider)(lollmsAPI)));
    }

    // Status Bar
    const statusBar = new LollmsStatusBar(context, lollmsAPI);

    // Configuration Listener
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('lollmsVsCoder')) {
            const newConfig = vscode.workspace.getConfiguration('lollmsVsCoder');
            lollmsAPI.updateConfig({
                apiUrl: newConfig.get<string>('apiUrl') || 'http://localhost:9642',
                apiKey: newConfig.get<string>('apiKey')?.trim() || '',
                modelName: newConfig.get<string>('modelName') || 'ollama/mistral',
                disableSslVerification: newConfig.get<boolean>('disableSslVerification') || false,
                sslCertPath: newConfig.get<string>('sslCertPath') || '',
                backendType: newConfig.get<'lollms' | 'openai' | 'ollama'>('backendType') || 'lollms',
                useLollmsExtensions: newConfig.get<boolean>('useLollmsExtensions') ?? true
            });
            if (e.affectsConfiguration('lollmsVsCoder.apiUrl') || e.affectsConfiguration('lollmsVsCoder.apiKey')) {
                statusBar.checkConnection();
            }
        }
    }));

    // Context
    let contextStateProvider: ContextStateProvider | undefined;
    const fileDecorationProvider = new FileDecorationProvider(undefined);
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(fileDecorationProvider));

    // Workspace Switching Logic
    async function switchActiveWorkspace(folder: vscode.WorkspaceFolder) {
        activeWorkspaceFolder = folder;
        statusBar.updateActiveWorkspace(folder);

        await discussionManager.switchWorkspace(folder.uri);
        services.treeProviders.discussion?.refresh();
        
        await skillsManager.switchWorkspace(folder.uri, context.extensionUri);
        services.treeProviders.skills?.refresh();
        
        codeGraphManager.setWorkspaceRoot(folder.uri);
        services.treeProviders.codeExplorer?.refresh();

        // Switch RLM DB Workspace
        await rlmDb.switchWorkspace(folder.uri);
        
        if (contextStateProvider) {
            await contextStateProvider.switchWorkspace(folder.uri.fsPath);
        } else {
            contextStateProvider = new ContextStateProvider(folder.uri.fsPath, context);
            contextManager.setContextStateProvider(contextStateProvider);
            codeGraphManager.setContextSetter((key, value) => {
                vscode.commands.executeCommand('setContext', `lollms:${key}`, value);
            });
            fileDecorationProvider.updateStateProvider(contextStateProvider);
            vscode.window.registerTreeDataProvider('lollmsFileTreeView', contextStateProvider);
        }

        ChatPanel.panels.forEach(panel => panel.dispose());
        vscode.window.showInformationMessage(`Lollms workspace switched to '${folder.name}'.`);
    }

    // Initialization logic
    function initializeWorkspace() {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            vscode.commands.executeCommand('setContext', 'lollms:hasWorkspace', false);
            return;
        }
        vscode.commands.executeCommand('setContext', 'lollms:hasWorkspace', true);
        const initial = activeWorkspaceFolder 
            ? (folders.find(f => f.uri.toString() === activeWorkspaceFolder!.uri.toString()) || folders[0]) 
            : folders[0];
        switchActiveWorkspace(initial);
    }

    initializeWorkspace();

    // Event Listeners
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(initializeWorkspace));
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        const folders = vscode.workspace.workspaceFolders;
        if (!editor || !folders || folders.length <= 1) return;
        const workspace = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        if (workspace && workspace.uri.toString() !== activeWorkspaceFolder?.uri.toString()) {
            switchActiveWorkspace(workspace);
        }
    }));
    
    // Process status updates
    context.subscriptions.push(processManager.onDidProcessChange(() => {
        statusBar.updateProcesses(processManager.getAll().length);
        ChatPanel.panels.forEach(panel => panel.updateGeneratingState());
    }));
}

export function deactivate(): void {
    disposeTerminal();
}
